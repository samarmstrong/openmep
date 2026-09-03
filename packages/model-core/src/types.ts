import { z } from "zod";

export const modelDisciplineSchema = z.enum(["architecture", "mechanical"]);

export type ModelDiscipline = z.infer<typeof modelDisciplineSchema>;

export const airflowTypeSchema = z.enum([
  "supply",
  "return",
  "exhaust",
  "outside-air",
  "unknown"
]);

export type AirflowType = z.infer<typeof airflowTypeSchema>;

export const systemAssignmentSchema = z.object({
  systemGlobalId: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  airflowType: airflowTypeSchema.default("unknown")
});

export type SystemAssignment = z.infer<typeof systemAssignmentSchema>;

export const modelStatusSchema = z.enum([
  "uploaded",
  "processing",
  "ready",
  "failed"
]);

export type ModelStatus = z.infer<typeof modelStatusSchema>;

export const bounds3DSchema = z.object({
  min: z.tuple([z.number(), z.number(), z.number()]),
  max: z.tuple([z.number(), z.number(), z.number()])
});

export type Bounds3D = z.infer<typeof bounds3DSchema>;

export const point3DSchema = z.tuple([z.number(), z.number(), z.number()]);

export type Point3D = z.infer<typeof point3DSchema>;

export const point2DSchema = z.tuple([z.number(), z.number()]);

export type Point2D = z.infer<typeof point2DSchema>;

export const lengthUnitSchema = z.string().trim().min(1);

export type LengthUnit = z.infer<typeof lengthUnitSchema>;

export const bounds2DSchema = z.object({
  min: point2DSchema,
  max: point2DSchema
});

export type Bounds2D = z.infer<typeof bounds2DSchema>;

export const planPolygonSchema = z.object({
  outer: z.array(point2DSchema).min(3),
  holes: z.array(z.array(point2DSchema).min(3)).default([])
});

export type PlanPolygon = z.infer<typeof planPolygonSchema>;

export const planPrimitiveKindSchema = z.enum([
  "wall",
  "door-opening",
  "column",
  "space"
]);

export type PlanPrimitiveKind = z.infer<typeof planPrimitiveKindSchema>;

export const planLinearKindSchema = z.enum(["mech-segment"]);

export type PlanLinearKind = z.infer<typeof planLinearKindSchema>;

export const planSymbolKindSchema = z.enum([
  "mech-fitting",
  "mech-terminal",
  "mech-equipment"
]);

export type PlanSymbolKind = z.infer<typeof planSymbolKindSchema>;

export const planPresentationCategorySchema = z.enum(["building"]);

export type PlanPresentationCategory = z.infer<typeof planPresentationCategorySchema>;

export const sourceCountsSchema = z.object({
  storeys: z.number().int().nonnegative(),
  spaces: z.number().int().nonnegative(),
  elements: z.number().int().nonnegative()
});

export type SourceCounts = z.infer<typeof sourceCountsSchema>;

export const modelSourceSummarySchema = z.object({
  modelId: z.string(),
  sourceId: z.string(),
  discipline: modelDisciplineSchema,
  name: z.string(),
  status: modelStatusSchema,
  schema: z.string().nullable(),
  sourceKey: z.string(),
  fragmentsKey: z.string().nullable(),
  indexKey: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  counts: sourceCountsSchema,
  fragmentsUrl: z.string().nullable(),
  errorMessage: z.string().nullable()
});

export type ModelSourceSummary = z.infer<typeof modelSourceSummarySchema>;

export const modelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: modelStatusSchema,
  schema: z.string().nullable(),
  sourceKey: z.string(),
  fragmentsKey: z.string().nullable(),
  indexKey: z.string().nullable(),
  planKey: z.string().nullable(),
  planStatus: z.enum(["processing", "ready", "failed"]),
  readyForViewer: z.boolean(),
  readyForPlan: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  counts: sourceCountsSchema,
  fragmentsUrl: z.string().nullable(),
  planUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  planErrorMessage: z.string().nullable(),
  sources: z.array(modelSourceSummarySchema).default([])
});

export type ModelSummary = z.infer<typeof modelSummarySchema>;

export const storeySummarySchema = z.object({
  modelId: z.string(),
  expressId: z.number().int(),
  globalId: z.string(),
  name: z.string(),
  longName: z.string().nullable(),
  elevation: z.number().nullable(),
  sortOrder: z.number().int(),
  placement: point3DSchema.nullable(),
  bounds: bounds3DSchema.nullable()
});

export type StoreySummary = z.infer<typeof storeySummarySchema>;

export const spaceSummarySchema = z.object({
  modelId: z.string(),
  sourceId: z.string().default("architecture"),
  discipline: modelDisciplineSchema.default("architecture"),
  expressId: z.number().int(),
  sourceGlobalId: z.string().default(""),
  globalId: z.string(),
  compositeGlobalId: z.string().default(""),
  name: z.string(),
  longName: z.string().nullable(),
  storeyGlobalId: z.string().nullable(),
  area: z.number().nullable(),
  placement: point3DSchema.nullable(),
  bounds: bounds3DSchema.nullable(),
  properties: z.record(z.string(), z.unknown())
});

export type SpaceSummary = z.infer<typeof spaceSummarySchema>;

export const elementSummarySchema = z.object({
  modelId: z.string(),
  sourceId: z.string().default("architecture"),
  discipline: modelDisciplineSchema.default("architecture"),
  expressId: z.number().int(),
  sourceGlobalId: z.string().default(""),
  globalId: z.string(),
  compositeGlobalId: z.string().default(""),
  ifcClass: z.string(),
  name: z.string().nullable(),
  longName: z.string().nullable(),
  description: z.string().nullable(),
  objectType: z.string().nullable(),
  tag: z.string().nullable(),
  storeyGlobalId: z.string().nullable(),
  spaceGlobalId: z.string().nullable(),
  placement: point3DSchema.nullable(),
  airflowType: airflowTypeSchema.default("unknown"),
  systemAssignments: z.array(systemAssignmentSchema).default([]),
  properties: z.record(z.string(), z.unknown())
});

export type ElementSummary = z.infer<typeof elementSummarySchema>;

export const relationshipRecordSchema = z.object({
  modelId: z.string(),
  relationType: z.string(),
  fromGlobalId: z.string(),
  toGlobalId: z.string(),
  payload: z.record(z.string(), z.unknown())
});

export type RelationshipRecord = z.infer<typeof relationshipRecordSchema>;

export const spaceBoundaryExposureSchema = z.enum([
  "internal",
  "external",
  "external-earth"
]);

export type SpaceBoundaryExposure = z.infer<typeof spaceBoundaryExposureSchema>;

/**
 * A surface (wall/slab/roof/window/door) that bounds a space, extracted from
 * IfcRelSpaceBoundary. Feeds envelope conduction in HVAC load calculation.
 */
export const spaceBoundarySchema = z.object({
  modelId: z.string(),
  spaceGlobalId: z.string(),
  elementGlobalId: z.string(),
  boundaryType: z.enum(["physical", "virtual"]),
  internalOrExternal: spaceBoundaryExposureSchema,
  areaSqft: z.number().nonnegative(),
  /** Azimuth of the surface normal, degrees clockwise from north (0=N, 90=E).
   *  Null when it can't be derived; only used by later solar-gain work. */
  orientationDegrees: z.number().nullable()
});

export type SpaceBoundary = z.infer<typeof spaceBoundarySchema>;

export const siteLocationSchema = z.object({
  latitude: z.number().nullable(),
  longitude: z.number().nullable()
});

export type SiteLocation = z.infer<typeof siteLocationSchema>;

export const planPrimitiveSchema = z.object({
  modelId: z.string(),
  sourceId: z.string().default("architecture"),
  discipline: modelDisciplineSchema.default("architecture"),
  sourceGlobalId: z.string().default(""),
  globalId: z.string(),
  compositeGlobalId: z.string().default(""),
  expressId: z.number().int(),
  ifcClass: z.string(),
  storeyGlobalId: z.string(),
  geometryType: z.literal("area").default("area"),
  kind: planPrimitiveKindSchema,
  polygons: z.array(planPolygonSchema).min(1),
  bounds: bounds2DSchema,
  presentationCategory: planPresentationCategorySchema,
  sourceName: z.string().nullable(),
  diagnostics: z.array(z.string())
});

export type PlanPrimitive = z.infer<typeof planPrimitiveSchema>;

export const planSpaceSchema = planPrimitiveSchema.extend({
  kind: z.literal("space"),
  label: z.string(),
  secondaryLabel: z.string().nullable(),
  area: z.number().nullable(),
  labelPoint: point2DSchema
});

export type PlanSpace = z.infer<typeof planSpaceSchema>;

export const mechanicalVisualItemSchema = z.object({
  modelId: z.string(),
  sourceId: z.string().default("mechanical"),
  discipline: modelDisciplineSchema.default("mechanical"),
  sourceGlobalId: z.string().default(""),
  globalId: z.string(),
  compositeGlobalId: z.string().default(""),
  backingElementId: z.string(),
  expressId: z.number().int(),
  ifcClass: z.string(),
  storeyGlobalId: z.string(),
  geometryType: z.literal("visual"),
  kind: z.union([planLinearKindSchema, planSymbolKindSchema]),
  polygons: z.array(planPolygonSchema).min(1),
  bounds: bounds2DSchema,
  presentationCategory: planPresentationCategorySchema,
  airflowType: airflowTypeSchema.default("unknown"),
  sourceName: z.string().nullable(),
  diagnostics: z.array(z.string()),
  anchor: point2DSchema,
  rotation: z.number(),
  connectedItemIds: z.array(z.string()).default([])
});

export type MechanicalVisualItem = z.infer<typeof mechanicalVisualItemSchema>;

export const mechanicalEditEdgeItemSchema = z.object({
  id: z.string(),
  visualRef: z.string(),
  elementRef: z.string(),
  editKind: z.literal("edge"),
  kind: planLinearKindSchema,
  path: z.array(point2DSchema).min(2),
  width: z.number().positive().nullable(),
  airflowType: airflowTypeSchema.default("unknown"),
  connectedItemIds: z.array(z.string()).default([])
});

export type MechanicalEditEdgeItem = z.infer<typeof mechanicalEditEdgeItemSchema>;

export const mechanicalEditNodeItemSchema = z.object({
  id: z.string(),
  visualRef: z.string(),
  elementRef: z.string(),
  editKind: z.literal("node"),
  kind: planSymbolKindSchema,
  position: point2DSchema,
  size: z.tuple([z.number().positive(), z.number().positive()]),
  rotation: z.number(),
  airflowType: airflowTypeSchema.default("unknown"),
  connectedItemIds: z.array(z.string()).default([]),
  /** Owning space (room) resolved by point-in-polygon on `position`; null when
   *  the terminal sits outside every classified IfcSpace (corridor/plenum). */
  spaceGlobalId: z.string().nullable().default(null),
  /** Total design supply CFM required by the owning space, denormalized from the
   *  loads layer so the editable plan is self-contained for the LLM. Null for
   *  non-supply terminals or terminals with no owning space. */
  spaceDesignCfm: z.number().nonnegative().nullable().default(null),
  /** This terminal's share of the owning space's design CFM (equal split across
   *  the space's supply terminals). Null for non-supply / unowned terminals. */
  requiredCfm: z.number().nonnegative().nullable().default(null)
});

export type MechanicalEditNodeItem = z.infer<typeof mechanicalEditNodeItemSchema>;

export const mechanicalEditItemSchema = z.union([
  mechanicalEditEdgeItemSchema,
  mechanicalEditNodeItemSchema
]);

export type MechanicalEditItem = z.infer<typeof mechanicalEditItemSchema>;

export const classificationConfidenceSchema = z.enum([
  "heuristic",
  "llm",
  "override"
]);

export type ClassificationConfidence = z.infer<typeof classificationConfidenceSchema>;

export const spaceLoadSchema = z.object({
  spaceGlobalId: z.string(),
  storeyGlobalId: z.string(),
  spaceTypeKey: z.string(),
  spaceTypeDisplayName: z.string(),
  classificationConfidence: classificationConfidenceSchema,
  areaSqft: z.number().nonnegative(),
  occupants: z.number().nonnegative(),
  ventilation: z.object({
    ra: z.number().nonnegative(),
    rp: z.number().nonnegative(),
    ez: z.number().positive(),
    vbz: z.number().nonnegative(),
    voz: z.number().nonnegative()
  }),
  thermal: z.object({
    sensibleLoadBtuH: z.number().nonnegative(),
    supplyDeltaTF: z.number().positive(),
    cfm: z.number().nonnegative(),
    /** Internal sensible gain (lighting + equipment + people), Btu/h. */
    internalBtuH: z.number().nonnegative().default(0),
    /** Envelope conduction gain (U·A·ΔT across exterior boundaries), Btu/h. */
    envelopeBtuH: z.number().nonnegative().default(0),
    /** Solar gain through glazing, Btu/h. */
    solarBtuH: z.number().nonnegative().default(0),
    /** Envelope conduction split by assembly class (for diagnostics/UI). */
    envelopeBreakdown: z.record(z.string(), z.number()).default({})
  }),
  estimator: z.object({
    cfmPerSqft: z.number().nonnegative(),
    cfm: z.number().nonnegative()
  }),
  designCfm: z.number().nonnegative(),
  diagnostics: z.array(z.string()).default([])
});

export type SpaceLoad = z.infer<typeof spaceLoadSchema>;

export const storeyLoadsSchema = z.object({
  modelId: z.string(),
  storeyGlobalId: z.string(),
  planVersion: z.number().int().positive(),
  spaces: z.array(spaceLoadSchema).default([]),
  totals: z.object({
    designCfm: z.number().nonnegative(),
    ventilationCfm: z.number().nonnegative(),
    sensibleLoadBtuH: z.number().nonnegative(),
    envelopeBtuH: z.number().nonnegative().default(0),
    solarBtuH: z.number().nonnegative().default(0),
    spaceCount: z.number().int().nonnegative()
  }),
  /** Resolved climate context for this storey's loads (null when the site has
   *  no usable coordinates and envelope conduction was skipped). */
  climate: z
    .object({
      zone: z.string(),
      representativeCity: z.string(),
      coolingDryBulbF: z.number(),
      heatingDryBulbF: z.number()
    })
    .nullable()
    .default(null)
});

export type StoreyLoads = z.infer<typeof storeyLoadsSchema>;

export const planArchitectureLayerSchema = z.object({
  primitives: z.array(planPrimitiveSchema).default([]),
  spaces: z.array(planSpaceSchema).default([])
});

export type PlanArchitectureLayer = z.infer<typeof planArchitectureLayerSchema>;

export const planLayerNameSchema = z.enum([
  "architecture",
  "mechanicalVisual2D",
  "mechanicalEdit2D",
  "loads"
]);

export type PlanLayerName = z.infer<typeof planLayerNameSchema>;

export const planStoreyLayerKeysSchema = z.object({
  architecture: z.string(),
  mechanicalVisual2D: z.string(),
  mechanicalEdit2D: z.string(),
  loads: z.string()
});

export type PlanStoreyLayerKeys = z.infer<typeof planStoreyLayerKeysSchema>;

export const planStoreySchema = z.object({
  modelId: z.string(),
  planVersion: z.number().int().positive(),
  globalId: z.string(),
  name: z.string(),
  longName: z.string().nullable(),
  elevation: z.number().nullable(),
  sortOrder: z.number().int(),
  units: lengthUnitSchema,
  origin3D: point3DSchema,
  uAxis3D: point3DSchema,
  vAxis3D: point3DSchema,
  upAxis3D: point3DSchema,
  worldBounds3D: bounds3DSchema,
  bounds: bounds2DSchema,
  contextBounds: bounds2DSchema,
  focusBounds: bounds2DSchema,
  architecture: planArchitectureLayerSchema,
  mechanicalVisual2D: z.array(mechanicalVisualItemSchema).default([]),
  mechanicalEdit2D: z.array(mechanicalEditItemSchema).default([]),
  loads: storeyLoadsSchema
});

export type PlanStorey = z.infer<typeof planStoreySchema>;

export const planStoreyManifestSchema = z.object({
  modelId: z.string(),
  planVersion: z.number().int().positive(),
  globalId: z.string(),
  name: z.string(),
  longName: z.string().nullable(),
  elevation: z.number().nullable(),
  sortOrder: z.number().int(),
  units: lengthUnitSchema,
  origin3D: point3DSchema,
  uAxis3D: point3DSchema,
  vAxis3D: point3DSchema,
  upAxis3D: point3DSchema,
  worldBounds3D: bounds3DSchema,
  bounds: bounds2DSchema,
  contextBounds: bounds2DSchema,
  focusBounds: bounds2DSchema,
  layerKeys: planStoreyLayerKeysSchema
});

export type PlanStoreyManifest = z.infer<typeof planStoreyManifestSchema>;

export const planModelSchema = z.object({
  modelId: z.string(),
  planVersion: z.number().int().positive(),
  schema: z.string(),
  storeys: z.array(planStoreySchema)
});

export type PlanModel = z.infer<typeof planModelSchema>;

export const storedPlanModelSchema = z.object({
  modelId: z.string(),
  planVersion: z.number().int().positive(),
  schema: z.string(),
  storeys: z.array(planStoreyManifestSchema)
});

export type StoredPlanModel = z.infer<typeof storedPlanModelSchema>;

export const elementDetailSchema = elementSummarySchema.extend({
  relationships: z.array(relationshipRecordSchema)
});

export type ElementDetail = z.infer<typeof elementDetailSchema>;

export const propertyFilterSchema = z.object({
  path: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  contains: z.string().optional()
}).refine(
  (value) => value.equals !== undefined || value.contains !== undefined,
  "A property filter requires either equals or contains."
);

export const queryRequestSchema = z.object({
  ifcClasses: z.array(z.string()).default([]),
  storeyGlobalIds: z.array(z.string()).default([]),
  spaceGlobalIds: z.array(z.string()).default([]),
  text: z.string().trim().optional(),
  propertyFilters: z.array(propertyFilterSchema).default([]),
  limit: z.number().int().positive().max(5000).default(200)
});

export type QueryRequest = z.infer<typeof queryRequestSchema>;

export const queryResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(elementSummarySchema)
});

export type QueryResponse = z.infer<typeof queryResponseSchema>;

export const viewerModeSchema = z.enum(["2d", "3d", "plan"]);

export type ViewerMode = z.infer<typeof viewerModeSchema>;

export const viewerSelectionStateSchema = z.object({
  mode: viewerModeSchema,
  selectedStoreyGlobalId: z.string().nullable(),
  selectedSpaceGlobalId: z.string().nullable(),
  selectedElementGlobalId: z.string().nullable(),
  hiddenClasses: z.array(z.string())
});

export type ViewerSelectionState = z.infer<typeof viewerSelectionStateSchema>;

export const ingestJobPayloadSchema = z.object({
  modelId: z.string()
});

export type IngestJobPayload = z.infer<typeof ingestJobPayloadSchema>;

export type IfcIndexRecord = {
  schema: string;
  lengthUnit: LengthUnit;
  site: SiteLocation;
  storeys: StoreySummary[];
  spaces: SpaceSummary[];
  elements: ElementSummary[];
  boundaries: SpaceBoundary[];
  relationships: RelationshipRecord[];
};
