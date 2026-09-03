import { IfcImporter } from "@thatopen/fragments";
import {
  IFCCURTAINWALL,
  IFCELEMENT,
  IFCPLATE,
  IFCRELASSIGNSTOGROUP,
  IFCRELCONNECTSPORTTOELEMENT,
  IFCRELCONNECTSPORTS,
  IFCRELSPACEBOUNDARY,
  IFCRELSPACEBOUNDARY1STLEVEL,
  IFCRELSPACEBOUNDARY2NDLEVEL,
  IFCWALL,
  IFCWALLSTANDARDCASE,
  IFCWINDOW
} from "web-ifc";

import type {
  ElementSummary,
  IfcIndexRecord,
  RelationshipRecord,
  SpaceBoundary,
  SpaceBoundaryExposure,
  SystemAssignment
} from "../types";
import {
  ensureArray,
  extractIfcMetadata,
  getWasmDirectory,
  toText,
  unwrapIfcValue,
  vectorToArray,
  withIfcModel,
  type IfcMetadataContext,
  resolveContainingStoreyExpressId
} from "./ifc-helpers";
import { classifyAirflowType, resolveElementAirflowType } from "./airflow";
import { extractGeometricEnvelopeBoundaries } from "./geometric-envelope";

const SQ_METERS_TO_SQ_FEET = 10.7639;

const BOUNDARY_AREA_PRIORITY = [
  "netsidearea",
  "netarea",
  "grosssidearea",
  "grossarea",
  "area"
];

const GEOMETRIC_REPLACEMENT_CLASSES = new Set([
  "IFCWALL",
  "IFCWALLSTANDARDCASE",
  "IFCCURTAINWALL",
  "IFCWINDOW",
  "IFCPLATE"
]);
const INDEX_ELEMENT_TYPES = [
  IFCELEMENT,
  IFCWALL,
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
  // Unsupported units fail loudly later in load calculation (computeStoreyLoads);
  // here we leave the area unconverted rather than silently scaling it.
  return 1;
}

/** Pull a net surface area (project area unit) from an element's quantity sets. */
function selectBoundaryArea(properties: Record<string, unknown>): number | null {
  const byPriority = new Map<string, number>();
  for (const groupValue of Object.values(properties)) {
    if (typeof groupValue !== "object" || groupValue === null) {
      continue;
    }
    for (const [name, value] of Object.entries(groupValue as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        continue;
      }
      const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
      if (BOUNDARY_AREA_PRIORITY.includes(normalized) && !byPriority.has(normalized)) {
        byPriority.set(normalized, value);
      }
    }
  }
  for (const key of BOUNDARY_AREA_PRIORITY) {
    const value = byPriority.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

/**
 * Best-effort per-boundary area from the connection geometry: handles the
 * common IfcCurveBoundedPlane → IfcPolyline case (Revit 1st-level boundaries)
 * via the shoelace formula. Returns null for any shape we don't parse, in
 * which case the caller falls back to the element's net-area quantity.
 */
function connectionGeometryArea(
  api: import("web-ifc").IfcAPI,
  ifcModelId: number,
  connectionGeometryExpressId: number | null | undefined
): number | null {
  if (!connectionGeometryExpressId) {
    return null;
  }
  const geometry = api.GetLine(ifcModelId, connectionGeometryExpressId);
  const surfaceExpressId = geometry?.SurfaceOnRelatingElement?.value;
  if (!surfaceExpressId) {
    return null;
  }
  const surface = api.GetLine(ifcModelId, surfaceExpressId);
  if (api.GetNameFromTypeCode(surface.type).toUpperCase() !== "IFCCURVEBOUNDEDPLANE") {
    return null;
  }
  const outerExpressId = surface?.OuterBoundary?.value;
  if (!outerExpressId) {
    return null;
  }
  const outer = api.GetLine(ifcModelId, outerExpressId);
  if (api.GetNameFromTypeCode(outer.type).toUpperCase() !== "IFCPOLYLINE") {
    return null;
  }

  const points: Array<[number, number]> = [];
  for (const handle of ensureArray(outer.Points)) {
    const pointExpressId = handle?.value;
    if (!pointExpressId) {
      continue;
    }
    const point = api.GetLine(ifcModelId, pointExpressId);
    const coords = unwrapIfcValue(point?.Coordinates);
    if (Array.isArray(coords) && coords.length >= 2) {
      points.push([Number(coords[0]), Number(coords[1])]);
    }
  }
  if (points.length < 3) {
    return null;
  }

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  const area = Math.abs(twiceArea) / 2;
  return area > 0 ? area : null;
}

function normalizeBoundaryType(value: unknown): "physical" | "virtual" {
  return (toText(value) ?? "").toUpperCase() === "VIRTUAL" ? "virtual" : "physical";
}

function normalizeBoundaryExposure(value: unknown): SpaceBoundaryExposure {
  const text = (toText(value) ?? "").toUpperCase();
  if (text.startsWith("EXTERNAL_EARTH")) {
    return "external-earth";
  }
  if (text.startsWith("EXTERNAL")) {
    return "external";
  }
  // INTERNAL or NOTDEFINED → treat as internal (contributes no design load).
  return "internal";
}

/**
 * Extract IfcRelSpaceBoundary relations into envelope-ready boundary records.
 * Areas come from the boundary's connection geometry when parseable, else the
 * related element's net-area quantity; boundaries with neither are skipped.
 *
 * Orientation is left null this iteration — placement rotation isn't resolved
 * yet, and orientation is only consumed by the future solar-gain pass.
 */
function extractSpaceBoundaries(
  api: import("web-ifc").IfcAPI,
  ifcModelId: number,
  modelId: string,
  context: IfcMetadataContext,
  elementGlobalIdByExpressId: Map<number, string>,
  lengthUnit: string
): SpaceBoundary[] {
  const factor = areaUnitFactor(lengthUnit);
  const relationIds = new Set<number>();
  for (const typeId of [
    IFCRELSPACEBOUNDARY,
    IFCRELSPACEBOUNDARY1STLEVEL,
    IFCRELSPACEBOUNDARY2NDLEVEL
  ]) {
    for (const id of vectorToArray(api.GetLineIDsWithType(ifcModelId, typeId, true))) {
      relationIds.add(id);
    }
  }

  const boundaries: SpaceBoundary[] = [];
  for (const relationId of relationIds) {
    const relation = api.GetLine(ifcModelId, relationId);
    const spaceExpressId = relation?.RelatingSpace?.value;
    const elementExpressId = relation?.RelatedBuildingElement?.value;
    if (!spaceExpressId || !elementExpressId) {
      continue;
    }

    const spaceGlobalId = context.globalIdByExpressId.get(spaceExpressId);
    const elementGlobalId = elementGlobalIdByExpressId.get(elementExpressId);
    if (!spaceGlobalId || !elementGlobalId) {
      continue;
    }

    const rawArea =
      connectionGeometryArea(api, ifcModelId, relation?.ConnectionGeometry?.value) ??
      selectBoundaryArea(context.propertyMap.get(elementExpressId) ?? {});
    if (rawArea === null) {
      continue;
    }

    boundaries.push({
      modelId,
      spaceGlobalId,
      elementGlobalId,
      boundaryType: normalizeBoundaryType(relation?.PhysicalOrVirtualBoundary),
      internalOrExternal: normalizeBoundaryExposure(relation?.InternalOrExternalBoundary),
      areaSqft: rawArea * factor,
      orientationDegrees: null
    });
  }
  return boundaries;
}

export async function convertIfcToFragments(bytes: Uint8Array): Promise<Uint8Array> {
  const importer = new IfcImporter();
  importer.wasm = {
    path: getWasmDirectory(),
    absolute: true
  };
  return importer.process({ bytes, raw: true });
}

export async function extractIfcIndex(
  bytes: Uint8Array,
  modelId: string
): Promise<IfcIndexRecord> {
  return withIfcModel(bytes, async (api, ifcModelId) => {
    const context = extractIfcMetadata(api, ifcModelId, modelId);
    const systemAssignmentsByElementExpressId = new Map<number, SystemAssignment[]>();
    const placementCache = new Map<number, [number, number, number] | null>();
    const resolveStoreyExpressId = (expressId: number) =>
      resolveContainingStoreyExpressId(context, expressId);
    const resolvePlacement = (placementExpressId: number | null | undefined): [number, number, number] | null => {
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
      const raw = unwrapIfcValue(location) as unknown[];
      const point: [number, number, number] = [
        (parentPoint?.[0] ?? 0) + Number(raw?.[0] ?? 0),
        (parentPoint?.[1] ?? 0) + Number(raw?.[1] ?? 0),
        (parentPoint?.[2] ?? 0) + Number(raw?.[2] ?? 0)
      ];
      placementCache.set(placementExpressId, point);
      return point;
    };

    const groupAssignmentRelationIds = vectorToArray(
      api.GetLineIDsWithType(ifcModelId, IFCRELASSIGNSTOGROUP, true)
    );
    for (const relationId of groupAssignmentRelationIds) {
      const relation = api.GetLine(ifcModelId, relationId);
      const systemExpressId = relation.RelatingGroup?.value;
      if (!systemExpressId) {
        continue;
      }

      const systemLine = api.GetLine(ifcModelId, systemExpressId);
      if (!systemLine) {
        continue;
      }

      const systemType = api.GetNameFromTypeCode(systemLine.type).toUpperCase();
      if (!systemType.endsWith("SYSTEM")) {
        continue;
      }

      const systemAssignment: SystemAssignment = {
        systemGlobalId: toText(systemLine.GlobalId) ?? String(systemExpressId),
        name: toText(systemLine.Name),
        description: toText(systemLine.Description),
        airflowType: classifyAirflowType({
          description: toText(systemLine.Description),
          name: toText(systemLine.Name)
        })
      };

      const relatedObjects = Array.isArray(relation.RelatedObjects)
        ? relation.RelatedObjects
        : relation.RelatedObjects
          ? [relation.RelatedObjects]
          : [];
      for (const handle of relatedObjects) {
        const relatedExpressId = handle?.value;
        if (!relatedExpressId) {
          continue;
        }
        const current = systemAssignmentsByElementExpressId.get(relatedExpressId) ?? [];
        current.push(systemAssignment);
        systemAssignmentsByElementExpressId.set(relatedExpressId, current);
      }
    }

    const elementExpressIds = new Set<number>();
    for (const type of INDEX_ELEMENT_TYPES) {
      for (const expressId of vectorToArray(api.GetLineIDsWithType(ifcModelId, type, true))) {
        elementExpressIds.add(expressId);
      }
    }

    const elements: ElementSummary[] = [...elementExpressIds].map((expressId) => {
      const line = api.GetLine(ifcModelId, expressId);
      const globalId = toText(line.GlobalId) ?? String(expressId);
      const storeyExpressId = resolveStoreyExpressId(expressId);
      const systemAssignments = (systemAssignmentsByElementExpressId.get(expressId) ?? [])
        .sort((left, right) => left.systemGlobalId.localeCompare(right.systemGlobalId));
      return {
        modelId,
        sourceId: "architecture",
        discipline: "architecture",
        expressId,
        sourceGlobalId: globalId,
        globalId,
        compositeGlobalId: globalId,
        ifcClass: api.GetNameFromTypeCode(line.type),
        name: toText(line.Name),
        longName: toText(line.LongName),
        description: toText(line.Description),
        objectType: toText(line.ObjectType),
        tag: toText(line.Tag),
        storeyGlobalId: storeyExpressId
          ? context.globalIdByExpressId.get(storeyExpressId) ?? null
          : null,
        spaceGlobalId: null,
        placement: resolvePlacement(line.ObjectPlacement?.value),
        airflowType: resolveElementAirflowType({
          systemAssignments,
          properties: context.propertyMap.get(expressId) ?? {},
          name: toText(line.Name),
          objectType: toText(line.ObjectType)
        }),
        systemAssignments,
        properties: context.propertyMap.get(expressId) ?? {}
      };
    });
    const elementGlobalIdByExpressId = new Map(
      elements.map((element) => [element.expressId, element.globalId])
    );
    const storeyGlobalIdByElementExpressId = new Map(
      elements.map((element) => [element.expressId, element.storeyGlobalId])
    );
    const elementsByGlobalId = new Map(
      elements.map((element) => [element.globalId, element])
    );

    const relationships: RelationshipRecord[] = [];
    for (const [fromExpressId, childIds] of context.aggregateChildren.entries()) {
      const fromGlobalId = context.globalIdByExpressId.get(fromExpressId);
      if (!fromGlobalId) {
        continue;
      }

      for (const childId of childIds) {
        const toGlobalId = context.globalIdByExpressId.get(childId);
        if (!toGlobalId) {
          continue;
        }
        relationships.push({
          modelId,
          relationType: "IfcRelAggregates",
          fromGlobalId,
          toGlobalId,
          payload: {}
        });
      }
    }

    for (const [fromExpressId, childIds] of context.containedChildren.entries()) {
      const fromGlobalId = context.globalIdByExpressId.get(fromExpressId);
      if (!fromGlobalId) {
        continue;
      }

      for (const childId of childIds) {
        const toGlobalId = context.globalIdByExpressId.get(childId);
        if (!toGlobalId) {
          continue;
        }
        relationships.push({
          modelId,
          relationType: "IfcRelContainedInSpatialStructure",
          fromGlobalId,
          toGlobalId,
          payload: {}
        });
      }
    }

    for (const [elementExpressId, systemAssignments] of systemAssignmentsByElementExpressId.entries()) {
      const elementGlobalId = elementGlobalIdByExpressId.get(elementExpressId);
      if (!elementGlobalId) {
        continue;
      }

      for (const systemAssignment of systemAssignments) {
        relationships.push({
          modelId,
          relationType: "IfcRelAssignsToGroup",
          fromGlobalId: elementGlobalId,
          toGlobalId: systemAssignment.systemGlobalId,
          payload: {
            systemGlobalId: systemAssignment.systemGlobalId,
            name: systemAssignment.name,
            description: systemAssignment.description,
            airflowType: systemAssignment.airflowType
          }
        });
      }
    }

    const elementExpressIdByPortExpressId = new Map<number, number>();
    const portToElementRelationIds = vectorToArray(
      api.GetLineIDsWithType(ifcModelId, IFCRELCONNECTSPORTTOELEMENT, true)
    );
    for (const relationId of portToElementRelationIds) {
      const relation = api.GetLine(ifcModelId, relationId);
      const portExpressId = relation.RelatingPort?.value;
      const elementExpressId = relation.RelatedElement?.value;
      if (portExpressId && elementExpressId) {
        elementExpressIdByPortExpressId.set(portExpressId, elementExpressId);
      }
    }

    const connectedPortsRelationIds = vectorToArray(
      api.GetLineIDsWithType(ifcModelId, IFCRELCONNECTSPORTS, true)
    );
    for (const relationId of connectedPortsRelationIds) {
      const relation = api.GetLine(ifcModelId, relationId);
      const fromPortExpressId = relation.RelatingPort?.value;
      const toPortExpressId = relation.RelatedPort?.value;
      if (!fromPortExpressId || !toPortExpressId) {
        continue;
      }

      const fromElementGlobalId = elementGlobalIdByExpressId.get(
        elementExpressIdByPortExpressId.get(fromPortExpressId) ?? -1
      );
      const toElementGlobalId = elementGlobalIdByExpressId.get(
        elementExpressIdByPortExpressId.get(toPortExpressId) ?? -1
      );
      if (!fromElementGlobalId || !toElementGlobalId) {
        continue;
      }

      relationships.push({
        modelId,
        relationType: "IfcRelConnectsPorts",
        fromGlobalId: fromElementGlobalId,
        toGlobalId: toElementGlobalId,
        payload: {
          fromPortExpressId,
          toPortExpressId
        }
      });
    }

    const relationBoundaries = extractSpaceBoundaries(
      api,
      ifcModelId,
      modelId,
      context,
      elementGlobalIdByExpressId,
      context.lengthUnit
    );
    const geometricBoundaries = extractGeometricEnvelopeBoundaries({
      api,
      ifcModelId,
      modelId,
      context,
      elementGlobalIdByExpressId,
      storeyGlobalIdByElementExpressId,
      lengthUnit: context.lengthUnit
    });
    const geometricReplacementElementIds = new Set(
      geometricBoundaries.map((boundary) => boundary.elementGlobalId)
    );
    const relationBoundariesWithoutReplacedGeometry = relationBoundaries.filter(
      (boundary) => {
        if (
          boundary.boundaryType !== "physical" ||
          boundary.internalOrExternal !== "external"
        ) {
          return true;
        }
        const element = elementsByGlobalId.get(boundary.elementGlobalId);
        if (!element || !GEOMETRIC_REPLACEMENT_CLASSES.has(element.ifcClass.toUpperCase())) {
          return true;
        }
        return !geometricReplacementElementIds.has(boundary.elementGlobalId);
      }
    );
    const boundaries = [
      ...relationBoundariesWithoutReplacedGeometry,
      ...geometricBoundaries
    ];

    return {
      schema: context.schema,
      lengthUnit: context.lengthUnit,
      site: context.site,
      storeys: context.storeys,
      spaces: context.spaces,
      elements,
      boundaries,
      relationships
    };
  });
}
