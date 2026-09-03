import * as THREE from "three";
import {
  IFCCURTAINWALL,
  IFCPLATE,
  IFCSPACE,
  IFCWALLSTANDARDCASE,
  IFCWINDOW,
  type IfcAPI
} from "web-ifc";

import type { SpaceBoundary } from "../types";
import type { IfcMetadataContext } from "./ifc-helpers";
import { vectorToArray } from "./ifc-helpers";

const SQ_METERS_TO_SQ_FEET = 10.7639;
const AREA_EPSILON = 1e-9;
const VERTICAL_NZ_MAX = 0.35;
const ASSIGNMENT_MAX_DISTANCE_FT = 30;

const GEOMETRIC_ENVELOPE_TYPES = [
  IFCWALLSTANDARDCASE,
  IFCCURTAINWALL,
  IFCWINDOW,
  IFCPLATE
];

function areaUnitFactor(lengthUnit: string): number {
  const unit = lengthUnit.toLowerCase();
  if (unit === "foot" || unit === "feet" || unit === "ft") {
    return 1;
  }
  if (unit === "metre" || unit === "meter" || unit === "m") {
    return SQ_METERS_TO_SQ_FEET;
  }
  return 1;
}

function normalizeFlatTransformation(flat: ArrayLike<number>): THREE.Matrix4 {
  const transform = new THREE.Matrix4().fromArray(Array.from(flat));
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

type Bounds = {
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
};

type SpaceEnvelopeTarget = {
  globalId: string;
  storeyGlobalId: string;
  bounds: Bounds;
};

type VerticalTriangle = {
  elementExpressId: number;
  elementGlobalId: string;
  storeyGlobalId: string;
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  areaSqft: number;
};

function expandBounds(bounds: Bounds, point: THREE.Vector3): void {
  bounds.min.min(point);
  bounds.max.max(point);
  bounds.center.add(point);
}

function finalizeBounds(bounds: Bounds, count: number): Bounds {
  return {
    min: bounds.min,
    max: bounds.max,
    center: bounds.center.divideScalar(count)
  };
}

function captureElementPoints(
  api: IfcAPI,
  ifcModelId: number,
  expressId: number
): THREE.Vector3[] {
  const mesh = api.GetFlatMesh(ifcModelId, expressId);
  if (!mesh || typeof mesh.geometries?.size !== "function" || mesh.geometries.size() === 0) {
    return [];
  }

  const points: THREE.Vector3[] = [];
  for (let geometryIndex = 0; geometryIndex < mesh.geometries.size(); geometryIndex += 1) {
    const placed = mesh.geometries.get(geometryIndex);
    const geometry = api.GetGeometry(ifcModelId, placed.geometryExpressID);
    const transform = normalizeFlatTransformation(placed.flatTransformation);
    const positions = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
    const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());

    for (let index = 0; index < indices.length; index += 1) {
      const vertexIndex = indices[index] * 6;
      points.push(
        new THREE.Vector3(
          positions[vertexIndex],
          positions[vertexIndex + 1],
          positions[vertexIndex + 2]
        ).applyMatrix4(transform)
      );
    }

    geometry.delete();
  }

  return points;
}

function extractSpaceTargets(
  api: IfcAPI,
  ifcModelId: number,
  context: IfcMetadataContext
): SpaceEnvelopeTarget[] {
  const targets: SpaceEnvelopeTarget[] = [];

  for (const spaceId of vectorToArray(api.GetLineIDsWithType(ifcModelId, IFCSPACE, true))) {
    const spaceGlobalId = context.globalIdByExpressId.get(spaceId);
    const space = context.spaces.find((candidate) => candidate.globalId === spaceGlobalId);
    if (!spaceGlobalId || !space?.storeyGlobalId) {
      continue;
    }

    const points = captureElementPoints(api, ifcModelId, spaceId);
    if (points.length === 0) {
      continue;
    }

    const seed = {
      min: points[0].clone(),
      max: points[0].clone(),
      center: new THREE.Vector3()
    };
    for (const point of points) {
      expandBounds(seed, point);
    }

    targets.push({
      globalId: spaceGlobalId,
      storeyGlobalId: space.storeyGlobalId,
      bounds: finalizeBounds(seed, points.length)
    });
  }

  return targets;
}

function captureVerticalEnvelopeTriangles(input: {
  api: IfcAPI;
  ifcModelId: number;
  expressId: number;
  elementGlobalId: string;
  storeyGlobalId: string;
  areaFactor: number;
}): VerticalTriangle[] {
  const { api, ifcModelId, expressId, elementGlobalId, storeyGlobalId, areaFactor } = input;
  const mesh = api.GetFlatMesh(ifcModelId, expressId);
  if (!mesh || typeof mesh.geometries?.size !== "function" || mesh.geometries.size() === 0) {
    return [];
  }

  const triangles: VerticalTriangle[] = [];
  for (let geometryIndex = 0; geometryIndex < mesh.geometries.size(); geometryIndex += 1) {
    const placed = mesh.geometries.get(geometryIndex);
    const geometry = api.GetGeometry(ifcModelId, placed.geometryExpressID);
    const transform = normalizeFlatTransformation(placed.flatTransformation);
    const positions = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
    const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());

    for (let index = 0; index < indices.length; index += 3) {
      const points: THREE.Vector3[] = [];
      for (let offset = 0; offset < 3; offset += 1) {
        const vertexIndex = indices[index + offset] * 6;
        points.push(
          new THREE.Vector3(
            positions[vertexIndex],
            positions[vertexIndex + 1],
            positions[vertexIndex + 2]
          ).applyMatrix4(transform)
        );
      }

      const [a, b, c] = points as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      const normal = new THREE.Vector3()
        .subVectors(b, a)
        .cross(new THREE.Vector3().subVectors(c, a));
      const area = normal.length() * 0.5;
      if (area <= AREA_EPSILON) {
        continue;
      }
      normal.normalize();
      if (Math.abs(normal.z) >= VERTICAL_NZ_MAX) {
        continue;
      }

      triangles.push({
        elementExpressId: expressId,
        elementGlobalId,
        storeyGlobalId,
        centroid: a.clone().add(b).add(c).divideScalar(3),
        normal,
        // Meshes include front and back faces. Halving each face makes the
        // summed facade area match the physical one while preserving orientation.
        areaSqft: area * areaFactor * 0.5
      });
    }

    geometry.delete();
  }

  return triangles;
}

function distanceToSpace(point: THREE.Vector3, target: SpaceEnvelopeTarget): number {
  const { min, max } = target.bounds;
  const dx = Math.max(min.x - point.x, 0, point.x - max.x);
  const dy = Math.max(min.y - point.y, 0, point.y - max.y);
  const dz = Math.max(min.z - point.z, 0, point.z - max.z);
  return Math.hypot(dx, dy) + dz * 4;
}

function assignTriangleToSpace(
  triangle: VerticalTriangle,
  targets: SpaceEnvelopeTarget[]
): SpaceEnvelopeTarget | null {
  let best: { target: SpaceEnvelopeTarget; distance: number } | null = null;
  for (const target of targets) {
    if (target.storeyGlobalId !== triangle.storeyGlobalId) {
      continue;
    }

    const distance = distanceToSpace(triangle.centroid, target);
    if (!best || distance < best.distance) {
      best = { target, distance };
    }
  }

  return best && best.distance <= ASSIGNMENT_MAX_DISTANCE_FT ? best.target : null;
}

function orientationAwayFromSpace(
  triangle: VerticalTriangle,
  target: SpaceEnvelopeTarget
): number {
  const outward = triangle.normal.clone();
  const fromSpace = triangle.centroid.clone().sub(target.bounds.center);
  if (outward.dot(fromSpace) < 0) {
    outward.multiplyScalar(-1);
  }
  return (Math.atan2(outward.x, outward.y) * (180 / Math.PI) + 360) % 360;
}

function orientationBucket(degrees: number): number {
  return Math.round(degrees / 45) * 45 % 360;
}

function geometricExpressIds(api: IfcAPI, ifcModelId: number): Set<number> {
  const ids = new Set<number>();
  for (const type of GEOMETRIC_ENVELOPE_TYPES) {
    for (const id of vectorToArray(api.GetLineIDsWithType(ifcModelId, type, false))) {
      ids.add(id);
    }
  }
  return ids;
}

export function extractGeometricEnvelopeBoundaries(input: {
  api: IfcAPI;
  ifcModelId: number;
  modelId: string;
  context: IfcMetadataContext;
  elementGlobalIdByExpressId: Map<number, string>;
  storeyGlobalIdByElementExpressId: Map<number, string | null>;
  lengthUnit: string;
}): SpaceBoundary[] {
  const {
    api,
    ifcModelId,
    modelId,
    context,
    elementGlobalIdByExpressId,
    storeyGlobalIdByElementExpressId,
    lengthUnit
  } = input;
  const targets = extractSpaceTargets(api, ifcModelId, context);
  if (targets.length === 0) {
    return [];
  }

  // Storeys with no IfcSpace (foundation walls, roof-level parapets) have no
  // conditioned envelope to recover; their walls are not assignment candidates.
  const storeysWithTargets = new Set(targets.map((target) => target.storeyGlobalId));
  const areaFactor = areaUnitFactor(lengthUnit);
  const aggregate = new Map<string, SpaceBoundary>();
  let recoveredAreaSqft = 0;
  let unassignedAreaSqft = 0;
  const unassignedByStorey = new Map<string, { areaSqft: number; targets: number; nearestFt: number }>();

  for (const expressId of geometricExpressIds(api, ifcModelId)) {
    const elementGlobalId = elementGlobalIdByExpressId.get(expressId);
    const storeyGlobalId = storeyGlobalIdByElementExpressId.get(expressId) ?? null;
    if (!elementGlobalId || !storeyGlobalId || !storeysWithTargets.has(storeyGlobalId)) {
      continue;
    }

    const triangles = captureVerticalEnvelopeTriangles({
      api,
      ifcModelId,
      expressId,
      elementGlobalId,
      storeyGlobalId,
      areaFactor
    });

    for (const triangle of triangles) {
      recoveredAreaSqft += triangle.areaSqft;
      const target = assignTriangleToSpace(triangle, targets);
      if (!target) {
        unassignedAreaSqft += triangle.areaSqft;
        const sameStorey = targets.filter((t) => t.storeyGlobalId === triangle.storeyGlobalId);
        const nearest = sameStorey.reduce(
          (best, t) => Math.min(best, distanceToSpace(triangle.centroid, t)),
          Number.POSITIVE_INFINITY
        );
        const entry = unassignedByStorey.get(triangle.storeyGlobalId) ?? {
          areaSqft: 0,
          targets: sameStorey.length,
          nearestFt: Number.POSITIVE_INFINITY
        };
        entry.areaSqft += triangle.areaSqft;
        entry.nearestFt = Math.min(entry.nearestFt, nearest);
        unassignedByStorey.set(triangle.storeyGlobalId, entry);
        continue;
      }

      const orientation = orientationBucket(orientationAwayFromSpace(triangle, target));
      const key = `${target.globalId}|${triangle.elementGlobalId}|${orientation}`;
      const current = aggregate.get(key);
      if (current) {
        current.areaSqft += triangle.areaSqft;
      } else {
        aggregate.set(key, {
          modelId,
          spaceGlobalId: target.globalId,
          elementGlobalId: triangle.elementGlobalId,
          boundaryType: "physical",
          internalOrExternal: "external",
          areaSqft: triangle.areaSqft,
          orientationDegrees: orientation
        });
      }
    }
  }

  if (unassignedAreaSqft > Math.max(25, recoveredAreaSqft * 0.02)) {
    const storeyName = (globalId: string) =>
      context.storeys.find((storey) => storey.globalId === globalId)?.name ?? globalId;
    const breakdown = [...unassignedByStorey.entries()]
      .sort((a, b) => b[1].areaSqft - a[1].areaSqft)
      .map(
        ([storeyGlobalId, entry]) =>
          `${storeyName(storeyGlobalId)}: ${entry.areaSqft.toFixed(0)} ft² ` +
          `(${entry.targets} space targets on storey, nearest ` +
          `${Number.isFinite(entry.nearestFt) ? entry.nearestFt.toFixed(1) : "∞"})`
      )
      .join("; ");
    throw new Error(
      `Geometric envelope recovery left ${unassignedAreaSqft.toFixed(1)} ft² of ` +
        `${recoveredAreaSqft.toFixed(1)} ft² vertical exterior surface unassigned to ` +
        `IfcSpace targets. By storey — ${breakdown}`
    );
  }

  return [...aggregate.values()].filter((boundary) => boundary.areaSqft > AREA_EPSILON);
}
