import path from "node:path";
import { createRequire } from "node:module";
import {
  IfcAPI,
  IFCBUILDINGSTOREY,
  IFCCONVERSIONBASEDUNIT,
  IFCELEMENTQUANTITY,
  IFCPROPERTYSET,
  IFCSITE,
  IFCSIUNIT,
  IFCUNITASSIGNMENT,
  IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCRELDEFINESBYPROPERTIES,
  IFCSPACE
} from "web-ifc";

import type {
  Bounds3D,
  SiteLocation,
  SpaceSummary,
  StoreySummary
} from "../types";

export type PlacementPoint = [number, number, number];

export type IfcMetadataContext = {
  schema: string;
  lengthUnit: string;
  site: SiteLocation;
  storeys: StoreySummary[];
  spaces: SpaceSummary[];
  aggregateChildren: Map<number, Set<number>>;
  aggregateParentByExpressId: Map<number, number>;
  containedChildren: Map<number, Set<number>>;
  spatialContainerByExpressId: Map<number, number>;
  globalIdByExpressId: Map<number, string>;
  expressIdByGlobalId: Map<string, number>;
  propertyMap: Map<number, Record<string, unknown>>;
};

// Use process.cwd() as the base for createRequire so that
// require.resolve returns real filesystem paths even when this
// module is bundled by Turbopack (which mangles import.meta.url).
const require = createRequire(path.resolve(process.cwd(), "package.json"));

export function unwrapIfcValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(unwrapIfcValue);
  }

  if (typeof value !== "object") {
    return value;
  }

  const candidate = value as Record<string, unknown>;

  if ("_representationValue" in candidate) {
    return candidate._representationValue ?? null;
  }

  if ("value" in candidate && Object.keys(candidate).length <= 3) {
    return candidate.value ?? null;
  }

  if ("expressID" in candidate && Object.keys(candidate).length === 2) {
    return candidate.expressID ?? null;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(candidate)) {
    if (key === "expressID" || key === "type" || key === "name") {
      continue;
    }
    normalized[key] = unwrapIfcValue(nested);
  }
  return normalized;
}

export function toText(value: unknown): string | null {
  const unwrapped = unwrapIfcValue(value);
  if (typeof unwrapped === "string") {
    return unwrapped;
  }
  if (typeof unwrapped === "number" || typeof unwrapped === "boolean") {
    return String(unwrapped);
  }
  return null;
}

export function toNumber(value: unknown): number | null {
  const unwrapped = unwrapIfcValue(value);
  return typeof unwrapped === "number" ? unwrapped : null;
}

/**
 * Convert an IfcCompoundPlaneAngleMeasure (a list of
 * [degrees, minutes, seconds, millionths-of-second]) to decimal degrees. The
 * sign is carried on the first non-zero component. Used for IfcSite
 * RefLatitude/RefLongitude.
 */
export function compoundPlaneAngleToDecimal(value: unknown): number | null {
  const unwrapped = unwrapIfcValue(value);
  if (!Array.isArray(unwrapped) || unwrapped.length === 0) {
    return null;
  }
  const parts = unwrapped
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
  if (parts.length === 0) {
    return null;
  }
  const [degrees = 0, minutes = 0, seconds = 0, millionths = 0] = parts;
  const sign = degrees < 0 || minutes < 0 || seconds < 0 || millionths < 0 ? -1 : 1;
  const magnitude =
    Math.abs(degrees) +
    Math.abs(minutes) / 60 +
    Math.abs(seconds) / 3600 +
    Math.abs(millionths) / 3_600_000_000;
  return sign * magnitude;
}

export function vectorToArray<T>(vector: { size(): number; get(index: number): T }) {
  return Array.from({ length: vector.size() }, (_, index) => vector.get(index));
}

export function ensureArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [value];
}

export function mergeBounds(points: PlacementPoint[]): Bounds3D | null {
  if (points.length === 0) {
    return null;
  }

  const min: PlacementPoint = [...points[0]] as PlacementPoint;
  const max: PlacementPoint = [...points[0]] as PlacementPoint;

  for (const point of points.slice(1)) {
    for (let index = 0; index < 3; index += 1) {
      min[index] = Math.min(min[index], point[index]);
      max[index] = Math.max(max[index], point[index]);
    }
  }

  return { min, max };
}

export function getWasmDirectory(): string {
  return `${path.dirname(require.resolve("web-ifc"))}/`;
}

export function newIfcApi(): IfcAPI {
  const api = new IfcAPI();
  api.SetWasmPath(getWasmDirectory(), true);
  return api;
}

export async function withIfcModel<T>(
  bytes: Uint8Array,
  fn: (api: IfcAPI, ifcModelId: number) => Promise<T>
): Promise<T> {
  const api = newIfcApi();
  await api.Init();
  const ifcModelId = api.OpenModel(bytes);

  try {
    return await fn(api, ifcModelId);
  } finally {
    api.CloseModel(ifcModelId);
  }
}

const FLOOR_AREA_MIN_TRIANGLE_AREA = 1e-9;

/**
 * Compute floor area for a 3D element by projecting every mesh triangle onto
 * the plane perpendicular to the building's up-axis and summing the absolute
 * contributions, then halving (divergence theorem: for a closed volume, the
 * up-axis projection accumulates top + bottom, i.e. 2× the footprint).
 *
 * The up-axis is detected per-space: IFC files from Revit often use Y-up,
 * not Z-up, so we pick whichever world axis carries the largest area-weighted
 * normal magnitude. Used as a fallback when an IfcSpace has no
 * Qto_SpaceBaseQuantities.
 */
function computeMeshFloorArea(
  api: IfcAPI,
  ifcModelId: number,
  expressId: number
): number | null {
  const mesh = api.GetFlatMesh(ifcModelId, expressId);
  if (!mesh || typeof mesh.geometries?.size !== "function" || mesh.geometries.size() === 0) {
    return null;
  }

  const axisAbsSum: [number, number, number] = [0, 0, 0];
  let triangleCount = 0;

  for (let geometryIndex = 0; geometryIndex < mesh.geometries.size(); geometryIndex += 1) {
    const placed = mesh.geometries.get(geometryIndex);
    const geometry = api.GetGeometry(ifcModelId, placed.geometryExpressID);
    const positions = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
    const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());

    // Use raw (pre-transform) vertex coordinates. Footprint area is invariant
    // under the rigid-body part of the placement (rotation + translation), and
    // web-ifc's flatTransformation misapplies IfcConversionBasedUnit scale for
    // some exports (e.g. Revit files declaring METRE as SI + FOOT as project
    // unit), shrinking world coords by 0.3048. Raw coords are always in the
    // IFC project length unit regardless.

    for (let i = 0; i < indices.length; i += 3) {
      const vi0 = indices[i] * 6;
      const vi1 = indices[i + 1] * 6;
      const vi2 = indices[i + 2] * 6;
      const p0: [number, number, number] = [positions[vi0], positions[vi0 + 1], positions[vi0 + 2]];
      const p1: [number, number, number] = [positions[vi1], positions[vi1 + 1], positions[vi1 + 2]];
      const p2: [number, number, number] = [positions[vi2], positions[vi2 + 1], positions[vi2 + 2]];

      const abx = p1[0] - p0[0];
      const aby = p1[1] - p0[1];
      const abz = p1[2] - p0[2];
      const acx = p2[0] - p0[0];
      const acy = p2[1] - p0[1];
      const acz = p2[2] - p0[2];

      // Components of (ab × ac); each is 2 × signed projected-triangle area onto
      // the plane perpendicular to that axis.
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;

      const magnitude = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (magnitude <= FLOOR_AREA_MIN_TRIANGLE_AREA) {
        continue;
      }

      axisAbsSum[0] += Math.abs(nx);
      axisAbsSum[1] += Math.abs(ny);
      axisAbsSum[2] += Math.abs(nz);
      triangleCount += 1;
    }

    geometry.delete();
  }

  if (triangleCount === 0) {
    return null;
  }

  const upAxisSum = Math.max(axisAbsSum[0], axisAbsSum[1], axisAbsSum[2]);
  if (upAxisSum <= FLOOR_AREA_MIN_TRIANGLE_AREA) {
    return null;
  }

  // Σ |n.up| = 2 × (top + bottom projected area) = 4 × footprint for a closed volume.
  return upAxisSum / 4;
}

const AREA_PROPERTY_PRIORITY = [
  "grossfloorarea",
  "netfloorarea",
  "floorarea",
  "grossarea",
  "netarea"
];

/**
 * Pick the most trustworthy area value from an IfcSpace's property/quantity
 * sets. Prefers named floor-area quantities over generic "*area*" matches so
 * we don't accidentally return wall or ceiling area.
 */
function selectAreaFromProperties(properties: Record<string, unknown>): number | null {
  const byPriority = new Map<string, number>();
  let genericFallback: number | null = null;

  for (const groupValue of Object.values(properties)) {
    if (typeof groupValue !== "object" || groupValue === null) {
      continue;
    }
    for (const [propertyName, propertyValue] of Object.entries(
      groupValue as Record<string, unknown>
    )) {
      if (typeof propertyValue !== "number" || !Number.isFinite(propertyValue) || propertyValue <= 0) {
        continue;
      }
      const normalized = propertyName.toLowerCase().replace(/[^a-z]/g, "");
      const priorityIndex = AREA_PROPERTY_PRIORITY.indexOf(normalized);
      if (priorityIndex >= 0 && !byPriority.has(normalized)) {
        byPriority.set(normalized, propertyValue);
      } else if (genericFallback === null && normalized.includes("area")) {
        genericFallback = propertyValue;
      }
    }
  }

  for (const key of AREA_PROPERTY_PRIORITY) {
    const value = byPriority.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return genericFallback;
}

function extractPropertyDefinition(
  api: IfcAPI,
  modelId: number,
  propertyDefinitionExpressId: number
): Record<string, unknown> {
  const propertyDefinition = api.GetLine(modelId, propertyDefinitionExpressId);
  const typeName = api.GetNameFromTypeCode(propertyDefinition.type).toUpperCase();
  const result: Record<string, unknown> = {};

  if (typeName === "IFCPROPERTYSET") {
    const setName = toText(propertyDefinition.Name) ?? `Pset_${propertyDefinitionExpressId}`;
    const properties: Record<string, unknown> = {};
    for (const handle of ensureArray(propertyDefinition.HasProperties)) {
      const property = api.GetLine(modelId, handle.value);
      const propertyName =
        toText(property.Name) ?? `${api.GetNameFromTypeCode(property.type)}_${property.expressID}`;
      if ("NominalValue" in property) {
        properties[propertyName] = unwrapIfcValue(property.NominalValue);
      } else if ("EnumerationValues" in property) {
        properties[propertyName] = unwrapIfcValue(property.EnumerationValues);
      } else {
        properties[propertyName] = unwrapIfcValue(property);
      }
    }
    result[setName] = properties;
    return result;
  }

  if (typeName === "IFCELEMENTQUANTITY") {
    const setName = toText(propertyDefinition.Name) ?? `Qto_${propertyDefinitionExpressId}`;
    const quantities: Record<string, unknown> = {};
    for (const handle of ensureArray(propertyDefinition.Quantities)) {
      const quantity = api.GetLine(modelId, handle.value);
      const quantityName =
        toText(quantity.Name) ?? `${api.GetNameFromTypeCode(quantity.type)}_${quantity.expressID}`;
      const numericEntry = Object.entries(quantity).find(
        ([key, nested]) => key.endsWith("Value") && typeof unwrapIfcValue(nested) === "number"
      );
      quantities[quantityName] = numericEntry
        ? unwrapIfcValue(numericEntry[1])
        : unwrapIfcValue(quantity);
    }
    result[setName] = quantities;
    return result;
  }

  result[typeName] = unwrapIfcValue(propertyDefinition) as Record<string, unknown>;
  return result;
}

const METRES_PER_LENGTH_UNIT: Record<string, number> = {
  metre: 1,
  meter: 1,
  m: 1,
  centimetre: 0.01,
  millimetre: 0.001,
  foot: 0.3048,
  feet: 0.3048,
  ft: 0.3048,
  inch: 0.0254
};

export function metresPerLengthUnit(lengthUnit: string): number {
  const factor = METRES_PER_LENGTH_UNIT[lengthUnit.trim().toLowerCase()];
  if (factor === undefined) {
    throw new Error(`Unsupported IFC length unit: ${lengthUnit}.`);
  }
  return factor;
}

/**
 * Walk IfcRelContainedInSpatialStructure / IfcRelAggregates upward until an
 * IfcBuildingStorey is reached. Exporters may contain elements directly in a
 * storey, in an IfcSpace aggregated into a storey, or nest them in assemblies.
 */
export function resolveContainingStoreyExpressId(
  context: Pick<IfcMetadataContext, "storeys" | "spatialContainerByExpressId" | "aggregateParentByExpressId">,
  expressId: number
): number | null {
  const storeyExpressIds = new Set(context.storeys.map((storey) => storey.expressId));
  const visited = new Set<number>();
  let current: number | null = expressId;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    if (storeyExpressIds.has(current)) {
      return current;
    }
    current =
      context.spatialContainerByExpressId.get(current) ??
      context.aggregateParentByExpressId.get(current) ??
      null;
  }
  return null;
}

export function extractIfcMetadata(
  api: IfcAPI,
  ifcModelId: number,
  modelId: string
): IfcMetadataContext {
  const schema = api.GetModelSchema(ifcModelId);
  const normalizeLengthUnit = (value: string) =>
    value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  const resolveLengthUnit = () => {
    const resolved = new Set<string>();
    const assignmentIds = vectorToArray(
      api.GetLineIDsWithType(ifcModelId, IFCUNITASSIGNMENT, true)
    );

    for (const assignmentId of assignmentIds) {
      const assignment = api.GetLine(ifcModelId, assignmentId);
      for (const handle of ensureArray(assignment?.Units)) {
        const unit = api.GetLine(ifcModelId, handle.value);
        if (!unit || toText(unit.UnitType)?.toUpperCase() !== "LENGTHUNIT") {
          continue;
        }

        if (unit.type === IFCSIUNIT) {
          const unitName = toText(unit.Name);
          if (!unitName) {
            continue;
          }
          const prefix = toText(unit.Prefix);
          resolved.add(
            normalizeLengthUnit(prefix ? `${prefix}${unitName}` : unitName)
          );
          continue;
        }

        if (unit.type === IFCCONVERSIONBASEDUNIT) {
          const unitName = toText(unit.Name);
          if (unitName) {
            resolved.add(normalizeLengthUnit(unitName));
          }
        }
      }
    }

    if (resolved.size !== 1) {
      throw new Error(
        resolved.size === 0
          ? "The IFC model did not define an explicit project length unit."
          : `The IFC model defined conflicting project length units: ${Array.from(resolved).join(", ")}.`
      );
    }

    return Array.from(resolved)[0] ?? "unknown";
  };
  const lengthUnit = resolveLengthUnit();

  const resolveSiteLocation = (): SiteLocation => {
    const siteIds = vectorToArray(api.GetLineIDsWithType(ifcModelId, IFCSITE, true));
    for (const siteId of siteIds) {
      const site = api.GetLine(ifcModelId, siteId);
      const latitude = compoundPlaneAngleToDecimal(site?.RefLatitude);
      const longitude = compoundPlaneAngleToDecimal(site?.RefLongitude);
      if (latitude !== null && longitude !== null) {
        return { latitude, longitude };
      }
    }
    return { latitude: null, longitude: null };
  };
  const site = resolveSiteLocation();

  const placementCache = new Map<number, PlacementPoint | null>();
  const globalIdByExpressId = new Map<number, string>();
  const expressIdByGlobalId = new Map<string, number>();
  const propertyMap = new Map<number, Record<string, unknown>>();
  const aggregateChildren = new Map<number, Set<number>>();
  const containedChildren = new Map<number, Set<number>>();
  const spatialContainerByExpressId = new Map<number, number>();
  const aggregateParentByExpressId = new Map<number, number>();

  const resolvePlacement = (placementExpressId: number | null | undefined): PlacementPoint | null => {
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
        : ([0, 0, 0] as PlacementPoint);
    const safeParentPoint = parentPoint ?? ([0, 0, 0] as PlacementPoint);

    const location = placement.RelativePlacement?.Location?.Coordinates ?? [];
    const raw = unwrapIfcValue(location) as unknown[];
    const current: PlacementPoint = [
      Number(raw?.[0] ?? 0),
      Number(raw?.[1] ?? 0),
      Number(raw?.[2] ?? 0)
    ];

    const point: PlacementPoint = [
      safeParentPoint[0] + current[0],
      safeParentPoint[1] + current[1],
      safeParentPoint[2] + current[2]
    ];

    placementCache.set(placementExpressId, point);
    return point;
  };

  const storeLineIdentity = (line: { GlobalId?: unknown; expressID: number }) => {
    const globalId = toText(line.GlobalId);
    if (!globalId) {
      return;
    }
    globalIdByExpressId.set(line.expressID, globalId);
    expressIdByGlobalId.set(globalId, line.expressID);
  };

  const relDefines = vectorToArray(
    api.GetLineIDsWithType(ifcModelId, IFCRELDEFINESBYPROPERTIES, true)
  );

  for (const expressId of relDefines) {
    const relation = api.GetLine(ifcModelId, expressId);
    const relatedIds = ensureArray(relation.RelatedObjects).map((handle) => handle.value);
    const definitionId = relation.RelatingPropertyDefinition?.value;
    if (!definitionId) {
      continue;
    }
    const extracted = extractPropertyDefinition(api, ifcModelId, definitionId);
    for (const relatedId of relatedIds) {
      propertyMap.set(relatedId, {
        ...(propertyMap.get(relatedId) ?? {}),
        ...extracted
      });
    }
  }

  const aggregateRelationIds = vectorToArray(
    api.GetLineIDsWithType(ifcModelId, IFCRELAGGREGATES, true)
  );

  for (const expressId of aggregateRelationIds) {
    const relation = api.GetLine(ifcModelId, expressId);
    const fromExpressId = relation.RelatingObject?.value;
    const relatedIds = ensureArray(relation.RelatedObjects).map((handle) => handle.value);
    if (!fromExpressId) {
      continue;
    }

    const set = aggregateChildren.get(fromExpressId) ?? new Set<number>();
    for (const relatedId of relatedIds) {
      set.add(relatedId);
      aggregateParentByExpressId.set(relatedId, fromExpressId);
    }
    aggregateChildren.set(fromExpressId, set);
  }

  const containedRelationIds = vectorToArray(
    api.GetLineIDsWithType(ifcModelId, IFCRELCONTAINEDINSPATIALSTRUCTURE, true)
  );

  for (const expressId of containedRelationIds) {
    const relation = api.GetLine(ifcModelId, expressId);
    const fromExpressId = relation.RelatingStructure?.value;
    const relatedIds = ensureArray(relation.RelatedElements).map((handle) => handle.value);
    if (!fromExpressId) {
      continue;
    }

    const set = containedChildren.get(fromExpressId) ?? new Set<number>();
    for (const relatedId of relatedIds) {
      set.add(relatedId);
      spatialContainerByExpressId.set(relatedId, fromExpressId);
    }
    containedChildren.set(fromExpressId, set);
  }

  const storeyIds = vectorToArray(
    api.GetLineIDsWithType(ifcModelId, IFCBUILDINGSTOREY, true)
  );
  const storeys: StoreySummary[] = storeyIds.map((expressId, index) => {
    const line = api.GetLine(ifcModelId, expressId);
    storeLineIdentity(line);
    return {
      modelId,
      expressId,
      globalId: toText(line.GlobalId) ?? String(expressId),
      name: toText(line.Name) ?? `Storey ${index + 1}`,
      longName: toText(line.LongName),
      elevation: toNumber(line.Elevation),
      sortOrder: index,
      placement: resolvePlacement(line.ObjectPlacement?.value),
      bounds: null
    };
  });

  const storeyByExpressId = new Map(storeys.map((storey) => [storey.expressId, storey]));
  const spaces: SpaceSummary[] = vectorToArray(
    api.GetLineIDsWithType(ifcModelId, IFCSPACE, true)
  ).map((expressId) => {
    const line = api.GetLine(ifcModelId, expressId);
    storeLineIdentity(line);

    const storeyExpressId = aggregateParentByExpressId.get(expressId) ?? null;
    if (storeyExpressId) {
      const storeyLine = api.GetLine(ifcModelId, storeyExpressId);
      storeLineIdentity(storeyLine);
    }

    const properties = propertyMap.get(expressId) ?? {};
    const propertyArea = selectAreaFromProperties(properties);
    const area =
      propertyArea !== null
        ? propertyArea
        : computeMeshFloorArea(api, ifcModelId, expressId);

    return {
      modelId,
      sourceId: "architecture",
      discipline: "architecture",
      expressId,
      sourceGlobalId: toText(line.GlobalId) ?? String(expressId),
      globalId: toText(line.GlobalId) ?? String(expressId),
      compositeGlobalId: toText(line.GlobalId) ?? String(expressId),
      name: toText(line.Name) ?? `Space ${expressId}`,
      longName: toText(line.LongName),
      storeyGlobalId: storeyExpressId
        ? globalIdByExpressId.get(storeyExpressId) ?? null
        : null,
      area,
      placement: resolvePlacement(line.ObjectPlacement?.value),
      bounds: null,
      properties
    };
  });

  for (const storey of storeys) {
    const positions: PlacementPoint[] = [];
    for (const space of spaces) {
      if (space.storeyGlobalId === storey.globalId && space.placement) {
        positions.push(space.placement as PlacementPoint);
      }
    }

    const childElementIds = containedChildren.get(storey.expressId) ?? new Set<number>();
    for (const childId of childElementIds) {
      const line = api.GetLine(ifcModelId, childId);
      storeLineIdentity(line);
      const placement = resolvePlacement(line.ObjectPlacement?.value);
      if (placement) {
        positions.push(placement);
      }
    }

    storey.bounds = mergeBounds(positions);
  }

  for (const space of spaces) {
    const storeyExpressId = space.storeyGlobalId
      ? expressIdByGlobalId.get(space.storeyGlobalId) ?? null
      : null;
    const storey = storeyExpressId ? storeyByExpressId.get(storeyExpressId) ?? null : null;
    if (space.placement && storey?.bounds) {
      space.bounds = mergeBounds([space.placement, storey.bounds.min, storey.bounds.max]);
    } else if (space.placement) {
      space.bounds = mergeBounds([space.placement]);
    }
  }

  return {
    schema,
    lengthUnit,
    site,
    storeys,
    spaces,
    aggregateChildren,
    aggregateParentByExpressId,
    containedChildren,
    spatialContainerByExpressId,
    globalIdByExpressId,
    expressIdByGlobalId,
    propertyMap
  };
}
