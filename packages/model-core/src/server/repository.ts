import type { PoolClient } from "pg";

import type {
  AirflowType,
  ElementDetail,
  ElementSummary,
  IfcIndexRecord,
  ModelDiscipline,
  ModelSourceSummary,
  ModelStatus,
  ModelSummary,
  QueryRequest,
  QueryResponse,
  RelationshipRecord,
  SpaceBoundary,
  SpaceSummary,
  StoreySummary
} from "../types";
import {
  airflowTypeSchema,
  elementDetailSchema,
  elementSummarySchema,
  modelSourceSummarySchema,
  modelSummarySchema,
  queryRequestSchema,
  queryResponseSchema,
  relationshipRecordSchema,
  spaceBoundarySchema,
  spaceSummarySchema,
  storeySummarySchema,
  systemAssignmentSchema
} from "../types";
import { query, withDbTransaction } from "./db";

type ModelRow = {
  id: string;
  name: string;
  status: ModelStatus;
  schema: string | null;
  source_key: string;
  fragments_key: string | null;
  index_key: string | null;
  plan_key: string | null;
  plan_status: "processing" | "ready" | "failed";
  created_at: Date;
  updated_at: Date;
  storey_count: number;
  space_count: number;
  element_count: number;
  error_message: string | null;
  plan_error_message: string | null;
};

type ModelSourceRow = {
  model_id: string;
  source_id: string;
  discipline: ModelDiscipline;
  name: string;
  status: ModelStatus;
  schema: string | null;
  source_key: string;
  fragments_key: string | null;
  index_key: string | null;
  storey_count: number;
  space_count: number;
  element_count: number;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

function rowToModelSourceSummary(row: ModelSourceRow): ModelSourceSummary {
  return modelSourceSummarySchema.parse({
    modelId: row.model_id,
    sourceId: row.source_id,
    discipline: row.discipline,
    name: row.name,
    status: row.status,
    schema: row.schema,
    sourceKey: row.source_key,
    fragmentsKey: row.fragments_key,
    indexKey: row.index_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    counts: {
      storeys: row.storey_count,
      spaces: row.space_count,
      elements: row.element_count
    },
    fragmentsUrl: row.fragments_key
      ? `/api/models/${row.model_id}/sources/${row.source_id}/fragments`
      : null,
    errorMessage: row.error_message
  });
}

function toLegacySourceFields(sources: ModelSourceSummary[]) {
  const primary =
    sources.find((source) => source.discipline === "architecture") ?? sources[0] ?? null;
  return {
    sourceKey: primary?.sourceKey ?? "",
    fragmentsKey: sources.length === 1 ? primary?.fragmentsKey ?? null : null,
    indexKey: primary?.indexKey ?? null,
    fragmentsUrl: sources.length === 1 ? primary?.fragmentsUrl ?? null : null
  };
}

function rowToModelSummary(row: ModelRow, sources: ModelSourceSummary[]): ModelSummary {
  const legacy = toLegacySourceFields(sources);
  return modelSummarySchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    schema: row.schema,
    sourceKey: legacy.sourceKey,
    fragmentsKey: legacy.fragmentsKey,
    indexKey: legacy.indexKey,
    planKey: row.plan_key,
    planStatus: row.plan_status,
    readyForViewer:
      row.status === "ready" && sources.every((source) => Boolean(source.fragmentsKey)),
    readyForPlan: row.plan_status === "ready" && Boolean(row.plan_key),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    counts: {
      storeys: row.storey_count,
      spaces: row.space_count,
      elements: row.element_count
    },
    fragmentsUrl: legacy.fragmentsUrl,
    planUrl: row.plan_key ? `/api/models/${row.id}/plan` : null,
    errorMessage: row.error_message,
    planErrorMessage: row.plan_error_message,
    sources
  });
}

async function listModelSourcesByModelIds(
  modelIds: string[]
): Promise<Map<string, ModelSourceSummary[]>> {
  if (modelIds.length === 0) {
    return new Map();
  }

  const result = await query<ModelSourceRow>(
    `select *
     from model_sources
     where model_id = any($1::uuid[])
     order by created_at asc, source_id asc`,
    [modelIds]
  );

  const grouped = new Map<string, ModelSourceSummary[]>();
  for (const row of result.rows) {
    const current = grouped.get(row.model_id) ?? [];
    current.push(rowToModelSourceSummary(row));
    grouped.set(row.model_id, current);
  }
  return grouped;
}

export async function listModelSources(modelId: string): Promise<ModelSourceSummary[]> {
  const grouped = await listModelSourcesByModelIds([modelId]);
  return grouped.get(modelId) ?? [];
}

export async function listModels(): Promise<ModelSummary[]> {
  const result = await query<ModelRow>(
    `select *
     from models
     order by created_at desc`
  );
  const sourcesByModelId = await listModelSourcesByModelIds(result.rows.map((row) => row.id));
  return result.rows.map((row) => rowToModelSummary(row, sourcesByModelId.get(row.id) ?? []));
}

export async function getModelSummary(modelId: string): Promise<ModelSummary | null> {
  const result = await query<ModelRow>(
    `select *
     from models
     where id = $1`,
    [modelId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const sources = await listModelSources(modelId);
  return rowToModelSummary(row, sources);
}

export async function createModelRecord(input: {
  id: string;
  name: string;
  sourceKey: string;
}): Promise<ModelSummary> {
  const result = await query<ModelRow>(
    `insert into models (id, name, status, source_key)
     values ($1, $2, 'uploaded', $3)
     returning *`,
    [input.id, input.name, input.sourceKey]
  );
  return rowToModelSummary(result.rows[0], []);
}

export async function createModelSourceRecord(input: {
  modelId: string;
  sourceId: string;
  discipline: ModelDiscipline;
  name: string;
  sourceKey: string;
}): Promise<void> {
  await query(
    `insert into model_sources (
       model_id,
       source_id,
       discipline,
       name,
       status,
       source_key
     ) values ($1, $2, $3, $4, 'uploaded', $5)
     on conflict (model_id, source_id) do update
       set discipline = excluded.discipline,
           name = excluded.name,
           source_key = excluded.source_key,
           updated_at = now()`,
    [
      input.modelId,
      input.sourceId,
      input.discipline,
      input.name,
      input.sourceKey
    ]
  );
}

export async function updateModelSourceStatus(
  modelId: string,
  sourceId: string,
  status: ModelStatus,
  extras: {
    schema?: string | null;
    fragmentsKey?: string | null;
    indexKey?: string | null;
    errorMessage?: string | null;
    counts?: {
      storeys: number;
      spaces: number;
      elements: number;
    };
  } = {}
): Promise<void> {
  await query(
    `update model_sources
     set status = $3,
         schema = coalesce($4, schema),
         fragments_key = $5,
         index_key = $6,
         error_message = $7,
         storey_count = $8,
         space_count = $9,
         element_count = $10,
         updated_at = now()
     where model_id = $1 and source_id = $2`,
    [
      modelId,
      sourceId,
      status,
      extras.schema ?? null,
      extras.fragmentsKey ?? null,
      extras.indexKey ?? null,
      extras.errorMessage ?? null,
      extras.counts?.storeys ?? 0,
      extras.counts?.spaces ?? 0,
      extras.counts?.elements ?? 0
    ]
  );
}

export async function updateModelStatus(
  modelId: string,
  status: ModelStatus,
  extras: {
    schema?: string | null;
    fragmentsKey?: string | null;
    indexKey?: string | null;
    errorMessage?: string | null;
    planStatus?: "processing" | "ready" | "failed" | null;
    planKey?: string | null;
    planErrorMessage?: string | null;
  } = {}
): Promise<void> {
  await query(
    `update models
     set status = $2,
         schema = coalesce($3, schema),
         fragments_key = coalesce($4, fragments_key),
         index_key = coalesce($5, index_key),
         error_message = $6,
         plan_status = coalesce($7, plan_status),
         plan_key = coalesce($8, plan_key),
         plan_error_message = coalesce($9, plan_error_message),
         updated_at = now()
     where id = $1`,
    [
      modelId,
      status,
      extras.schema ?? null,
      extras.fragmentsKey ?? null,
      extras.indexKey ?? null,
      extras.errorMessage ?? null,
      extras.planStatus ?? null,
      extras.planKey ?? null,
      extras.planErrorMessage ?? null
    ]
  );
}

export async function updatePlanStatus(
  modelId: string,
  status: "processing" | "ready" | "failed",
  extras: {
    planKey?: string | null;
    planErrorMessage?: string | null;
  } = {}
): Promise<void> {
  await query(
    `update models
     set plan_status = $2,
         plan_key = $3,
         plan_error_message = $4,
         updated_at = now()
     where id = $1`,
    [
      modelId,
      status,
      extras.planKey ?? null,
      extras.planErrorMessage ?? null
    ]
  );
}

export async function replaceModelIndex(
  modelId: string,
  index: IfcIndexRecord,
  _keys: {
    fragmentsKey: string;
    indexKey: string;
  }
): Promise<void> {
  await withDbTransaction(async (client) => {
    await client.query(`delete from space_boundaries where model_id = $1`, [modelId]);
    await client.query(`delete from relationships where model_id = $1`, [modelId]);
    await client.query(`delete from elements where model_id = $1`, [modelId]);
    await client.query(`delete from spaces where model_id = $1`, [modelId]);
    await client.query(`delete from storeys where model_id = $1`, [modelId]);

    for (const storey of index.storeys) {
      await insertStorey(storey, client);
    }

    for (const space of index.spaces) {
      await insertSpace(space, client);
    }

    for (const element of index.elements) {
      await insertElement(element, client);
    }

    for (const boundary of index.boundaries) {
      await insertSpaceBoundary(boundary, client);
    }

    for (const relationship of index.relationships) {
      await insertRelationship(relationship, client);
    }

    await client.query(
      `update models
     set status = 'ready',
           schema = $2,
           fragments_key = null,
           index_key = null,
           error_message = null,
           plan_status = 'processing',
           plan_key = null,
           plan_error_message = null,
           storey_count = $3,
           space_count = $4,
           element_count = $5,
           updated_at = now()
       where id = $1`,
      [
        modelId,
        index.schema,
        index.storeys.length,
        index.spaces.length,
        index.elements.length
      ]
    );
  });
}

async function insertStorey(storey: StoreySummary, client: PoolClient) {
  const parsed = storeySummarySchema.parse(storey);
  await query(
    `insert into storeys (
       model_id,
       express_id,
       global_id,
       name,
       long_name,
       elevation,
       sort_order,
       placement,
       bounds
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      parsed.modelId,
      parsed.expressId,
      parsed.globalId,
      parsed.name,
      parsed.longName,
      parsed.elevation,
      parsed.sortOrder,
      JSON.stringify(parsed.placement),
      JSON.stringify(parsed.bounds)
    ],
    client
  );
}

async function insertSpace(space: SpaceSummary, client: PoolClient) {
  const parsed = spaceSummarySchema.parse(space);
  await query(
    `insert into spaces (
       model_id,
       source_id,
       discipline,
       express_id,
       source_global_id,
       global_id,
       name,
       long_name,
       storey_global_id,
       area,
       placement,
       bounds,
       properties
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb)`,
    [
      parsed.modelId,
      parsed.sourceId,
      parsed.discipline,
      parsed.expressId,
      parsed.sourceGlobalId,
      parsed.globalId,
      parsed.name,
      parsed.longName,
      parsed.storeyGlobalId,
      parsed.area,
      JSON.stringify(parsed.placement),
      JSON.stringify(parsed.bounds),
      JSON.stringify(parsed.properties)
    ],
    client
  );
}

async function insertElement(element: ElementSummary, client: PoolClient) {
  const parsed = elementSummarySchema.parse(element);
  await query(
    `insert into elements (
       model_id,
       source_id,
       discipline,
       express_id,
       source_global_id,
       global_id,
       ifc_class,
       name,
       long_name,
       description,
       object_type,
       tag,
       storey_global_id,
       space_global_id,
       placement,
       airflow_type,
       system_assignments,
       properties
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17::jsonb, $18::jsonb
     )`,
    [
      parsed.modelId,
      parsed.sourceId,
      parsed.discipline,
      parsed.expressId,
      parsed.sourceGlobalId,
      parsed.globalId,
      parsed.ifcClass,
      parsed.name,
      parsed.longName,
      parsed.description,
      parsed.objectType,
      parsed.tag,
      parsed.storeyGlobalId,
      parsed.spaceGlobalId,
      JSON.stringify(parsed.placement),
      parsed.airflowType,
      JSON.stringify(parsed.systemAssignments),
      JSON.stringify(parsed.properties)
    ],
    client
  );
}

async function insertSpaceBoundary(boundary: SpaceBoundary, client: PoolClient) {
  const parsed = spaceBoundarySchema.parse(boundary);
  await query(
    `insert into space_boundaries (
       model_id,
       space_global_id,
       element_global_id,
       boundary_type,
       internal_or_external,
       area_sqft,
       orientation_degrees
     ) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (model_id, space_global_id, element_global_id) do update set
       boundary_type = excluded.boundary_type,
       internal_or_external = excluded.internal_or_external,
       area_sqft = excluded.area_sqft,
       orientation_degrees = excluded.orientation_degrees`,
    [
      parsed.modelId,
      parsed.spaceGlobalId,
      parsed.elementGlobalId,
      parsed.boundaryType,
      parsed.internalOrExternal,
      parsed.areaSqft,
      parsed.orientationDegrees
    ],
    client
  );
}

type SpaceBoundaryRow = {
  model_id: string;
  space_global_id: string;
  element_global_id: string;
  boundary_type: string;
  internal_or_external: string;
  area_sqft: number;
  orientation_degrees: number | null;
};

export async function listSpaceBoundariesByStorey(
  modelId: string,
  storeyGlobalId: string
): Promise<SpaceBoundary[]> {
  const result = await query<SpaceBoundaryRow>(
    `select b.*
     from space_boundaries b
     join spaces s
       on s.model_id = b.model_id and s.global_id = b.space_global_id
     where b.model_id = $1 and s.storey_global_id = $2
     order by b.space_global_id, b.element_global_id`,
    [modelId, storeyGlobalId]
  );
  return result.rows.map((row) =>
    spaceBoundarySchema.parse({
      modelId: row.model_id,
      spaceGlobalId: row.space_global_id,
      elementGlobalId: row.element_global_id,
      boundaryType: row.boundary_type,
      internalOrExternal: row.internal_or_external,
      areaSqft: row.area_sqft,
      orientationDegrees: row.orientation_degrees
    })
  );
}

async function insertRelationship(
  relationship: RelationshipRecord,
  client: PoolClient
) {
  const parsed = relationshipRecordSchema.parse(relationship);
  await query(
    `insert into relationships (
       model_id,
       relation_type,
       from_global_id,
       to_global_id,
       payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      parsed.modelId,
      parsed.relationType,
      parsed.fromGlobalId,
      parsed.toGlobalId,
      JSON.stringify(parsed.payload)
    ],
    client
  );
}

type StoreyRow = {
  model_id: string;
  express_id: number;
  global_id: string;
  name: string;
  long_name: string | null;
  elevation: number | null;
  sort_order: number;
  placement: [number, number, number] | null;
  bounds: StoreySummary["bounds"];
};

export async function getStoreys(modelId: string): Promise<StoreySummary[]> {
  const result = await query<StoreyRow>(
    `select *
     from storeys
     where model_id = $1
     order by sort_order asc, elevation asc nulls last, name asc`,
    [modelId]
  );

  return result.rows.map((row: StoreyRow) =>
    storeySummarySchema.parse({
      modelId: row.model_id,
      expressId: row.express_id,
      globalId: row.global_id,
      name: row.name,
      longName: row.long_name,
      elevation: row.elevation,
      sortOrder: row.sort_order,
      placement: row.placement,
      bounds: row.bounds
    })
  );
}

type SpaceRow = {
  model_id: string;
  source_id: string;
  discipline: ModelDiscipline;
  express_id: number;
  source_global_id: string;
  global_id: string;
  name: string;
  long_name: string | null;
  storey_global_id: string | null;
  area: number | null;
  placement: [number, number, number] | null;
  bounds: SpaceSummary["bounds"];
  properties: Record<string, unknown>;
};

export async function getSpaces(
  modelId: string,
  storeyGlobalId?: string
): Promise<SpaceSummary[]> {
  const values: unknown[] = [modelId];
  let whereClause = "where model_id = $1";
  if (storeyGlobalId) {
    values.push(storeyGlobalId);
    whereClause += ` and storey_global_id = $${values.length}`;
  }

  const result = await query<SpaceRow>(
    `select *
     from spaces
     ${whereClause}
     order by name asc`,
    values
  );

  return result.rows.map((row: SpaceRow) =>
    spaceSummarySchema.parse({
      modelId: row.model_id,
      sourceId: row.source_id,
      discipline: row.discipline,
      expressId: row.express_id,
      sourceGlobalId: row.source_global_id,
      globalId: row.global_id,
      compositeGlobalId: row.global_id,
      name: row.name,
      longName: row.long_name,
      storeyGlobalId: row.storey_global_id,
      area: row.area,
      placement: row.placement,
      bounds: row.bounds,
      properties: row.properties ?? {}
    })
  );
}

type ElementRow = {
  model_id: string;
  source_id: string;
  discipline: ModelDiscipline;
  express_id: number;
  source_global_id: string;
  global_id: string;
  ifc_class: string;
  name: string | null;
  long_name: string | null;
  description: string | null;
  object_type: string | null;
  tag: string | null;
  storey_global_id: string | null;
  space_global_id: string | null;
  placement: [number, number, number] | null;
  airflow_type: AirflowType;
  system_assignments: unknown[];
  properties: Record<string, unknown>;
};

function rowToElementSummary(row: ElementRow): ElementSummary {
  return elementSummarySchema.parse({
    modelId: row.model_id,
    sourceId: row.source_id,
    discipline: row.discipline,
    expressId: row.express_id,
    sourceGlobalId: row.source_global_id,
    globalId: row.global_id,
    compositeGlobalId: row.global_id,
    ifcClass: row.ifc_class,
    name: row.name,
    longName: row.long_name,
    description: row.description,
    objectType: row.object_type,
    tag: row.tag,
    storeyGlobalId: row.storey_global_id,
    spaceGlobalId: row.space_global_id,
    placement: row.placement,
    airflowType: airflowTypeSchema.parse(row.airflow_type),
    systemAssignments: (row.system_assignments ?? []).map((assignment) =>
      systemAssignmentSchema.parse(assignment)
    ),
    properties: row.properties ?? {}
  });
}

export async function getElementDetail(
  modelId: string,
  globalId: string
): Promise<ElementDetail | null> {
  const elementResult = await query<ElementRow>(
    `select *
     from elements
     where model_id = $1 and global_id = $2`,
    [modelId, globalId]
  );

  const row = elementResult.rows[0];
  if (!row) {
    return null;
  }

  const relationshipsResult = await query<{
    model_id: string;
    relation_type: string;
    from_global_id: string;
    to_global_id: string;
    payload: Record<string, unknown>;
  }>(
    `select *
     from relationships
     where model_id = $1
       and (from_global_id = $2 or to_global_id = $2)
     order by relation_type asc`,
    [modelId, globalId]
  );

  return elementDetailSchema.parse({
    ...rowToElementSummary(row),
    relationships: relationshipsResult.rows.map((relationship) =>
      relationshipRecordSchema.parse({
        modelId: relationship.model_id,
        relationType: relationship.relation_type,
        fromGlobalId: relationship.from_global_id,
        toGlobalId: relationship.to_global_id,
        payload: relationship.payload ?? {}
      })
    )
  });
}

export async function queryElements(
  modelId: string,
  request: QueryRequest
): Promise<QueryResponse> {
  const parsed = queryRequestSchema.parse(request);
  const conditions = ["model_id = $1"];
  const values: unknown[] = [modelId];

  if (parsed.ifcClasses.length > 0) {
    values.push(parsed.ifcClasses);
    conditions.push(`ifc_class = any($${values.length}::text[])`);
  }

  if (parsed.storeyGlobalIds.length > 0) {
    values.push(parsed.storeyGlobalIds);
    conditions.push(`storey_global_id = any($${values.length}::text[])`);
  }

  if (parsed.spaceGlobalIds.length > 0) {
    values.push(parsed.spaceGlobalIds);
    conditions.push(`space_global_id = any($${values.length}::text[])`);
  }

  if (parsed.text) {
    values.push(`%${parsed.text}%`);
    const placeholder = `$${values.length}`;
    conditions.push(
      `(coalesce(name, '') ilike ${placeholder}
        or coalesce(long_name, '') ilike ${placeholder}
        or coalesce(description, '') ilike ${placeholder}
        or coalesce(object_type, '') ilike ${placeholder}
        or properties::text ilike ${placeholder})`
    );
  }

  for (const filter of parsed.propertyFilters) {
    values.push(filter.path.split("."));
    const pathPlaceholder = `$${values.length}`;
    if (filter.equals !== undefined) {
      values.push(String(filter.equals));
      conditions.push(`properties #>> ${pathPlaceholder} = $${values.length}`);
    } else if (filter.contains) {
      values.push(`%${filter.contains}%`);
      conditions.push(`properties #>> ${pathPlaceholder} ilike $${values.length}`);
    }
  }

  values.push(parsed.limit);
  const limitPlaceholder = `$${values.length}`;
  const whereClause = conditions.join(" and ");

  const itemsResult = await query<ElementRow>(
    `select *
     from elements
     where ${whereClause}
     order by ifc_class asc, name asc nulls last, global_id asc
     limit ${limitPlaceholder}`,
    values
  );

  const countResult = await query<{ count: string }>(
    `select count(*)::text as count
     from elements
     where ${whereClause}`,
    values.slice(0, -1)
  );

  return queryResponseSchema.parse({
    total: Number(countResult.rows[0]?.count ?? "0"),
    items: itemsResult.rows.map(rowToElementSummary)
  });
}
