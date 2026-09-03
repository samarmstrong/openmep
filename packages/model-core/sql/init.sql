create extension if not exists pgcrypto;

create table if not exists models (
  id uuid primary key,
  name text not null,
  status text not null check (status in ('uploaded', 'processing', 'ready', 'failed')),
  schema text,
  source_key text not null,
  fragments_key text,
  index_key text,
  plan_key text,
  plan_status text not null default 'processing' check (plan_status in ('processing', 'ready', 'failed')),
  storey_count integer not null default 0,
  space_count integer not null default 0,
  element_count integer not null default 0,
  error_message text,
  plan_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists model_sources (
  model_id uuid not null references models(id) on delete cascade,
  source_id text not null,
  discipline text not null check (discipline in ('architecture', 'mechanical')),
  name text not null,
  status text not null check (status in ('uploaded', 'processing', 'ready', 'failed')),
  schema text,
  source_key text not null,
  fragments_key text,
  index_key text,
  storey_count integer not null default 0,
  space_count integer not null default 0,
  element_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (model_id, source_id)
);

alter table if exists models
  add column if not exists plan_key text;

alter table if exists models
  add column if not exists plan_status text not null default 'processing';

alter table if exists models
  add column if not exists plan_error_message text;

alter table if exists model_sources
  add column if not exists schema text;

alter table if exists model_sources
  add column if not exists fragments_key text;

alter table if exists model_sources
  add column if not exists index_key text;

alter table if exists model_sources
  add column if not exists storey_count integer not null default 0;

alter table if exists model_sources
  add column if not exists space_count integer not null default 0;

alter table if exists model_sources
  add column if not exists element_count integer not null default 0;

alter table if exists model_sources
  add column if not exists error_message text;

create table if not exists storeys (
  model_id uuid not null references models(id) on delete cascade,
  express_id integer not null,
  global_id text not null,
  name text not null,
  long_name text,
  elevation double precision,
  sort_order integer not null,
  placement jsonb,
  bounds jsonb,
  primary key (model_id, global_id)
);

create index if not exists idx_storeys_model_sort on storeys (model_id, sort_order);

create table if not exists spaces (
  model_id uuid not null references models(id) on delete cascade,
  source_id text not null default 'architecture',
  discipline text not null default 'architecture',
  express_id integer not null,
  source_global_id text not null default '',
  global_id text not null,
  name text not null,
  long_name text,
  storey_global_id text,
  area double precision,
  placement jsonb,
  bounds jsonb,
  properties jsonb not null default '{}'::jsonb,
  primary key (model_id, global_id)
);

alter table if exists spaces
  add column if not exists source_id text not null default 'architecture';

alter table if exists spaces
  add column if not exists discipline text not null default 'architecture';

alter table if exists spaces
  add column if not exists source_global_id text not null default '';

create index if not exists idx_spaces_model_storey on spaces (model_id, storey_global_id);

create table if not exists elements (
  model_id uuid not null references models(id) on delete cascade,
  source_id text not null default 'architecture',
  discipline text not null default 'architecture',
  express_id integer not null,
  source_global_id text not null default '',
  global_id text not null,
  ifc_class text not null,
  name text,
  long_name text,
  description text,
  object_type text,
  tag text,
  storey_global_id text,
  space_global_id text,
  placement jsonb,
  airflow_type text not null default 'unknown',
  system_assignments jsonb not null default '[]'::jsonb,
  properties jsonb not null default '{}'::jsonb,
  primary key (model_id, global_id)
);

alter table if exists elements
  add column if not exists source_id text not null default 'architecture';

alter table if exists elements
  add column if not exists discipline text not null default 'architecture';

alter table if exists elements
  add column if not exists source_global_id text not null default '';

alter table if exists elements
  add column if not exists airflow_type text not null default 'unknown';

alter table if exists elements
  add column if not exists system_assignments jsonb not null default '[]'::jsonb;

create index if not exists idx_elements_model_storey on elements (model_id, storey_global_id);
create index if not exists idx_elements_model_class on elements (model_id, ifc_class);

create table if not exists relationships (
  id bigserial primary key,
  model_id uuid not null references models(id) on delete cascade,
  relation_type text not null,
  from_global_id text not null,
  to_global_id text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_relationships_model_from on relationships (model_id, from_global_id);
create index if not exists idx_relationships_model_to on relationships (model_id, to_global_id);

create table if not exists space_boundaries (
  model_id uuid not null references models(id) on delete cascade,
  space_global_id text not null,
  element_global_id text not null,
  boundary_type text not null,
  internal_or_external text not null,
  area_sqft double precision not null,
  orientation_degrees double precision,
  primary key (model_id, space_global_id, element_global_id)
);

create index if not exists idx_space_boundaries_space on space_boundaries (model_id, space_global_id);
