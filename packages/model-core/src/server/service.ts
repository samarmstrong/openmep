import { randomUUID } from "node:crypto";
import { classifySystemDomain } from "./airflow";
import { z } from "zod";

import type {
  Bounds2D,
  IfcIndexRecord,
  IngestJobPayload,
  MechanicalEditItem,
  MechanicalVisualItem,
  ModelDiscipline,
  ModelSourceSummary,
  PlanModel,
  PlanPolygon,
  Point2D,
  PlanPrimitive,
  PlanStoreyManifest,
  PlanSpace,
  PlanStorey,
  StoredPlanModel,
  SpaceBoundary,
  SpaceSummary,
  StoreyLoads,
  StoreySummary
} from "../types";
import {
  createModelRecord,
  createModelSourceRecord,
  getModelSummary,
  replaceModelIndex,
  updateModelStatus,
  updateModelSourceStatus,
  updatePlanStatus
} from "./repository";
import { getStorageAdapter } from "./storage";
import { convertIfcToFragments, extractIfcIndex } from "./ifc";
import {
  CURRENT_PLAN_VERSION,
  extractIfcMechanicalPlanLayers,
  extractIfcPlanModel
} from "./plan";
import {
  assertLoadInputCoverage,
  assignTerminalCfm,
  classifySpaces,
  computeStoreyLoads,
  createClaudeCodeClassifier,
  resolveClimate,
  type SpaceClassification
} from "./hvac";
import { enqueueModelIngestJob } from "./queue";
import {
  mechanicalEditItemSchema,
  mechanicalVisualItemSchema,
  modelSourceSummarySchema,
  planArchitectureLayerSchema,
  planModelSchema,
  planStoreyManifestSchema,
  planStoreySchema,
  storedPlanModelSchema,
  storeyLoadsSchema
} from "../types";

const planRegenerationJobs = new Map<string, Promise<void>>();
const BUILDING_ENVELOPE_MARGIN = 6;
const SITE_SLAB_NAME_PATTERN =
  /\b(asphalt|sidewalk|grass|curb|pavement|marking|parking|drive|road|yard)\b/i;

type SourceUpload = {
  sourceId: string;
  discipline: ModelDiscipline;
  name: string;
  ifcBytes: Buffer;
};

type ProcessedSource = {
  summary: ModelSourceSummary;
  bytes: Uint8Array;
  index: IfcIndexRecord;
};

export type CompositeProcessedSource = ProcessedSource;

function buildSourceKey(modelId: string, sourceId: string) {
  return `models/${modelId}/sources/${sourceId}/source.ifc`;
}

function buildSourceFragmentsKey(modelId: string, sourceId: string) {
  return `models/${modelId}/sources/${sourceId}/model.frag`;
}

function buildSourceIndexKey(modelId: string, sourceId: string) {
  return `models/${modelId}/sources/${sourceId}/index.json`;
}

function buildPlanKey(modelId: string) {
  return `models/${modelId}/plan.json`;
}

function buildPlanLayerKey(
  modelId: string,
  storeyGlobalId: string,
  layerName: "architecture" | "mechanicalVisual2D" | "mechanicalEdit2D" | "loads"
) {
  return `models/${modelId}/plan/${encodeURIComponent(storeyGlobalId)}/${layerName}.json`;
}

function compositeGlobalId(sourceId: string, sourceGlobalId: string) {
  return `${sourceId}:${sourceGlobalId}`;
}

const DEFAULT_PLAN_LAYERS = ["architecture", "mechanicalVisual2D"] as const;
const planArchitecturePayloadSchema = planArchitectureLayerSchema;
const planMechanicalVisualPayloadSchema = z.array(mechanicalVisualItemSchema);
const planMechanicalEditPayloadSchema = z.array(mechanicalEditItemSchema);
const planLoadsPayloadSchema = storeyLoadsSchema;

function normalizeStoreyName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function storeyMatchKey(storey: Pick<StoreySummary, "name" | "elevation">) {
  return `${normalizeStoreyName(storey.name)}:${Math.round((storey.elevation ?? 0) * 1000)}`;
}

function ensureModelSources(model: Awaited<ReturnType<typeof getModelSummary>>) {
  if (!model) {
    return [];
  }

  if (model.sources.length > 0) {
    return model.sources;
  }

  return [
    modelSourceSummarySchema.parse({
      modelId: model.id,
      sourceId: "architecture",
      discipline: "architecture",
      name: model.name,
      status: model.status,
      schema: model.schema,
      sourceKey: model.sourceKey,
      fragmentsKey: model.fragmentsKey,
      indexKey: model.indexKey,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
      counts: model.counts,
      fragmentsUrl: model.fragmentsUrl,
      errorMessage: model.errorMessage
    })
  ];
}

function mergeBounds(bounds: Bounds2D[]): Bounds2D {
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

function snap(value: number) {
  return Math.round(value * 1e4) / 1e4;
}

function expandBounds(bounds: Bounds2D, padding: number): Bounds2D {
  return {
    min: [bounds.min[0] - padding, bounds.min[1] - padding],
    max: [bounds.max[0] + padding, bounds.max[1] + padding]
  };
}

function translatePoint(point: Point2D, offset: Point2D): Point2D {
  return [snap(point[0] + offset[0]), snap(point[1] + offset[1])];
}

function translateBounds(bounds: Bounds2D, offset: Point2D): Bounds2D {
  return {
    min: translatePoint(bounds.min, offset),
    max: translatePoint(bounds.max, offset)
  };
}

function translatePolygons(polygons: PlanPolygon[], offset: Point2D): PlanPolygon[] {
  return polygons.map((polygon) => ({
    outer: polygon.outer.map((point) => translatePoint(point, offset)),
    holes: polygon.holes.map((hole) => hole.map((point) => translatePoint(point, offset)))
  }));
}

function intersectsBounds(left: Bounds2D, right: Bounds2D) {
  return !(
    left.max[0] < right.min[0] ||
    left.min[0] > right.max[0] ||
    left.max[1] < right.min[1] ||
    left.min[1] > right.max[1]
  );
}

async function readStoredJsonByKey(key: string) {
  const object = await getStorageAdapter().getObject(key);
  return JSON.parse(object.body.toString("utf8")) as unknown;
}

async function hydrateStoredPlanStorey(
  manifest: PlanStoreyManifest
): Promise<PlanStorey> {
  const [architecture, mechanicalVisual2D, mechanicalEdit2D, loads] = await Promise.all([
    readStoredJsonByKey(manifest.layerKeys.architecture).then((payload) =>
      planArchitecturePayloadSchema.parse(payload)
    ),
    readStoredJsonByKey(manifest.layerKeys.mechanicalVisual2D).then((payload) =>
      planMechanicalVisualPayloadSchema.parse(payload)
    ),
    readStoredJsonByKey(manifest.layerKeys.mechanicalEdit2D).then((payload) =>
      planMechanicalEditPayloadSchema.parse(payload)
    ),
    readStoredJsonByKey(manifest.layerKeys.loads).then((payload) =>
      planLoadsPayloadSchema.parse(payload)
    )
  ]);

  return planStoreySchema.parse({
    ...manifest,
    architecture,
    mechanicalVisual2D,
    mechanicalEdit2D,
    loads
  });
}

async function hydrateStoredPlan(manifest: StoredPlanModel) {
  const storeys = await Promise.all(manifest.storeys.map((storey) => hydrateStoredPlanStorey(storey)));
  return planModelSchema.parse({
    ...manifest,
    storeys
  });
}

async function readStoredPlanByKey(key: string) {
  const parsed = await readStoredJsonByKey(key);
  const directPlan = planModelSchema.safeParse(parsed);
  if (directPlan.success) {
    return directPlan.data;
  }

  const manifest = storedPlanModelSchema.safeParse(parsed);
  if (manifest.success) {
    return hydrateStoredPlan(manifest.data);
  }

  return null;
}

function alignStoreysToAnchor(
  anchorStoreys: StoreySummary[],
  sourceStoreys: StoreySummary[],
  sourceId: string
) {
  const anchorByKey = new Map(
    anchorStoreys.map((storey) => [storeyMatchKey(storey), compositeGlobalId(sourceId, storey.globalId)])
  );
  const aligned = new Map<string, string>();
  for (const storey of sourceStoreys) {
    const key = storeyMatchKey(storey);
    const matched = anchorByKey.get(key);
    if (!matched) {
      throw new Error(`Source storey ${storey.name} could not be aligned to the architectural anchor.`);
    }
    aligned.set(storey.globalId, matched);
  }
  return aligned;
}

function decorateAnchorStoreys(
  modelId: string,
  sourceId: string,
  storeys: StoreySummary[]
): StoreySummary[] {
  return storeys.map((storey) => ({
    ...storey,
    modelId,
    globalId: compositeGlobalId(sourceId, storey.globalId)
  }));
}

function decorateSpaceSummary(
  modelId: string,
  source: ModelSourceSummary,
  storeyGlobalIdBySourceGlobalId: Map<string, string>,
  space: SpaceSummary
): SpaceSummary {
  const compositeId = compositeGlobalId(source.sourceId, space.globalId);
  return {
    ...space,
    modelId,
    sourceId: source.sourceId,
    discipline: source.discipline,
    sourceGlobalId: space.globalId,
    globalId: compositeId,
    compositeGlobalId: compositeId,
    storeyGlobalId: space.storeyGlobalId
      ? storeyGlobalIdBySourceGlobalId.get(space.storeyGlobalId) ?? null
      : null
  };
}

function decorateElementSummary(
  modelId: string,
  source: ModelSourceSummary,
  storeyGlobalIdBySourceGlobalId: Map<string, string>,
  element: IfcIndexRecord["elements"][number]
) {
  const compositeId = compositeGlobalId(source.sourceId, element.globalId);
  return {
    ...element,
    modelId,
    sourceId: source.sourceId,
    discipline: source.discipline,
    sourceGlobalId: element.globalId,
    globalId: compositeId,
    compositeGlobalId: compositeId,
    storeyGlobalId: element.storeyGlobalId
      ? storeyGlobalIdBySourceGlobalId.get(element.storeyGlobalId) ?? null
      : null
  };
}

function resolveRelationshipEndpoint(
  source: ModelSourceSummary,
  sourceIndex: IfcIndexRecord,
  storeyGlobalIdBySourceGlobalId: Map<string, string>,
  rawGlobalId: string
) {
  if (storeyGlobalIdBySourceGlobalId.has(rawGlobalId)) {
    return storeyGlobalIdBySourceGlobalId.get(rawGlobalId) ?? rawGlobalId;
  }
  if (sourceIndex.spaces.some((space) => space.globalId === rawGlobalId)) {
    return compositeGlobalId(source.sourceId, rawGlobalId);
  }
  if (sourceIndex.elements.some((element) => element.globalId === rawGlobalId)) {
    return compositeGlobalId(source.sourceId, rawGlobalId);
  }
  return compositeGlobalId(source.sourceId, rawGlobalId);
}

export function composeCompositeIndex(modelId: string, processedSources: ProcessedSource[]): IfcIndexRecord {
  const anchorSource =
    processedSources.find((source) => source.summary.discipline === "architecture") ??
    processedSources[0];
  if (!anchorSource) {
    throw new Error("No IFC sources were available for composite indexing.");
  }
  const lengthUnits = new Set(processedSources.map((source) => source.index.lengthUnit));
  if (lengthUnits.size !== 1) {
    throw new Error(
      `Composite indexing requires one shared project length unit, found: ${Array.from(lengthUnits).join(", ")}.`
    );
  }

  const anchorSourceId = anchorSource.summary.sourceId;
  const anchorStoreys = decorateAnchorStoreys(modelId, anchorSourceId, anchorSource.index.storeys);
  const storeys: StoreySummary[] = anchorStoreys;
  const anchorStoreyByRawGlobalId = new Map(
    anchorSource.index.storeys.map((storey, index) => [storey.globalId, anchorStoreys[index].globalId])
  );

  const spaces: SpaceSummary[] = [];
  const elements = [];
  const boundaries: SpaceBoundary[] = [];
  const relationships = [];

  for (const processedSource of processedSources) {
    const storeyGlobalIdBySourceGlobalId =
      processedSource.summary.sourceId === anchorSourceId
        ? anchorStoreyByRawGlobalId
        : alignStoreysToAnchor(
            anchorSource.index.storeys,
            processedSource.index.storeys,
            anchorSourceId
          );

    // Only the architectural model defines rooms. Revit MEP exports carry their
    // own IfcSpace copies of the same rooms; taking them would double the load
    // targets.
    const ownsSpaces = processedSource.summary.discipline === "architecture";
    if (ownsSpaces) {
      spaces.push(
        ...processedSource.index.spaces.map((space) =>
          decorateSpaceSummary(modelId, processedSource.summary, storeyGlobalIdBySourceGlobalId, space)
        )
      );
    }
    elements.push(
      ...processedSource.index.elements.map((element) =>
        decorateElementSummary(modelId, processedSource.summary, storeyGlobalIdBySourceGlobalId, element)
      )
    );
    boundaries.push(
      ...(ownsSpaces ? processedSource.index.boundaries : []).map((boundary) => ({
        ...boundary,
        modelId,
        // Re-key onto the composite globalIds so boundaries join to the
        // decorated spaces/elements in this composite index.
        spaceGlobalId: compositeGlobalId(processedSource.summary.sourceId, boundary.spaceGlobalId),
        elementGlobalId: compositeGlobalId(
          processedSource.summary.sourceId,
          boundary.elementGlobalId
        )
      }))
    );
    relationships.push(
      ...processedSource.index.relationships.map((relationship) => ({
        ...relationship,
        modelId,
        fromGlobalId: resolveRelationshipEndpoint(
          processedSource.summary,
          processedSource.index,
          storeyGlobalIdBySourceGlobalId,
          relationship.fromGlobalId
        ),
        toGlobalId: resolveRelationshipEndpoint(
          processedSource.summary,
          processedSource.index,
          storeyGlobalIdBySourceGlobalId,
          relationship.toGlobalId
        )
      }))
    );
  }

  return {
    schema: anchorSource.index.schema,
    lengthUnit: anchorSource.index.lengthUnit,
    site: anchorSource.index.site,
    storeys,
    spaces,
    elements,
    boundaries,
    relationships
  };
}

function decorateArchitecturePlan(plan: PlanModel, sourceId: string): PlanModel {
  return {
    ...plan,
    storeys: plan.storeys.map((storey) => {
      const storeyGlobalId = compositeGlobalId(sourceId, storey.globalId);
      const primitives = storey.architecture.primitives.map((primitive) => {
        const compositeId = compositeGlobalId(sourceId, primitive.globalId);
        return {
          ...primitive,
          sourceId,
          discipline: "architecture" as const,
          sourceGlobalId: primitive.globalId,
          globalId: compositeId,
          compositeGlobalId: compositeId,
          storeyGlobalId
        };
      });
      const spaces = storey.architecture.spaces.map((space) => {
        const compositeId = compositeGlobalId(sourceId, space.globalId);
        return {
          ...space,
          sourceId,
          discipline: "architecture" as const,
          sourceGlobalId: space.globalId,
          globalId: compositeId,
          compositeGlobalId: compositeId,
          storeyGlobalId
        };
      });

      return {
        ...storey,
        globalId: storeyGlobalId,
        architecture: {
          primitives,
          spaces
        }
      };
    })
  };
}

function applyMechanicalConnections(
  plan: PlanModel,
  relationships: IfcIndexRecord["relationships"]
): PlanModel {
  const connectedByItemId = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    if (relationship.relationType !== "IfcRelConnectsPorts") {
      continue;
    }
    const fromSet = connectedByItemId.get(relationship.fromGlobalId) ?? new Set<string>();
    fromSet.add(relationship.toGlobalId);
    connectedByItemId.set(relationship.fromGlobalId, fromSet);
    const toSet = connectedByItemId.get(relationship.toGlobalId) ?? new Set<string>();
    toSet.add(relationship.fromGlobalId);
    connectedByItemId.set(relationship.toGlobalId, toSet);
  }

  return {
    ...plan,
    storeys: plan.storeys.map((storey) => ({
      ...storey,
      // Port relationships extend whatever the plan extraction already knows
      // (geometrically inferred links for port-less exports).
      mechanicalVisual2D: storey.mechanicalVisual2D.map((item) => ({
        ...item,
        connectedItemIds: Array.from(
          new Set([...item.connectedItemIds, ...(connectedByItemId.get(item.backingElementId) ?? [])])
        ).sort()
      })),
      mechanicalEdit2D: storey.mechanicalEdit2D.map((item) => ({
        ...item,
        connectedItemIds: Array.from(
          new Set([...item.connectedItemIds, ...(connectedByItemId.get(item.elementRef) ?? [])])
        ).sort()
      }))
    }))
  };
}

function rebasePlanStorey(storey: PlanStorey): PlanStorey {
  const allBounds = [
    ...storey.architecture.primitives.map((primitive) => primitive.bounds),
    ...storey.architecture.spaces.map((space) => space.bounds),
    ...storey.mechanicalVisual2D.map((item) => item.bounds)
  ];
  const sourceBounds = allBounds.length > 0 ? mergeBounds(allBounds) : storey.bounds;
  const offset: Point2D = [-sourceBounds.min[0], -sourceBounds.min[1]];
  const architecture = {
    primitives: storey.architecture.primitives.map((primitive) => ({
      ...primitive,
      polygons: translatePolygons(primitive.polygons, offset),
      bounds: translateBounds(primitive.bounds, offset)
    })),
    spaces: storey.architecture.spaces.map((space) => ({
      ...space,
      polygons: translatePolygons(space.polygons, offset),
      bounds: translateBounds(space.bounds, offset),
      labelPoint: translatePoint(space.labelPoint, offset)
    }))
  };
  const mechanicalVisual2D = storey.mechanicalVisual2D.map((item) => ({
    ...item,
    polygons: translatePolygons(item.polygons, offset),
    bounds: translateBounds(item.bounds, offset),
    anchor: translatePoint(item.anchor, offset)
  }));
  const mechanicalEdit2D = storey.mechanicalEdit2D.map((item) =>
    item.editKind === "edge"
      ? {
          ...item,
          path: item.path.map((point) => translatePoint(point, offset))
        }
      : {
          ...item,
          position: translatePoint(item.position, offset)
        }
  );
  const contextBounds = translateBounds(sourceBounds, offset);
  const focusBoundsCandidates = [
    ...architecture.spaces.map((space) => space.bounds),
    ...architecture.primitives
      .filter((primitive) => primitive.presentationCategory === "building")
      .map((primitive) => primitive.bounds),
    ...mechanicalVisual2D.map((item) => item.bounds)
  ];
  const focusBounds =
    focusBoundsCandidates.length > 0 ? mergeBounds(focusBoundsCandidates) : contextBounds;

  return {
    ...storey,
    bounds: contextBounds,
    contextBounds,
    focusBounds,
    architecture,
    mechanicalVisual2D,
    mechanicalEdit2D,
    loads: storey.loads
  };
}

export type BuildCompositePlanOptions = {
  /** Injectable for tests — receives spaces the heuristic can't classify and
   *  must resolve every one to a valid ASHRAE space-type key. Defaults to a
   *  claude-code classifier that shells out to the `claude` CLI, authenticating
   *  via ANTHROPIC_API_KEY if set or the developer's OAuth login otherwise. */
  llmClassifier?: (spaces: SpaceSummary[]) => Promise<Map<string, string>>;
};

function defaultLlmClassifier(): (
  spaces: SpaceSummary[]
) => Promise<Map<string, string>> {
  return createClaudeCodeClassifier({ bare: !!process.env.ANTHROPIC_API_KEY });
}

function polygonArea(outer: ReadonlyArray<readonly [number, number]>): number {
  let twiceArea = 0;
  for (let index = 0; index < outer.length; index += 1) {
    const [x1, y1] = outer[index];
    const [x2, y2] = outer[(index + 1) % outer.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) / 2;
}

async function attachLoadsToStoreys(
  modelId: string,
  planVersion: number,
  storeys: PlanStorey[],
  compositeIndex: IfcIndexRecord,
  lengthUnit: string,
  options: BuildCompositePlanOptions
): Promise<PlanStorey[]> {
  const compositeSpaces = compositeIndex.spaces;
  // Rooms-only exports (every boundary virtual, no building elements) must
  // fail here rather than degrade to ventilation-only loads.
  assertLoadInputCoverage(compositeIndex);
  const classifications = await classifySpaces(compositeSpaces, {
    llmClassifier: options.llmClassifier ?? defaultLlmClassifier()
  });

  // Resolve climate once per model from the site coordinates. Null when the
  // IFC has no usable IfcSite location — envelope conduction is then skipped.
  const climate = resolveClimate(compositeIndex.site);

  const elementsByGlobalId = new Map(
    compositeIndex.elements.map((element) => [element.globalId, element])
  );
  const boundariesBySpaceGlobalId = new Map<string, SpaceBoundary[]>();
  for (const boundary of compositeIndex.boundaries) {
    const bucket = boundariesBySpaceGlobalId.get(boundary.spaceGlobalId) ?? [];
    bucket.push(boundary);
    boundariesBySpaceGlobalId.set(boundary.spaceGlobalId, bucket);
  }

  const spacesByStoreyId = new Map<string, SpaceSummary[]>();
  for (const space of compositeSpaces) {
    if (!space.storeyGlobalId) continue;
    const bucket = spacesByStoreyId.get(space.storeyGlobalId) ?? [];
    bucket.push(space);
    spacesByStoreyId.set(space.storeyGlobalId, bucket);
  }

  // Build a polygon-derived area fallback for IFC models whose IfcSpaces lack
  // NetFloorArea/GrossFloorArea properties. The plan layer's projected
  // polygons are in the same length unit as the storey (typically feet).
  const polygonAreaBySpaceId = new Map<string, number>();
  for (const storey of storeys) {
    for (const planSpace of storey.architecture.spaces) {
      const total = planSpace.polygons.reduce((sum, polygon) => {
        const outerArea = polygonArea(polygon.outer);
        const holeArea = polygon.holes.reduce(
          (inner, hole) => inner + polygonArea(hole),
          0
        );
        return sum + Math.max(outerArea - holeArea, 0);
      }, 0);
      if (total > 0) {
        polygonAreaBySpaceId.set(planSpace.globalId, total);
      }
    }
  }

  return storeys.map((storey) => {
    const storeySpaces = spacesByStoreyId.get(storey.globalId) ?? [];
    const spacesWithDerivedArea = storeySpaces.map((space) => {
      if (space.area !== null && space.area > 0) {
        return space;
      }
      const fallback = polygonAreaBySpaceId.get(space.globalId);
      if (fallback === undefined) {
        return space;
      }
      return { ...space, area: fallback };
    });
    const loads: StoreyLoads = computeStoreyLoads({
      modelId,
      planVersion,
      storeyGlobalId: storey.globalId,
      spaces: spacesWithDerivedArea,
      classifications: new Map<string, SpaceClassification>(
        spacesWithDerivedArea
          .map((space) => [space.globalId, classifications.get(space.globalId)] as const)
          .filter((entry): entry is readonly [string, SpaceClassification] => entry[1] !== undefined)
      ),
      lengthUnit,
      boundariesBySpaceGlobalId,
      elementsByGlobalId,
      climate
    });

    // Ground the editable plan in the loads: locate supply terminals in their
    // rooms and denormalize each space's design CFM onto them, so the plan the
    // LLM edits carries CFM targets and room ownership (not just geometry).
    const terminalCfm = assignTerminalCfm(
      storey.mechanicalEdit2D ?? [],
      storey.architecture.spaces,
      loads.spaces
    );

    return { ...storey, mechanicalEdit2D: terminalCfm.editItems, loads };
  });
}

export async function buildCompositePlanModel(
  modelId: string,
  processedSources: ProcessedSource[],
  options: BuildCompositePlanOptions = {}
): Promise<PlanModel> {
  const architectureSource =
    processedSources.find((source) => source.summary.discipline === "architecture") ?? null;
  if (!architectureSource) {
    throw new Error("Composite plan generation requires an architectural source.");
  }

  const architecturePlan = decorateArchitecturePlan(
    await extractIfcPlanModel(architectureSource.bytes, modelId),
    architectureSource.summary.sourceId
  );

  const compositeIndexForArchitectureOnly = () =>
    composeCompositeIndex(modelId, processedSources);

  const mechanicalSource =
    processedSources.find((source) => source.summary.discipline === "mechanical") ?? null;
  if (!mechanicalSource) {
    const compositeIndex = compositeIndexForArchitectureOnly();
    const lengthUnit = architecturePlan.storeys[0]?.units ?? compositeIndex.lengthUnit;
    const withLoads = await attachLoadsToStoreys(
      modelId,
      architecturePlan.planVersion,
      architecturePlan.storeys,
      compositeIndex,
      lengthUnit,
      options
    );
    return {
      ...architecturePlan,
      storeys: withLoads.map((storey) => rebasePlanStorey(storey))
    };
  }
  if (
    architecturePlan.storeys.some((storey) => storey.units !== mechanicalSource.index.lengthUnit)
  ) {
    throw new Error(
      `Composite plan generation requires one shared project length unit, found ${architecturePlan.storeys[0]?.units ?? "unknown"} and ${mechanicalSource.index.lengthUnit}.`
    );
  }

  const mechanicalLayersByStoreyId = await extractIfcMechanicalPlanLayers(
    mechanicalSource.bytes,
    modelId,
    mechanicalSource.summary.sourceId,
    architecturePlan.storeys,
    new Map(
      mechanicalSource.index.elements.map((element) => [
        element.sourceGlobalId || element.globalId,
        element.airflowType
      ])
    ),
    new Set(
      mechanicalSource.index.elements
        .filter((element) => classifySystemDomain(element.properties) === "non-air")
        .map((element) => element.sourceGlobalId || element.globalId)
    )
  );

  const merged = {
    ...architecturePlan,
    storeys: architecturePlan.storeys.map((storey) => {
      const mechanicalLayers = mechanicalLayersByStoreyId.get(storey.globalId) ?? {
        visualItems: [],
        editItems: []
      };
      return {
        ...storey,
        mechanicalVisual2D: [...mechanicalLayers.visualItems].sort((left, right) =>
          left.globalId.localeCompare(right.globalId)
        ),
        mechanicalEdit2D: [...mechanicalLayers.editItems].sort((left, right) =>
          left.id.localeCompare(right.id)
        )
      };
    })
  };

  const compositeIndex = composeCompositeIndex(modelId, processedSources);
  const connected = applyMechanicalConnections(merged, compositeIndex.relationships);
  const lengthUnit = architecturePlan.storeys[0]?.units ?? compositeIndex.lengthUnit;
  const withLoads = await attachLoadsToStoreys(
    modelId,
    connected.planVersion,
    connected.storeys,
    compositeIndex,
    lengthUnit,
    options
  );
  return {
    ...connected,
    storeys: withLoads.map((storey) => rebasePlanStorey(storey))
  };
}

export async function createUploadModel(input: {
  id?: string;
  name: string;
  ifcBytes?: Buffer;
  sources?: SourceUpload[];
}, options: { enqueue?: boolean } = {}) {
  const modelId = input.id ?? randomUUID();
  const storage = getStorageAdapter();
  const sources = input.sources?.length
    ? input.sources
    : input.ifcBytes
      ? [{
          sourceId: "architecture",
          discipline: "architecture" as const,
          name: input.name,
          ifcBytes: input.ifcBytes
        }]
      : [];
  if (sources.length === 0) {
    throw new Error("At least one IFC source is required.");
  }

  const architectureSource =
    sources.find((source) => source.discipline === "architecture") ?? sources[0];
  const sourceKey = buildSourceKey(modelId, architectureSource.sourceId);

  const model = await createModelRecord({
    id: modelId,
    name: input.name,
    sourceKey
  });

  for (const source of sources) {
    const nextSourceKey = buildSourceKey(modelId, source.sourceId);
    await storage.putObject(nextSourceKey, source.ifcBytes, "application/octet-stream");
    await createModelSourceRecord({
      modelId,
      sourceId: source.sourceId,
      discipline: source.discipline,
      name: source.name,
      sourceKey: nextSourceKey
    });
  }

  if (options.enqueue !== false) {
    await enqueueModelIngestJob({ modelId });
  }
  return (await getModelSummary(model.id)) ?? model;
}

export async function processModelIngestJob(payload: IngestJobPayload) {
  const storage = getStorageAdapter();
  const model = await getModelSummary(payload.modelId);
  if (!model) {
    throw new Error(`Model ${payload.modelId} was not found.`);
  }

  const sources = ensureModelSources(model);
  await updateModelStatus(payload.modelId, "processing", {
    errorMessage: null,
    planStatus: "processing",
    planKey: null,
    planErrorMessage: null
  });

  try {
    const processedSources: ProcessedSource[] = [];
    for (const source of sources) {
      await updateModelSourceStatus(payload.modelId, source.sourceId, "processing", {
        errorMessage: null
      });

      try {
        const stored = await storage.getObject(source.sourceKey);
        const bytes = new Uint8Array(stored.body);
        const [fragments, index] = await Promise.all([
          convertIfcToFragments(bytes),
          extractIfcIndex(bytes, payload.modelId)
        ]);
        const fragmentsKey = buildSourceFragmentsKey(payload.modelId, source.sourceId);
        const indexKey = buildSourceIndexKey(payload.modelId, source.sourceId);
        await Promise.all([
          storage.putObject(
            fragmentsKey,
            Buffer.from(fragments),
            "application/octet-stream"
          ),
          storage.putObject(
            indexKey,
            Buffer.from(JSON.stringify(index, null, 2)),
            "application/json"
          )
        ]);
        await updateModelSourceStatus(payload.modelId, source.sourceId, "ready", {
          schema: index.schema,
          fragmentsKey,
          indexKey,
          errorMessage: null,
          counts: {
            storeys: index.storeys.length,
            spaces: index.spaces.length,
            elements: index.elements.length
          }
        });
        processedSources.push({
          summary: {
            ...source,
            status: "ready",
            schema: index.schema,
            fragmentsKey,
            indexKey,
            counts: {
              storeys: index.storeys.length,
              spaces: index.spaces.length,
              elements: index.elements.length
            },
            fragmentsUrl: `/api/models/${payload.modelId}/sources/${source.sourceId}/fragments`,
            errorMessage: null
          },
          bytes,
          index
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown IFC ingestion error.";
        await updateModelSourceStatus(payload.modelId, source.sourceId, "failed", {
          errorMessage: message
        });
        throw error;
      }
    }

    const compositeIndex = composeCompositeIndex(payload.modelId, processedSources);
    await replaceModelIndex(payload.modelId, compositeIndex, {
      fragmentsKey: "",
      indexKey: ""
    });
    const plan = await buildCompositePlanModel(payload.modelId, processedSources);
    await persistPlanModel(payload.modelId, plan);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown IFC ingestion error.";
    await updateModelStatus(payload.modelId, "failed", {
      errorMessage: message,
      planStatus: "failed",
      planErrorMessage: message
    });
    throw error;
  }
}

async function persistPlanModel(modelId: string, plan: PlanModel) {
  const storage = getStorageAdapter();
  const planKey = buildPlanKey(modelId);
  const layerWrites: Promise<unknown>[] = [];
  const manifest: StoredPlanModel = {
    modelId,
    planVersion: plan.planVersion,
    schema: plan.schema,
    storeys: plan.storeys.map((storey) => {
      const layerKeys = {
        architecture: buildPlanLayerKey(modelId, storey.globalId, "architecture"),
        mechanicalVisual2D: buildPlanLayerKey(modelId, storey.globalId, "mechanicalVisual2D"),
        mechanicalEdit2D: buildPlanLayerKey(modelId, storey.globalId, "mechanicalEdit2D"),
        loads: buildPlanLayerKey(modelId, storey.globalId, "loads")
      };

      layerWrites.push(
        storage.putObject(
          layerKeys.architecture,
          Buffer.from(JSON.stringify(storey.architecture, null, 2)),
          "application/json"
        ),
        storage.putObject(
          layerKeys.mechanicalVisual2D,
          Buffer.from(JSON.stringify(storey.mechanicalVisual2D, null, 2)),
          "application/json"
        ),
        storage.putObject(
          layerKeys.mechanicalEdit2D,
          Buffer.from(JSON.stringify(storey.mechanicalEdit2D, null, 2)),
          "application/json"
        ),
        storage.putObject(
          layerKeys.loads,
          Buffer.from(JSON.stringify(storey.loads, null, 2)),
          "application/json"
        )
      );

      return planStoreyManifestSchema.parse({
        modelId: storey.modelId,
        planVersion: storey.planVersion,
        globalId: storey.globalId,
        name: storey.name,
        longName: storey.longName,
        elevation: storey.elevation,
        sortOrder: storey.sortOrder,
        units: storey.units,
        origin3D: storey.origin3D,
        uAxis3D: storey.uAxis3D,
        vAxis3D: storey.vAxis3D,
        upAxis3D: storey.upAxis3D,
        worldBounds3D: storey.worldBounds3D,
        bounds: storey.bounds,
        contextBounds: storey.contextBounds,
        focusBounds: storey.focusBounds,
        layerKeys
      });
    })
  };

  await Promise.all([
    ...layerWrites,
    storage.putObject(
      planKey,
      Buffer.from(JSON.stringify(manifest, null, 2)),
      "application/json"
    )
  ]);

  await updatePlanStatus(modelId, "ready", {
    planKey,
    planErrorMessage: null
  });
}

export async function regeneratePlanModel(modelId: string) {
  const storage = getStorageAdapter();
  const model = await getModelSummary(modelId);
  if (!model) {
    throw new Error(`Model ${modelId} was not found.`);
  }
  if (model.status !== "ready") {
    return;
  }

  await updatePlanStatus(modelId, "processing", {
    planKey: null,
    planErrorMessage: null
  });

  try {
    const sources = ensureModelSources(model);
    const processedSources: ProcessedSource[] = [];
    for (const source of sources) {
      const stored = await storage.getObject(source.sourceKey);
      const bytes = new Uint8Array(stored.body);
      processedSources.push({
        summary: source,
        bytes,
        index: await extractIfcIndex(bytes, modelId)
      });
    }
    const plan = await buildCompositePlanModel(modelId, processedSources);
    await persistPlanModel(modelId, plan);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown IFC plan extraction error.";
    await updatePlanStatus(modelId, "failed", {
      planKey: null,
      planErrorMessage: message
    });
  }
}

export function queuePlanRegeneration(modelId: string) {
  const existing = planRegenerationJobs.get(modelId);
  if (existing) {
    return existing;
  }

  const job = regeneratePlanModel(modelId).finally(() => {
    planRegenerationJobs.delete(modelId);
  });
  planRegenerationJobs.set(modelId, job);
  return job;
}

export async function getPlanModel(modelId: string): Promise<PlanModel | null> {
  const model = await getModelSummary(modelId);
  if (!model) {
    return null;
  }
  if (model.status !== "ready") {
    return null;
  }
  const candidateKeys = Array.from(
    new Set([model.planKey, buildPlanKey(modelId)].filter((key): key is string => Boolean(key)))
  );

  for (const key of candidateKeys) {
    try {
      const plan = await readStoredPlanByKey(key);
      if (plan) {
        return plan;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function getPlanStorey(
  modelId: string,
  storeyGlobalId?: string,
  layers: ReadonlyArray<
    "architecture" | "mechanicalVisual2D" | "mechanicalEdit2D" | "loads"
  > = DEFAULT_PLAN_LAYERS
): Promise<PlanStorey | null> {
  const plan = await getPlanModel(modelId);
  if (!plan) {
    return null;
  }

  const storey = storeyGlobalId
    ? plan.storeys.find((candidate) => candidate.globalId === storeyGlobalId) ?? null
    : plan.storeys[0] ?? null;

  if (!storey) {
    return null;
  }

  const selectedLayers = new Set(layers);
  const emptyLoads: StoreyLoads = {
    modelId: storey.modelId,
    storeyGlobalId: storey.globalId,
    planVersion: storey.planVersion,
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
  };
  return planStoreySchema.parse({
    ...storey,
    architecture: selectedLayers.has("architecture")
      ? storey.architecture
      : {
          primitives: [],
          spaces: []
        },
    mechanicalVisual2D: selectedLayers.has("mechanicalVisual2D")
      ? storey.mechanicalVisual2D
      : [],
    mechanicalEdit2D: selectedLayers.has("mechanicalEdit2D")
      ? storey.mechanicalEdit2D
      : [],
    loads: selectedLayers.has("loads") ? storey.loads : emptyLoads
  });
}
