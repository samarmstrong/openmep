import { ClipType, FillRule, PolyTree64, booleanOpWithPolyTree, type Paths64 } from "clipper2-ts";
import polylabel from "polylabel";
import * as THREE from "three";
import {
  IFCBUILDINGELEMENTPROXY,
  IFCCOLUMN,
  IFCDOOR,
  IFCENERGYCONVERSIONDEVICE,
  IFCFLOWCONTROLLER,
  IFCFLOWFITTING,
  IFCFLOWMOVINGDEVICE,
  IFCFLOWSEGMENT,
  IFCFLOWTERMINAL,
  IFCRELCONNECTSPORTS,
  IFCRELFILLSELEMENT,
  IFCSPACE,
  IFCUNITARYEQUIPMENT,
  IFCWALL
} from "web-ifc";

import type {
  AirflowType,
  Bounds2D,
  Bounds3D,
  MechanicalEditEdgeItem,
  MechanicalEditItem,
  MechanicalEditNodeItem,
  MechanicalVisualItem,
  PlanModel,
  PlanPresentationCategory,
  PlanPolygon,
  PlanPrimitive,
  PlanPrimitiveKind,
  PlanSpace,
  PlanStorey,
  Point2D,
  Point3D,
  SpaceSummary,
  StoreySummary
} from "../types";
import {
  extractIfcMetadata,
  metresPerLengthUnit,
  resolveContainingStoreyExpressId,
  toText,
  vectorToArray,
  withIfcModel
} from "./ifc-helpers";

const SNAP_FACTOR = 1e4;
const AREA_EPSILON = 1e-8;
const HORIZONTAL_FACE_THRESHOLD = 0.25;
const UP_AXIS_NORMAL_THRESHOLD = 0.8;

export const CURRENT_PLAN_VERSION = 7;

type Pair = [number, number];
type Ring = Pair[];

type ExtractionTarget = {
  type: number;
  kind: Exclude<PlanPrimitiveKind, "space">;
};

type MeshTriangle = {
  points: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  normal: THREE.Vector3;
  area: number;
};

type MeshCapture = {
  kind: string;
  vertices: THREE.Vector3[];
  triangles: MeshTriangle[];
};

type PrimitiveInput = {
  mesh: MeshCapture;
  globalId: string;
  expressId: number;
  ifcClass: string;
  storeyGlobalId: string;
  kind: Exclude<PlanPrimitiveKind, "space">;
  sourceName: string | null;
  diagnostics: string[];
};

type SpaceInput = {
  mesh: MeshCapture;
  storeyGlobalId: string;
  space: SpaceSummary;
};

type StoreyPlanInputs = {
  primitiveInputs: PrimitiveInput[];
  spaceInputs: SpaceInput[];
};

type StoreyBasis = {
  origin: THREE.Vector3;
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
  upAxis: THREE.Vector3;
  worldBounds3D: Bounds3D;
  localBounds: Bounds2D;
  projectPoint: (point: THREE.Vector3) => Point2D;
};

type MechanicalTarget = {
  type: number;
  kind: MechanicalVisualItem["kind"];
};

const EXTRACTION_TARGETS: ExtractionTarget[] = [
  { type: IFCWALL, kind: "wall" },
  { type: IFCDOOR, kind: "door-opening" },
  { type: IFCCOLUMN, kind: "column" }
];

const MECHANICAL_TARGETS: MechanicalTarget[] = [
  { type: IFCFLOWSEGMENT, kind: "mech-segment" },
  { type: IFCFLOWFITTING, kind: "mech-fitting" },
  { type: IFCFLOWCONTROLLER, kind: "mech-fitting" },
  { type: IFCFLOWTERMINAL, kind: "mech-terminal" },
  { type: IFCBUILDINGELEMENTPROXY, kind: "mech-equipment" },
  { type: IFCFLOWMOVINGDEVICE, kind: "mech-equipment" },
  { type: IFCENERGYCONVERSIONDEVICE, kind: "mech-equipment" },
  { type: IFCUNITARYEQUIPMENT, kind: "mech-equipment" }
];

/** Two duct pieces are joined when their geometry comes within 5 cm. */
const GEOMETRIC_CONNECTION_TOLERANCE_M = 0.05;
const GEOMETRIC_CONNECTION_DIAGNOSTIC =
  "connections inferred from geometry: source has no IfcRelConnectsPorts";

function snap(value: number) {
  return Math.round(value * SNAP_FACTOR) / SNAP_FACTOR;
}

function toOpenRing(ring: Ring): Point2D[] {
  const points = ring.map(([x, y]) => [snap(x), snap(y)] as Point2D);
  const normalized: Point2D[] = [];

  for (const point of points) {
    const last = normalized[normalized.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) {
      normalized.push(point);
    }
  }

  if (normalized.length > 1) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      normalized.pop();
    }
  }

  if (normalized.length < 3) {
    return [];
  }

  let index = 0;
  while (index < normalized.length && normalized.length >= 3) {
    const previous = normalized[(index - 1 + normalized.length) % normalized.length];
    const current = normalized[index];
    const next = normalized[(index + 1) % normalized.length];
    const areaTwice =
      previous[0] * (current[1] - next[1]) +
      current[0] * (next[1] - previous[1]) +
      next[0] * (previous[1] - current[1]);

    if (Math.abs(areaTwice) <= AREA_EPSILON) {
      normalized.splice(index, 1);
      continue;
    }

    index += 1;
  }

  return normalized.length >= 3 ? normalized : [];
}

function signedArea(ring: Point2D[]) {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

function toClosedRing(ring: Point2D[]): Point2D[] {
  if (ring.length === 0) {
    return [];
  }
  return [...ring, ring[0]];
}

function polygonArea(polygon: PlanPolygon) {
  let total = Math.abs(signedArea(polygon.outer));
  for (const hole of polygon.holes) {
    total -= Math.abs(signedArea(hole));
  }
  return total;
}

function computeBounds(polygons: PlanPolygon[]): Bounds2D {
  const points = polygons.flatMap((polygon) => [polygon.outer, ...polygon.holes]).flat();
  if (points.length === 0) {
    throw new Error("Plan primitive did not contain any points.");
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    min: [minX, minY],
    max: [maxX, maxY]
  };
}

function computeBoundsFromPoints(points: Point2D[]): Bounds2D {
  if (points.length === 0) {
    throw new Error("Cannot compute bounds from an empty point set.");
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    min: [snap(minX), snap(minY)],
    max: [snap(maxX), snap(maxY)]
  };
}

function mergePlanBounds(bounds: Bounds2D[]): Bounds2D {
  if (bounds.length === 0) {
    throw new Error("Cannot merge an empty bounds set.");
  }

  let minX = bounds[0].min[0];
  let minY = bounds[0].min[1];
  let maxX = bounds[0].max[0];
  let maxY = bounds[0].max[1];

  for (const bound of bounds.slice(1)) {
    minX = Math.min(minX, bound.min[0]);
    minY = Math.min(minY, bound.min[1]);
    maxX = Math.max(maxX, bound.max[0]);
    maxY = Math.max(maxY, bound.max[1]);
  }

  return {
    min: [minX, minY],
    max: [maxX, maxY]
  };
}


function pointInRing(point: Point2D, ring: Point2D[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || Number.EPSILON) + xi;

    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(point: Point2D, polygon: PlanPolygon) {
  if (!pointInRing(point, polygon.outer)) {
    return false;
  }
  return polygon.holes.every((hole) => !pointInRing(point, hole));
}

function selectLargestPolygon(polygons: PlanPolygon[]) {
  const largest = polygons.reduce<PlanPolygon | null>((current, candidate) => {
    if (!current || polygonArea(candidate) > polygonArea(current)) {
      return candidate;
    }
    return current;
  }, null);

  if (!largest) {
    throw new Error("Unable to select a polygon for label placement.");
  }

  return largest;
}

function toPoint3D(vector: THREE.Vector3): Point3D {
  return [snap(vector.x), snap(vector.y), snap(vector.z)];
}

function boundsFromVectors(points: THREE.Vector3[]): Bounds3D | null {
  if (points.length === 0) {
    return null;
  }

  const min = points[0].clone();
  const max = points[0].clone();

  for (const point of points.slice(1)) {
    min.min(point);
    max.max(point);
  }

  return {
    min: toPoint3D(min),
    max: toPoint3D(max)
  };
}

function axisFromIndex(index: number) {
  if (index === 0) {
    return new THREE.Vector3(1, 0, 0);
  }
  if (index === 1) {
    return new THREE.Vector3(0, 1, 0);
  }
  return new THREE.Vector3(0, 0, 1);
}

function chooseMostOrthogonalAxis(upAxis: THREE.Vector3) {
  const axes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1)
  ];

  return axes.reduce((best, candidate) => {
    const alignment = Math.abs(candidate.dot(upAxis));
    if (!best || alignment < best.alignment) {
      return { axis: candidate, alignment };
    }
    return best;
  }, null as { axis: THREE.Vector3; alignment: number } | null)?.axis.clone() ??
    new THREE.Vector3(1, 0, 0);
}

function createSeedAxes(upAxis: THREE.Vector3) {
  const seed = chooseMostOrthogonalAxis(upAxis);
  const uAxis = seed.addScaledVector(upAxis, -seed.dot(upAxis)).normalize();
  const vAxis = new THREE.Vector3().crossVectors(upAxis, uAxis).normalize();
  return { uAxis, vAxis };
}

function stabilizeMajorAxis(axis: THREE.Vector3) {
  const dominantIndex =
    Math.abs(axis.x) >= Math.abs(axis.y) && Math.abs(axis.x) >= Math.abs(axis.z)
      ? 0
      : Math.abs(axis.y) >= Math.abs(axis.z)
        ? 1
        : 2;
  const dominantValue = dominantIndex === 0 ? axis.x : dominantIndex === 1 ? axis.y : axis.z;
  return dominantValue < 0 ? axis.multiplyScalar(-1) : axis;
}

function createStoreyBasisFromAxes(
  points: THREE.Vector3[],
  worldBounds: Bounds3D,
  uAxis: THREE.Vector3,
  vAxis: THREE.Vector3,
  upAxis: THREE.Vector3
): StoreyBasis {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  let sumUp = 0;

  for (const point of points) {
    const u = point.dot(uAxis);
    const v = point.dot(vAxis);
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
    sumUp += point.dot(upAxis);
  }

  const averageUp = sumUp / points.length;
  const origin = uAxis.clone().multiplyScalar(minU)
    .add(vAxis.clone().multiplyScalar(minV))
    .add(upAxis.clone().multiplyScalar(averageUp));

  return {
    origin,
    uAxis,
    vAxis,
    upAxis,
    worldBounds3D: worldBounds,
    localBounds: {
      min: [0, 0],
      max: [snap(maxU - minU), snap(maxV - minV)]
    },
    projectPoint(point) {
      const relative = point.clone().sub(origin);
      return [snap(relative.dot(uAxis)), snap(relative.dot(vAxis))];
    }
  };
}

function normalizeRightAngleAngle(angle: number) {
  while (angle <= -Math.PI / 4) {
    angle += Math.PI / 2;
  }
  while (angle > Math.PI / 4) {
    angle -= Math.PI / 2;
  }
  return angle;
}

function dominantOrthogonalEdgeAngle(
  edges: Array<{ dx: number; dy: number; length: number }>,
  minEdgeLength: number
) {
  let cos4 = 0;
  let sin4 = 0;
  let totalWeight = 0;

  for (const edge of edges) {
    if (edge.length < minEdgeLength) {
      continue;
    }

    const weight = edge.length * edge.length;
    const angle = Math.atan2(edge.dy, edge.dx);
    cos4 += Math.cos(angle * 4) * weight;
    sin4 += Math.sin(angle * 4) * weight;
    totalWeight += weight;
  }

  if (totalWeight <= AREA_EPSILON) {
    return null;
  }

  const strength = Math.hypot(cos4, sin4) / totalWeight;
  if (strength < 0.35) {
    return null;
  }

  return normalizeRightAngleAngle(Math.atan2(sin4, cos4) / 4);
}

function edgeKey(start: Point2D, end: Point2D) {
  const [from, to] =
    start[0] < end[0] || (start[0] === end[0] && start[1] <= end[1])
      ? [start, end]
      : [end, start];
  return `${from[0]},${from[1]}|${to[0]},${to[1]}`;
}

function collectProjectedBoundaryEdges(mesh: MeshCapture, basis: StoreyBasis) {
  let positiveArea = 0;
  let negativeArea = 0;
  for (const triangle of mesh.triangles) {
    const alignment = triangle.normal.dot(basis.upAxis);
    if (alignment >= HORIZONTAL_FACE_THRESHOLD) {
      positiveArea += triangle.area;
    } else if (alignment <= -HORIZONTAL_FACE_THRESHOLD) {
      negativeArea += triangle.area;
    }
  }

  const preferredSign = positiveArea >= negativeArea ? 1 : -1;
  const counts = new Map<string, { start: Point2D; end: Point2D; count: number }>();

  for (const triangle of mesh.triangles) {
    const alignment = triangle.normal.dot(basis.upAxis);
    if (preferredSign * alignment < HORIZONTAL_FACE_THRESHOLD) {
      continue;
    }

    const projected = triangle.points.map((point) => basis.projectPoint(point)) as Ring;
    for (let index = 0; index < projected.length; index += 1) {
      const start = projected[index];
      const end = projected[(index + 1) % projected.length];
      if (start[0] === end[0] && start[1] === end[1]) {
        continue;
      }

      const key = edgeKey(start, end);
      const current = counts.get(key);
      if (current) {
        current.count += 1;
        continue;
      }

      counts.set(key, {
        start,
        end,
        count: 1
      });
    }
  }

  return Array.from(counts.values())
    .filter((edge) => edge.count % 2 === 1)
    .map((edge) => ({
      start: edge.start,
      end: edge.end,
      dx: edge.end[0] - edge.start[0],
      dy: edge.end[1] - edge.start[1],
      length: Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1])
    }));
}

function pointKey(point: Point2D) {
  return `${point[0]},${point[1]}`;
}

function pointsEqual(left: Point2D, right: Point2D) {
  return left[0] === right[0] && left[1] === right[1];
}

function refinePlanAxesToOrthogonalGeometry(
  meshes: MeshCapture[],
  basis: StoreyBasis
) {
  if (meshes.length === 0) {
    return null;
  }

  const edges = meshes.flatMap((mesh) => collectProjectedBoundaryEdges(mesh, basis));
  if (edges.length === 0) {
    return null;
  }

  const maxExtent = Math.max(basis.localBounds.max[0], basis.localBounds.max[1]);
  const snapEdgeLength = Math.max(maxExtent * 0.01, 0.25);
  const angle = dominantOrthogonalEdgeAngle(edges, snapEdgeLength);
  if (angle === null || Math.abs(angle) <= THREE.MathUtils.degToRad(0.25)) {
    return null;
  }

  const uAxis = stabilizeMajorAxis(
    basis.uAxis.clone().multiplyScalar(Math.cos(angle))
      .add(basis.vAxis.clone().multiplyScalar(Math.sin(angle)))
      .normalize()
  );
  const vAxis = new THREE.Vector3().crossVectors(basis.upAxis, uAxis).normalize();

  return { uAxis, vAxis };
}

function cornersFromBounds(bounds: Bounds3D): THREE.Vector3[] {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  return [
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(minX, minY, maxZ),
    new THREE.Vector3(minX, maxY, minZ),
    new THREE.Vector3(minX, maxY, maxZ),
    new THREE.Vector3(maxX, minY, minZ),
    new THREE.Vector3(maxX, minY, maxZ),
    new THREE.Vector3(maxX, maxY, minZ),
    new THREE.Vector3(maxX, maxY, maxZ)
  ];
}

function fitPlanAxes(points: THREE.Vector3[], upAxis: THREE.Vector3) {
  const { uAxis: seedU, vAxis: seedV } = createSeedAxes(upAxis);
  if (points.length < 2) {
    return { uAxis: seedU, vAxis: seedV };
  }

  let meanX = 0;
  let meanY = 0;
  const projected = points.map((point) => {
    const x = point.dot(seedU);
    const y = point.dot(seedV);
    meanX += x;
    meanY += y;
    return [x, y] as const;
  });

  meanX /= projected.length;
  meanY /= projected.length;

  let xx = 0;
  let xy = 0;
  let yy = 0;

  for (const [x, y] of projected) {
    const dx = x - meanX;
    const dy = y - meanY;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }

  if (Math.abs(xy) <= AREA_EPSILON && Math.abs(xx - yy) <= AREA_EPSILON) {
    return { uAxis: seedU, vAxis: seedV };
  }

  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const largestEigenvalue =
    trace / 2 + Math.sqrt(Math.max(0, trace * trace * 0.25 - det));

  const eigenvector =
    Math.abs(xy) > AREA_EPSILON
      ? new THREE.Vector2(largestEigenvalue - yy, xy)
      : xx >= yy
        ? new THREE.Vector2(1, 0)
        : new THREE.Vector2(0, 1);

  const major2D = eigenvector.normalize();
  const uAxis = stabilizeMajorAxis(
    seedU.clone().multiplyScalar(major2D.x).add(seedV.clone().multiplyScalar(major2D.y)).normalize()
  );
  const vAxis = new THREE.Vector3().crossVectors(upAxis, uAxis).normalize();

  return { uAxis, vAxis };
}

function chooseUpAxis(points: THREE.Vector3[], triangles: MeshTriangle[]) {
  const candidateWeights = [0, 0, 0];

  for (const triangle of triangles) {
    const absoluteNormal = [
      Math.abs(triangle.normal.x),
      Math.abs(triangle.normal.y),
      Math.abs(triangle.normal.z)
    ];
    const dominant = Math.max(...absoluteNormal);
    if (dominant < UP_AXIS_NORMAL_THRESHOLD) {
      continue;
    }

    const axisIndex = absoluteNormal.indexOf(dominant);
    candidateWeights[axisIndex] += triangle.area * dominant;
  }

  if (candidateWeights.some((weight) => weight > 0)) {
    const axisIndex = candidateWeights.indexOf(Math.max(...candidateWeights));
    return axisFromIndex(axisIndex);
  }

  const worldBounds = boundsFromVectors(points);
  if (!worldBounds) {
    return new THREE.Vector3(0, 1, 0);
  }

  const extents = [
    worldBounds.max[0] - worldBounds.min[0],
    worldBounds.max[1] - worldBounds.min[1],
    worldBounds.max[2] - worldBounds.min[2]
  ];
  const axisIndex = extents.indexOf(Math.min(...extents));
  return axisFromIndex(axisIndex);
}

function createStoreyBasis(storey: StoreySummary, meshes: MeshCapture[]): StoreyBasis {
  const points = meshes.flatMap((mesh) => mesh.vertices);
  const wallAndSpaceMeshes = meshes.filter((mesh) => mesh.kind === "wall" || mesh.kind === "space");
  const horizontalCandidates = meshes
    .filter((mesh) => mesh.kind === "space")
    .flatMap((mesh) => mesh.triangles);
  const allTriangles = meshes.flatMap((mesh) => mesh.triangles);

  const fallbackBounds = storey.bounds ?? {
    min: [0, 0, 0] as Point3D,
    max: [1, 1, 1] as Point3D
  };
  const fallbackPoints = points.length > 0 ? points : cornersFromBounds(fallbackBounds);
  const worldBounds = boundsFromVectors(fallbackPoints) ?? fallbackBounds;
  const upAxis = chooseUpAxis(
    fallbackPoints,
    horizontalCandidates.length > 0 ? horizontalCandidates : allTriangles
  );
  const provisionalAxes = fitPlanAxes(fallbackPoints, upAxis);
  const provisionalBasis = createStoreyBasisFromAxes(
    fallbackPoints,
    worldBounds,
    provisionalAxes.uAxis,
    provisionalAxes.vAxis,
    upAxis
  );
  const refinedAxes = refinePlanAxesToOrthogonalGeometry(wallAndSpaceMeshes, provisionalBasis);

  return createStoreyBasisFromAxes(
    fallbackPoints,
    worldBounds,
    refinedAxes?.uAxis ?? provisionalBasis.uAxis,
    refinedAxes?.vAxis ?? provisionalBasis.vAxis,
    upAxis
  );
}

/**
 * Strip a uniform scale that web-ifc occasionally bakes into `flatTransformation`
 * when an IFC declares IfcSIUnit=METRE + IfcConversionBasedUnit=FOOT: vertex
 * arrays are already in the project length unit, but web-ifc scales the matrix
 * by 0.3048 anyway, collapsing world coordinates to ~9% of their real size and
 * starving downstream sweep-line clipping of precision. We detect non-unit
 * column magnitudes and undo them (rotation/translation preserved).
 */
function normalizeFlatTransformation(flat: ArrayLike<number>): THREE.Matrix4 {
  const transform = new THREE.Matrix4().fromArray(flat);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  transform.decompose(position, quaternion, scale);

  const scaleIsUnit =
    Math.abs(scale.x - 1) < 1e-3 &&
    Math.abs(scale.y - 1) < 1e-3 &&
    Math.abs(scale.z - 1) < 1e-3;
  if (scaleIsUnit) {
    return transform;
  }

  position.x /= scale.x;
  position.y /= scale.y;
  position.z /= scale.z;
  return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
}

function captureMeshGeometry(
  api: Parameters<typeof withIfcModel>[1] extends (api: infer T, ifcModelId: number) => unknown
    ? T
    : never,
  ifcModelId: number,
  expressId: number,
  kind: string
): MeshCapture {
  const mesh = api.GetFlatMesh(ifcModelId, expressId);
  if (!mesh || typeof mesh.geometries?.size !== "function" || mesh.geometries.size() === 0) {
    throw new Error(`IFC element #${expressId} did not expose any geometry.`);
  }

  const vertices: THREE.Vector3[] = [];
  const triangles: MeshTriangle[] = [];

  for (let geometryIndex = 0; geometryIndex < mesh.geometries.size(); geometryIndex += 1) {
    const placedGeometry = mesh.geometries.get(geometryIndex);
    const geometry = api.GetGeometry(ifcModelId, placedGeometry.geometryExpressID);
    const transform = normalizeFlatTransformation(placedGeometry.flatTransformation);
    const positions = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
    const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());

    for (let index = 0; index < indices.length; index += 3) {
      const trianglePoints: THREE.Vector3[] = [];

      for (let offset = 0; offset < 3; offset += 1) {
        const vertexIndex = indices[index + offset] * 6;
        const point = new THREE.Vector3(
          positions[vertexIndex],
          positions[vertexIndex + 1],
          positions[vertexIndex + 2]
        ).applyMatrix4(transform);
        trianglePoints.push(point);
        vertices.push(point.clone());
      }

      const [a, b, c] = trianglePoints as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      const normal = new THREE.Vector3()
        .subVectors(b, a)
        .cross(new THREE.Vector3().subVectors(c, a));
      const area = normal.length() * 0.5;
      if (area <= AREA_EPSILON) {
        continue;
      }

      triangles.push({
        points: [a.clone(), b.clone(), c.clone()],
        normal: normal.normalize(),
        area
      });
    }

    geometry.delete();
  }

  if (triangles.length === 0 || vertices.length === 0) {
    throw new Error(`IFC element #${expressId} did not yield any triangles.`);
  }

  return {
    kind,
    vertices,
    triangles
  };
}

/**
 * Plan footprint = 2D union of every face's projection (the element's plan
 * silhouette). A union (rather than edge parity over near-horizontal faces)
 * survives faces at several heights projecting onto the same area (stair
 * soffits, both end caps of a riser), T-junctions between separately
 * tessellated coplanar faces, and elements with only sloped faces (a vertical
 * duct transition). Exactly vertical faces project to zero area and are skipped.
 */
function extractPolygonsFromMesh(mesh: MeshCapture, basis: StoreyBasis, expressId: number) {
  const subject: Paths64 = [];
  for (const triangle of mesh.triangles) {
    const path = triangle.points.map((point) => {
      const [u, v] = basis.projectPoint(point);
      return { x: Math.round(u * SNAP_FACTOR), y: Math.round(v * SNAP_FACTOR) };
    });
    const [a, b, c] = path;
    const twiceArea = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (twiceArea === 0) {
      continue;
    }
    // Opposite faces (floor/ceiling, top/bottom of a duct) project with opposite
    // winding and would cancel under NonZero; orient every face the same way.
    subject.push(twiceArea > 0 ? path : path.reverse());
  }
  if (subject.length === 0) {
    throw new Error(`IFC element #${expressId} did not yield any projectable triangles.`);
  }

  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Union, subject, null, tree, FillRule.NonZero);

  const toRing = (path: Paths64[number]): Point2D[] =>
    toOpenRing(path.map((point) => [point.x / SNAP_FACTOR, point.y / SNAP_FACTOR]));
  const polygons: PlanPolygon[] = [];
  const visit = (node: PolyTree64, parentOuter: PlanPolygon | null) => {
    for (let index = 0; index < node.count; index += 1) {
      const child = node.child(index);
      const ring = child.polygon ? toRing(child.polygon) : [];
      if (ring.length < 3 || Math.abs(signedArea(ring)) <= AREA_EPSILON) {
        visit(child, parentOuter);
        continue;
      }
      if (child.isHole) {
        if (parentOuter) {
          parentOuter.holes.push(signedArea(ring) <= 0 ? ring : [...ring].reverse());
        }
        visit(child, parentOuter);
        continue;
      }
      const polygon: PlanPolygon = {
        outer: signedArea(ring) >= 0 ? ring : [...ring].reverse(),
        holes: []
      };
      polygons.push(polygon);
      visit(child, polygon);
    }
  };
  visit(tree, null);

  if (polygons.length === 0) {
    throw new Error(`IFC element #${expressId} did not yield a valid 2D footprint.`);
  }
  return polygons;
}

function buildPlanPrimitive<TKind extends PlanPrimitiveKind>(input: {
  modelId: string;
  globalId: string;
  expressId: number;
  ifcClass: string;
  storeyGlobalId: string;
  kind: TKind;
  polygons: PlanPolygon[];
  presentationCategory: PlanPresentationCategory;
  sourceName: string | null;
  diagnostics?: string[];
}): PlanPrimitive & { kind: TKind } {
  return {
    modelId: input.modelId,
    sourceId: "architecture",
    discipline: "architecture",
    sourceGlobalId: input.globalId,
    globalId: input.globalId,
    compositeGlobalId: input.globalId,
    expressId: input.expressId,
    ifcClass: input.ifcClass,
    storeyGlobalId: input.storeyGlobalId,
    geometryType: "area",
    kind: input.kind,
    polygons: input.polygons,
    bounds: computeBounds(input.polygons),
    presentationCategory: input.presentationCategory,
    sourceName: input.sourceName,
    diagnostics: input.diagnostics ?? []
  };
}

function buildPlanSpace(
  modelId: string,
  storeyGlobalId: string,
  space: SpaceSummary,
  polygons: PlanPolygon[]
): PlanSpace {
  const labelPolygon = selectLargestPolygon(polygons);
  const labelPoint = polylabel(
    [toClosedRing(labelPolygon.outer), ...labelPolygon.holes.map(toClosedRing)],
    0.01
  ) as unknown as Point2D;

  const snappedLabelPoint: Point2D = [snap(labelPoint[0]), snap(labelPoint[1])];
  if (!pointInPolygon(snappedLabelPoint, labelPolygon)) {
    throw new Error(`IfcSpace ${space.globalId} produced an invalid label point.`);
  }

  return {
    ...buildPlanPrimitive({
      modelId,
      globalId: space.globalId,
      expressId: space.expressId,
      ifcClass: "IFCSPACE",
      storeyGlobalId,
      kind: "space",
      polygons,
      presentationCategory: "building",
      sourceName: space.longName ?? space.name,
      diagnostics: []
    }),
    label: space.longName ?? space.name,
    secondaryLabel: space.longName ? space.name : null,
    area: space.area,
    labelPoint: snappedLabelPoint
  };
}

function buildDoorOpeningMap(
  api: Parameters<typeof withIfcModel>[1] extends (api: infer T, ifcModelId: number) => unknown
    ? T
    : never,
  ifcModelId: number
) {
  const doorOpeningByDoorExpressId = new Map<number, number>();
  const relationIds = vectorToArray(
    api.GetLineIDsWithType(ifcModelId, IFCRELFILLSELEMENT, true)
  );

  for (const relationId of relationIds) {
    const relation = api.GetLine(ifcModelId, relationId);
    const doorExpressId = relation.RelatedBuildingElement?.value;
    const openingExpressId = relation.RelatingOpeningElement?.value;
    if (doorExpressId && openingExpressId) {
      doorOpeningByDoorExpressId.set(doorExpressId, openingExpressId);
    }
  }

  return doorOpeningByDoorExpressId;
}

function createStoreyBasisFromPlanStorey(storey: PlanStorey): StoreyBasis {
  const origin = new THREE.Vector3(...storey.origin3D);
  const uAxis = new THREE.Vector3(...storey.uAxis3D).normalize();
  const vAxis = new THREE.Vector3(...storey.vAxis3D).normalize();
  const upAxis = new THREE.Vector3(...storey.upAxis3D).normalize();

  return {
    origin,
    uAxis,
    vAxis,
    upAxis,
    worldBounds3D: storey.worldBounds3D,
    localBounds: storey.bounds,
    projectPoint(point) {
      const relative = point.clone().sub(origin);
      return [snap(relative.dot(uAxis)), snap(relative.dot(vAxis))];
    }
  };
}

function normalizeStoreyName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function storeyMatchKey(name: string, elevation: number | null) {
  return `${normalizeStoreyName(name)}|${snap(elevation ?? 0)}`;
}

function centroidOfPoints(points: Point2D[]) {
  if (points.length === 0) {
    return [0, 0] as Point2D;
  }

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  return [snap(sumX / points.length), snap(sumY / points.length)] as Point2D;
}

function principalAxisFromPoints(points: Point2D[]) {
  if (points.length < 2) {
    return {
      center: centroidOfPoints(points),
      axis: [1, 0] as Point2D,
      minProjection: 0,
      maxProjection: 0,
      halfWidth: 0
    };
  }

  const center = centroidOfPoints(points);
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [x, y] of points) {
    const dx = x - center[0];
    const dy = y - center[1];
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }

  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const eigenValue =
    trace / 2 + Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
  const eigenvector =
    Math.abs(xy) > AREA_EPSILON
      ? new THREE.Vector2(eigenValue - yy, xy)
      : xx >= yy
        ? new THREE.Vector2(1, 0)
        : new THREE.Vector2(0, 1);
  const axis = eigenvector.normalize();
  const orthogonal = new THREE.Vector2(-axis.y, axis.x);

  let minProjection = Infinity;
  let maxProjection = -Infinity;
  let maxOffset = 0;
  for (const [x, y] of points) {
    const dx = x - center[0];
    const dy = y - center[1];
    const along = dx * axis.x + dy * axis.y;
    const across = dx * orthogonal.x + dy * orthogonal.y;
    minProjection = Math.min(minProjection, along);
    maxProjection = Math.max(maxProjection, along);
    maxOffset = Math.max(maxOffset, Math.abs(across));
  }

  return {
    center,
    axis: [snap(axis.x), snap(axis.y)] as Point2D,
    minProjection: snap(minProjection),
    maxProjection: snap(maxProjection),
    halfWidth: snap(maxOffset)
  };
}

export type ConnectionCandidate = {
  elementRef: string;
  kind: MechanicalVisualItem["kind"];
  airflowType: AirflowType;
  /** World-space AABB of the element mesh, in the project length unit. */
  min: [number, number, number];
  max: [number, number, number];
  /** Plan-space footprint bounds. */
  bounds2D: Bounds2D;
  /** Centerline end points (segments only). */
  ends: Point2D[] | null;
  halfWidth: number;
};

function distancePointToBounds(point: Point2D, bounds: Bounds2D) {
  const dx = Math.max(bounds.min[0] - point[0], 0, point[0] - bounds.max[0]);
  const dy = Math.max(bounds.min[1] - point[1], 0, point[1] - bounds.max[1]);
  return Math.hypot(dx, dy);
}

function endZoneTouches(segment: ConnectionCandidate, other: ConnectionCandidate, tolerance: number) {
  const reach = tolerance + segment.halfWidth;
  return (segment.ends ?? []).some((end) => distancePointToBounds(end, other.bounds2D) <= reach);
}

/**
 * Infer duct connectivity from geometry for exports that carry no
 * IfcRelConnectsPorts (Revit MEP ≤ 2011). Two items connect when their 3D
 * bounding boxes come within `tolerance`; two segments must additionally meet
 * at an end of one of them (parallel runs touching along their length do not).
 * Items whose air systems are both known and different never connect.
 */
export function inferGeometricConnections(
  candidates: ReadonlyArray<ConnectionCandidate>,
  tolerance: number
): Map<string, Set<string>> {
  const connections = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    (connections.get(a) ?? connections.set(a, new Set()).get(a)!).add(b);
    (connections.get(b) ?? connections.set(b, new Set()).get(b)!).add(a);
  };
  const sorted = [...candidates].sort((left, right) => left.min[0] - right.min[0]);

  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j];
      if (b.min[0] > a.max[0] + tolerance) {
        break;
      }
      const boxesTouch =
        b.min[1] <= a.max[1] + tolerance &&
        a.min[1] <= b.max[1] + tolerance &&
        b.min[2] <= a.max[2] + tolerance &&
        a.min[2] <= b.max[2] + tolerance;
      if (!boxesTouch) {
        continue;
      }
      if (a.airflowType !== "unknown" && b.airflowType !== "unknown" && a.airflowType !== b.airflowType) {
        continue;
      }
      // Takeoffs and duct-mounted terminals attach along a run. Two segments
      // must meet at an end of at least one of them: a curved flex duct's
      // principal-axis ends are not its true ends, so the rigid side decides.
      const bothSegments = a.kind === "mech-segment" && b.kind === "mech-segment";
      if (bothSegments && !(endZoneTouches(a, b, tolerance) || endZoneTouches(b, a, tolerance))) {
        continue;
      }
      connect(a.elementRef, b.elementRef);
    }
  }
  return connections;
}

export type MechanicalPlanLayers = {
  visualItems: MechanicalVisualItem[];
  editItems: MechanicalEditItem[];
};

export async function extractIfcMechanicalPlanLayers(
  bytes: Uint8Array,
  modelId: string,
  sourceId: string,
  anchorStoreys: PlanStorey[],
  airflowBySourceGlobalId: ReadonlyMap<string, AirflowType> = new Map(),
  /** Elements on declared non-air systems (pipes, sprinklers, electrical). */
  excludedSourceGlobalIds: ReadonlySet<string> = new Set()
): Promise<Map<string, MechanicalPlanLayers>> {
  return withIfcModel(bytes, async (api, ifcModelId) => {
    const context = extractIfcMetadata(api, ifcModelId, modelId);
    const placementCache = new Map<number, [number, number, number] | null>();
    const anchorStoreyByKey = new Map(
      anchorStoreys.map((storey) => [storeyMatchKey(storey.name, storey.elevation), storey])
    );
    const basisByStoreyId = new Map(
      anchorStoreys.map((storey) => [storey.globalId, createStoreyBasisFromPlanStorey(storey)])
    );

    const resolvePlacement = (
      placementExpressId: number | null | undefined
    ): [number, number, number] | null => {
      if (!placementExpressId) {
        return null;
      }
      if (placementCache.has(placementExpressId)) {
        return placementCache.get(placementExpressId) ?? null;
      }

      const placement = api.GetLine(ifcModelId, placementExpressId);
      if (!placement) {
        placementCache.set(placementExpressId, null);
        return null;
      }

      const parentPoint =
        placement.PlacementRelTo?.value
          ? resolvePlacement(placement.PlacementRelTo.value)
          : ([0, 0, 0] as [number, number, number]);
      const location = placement.RelativePlacement?.Location?.Coordinates ?? [];
      const point: [number, number, number] = [
        (parentPoint?.[0] ?? 0) + Number(location[0]?._representationValue ?? location[0]?.value ?? 0),
        (parentPoint?.[1] ?? 0) + Number(location[1]?._representationValue ?? location[1]?.value ?? 0),
        (parentPoint?.[2] ?? 0) + Number(location[2]?._representationValue ?? location[2]?.value ?? 0)
      ];
      placementCache.set(placementExpressId, point);
      return point;
    };

    const resolveStoreyExpressId = (expressId: number) =>
      resolveContainingStoreyExpressId(context, expressId);

    const matchedAnchorStoreyByMechanicalExpressId = new Map<number, PlanStorey>();
    for (const storey of context.storeys) {
      const anchorStorey = anchorStoreyByKey.get(storeyMatchKey(storey.name, storey.elevation));
      if (!anchorStorey) {
        throw new Error(`Mechanical storey ${storey.name} could not be aligned to the architectural anchor.`);
      }

      matchedAnchorStoreyByMechanicalExpressId.set(storey.expressId, anchorStorey);
    }

    // Elevation bands [elevation_i, elevation_{i+1}) of the *occupied* storeys
    // (those with rooms). Datum levels such as "Roof" or "Parapet" do not
    // start a band, so ceiling-void and rooftop ductwork stays with the level
    // it serves. Available only when every occupied storey has an elevation.
    const occupiedStoreys = anchorStoreys.filter((storey) => storey.architecture.spaces.length > 0);
    const storeyBands = occupiedStoreys.every((storey) => storey.elevation !== null)
      ? [...occupiedStoreys]
          .sort((left, right) => (left.elevation ?? 0) - (right.elevation ?? 0))
          .map((storey) => ({ elevation: storey.elevation ?? 0, anchor: storey }))
      : [];
    const storeyByElevationBand = (up: number): PlanStorey | null => {
      if (storeyBands.length === 0) {
        return null;
      }
      let match = storeyBands[0];
      for (const band of storeyBands) {
        if (up >= band.elevation) {
          match = band;
        }
      }
      return match.anchor;
    };
    const centroidUp = (mesh: MeshCapture) => {
      let min = Infinity;
      let max = -Infinity;
      for (const vertex of mesh.vertices) {
        min = Math.min(min, vertex.y);
        max = Math.max(max, vertex.y);
      }
      return (min + max) / 2;
    };

    const layersByStoreyId = new Map<string, MechanicalPlanLayers>();
    const connectionCandidates: ConnectionCandidate[] = [];
    const getStoreyLayers = (storeyGlobalId: string) => {
      const current = layersByStoreyId.get(storeyGlobalId);
      if (current) {
        return current;
      }

      const created: MechanicalPlanLayers = {
        visualItems: [],
        editItems: []
      };
      layersByStoreyId.set(storeyGlobalId, created);
      return created;
    };

    for (const target of MECHANICAL_TARGETS) {
      const expressIds = vectorToArray(api.GetLineIDsWithType(ifcModelId, target.type, true));

      for (const expressId of expressIds) {
        const line = api.GetLine(ifcModelId, expressId);
        const sourceGlobalId = toText(line.GlobalId) ?? String(expressId);
        if (excludedSourceGlobalIds.has(sourceGlobalId)) {
          continue;
        }
        const compositeGlobalId = `${sourceId}:${sourceGlobalId}`;
        const airflowType = airflowBySourceGlobalId.get(sourceGlobalId) ?? "unknown";
        const storeyExpressId = resolveStoreyExpressId(expressId);
        const containmentStorey = storeyExpressId
          ? matchedAnchorStoreyByMechanicalExpressId.get(storeyExpressId) ?? null
          : null;
        const mesh = captureMeshGeometry(api, ifcModelId, expressId, target.kind);
        const diagnostics: string[] = [];
        // Ductwork belongs to the storey whose elevation band it occupies. Revit
        // files the element under its reference level / containing room, which
        // for rooftop or ceiling-void runs can be a different storey.
        const elevationStorey = storeyByElevationBand(centroidUp(mesh));
        const anchorStorey = elevationStorey ?? containmentStorey;
        if (!anchorStorey) {
          throw new Error(`${api.GetNameFromTypeCode(line.type)} ${sourceGlobalId} is missing an aligned architectural storey.`);
        }
        if (containmentStorey && anchorStorey.globalId !== containmentStorey.globalId) {
          diagnostics.push(
            `storey assigned by elevation: ${anchorStorey.name} (IFC containment says ${containmentStorey.name})`
          );
        }

        const basis = basisByStoreyId.get(anchorStorey.globalId);
        if (!basis) {
          throw new Error(`Architectural plan basis for ${anchorStorey.name} was not available.`);
        }

        const projectedPoints = mesh.vertices.map((point) => basis.projectPoint(point));
        const placement = resolvePlacement(line.ObjectPlacement?.value);
        const placementPoint = placement
          ? basis.projectPoint(new THREE.Vector3(...placement))
          : null;
        const storeyLayers = getStoreyLayers(anchorStorey.globalId);
        const principalAxis = principalAxisFromPoints(projectedPoints);
        const rotation = snap(Math.atan2(principalAxis.axis[1], principalAxis.axis[0]));
        const anchor = placementPoint ?? principalAxis.center;
        const visualItemId = `${compositeGlobalId}:visual`;

        const polygons = extractPolygonsFromMesh(mesh, basis, expressId);
        const polygonBounds = computeBounds(polygons);
        const candidate: ConnectionCandidate = {
          elementRef: compositeGlobalId,
          kind: target.kind,
          airflowType,
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
          bounds2D: polygonBounds,
          ends: null,
          halfWidth: 0
        };
        for (const vertex of mesh.vertices) {
          candidate.min = [
            Math.min(candidate.min[0], vertex.x),
            Math.min(candidate.min[1], vertex.y),
            Math.min(candidate.min[2], vertex.z)
          ];
          candidate.max = [
            Math.max(candidate.max[0], vertex.x),
            Math.max(candidate.max[1], vertex.y),
            Math.max(candidate.max[2], vertex.z)
          ];
        }
        connectionCandidates.push(candidate);

        storeyLayers.visualItems.push({
          modelId,
          sourceId,
          discipline: "mechanical",
          sourceGlobalId,
          globalId: visualItemId,
          compositeGlobalId,
          backingElementId: compositeGlobalId,
          expressId,
          ifcClass: api.GetNameFromTypeCode(line.type),
          storeyGlobalId: anchorStorey.globalId,
          geometryType: "visual",
          kind: target.kind,
          polygons,
          bounds: polygonBounds,
          presentationCategory: "building",
          airflowType,
          sourceName: toText(line.Name) ?? toText(line.LongName),
          diagnostics,
          anchor,
          rotation,
          connectedItemIds: []
        });

        if (target.kind === "mech-segment") {
          const start: Point2D = [
            snap(principalAxis.center[0] + principalAxis.axis[0] * principalAxis.minProjection),
            snap(principalAxis.center[1] + principalAxis.axis[1] * principalAxis.minProjection)
          ];
          const end: Point2D = [
            snap(principalAxis.center[0] + principalAxis.axis[0] * principalAxis.maxProjection),
            snap(principalAxis.center[1] + principalAxis.axis[1] * principalAxis.maxProjection)
          ];

          candidate.ends = [start, end];
          candidate.halfWidth = principalAxis.halfWidth;
          const editItem: MechanicalEditEdgeItem = {
            id: `${compositeGlobalId}:edit`,
            visualRef: visualItemId,
            elementRef: compositeGlobalId,
            editKind: "edge",
            kind: "mech-segment",
            path: [start, end],
            width: principalAxis.halfWidth > 0 ? snap(principalAxis.halfWidth * 2) : null,
            airflowType,
            connectedItemIds: []
          };
          storeyLayers.editItems.push(editItem);
          continue;
        }

        const size: Point2D = [
          snap(polygonBounds.max[0] - polygonBounds.min[0]),
          snap(polygonBounds.max[1] - polygonBounds.min[1])
        ];
        const editItem: MechanicalEditNodeItem = {
          id: `${compositeGlobalId}:edit`,
          visualRef: visualItemId,
          elementRef: compositeGlobalId,
          editKind: "node",
          kind: target.kind as MechanicalEditNodeItem["kind"],
          position: principalAxis.center,
          size,
          rotation,
          airflowType,
          connectedItemIds: [],
          // CFM target + room ownership are resolved later, once loads exist
          // (see assignTerminalCfm in attachLoadsToStoreys).
          spaceGlobalId: null,
          spaceDesignCfm: null,
          requiredCfm: null
        };
        storeyLayers.editItems.push(editItem);
      }
    }

    const hasPortRelations =
      api.GetLineIDsWithType(ifcModelId, IFCRELCONNECTSPORTS, false).size() > 0;
    if (!hasPortRelations) {
      // Whole-model inference: risers and mis-levelled fittings join items on
      // neighbouring storeys.
      const tolerance = GEOMETRIC_CONNECTION_TOLERANCE_M / metresPerLengthUnit(context.lengthUnit);
      const connections = inferGeometricConnections(connectionCandidates, tolerance);
      for (const layers of layersByStoreyId.values()) {
        for (const item of layers.visualItems) {
          item.connectedItemIds = [...(connections.get(item.backingElementId) ?? [])].sort();
          item.diagnostics.push(GEOMETRIC_CONNECTION_DIAGNOSTIC);
        }
        for (const item of layers.editItems) {
          item.connectedItemIds = [...(connections.get(item.elementRef) ?? [])].sort();
        }
      }
    }

    return layersByStoreyId;
  });
}

function mapStoreys(storeys: StoreySummary[]) {
  return new Map(storeys.map((storey) => [storey.globalId, storey]));
}

function mapSpacesByExpressId(spaces: SpaceSummary[]) {
  return new Map(spaces.map((space) => [space.expressId, space]));
}


export async function extractIfcPlanModel(
  bytes: Uint8Array,
  modelId: string
): Promise<PlanModel> {
  return withIfcModel(bytes, async (api, ifcModelId) => {
    const context = extractIfcMetadata(api, ifcModelId, modelId);
    const storeyByGlobalId = mapStoreys(context.storeys);
    const spaceByExpressId = mapSpacesByExpressId(context.spaces);
    const inputsByStoreyId = new Map<string, StoreyPlanInputs>();
    const doorOpeningByDoorExpressId = buildDoorOpeningMap(api, ifcModelId);
    const placementCache = new Map<number, [number, number, number] | null>();

    const getStoreyInputs = (storeyGlobalId: string) => {
      const current = inputsByStoreyId.get(storeyGlobalId);
      if (current) {
        return current;
      }

      const created: StoreyPlanInputs = {
        primitiveInputs: [],
        spaceInputs: []
      };
      inputsByStoreyId.set(storeyGlobalId, created);
      return created;
    };

    const resolvePlacement = (
      placementExpressId: number | null | undefined
    ): [number, number, number] | null => {
      if (!placementExpressId) {
        return null;
      }
      if (placementCache.has(placementExpressId)) {
        return placementCache.get(placementExpressId) ?? null;
      }

      const placement = api.GetLine(ifcModelId, placementExpressId);
      if (!placement) {
        placementCache.set(placementExpressId, null);
        return null;
      }

      const parentPoint =
        placement.PlacementRelTo?.value
          ? resolvePlacement(placement.PlacementRelTo.value)
          : ([0, 0, 0] as [number, number, number]);
      const coordinates = placement.RelativePlacement?.Location?.Coordinates ?? [];
      const point: [number, number, number] = [
        (parentPoint?.[0] ?? 0) + Number(coordinates[0]?._representationValue ?? coordinates[0]?.value ?? 0),
        (parentPoint?.[1] ?? 0) + Number(coordinates[1]?._representationValue ?? coordinates[1]?.value ?? 0),
        (parentPoint?.[2] ?? 0) + Number(coordinates[2]?._representationValue ?? coordinates[2]?.value ?? 0)
      ];
      placementCache.set(placementExpressId, point);
      return point;
    };

    const resolveStoreyExpressId = (expressId: number) => {
      const contained = resolveContainingStoreyExpressId(context, expressId);
      if (contained) {
        return { storeyExpressId: contained, diagnostic: null };
      }

      const line = api.GetLine(ifcModelId, expressId);
      const placement = resolvePlacement(line.ObjectPlacement?.value);
      if (!placement) {
        return { storeyExpressId: null, diagnostic: null };
      }

      const closestStorey = context.storeys.reduce<StoreySummary | null>((best, storey) => {
        const storeyPlacement = storey.placement ?? null;
        if (!storeyPlacement && storey.elevation === null) {
          return best;
        }
        if (!best) {
          return storey;
        }

        if (storeyPlacement && best.placement) {
          const distance = Math.hypot(
            placement[0] - storeyPlacement[0],
            placement[1] - storeyPlacement[1],
            placement[2] - storeyPlacement[2]
          );
          const bestDistance = Math.hypot(
            placement[0] - best.placement[0],
            placement[1] - best.placement[1],
            placement[2] - best.placement[2]
          );
          return distance < bestDistance ? storey : best;
        }

        const storeyElevation = storey.elevation ?? storeyPlacement?.[2] ?? 0;
        const bestElevation = best.elevation ?? best.placement?.[2] ?? 0;
        return Math.abs(storeyElevation - placement[2]) < Math.abs(bestElevation - placement[2]) ? storey : best;
      }, null);

      return closestStorey
        ? {
            storeyExpressId: closestStorey.expressId,
            diagnostic: "Derived storey assignment from element placement because IFC spatial relationships were missing."
          }
        : { storeyExpressId: null, diagnostic: null };
    };

    for (const target of EXTRACTION_TARGETS) {
      const expressIds = vectorToArray(api.GetLineIDsWithType(ifcModelId, target.type, true));

      for (const expressId of expressIds) {
        const line = api.GetLine(ifcModelId, expressId);
        const globalId = toText(line.GlobalId) ?? String(expressId);
        const storeyResolution = resolveStoreyExpressId(expressId);
        const storeyExpressId = storeyResolution.storeyExpressId;
        if (!storeyExpressId) {
          throw new Error(
            `${api.GetNameFromTypeCode(line.type)} ${globalId} is missing a storey assignment.`
          );
        }

        const storeyGlobalId = context.globalIdByExpressId.get(storeyExpressId);
        if (!storeyGlobalId || !storeyByGlobalId.has(storeyGlobalId)) {
          throw new Error(
            `${api.GetNameFromTypeCode(line.type)} ${globalId} resolved to an unknown storey.`
          );
        }

        const diagnostics = storeyResolution.diagnostic ? [storeyResolution.diagnostic] : [];
        let geometryExpressId = expressId;
        if (target.kind === "door-opening") {
          const openingExpressId = doorOpeningByDoorExpressId.get(expressId) ?? null;
          if (openingExpressId) {
            geometryExpressId = openingExpressId;
          } else {
            diagnostics.push("Derived from IfcDoor geometry because no IfcRelFillsElement was present.");
          }
        }

        const mesh = captureMeshGeometry(api, ifcModelId, geometryExpressId, target.kind);
        getStoreyInputs(storeyGlobalId).primitiveInputs.push({
          mesh,
          globalId,
          expressId,
          ifcClass: api.GetNameFromTypeCode(line.type),
          storeyGlobalId,
          kind: target.kind,
          sourceName: toText(line.Name) ?? toText(line.LongName),
          diagnostics
        });
      }
    }

    const spaceIds = vectorToArray(api.GetLineIDsWithType(ifcModelId, IFCSPACE, true));
    for (const expressId of spaceIds) {
      const space = spaceByExpressId.get(expressId) ?? null;
      if (!space?.storeyGlobalId) {
        throw new Error(`IfcSpace #${expressId} is missing a storey assignment.`);
      }
      if (!storeyByGlobalId.has(space.storeyGlobalId)) {
        throw new Error(`IfcSpace ${space.globalId} resolved to an unknown storey.`);
      }

      const mesh = captureMeshGeometry(api, ifcModelId, expressId, "space");
      getStoreyInputs(space.storeyGlobalId).spaceInputs.push({
        mesh,
        storeyGlobalId: space.storeyGlobalId,
        space
      });
    }

    const storeys: PlanStorey[] = context.storeys.map((storey) => {
      const inputs = inputsByStoreyId.get(storey.globalId) ?? {
        primitiveInputs: [],
        spaceInputs: []
      };
      const basisMeshes = [
        ...inputs.primitiveInputs
          .filter((input) => input.kind === "wall" || input.kind === "column")
          .map((input) => input.mesh),
        ...inputs.spaceInputs.map((input) => input.mesh)
      ];
      const basis = createStoreyBasis(storey, basisMeshes);

      const rawPrimitives = inputs.primitiveInputs.flatMap((input) => {
        let polygons: PlanPolygon[];
        try {
          polygons = extractPolygonsFromMesh(input.mesh, basis, input.expressId);
        } catch (err) {
          // Skip primitives whose mesh can't be projected to a 2D footprint
          // (e.g. faceted-brep walls without horizontal caps, degenerate
          // clipping artifacts). Loads depend on spaces, not primitives — a
          // missing wall polygon is a visual artifact, not a correctness bug.
          console.warn(
            `[plan] skipping primitive #${input.expressId} (${input.ifcClass}): ${(err as Error).message}`
          );
          return [];
        }
        return [
          buildPlanPrimitive({
            modelId,
            globalId: input.globalId,
            expressId: input.expressId,
            ifcClass: input.ifcClass,
            storeyGlobalId: input.storeyGlobalId,
            kind: input.kind,
            polygons,
            presentationCategory: "building",
            sourceName: input.sourceName,
            diagnostics: input.diagnostics
          })
        ];
      }).sort((left, right) => left.globalId.localeCompare(right.globalId));

      const spaces = inputs.spaceInputs.map((input) =>
        buildPlanSpace(
          modelId,
          input.storeyGlobalId,
          input.space,
          extractPolygonsFromMesh(input.mesh, basis, input.space.expressId)
        )
      ).sort((left, right) => left.globalId.localeCompare(right.globalId));

      const contextBounds = [
        ...rawPrimitives.map((primitive) => primitive.bounds),
        ...spaces.map((space) => space.bounds)
      ];
      const bounds =
        contextBounds.length > 0
          ? mergePlanBounds(contextBounds)
          : basis.localBounds;
      const primitives = rawPrimitives;
      const focusBoundsCandidates = [
        ...spaces.map((space) => space.bounds),
        ...primitives
          .filter((primitive) => primitive.presentationCategory === "building")
          .map((primitive) => primitive.bounds)
      ];
      const focusBounds =
        focusBoundsCandidates.length > 0
          ? mergePlanBounds(focusBoundsCandidates)
          : bounds;

      return {
        modelId,
        planVersion: CURRENT_PLAN_VERSION,
        globalId: storey.globalId,
        name: storey.name,
        longName: storey.longName,
        elevation: storey.elevation,
        sortOrder: storey.sortOrder,
        units: context.lengthUnit,
        origin3D: toPoint3D(basis.origin),
        uAxis3D: toPoint3D(basis.uAxis),
        vAxis3D: toPoint3D(basis.vAxis),
        upAxis3D: toPoint3D(basis.upAxis),
        worldBounds3D: basis.worldBounds3D,
        bounds,
        contextBounds: bounds,
        focusBounds,
        architecture: {
          primitives,
          spaces
        },
        mechanicalVisual2D: [],
        mechanicalEdit2D: [],
        loads: {
          modelId,
          storeyGlobalId: storey.globalId,
          planVersion: CURRENT_PLAN_VERSION,
          spaces: [],
          totals: {
            designCfm: 0,
            ventilationCfm: 0,
            sensibleLoadBtuH: 0,
            envelopeBtuH: 0,
            solarBtuH: 0,
            spaceCount: 0
          },
          climate: null
        }
      };
    });

    if (storeys.every((storey) => storey.architecture.spaces.length === 0)) {
      throw new Error("The IFC model did not produce any IfcSpace polygons.");
    }

    return {
      modelId,
      planVersion: CURRENT_PLAN_VERSION,
      schema: context.schema,
      storeys
    };
  });
}
