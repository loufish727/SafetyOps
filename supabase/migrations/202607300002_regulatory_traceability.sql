-- SafetyOps regulatory traceability foundation
--
-- This migration deliberately separates:
--   1. exact, immutable source observations;
--   2. parsed paragraph-level regulatory text;
--   3. human-reviewed operational requirements; and
--   4. company/location applicability and control mappings.
--
-- The eCFR is a current editorial compilation, not the official annual legal
-- edition. Source records therefore retain eCFR, Federal Register, OSHA, and
-- GovInfo links and dates independently. A UI must never replace those fields
-- with an unqualified "current" label.
--
-- Scheduled fetching belongs in a Supabase Edge Function. Keep service-role,
-- GovInfo, signing, and scheduler secrets in Edge Function secrets/Supabase
-- Vault. Never commit them to this migration or expose them to GitHub Pages.

create schema if not exists regulatory_private;

revoke all on schema regulatory_private from public, anon, authenticated;
grant usage on schema regulatory_private to service_role;

-- ---------------------------------------------------------------------------
-- Global source catalogue
-- ---------------------------------------------------------------------------

create table public.regulatory_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.regulatory_jurisdictions(id) on delete restrict,
  code text not null unique
    check (code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'),
  name text not null check (char_length(name) between 2 and 200),
  country_code text not null default 'US'
    check (country_code ~ '^[A-Z]{2}$'),
  subdivision_code text,
  agency_name text not null,
  agency_url text not null check (agency_url ~ '^https://'),
  coverage_scope text not null
    check (coverage_scope in (
      'federal',
      'state_private_and_public',
      'state_public_only',
      'territorial',
      'local'
    )),
  coverage_rules jsonb not null default '{}'::jsonb,
  valid_from date,
  valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table public.regulatory_sources (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null
    references public.regulatory_jurisdictions(id) on delete restrict,
  source_code text not null unique
    check (source_code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 2 and 200),
  source_kind text not null
    check (source_kind in (
      'ecfr',
      'annual_cfr',
      'federal_register',
      'osha_standard',
      'osha_interpretation',
      'osha_directive',
      'osha_publication',
      'state_code',
      'state_guidance'
    )),
  authority_class text not null
    check (authority_class in (
      'binding_regulation',
      'statute',
      'official_rulemaking',
      'interpretation',
      'enforcement_policy',
      'guidance',
      'proposal'
    )),
  base_url text not null check (base_url ~ '^https://'),
  adapter_key text not null,
  official boolean not null default true,
  poll_interval interval not null default interval '1 day'
    check (poll_interval >= interval '15 minutes'),
  -- Adapter configuration must contain no credentials or bearer tokens.
  adapter_config jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.regulatory_documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.regulatory_sources(id) on delete restrict,
  external_key text not null,
  document_kind text not null
    check (document_kind in (
      'title',
      'part',
      'standard',
      'final_rule',
      'proposed_rule',
      'notice',
      'correction',
      'interpretation_letter',
      'directive',
      'publication',
      'state_standard'
    )),
  document_number text,
  docket_number text,
  title text not null check (char_length(title) between 2 and 500),
  agency_name text not null,
  canonical_url text not null check (canonical_url ~ '^https://'),
  current_status text not null default 'current'
    check (current_status in (
      'current',
      'superseded',
      'withdrawn',
      'archived',
      'proposed',
      'reserved'
    )),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_key)
);

-- Only explicitly provisioned system curators may review global content.
-- Tenant safety-manager status alone is intentionally insufficient because the
-- global catalogue can serve more than one company.
create table regulatory_private.system_curators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  can_review boolean not null default true,
  can_approve boolean not null default false,
  active boolean not null default true,
  provisioned_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table regulatory_private.sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.regulatory_sources(id) on delete restrict,
  trigger_kind text not null
    check (trigger_kind in ('scheduled', 'manual', 'retry', 'backfill')),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed', 'cancelled')),
  requested_by uuid references auth.users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  checkpoint jsonb not null default '{}'::jsonb,
  fetched_count integer not null default 0 check (fetched_count >= 0),
  changed_count integer not null default 0 check (changed_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  -- Error summaries must be scrubbed of secrets and authorization headers.
  error_summary jsonb not null default '{}'::jsonb,
  check (finished_at is null or finished_at >= started_at)
);

create table regulatory_private.source_cursors (
  source_id uuid primary key references public.regulatory_sources(id) on delete cascade,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  latest_amended_on date,
  latest_issue_date date,
  up_to_date_as_of date,
  import_in_progress boolean,
  http_etag text,
  http_last_modified timestamptz,
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  next_check_at timestamptz not null default now(),
  last_error_code text,
  updated_at timestamptz not null default now()
);

create table regulatory_private.fetch_jobs (
  id bigint generated always as identity primary key,
  source_id uuid not null references public.regulatory_sources(id) on delete cascade,
  sync_run_id uuid references regulatory_private.sync_runs(id) on delete restrict,
  idempotency_key text not null unique,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  priority smallint not null default 100,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  -- request_spec is generated from an allowlisted adapter. It must not accept an
  -- arbitrary URL from a browser caller.
  request_spec jsonb not null default '{}'::jsonb,
  last_error jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Raw snapshots are inserted only after exact bytes have been uploaded and
-- SHA-256 verified. Failed/pending fetches belong in fetch_jobs/rejections.
create table regulatory_private.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null
    references public.regulatory_documents(id) on delete restrict,
  source_id uuid not null
    references public.regulatory_sources(id) on delete restrict,
  sync_run_id uuid not null
    references regulatory_private.sync_runs(id) on delete restrict,
  external_revision text,
  request_url text not null check (request_url ~ '^https://'),
  canonical_url text not null check (canonical_url ~ '^https://'),
  retrieved_at timestamptz not null default now(),
  http_status integer not null check (http_status between 200 and 299),
  http_etag text,
  http_last_modified timestamptz,
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  raw_storage_path text not null unique
    check (raw_storage_path like 'regulatory/%'),
  raw_sha256 text not null
    check (raw_sha256 ~ '^[0-9a-f]{64}$'),
  source_published_on date,
  source_effective_on date,
  latest_amended_on date,
  latest_issue_date date,
  up_to_date_as_of date,
  import_in_progress boolean,
  parser_version text not null,
  normalization_version text not null,
  -- Store only a safe allowlist of response headers, never cookies or auth.
  response_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, raw_sha256)
);

alter table regulatory_private.source_cursors
  add column last_snapshot_id uuid
  references regulatory_private.source_snapshots(id) on delete restrict;

create table regulatory_private.parse_runs (
  id uuid primary key default gen_random_uuid(),
  source_snapshot_id uuid not null
    references regulatory_private.source_snapshots(id) on delete restrict,
  sync_run_id uuid not null
    references regulatory_private.sync_runs(id) on delete restrict,
  parser_version text not null,
  normalization_version text not null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  unit_count integer not null default 0 check (unit_count >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  output_manifest_sha256 text
    check (output_manifest_sha256 is null or output_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  warnings jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check (finished_at is null or finished_at >= started_at)
);

create table regulatory_private.ingestion_rejections (
  id bigint generated always as identity primary key,
  sync_run_id uuid not null
    references regulatory_private.sync_runs(id) on delete restrict,
  source_id uuid not null
    references public.regulatory_sources(id) on delete restrict,
  source_snapshot_id uuid
    references regulatory_private.source_snapshots(id) on delete restrict,
  rejection_code text not null,
  safe_summary text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.regulatory_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null
    references public.regulatory_documents(id) on delete restrict,
  source_snapshot_id uuid not null
    references regulatory_private.source_snapshots(id) on delete restrict,
  revision_key text not null,
  publication_date date,
  effective_from date,
  effective_to date,
  latest_amended_on date,
  latest_issue_date date,
  up_to_date_as_of date,
  legal_status text not null default 'current'
    check (legal_status in (
      'current',
      'superseded',
      'withdrawn',
      'archived',
      'proposed',
      'reserved',
      'corrected'
    )),
  officiality text not null
    check (officiality in (
      'informational_editorial',
      'official_annual_edition',
      'agency_official',
      'agency_guidance'
    )),
  content_sha256 text not null
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  official_url text not null check (official_url ~ '^https://'),
  ecfr_url text check (ecfr_url is null or ecfr_url ~ '^https://'),
  govinfo_url text check (govinfo_url is null or govinfo_url ~ '^https://'),
  federal_register_url text
    check (federal_register_url is null or federal_register_url ~ '^https://'),
  temporal_metadata jsonb not null default '{}'::jsonb,
  supersedes_version_id uuid
    references public.regulatory_document_versions(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (document_id, revision_key),
  unique (document_id, source_snapshot_id),
  unique (id, document_id),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (supersedes_version_id is null or supersedes_version_id <> id)
);

-- regulatory_units is a logical identity. Citation changes and redesignations
-- produce unit-version relations; they do not rewrite historical identifiers.
create table public.regulatory_units (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null
    references public.regulatory_documents(id) on delete restrict,
  unit_key text not null,
  first_seen_at timestamptz not null default now(),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique (document_id, unit_key)
);

create table public.regulatory_unit_versions (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.regulatory_units(id) on delete restrict,
  document_version_id uuid not null,
  source_snapshot_id uuid not null
    references regulatory_private.source_snapshots(id) on delete restrict,
  parent_unit_version_id uuid
    references public.regulatory_unit_versions(id) on delete restrict,
  unit_type text not null
    check (unit_type in (
      'title',
      'subtitle',
      'chapter',
      'subchapter',
      'part',
      'subpart',
      'subject_group',
      'section',
      'paragraph',
      'appendix',
      'table',
      'editorial_note'
    )),
  title_number integer,
  chapter_code text,
  part_number text,
  subpart_code text,
  section_number text,
  paragraph_path text[] not null default '{}'::text[],
  canonical_citation text not null,
  citation_components jsonb not null default '{}'::jsonb,
  heading text,
  source_text text not null,
  source_locator jsonb not null,
  source_order bigint not null check (source_order >= 0),
  content_sha256 text not null
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from date,
  effective_to date,
  legal_status text not null default 'current'
    check (legal_status in (
      'current',
      'superseded',
      'withdrawn',
      'archived',
      'proposed',
      'reserved',
      'corrected'
    )),
  created_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(canonical_citation, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(heading, '')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(source_text, '')), 'C')
  ) stored,
  foreign key (document_version_id)
    references public.regulatory_document_versions(id) on delete restrict,
  unique (unit_id, document_version_id),
  unique (document_version_id, canonical_citation),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

create table public.regulatory_citation_aliases (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.regulatory_units(id) on delete restrict,
  citation_scheme text not null default 'CFR',
  citation_text text not null,
  canonical_citation text not null,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  unique (citation_scheme, citation_text, unit_id, valid_from),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table public.regulatory_unit_relations (
  id uuid primary key default gen_random_uuid(),
  from_unit_id uuid not null
    references public.regulatory_units(id) on delete restrict,
  to_unit_id uuid not null
    references public.regulatory_units(id) on delete restrict,
  relation_type text not null
    check (relation_type in (
      'supersedes',
      'redesignates',
      'corrects',
      'adopts',
      'modifies',
      'supplements',
      'equivalent_to',
      'more_stringent_than',
      'interprets',
      'cross_references'
    )),
  evidence_document_version_id uuid
    references public.regulatory_document_versions(id) on delete restrict,
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'reviewed', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  rationale text,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  unique (from_unit_id, to_unit_id, relation_type, valid_from),
  check (from_unit_id <> to_unit_id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

-- ---------------------------------------------------------------------------
-- Human-reviewed operational requirements and releases
-- ---------------------------------------------------------------------------

create table public.compliance_requirements (
  id uuid primary key default gen_random_uuid(),
  requirement_code text not null unique
    check (requirement_code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'),
  title text not null check (char_length(title) between 2 and 300),
  domain text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.compliance_requirement_versions (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null
    references public.compliance_requirements(id) on delete restrict,
  version integer not null check (version > 0),
  requirement_type text not null
    check (requirement_type in (
      'training',
      'inspection',
      'recordkeeping',
      'reporting',
      'ppe',
      'written_program',
      'medical_surveillance',
      'posting',
      'permit',
      'emergency_plan',
      'exposure_control',
      'other'
    )),
  plain_language_summary text not null,
  duty_holder text not null default 'employer',
  applicability_rules jsonb not null default '{}'::jsonb,
  exceptions jsonb not null default '[]'::jsonb,
  trigger_rules jsonb not null default '{}'::jsonb,
  cadence_rules jsonb not null default '{}'::jsonb,
  evidence_expectations jsonb not null default '{}'::jsonb,
  retention_rules jsonb not null default '{}'::jsonb,
  preparation_method text not null default 'human'
    check (preparation_method in ('human', 'machine_assisted', 'imported')),
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'retired')),
  prepared_by uuid references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  content_sha256 text
    check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requirement_id, version),
  unique (id, requirement_id)
);

create table public.requirement_citations (
  id uuid primary key default gen_random_uuid(),
  requirement_version_id uuid not null
    references public.compliance_requirement_versions(id) on delete restrict,
  unit_version_id uuid not null
    references public.regulatory_unit_versions(id) on delete restrict,
  relationship text not null
    check (relationship in (
      'mandatory_authority',
      'definition',
      'exception',
      'interpretation',
      'enforcement_policy',
      'guidance'
    )),
  is_primary boolean not null default false,
  exact_excerpt text,
  exact_excerpt_sha256 text
    check (
      exact_excerpt_sha256 is null
      or exact_excerpt_sha256 ~ '^[0-9a-f]{64}$'
    ),
  source_locator jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (requirement_version_id, unit_version_id, relationship)
);

create table public.regulatory_releases (
  id uuid primary key default gen_random_uuid(),
  release_number text not null unique,
  title text not null check (char_length(title) between 2 and 300),
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  notes text,
  manifest_sha256 text
    check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_storage_path text
    check (
      manifest_storage_path is null
      or manifest_storage_path like 'regulatory/%'
    ),
  supersedes_release_id uuid
    references public.regulatory_releases(id) on delete restrict,
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  check (supersedes_release_id is null or supersedes_release_id <> id)
);

create table public.regulatory_release_items (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null
    references public.regulatory_releases(id) on delete restrict,
  document_version_id uuid
    references public.regulatory_document_versions(id) on delete restrict,
  unit_version_id uuid
    references public.regulatory_unit_versions(id) on delete restrict,
  requirement_version_id uuid
    references public.compliance_requirement_versions(id) on delete restrict,
  item_sha256 text not null
    check (item_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (
    num_nonnulls(document_version_id, unit_version_id, requirement_version_id) = 1
  ),
  unique nulls not distinct (
    release_id,
    document_version_id,
    unit_version_id,
    requirement_version_id
  )
);

create table public.regulatory_change_sets (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.regulatory_sources(id) on delete restrict,
  detected_in_run_id uuid not null
    references regulatory_private.sync_runs(id) on delete restrict,
  from_snapshot_id uuid
    references regulatory_private.source_snapshots(id) on delete restrict,
  to_snapshot_id uuid not null
    references regulatory_private.source_snapshots(id) on delete restrict,
  status text not null default 'detected'
    check (status in (
      'detected',
      'triaged',
      'in_review',
      'approved',
      'published',
      'rejected'
    )),
  risk_level public.priority_level not null default 'medium',
  title text not null,
  summary jsonb not null default '{}'::jsonb,
  source_publication_date date,
  source_effective_date date,
  assigned_to uuid references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_snapshot_id is null or from_snapshot_id <> to_snapshot_id)
);

create table public.regulatory_change_items (
  id uuid primary key default gen_random_uuid(),
  change_set_id uuid not null
    references public.regulatory_change_sets(id) on delete restrict,
  change_type text not null
    check (change_type in (
      'added',
      'modified',
      'removed',
      'redesignated',
      'corrected',
      'status_changed'
    )),
  old_document_version_id uuid
    references public.regulatory_document_versions(id) on delete restrict,
  new_document_version_id uuid
    references public.regulatory_document_versions(id) on delete restrict,
  old_unit_version_id uuid
    references public.regulatory_unit_versions(id) on delete restrict,
  new_unit_version_id uuid
    references public.regulatory_unit_versions(id) on delete restrict,
  old_sha256 text check (old_sha256 is null or old_sha256 ~ '^[0-9a-f]{64}$'),
  new_sha256 text check (new_sha256 is null or new_sha256 ~ '^[0-9a-f]{64}$'),
  structured_diff jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    num_nonnulls(
      old_document_version_id,
      new_document_version_id,
      old_unit_version_id,
      new_unit_version_id
    ) >= 1
  )
);

create table public.regulatory_corrections (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.regulatory_sources(id) on delete restrict,
  external_key text not null,
  affected_unit_id uuid references public.regulatory_units(id) on delete restrict,
  erroneous_snapshot_id uuid
    references regulatory_private.source_snapshots(id) on delete restrict,
  corrected_snapshot_id uuid not null
    references regulatory_private.source_snapshots(id) on delete restrict,
  error_current_as_of date,
  corrected_current_as_of date not null,
  corrective_action text not null,
  official_url text not null check (official_url ~ '^https://'),
  created_at timestamptz not null default now(),
  unique (source_id, external_key)
);

-- ---------------------------------------------------------------------------
-- Company/location applicability, controls, evidence, and change workflow
-- ---------------------------------------------------------------------------

create table public.location_regulatory_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid not null,
  version integer not null check (version > 0),
  state_code text not null check (state_code ~ '^[A-Z]{2}$'),
  employer_type text not null
    check (employer_type in (
      'private',
      'state_government',
      'local_government',
      'federal',
      'tribal',
      'other'
    )),
  naics_codes text[] not null default '{}'::text[],
  operation_facts jsonb not null default '{}'::jsonb,
  hazard_facts jsonb not null default '{}'::jsonb,
  workforce_facts jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'superseded')),
  effective_from date,
  effective_to date,
  prepared_by uuid not null references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete cascade,
  unique (company_id, location_id, version),
  unique (company_id, location_id, id),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

create table public.location_jurisdiction_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid not null,
  profile_id uuid not null,
  jurisdiction_id uuid not null
    references public.regulatory_jurisdictions(id) on delete restrict,
  coverage_status text not null
    check (coverage_status in (
      'applies',
      'does_not_apply',
      'partial',
      'requires_review'
    )),
  coverage_rationale text not null,
  carve_outs jsonb not null default '[]'::jsonb,
  valid_from date,
  valid_to date,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (company_id, location_id, profile_id)
    references public.location_regulatory_profiles(company_id, location_id, id)
    on delete restrict,
  unique (profile_id, jurisdiction_id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table public.requirement_applicability_assessments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid not null,
  profile_id uuid not null,
  requirement_version_id uuid not null
    references public.compliance_requirement_versions(id) on delete restrict,
  applicability_status text not null
    check (applicability_status in (
      'applies',
      'does_not_apply',
      'conditional',
      'not_assessed'
    )),
  rationale text not null,
  input_fact_snapshot jsonb not null default '{}'::jsonb,
  decision_rule_version text,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'superseded')),
  assessed_by uuid not null references auth.users(id),
  assessed_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  valid_from date,
  valid_to date,
  supersedes_assessment_id uuid,
  assessment_sha256 text
    check (assessment_sha256 is null or assessment_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, location_id, profile_id)
    references public.location_regulatory_profiles(company_id, location_id, id)
    on delete restrict,
  unique (company_id, id),
  foreign key (company_id, supersedes_assessment_id)
    references public.requirement_applicability_assessments(company_id, id)
    on delete restrict,
  check (
    supersedes_assessment_id is null
    or supersedes_assessment_id <> id
  ),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

-- A control mapping is pinned to one immutable form, course, or document
-- version. control_locator contains stable question, lesson, or section keys.
create table public.control_requirement_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid,
  requirement_version_id uuid not null
    references public.compliance_requirement_versions(id) on delete restrict,
  form_template_version_id uuid,
  training_course_version_id uuid,
  document_version_id uuid,
  coverage_kind text not null
    check (coverage_kind in ('full', 'partial', 'supporting')),
  control_locator jsonb not null default '{}'::jsonb,
  workflow_effects jsonb not null default '{}'::jsonb,
  rationale text not null,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'superseded')),
  effective_from timestamptz,
  effective_to timestamptz,
  mapped_by uuid not null references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  mapping_sha256 text
    check (mapping_sha256 is null or mapping_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete cascade,
  foreign key (company_id, form_template_version_id)
    references public.form_template_versions(company_id, id) on delete restrict,
  foreign key (company_id, training_course_version_id)
    references public.training_course_versions(company_id, id) on delete restrict,
  foreign key (company_id, document_version_id)
    references public.document_versions(company_id, id) on delete restrict,
  check (
    num_nonnulls(
      form_template_version_id,
      training_course_version_id,
      document_version_id
    ) = 1
  ),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

-- Typed evidence links preserve referential integrity for the current modules.
-- Add a typed column/FK here when a new evidence-producing module is added;
-- do not fall back to an unconstrained entity_type/entity_id pair.
create table public.compliance_evidence_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid,
  requirement_version_id uuid not null
    references public.compliance_requirement_versions(id) on delete restrict,
  control_mapping_id uuid,
  inspection_id uuid references public.inspections(id) on delete restrict,
  incident_id uuid references public.incidents(id) on delete restrict,
  corrective_action_id uuid
    references public.corrective_actions(id) on delete restrict,
  training_assignment_id uuid
    references public.training_assignments(id) on delete restrict,
  document_acknowledgement_id uuid
    references public.document_acknowledgements(id) on delete restrict,
  evidence_locator jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  linked_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, control_mapping_id)
    references public.control_requirement_mappings(company_id, id)
    on delete restrict,
  check (
    num_nonnulls(
      inspection_id,
      incident_id,
      corrective_action_id,
      training_assignment_id,
      document_acknowledgement_id
    ) = 1
  )
);

create table public.regulatory_change_impacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid,
  change_set_id uuid not null
    references public.regulatory_change_sets(id) on delete restrict,
  requirement_version_id uuid
    references public.compliance_requirement_versions(id) on delete restrict,
  control_mapping_id uuid,
  corrective_action_id uuid
    references public.corrective_actions(id) on delete restrict,
  impact_status text not null default 'open'
    check (impact_status in (
      'open',
      'assessing',
      'action_required',
      'accepted_no_change',
      'resolved'
    )),
  severity public.priority_level not null default 'medium',
  impact_summary text not null,
  assigned_to uuid references auth.users(id),
  due_at timestamptz,
  resolution text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete cascade,
  foreign key (company_id, control_mapping_id)
    references public.control_requirement_mappings(company_id, id)
    on delete restrict
);

-- Dedicated append-only audit stream for both global and tenant regulatory
-- records. before/after hashes make silent row mutation evident inside normal
-- application authority. A database superuser can still alter PostgreSQL;
-- export signed daily manifests to independent WORM storage when legal-grade
-- non-repudiation is required.
create table public.regulatory_audit_events (
  id bigint generated always as identity primary key,
  company_id uuid references public.companies(id) on delete restrict,
  actor_user_id uuid references auth.users(id),
  actor_type text not null
    check (actor_type in ('user', 'service', 'database')),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  before_row_sha256 text
    check (before_row_sha256 is null or before_row_sha256 ~ '^[0-9a-f]{64}$'),
  after_row_sha256 text
    check (after_row_sha256 is null or after_row_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 text not null
    check (event_sha256 ~ '^[0-9a-f]{64}$'),
  source_snapshot_id uuid
    references regulatory_private.source_snapshots(id) on delete restrict,
  change_set_id uuid
    references public.regulatory_change_sets(id) on delete restrict,
  release_id uuid references public.regulatory_releases(id) on delete restrict,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index regulatory_sources_jurisdiction_idx
  on public.regulatory_sources(jurisdiction_id, active);
create index regulatory_documents_source_status_idx
  on public.regulatory_documents(source_id, current_status, last_seen_at desc);
create index regulatory_document_versions_dates_idx
  on public.regulatory_document_versions(document_id, up_to_date_as_of desc);
create index regulatory_unit_versions_citation_idx
  on public.regulatory_unit_versions(canonical_citation);
create index regulatory_unit_versions_section_idx
  on public.regulatory_unit_versions(title_number, part_number, section_number);
create index regulatory_unit_versions_search_idx
  on public.regulatory_unit_versions using gin(search_vector);
create index regulatory_unit_versions_snapshot_idx
  on public.regulatory_unit_versions(source_snapshot_id);
create index requirement_citations_requirement_idx
  on public.requirement_citations(requirement_version_id, relationship);
create index requirement_citations_unit_idx
  on public.requirement_citations(unit_version_id);
create index regulatory_release_items_release_idx
  on public.regulatory_release_items(release_id);
create index regulatory_change_sets_status_idx
  on public.regulatory_change_sets(status, source_effective_date);
create index regulatory_change_items_set_idx
  on public.regulatory_change_items(change_set_id);
create index location_regulatory_profiles_location_idx
  on public.location_regulatory_profiles(company_id, location_id, status);
create index requirement_applicability_location_idx
  on public.requirement_applicability_assessments(
    company_id,
    location_id,
    applicability_status,
    status
  );
create index control_requirement_mappings_requirement_idx
  on public.control_requirement_mappings(company_id, requirement_version_id, status);
create index compliance_evidence_requirement_idx
  on public.compliance_evidence_links(company_id, requirement_version_id, observed_at desc);
create index regulatory_change_impacts_open_idx
  on public.regulatory_change_impacts(company_id, impact_status, due_at);
create index regulatory_audit_company_time_idx
  on public.regulatory_audit_events(company_id, occurred_at desc);
create index regulatory_audit_entity_idx
  on public.regulatory_audit_events(entity_type, entity_id, occurred_at desc);
create index regulatory_snapshot_document_time_idx
  on regulatory_private.source_snapshots(document_id, retrieved_at desc);
create index regulatory_fetch_jobs_queue_idx
  on regulatory_private.fetch_jobs(status, available_at, priority);

-- ---------------------------------------------------------------------------
-- Authorization and publication helpers
-- ---------------------------------------------------------------------------

create or replace function private.is_regulatory_curator(
  target_permission text default 'review'
)
returns boolean
language sql
stable
security definer
set search_path = public, regulatory_private, pg_temp
as $$
  select exists (
    select 1
    from regulatory_private.system_curators curator
    where curator.user_id = auth.uid()
      and curator.active
      and (
        (target_permission = 'review' and curator.can_review)
        or (target_permission = 'approve' and curator.can_approve)
      )
  );
$$;

create or replace function private.is_regulatory_item_published(
  target_kind text,
  target_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.regulatory_release_items item
    join public.regulatory_releases release_record
      on release_record.id = item.release_id
    where release_record.status = 'published'
      and (
        (target_kind = 'document_version' and item.document_version_id = target_id)
        or (target_kind = 'unit_version' and item.unit_version_id = target_id)
        or (
          target_kind = 'requirement_version'
          and item.requirement_version_id = target_id
        )
      )
  );
$$;

create or replace function private.is_regulatory_document_published(
  target_document_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.regulatory_document_versions version_record
    where version_record.document_id = target_document_id
      and private.is_regulatory_item_published(
        'document_version',
        version_record.id
      )
  );
$$;

create or replace function private.is_regulatory_unit_published(
  target_unit_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.regulatory_unit_versions version_record
    where version_record.unit_id = target_unit_id
      and private.is_regulatory_item_published('unit_version', version_record.id)
  );
$$;

create or replace function private.is_compliance_requirement_published(
  target_requirement_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.compliance_requirement_versions version_record
    where version_record.requirement_id = target_requirement_id
      and private.is_regulatory_item_published(
        'requirement_version',
        version_record.id
      )
  );
$$;

-- Safe provenance surface for authenticated users and auditors. It exposes
-- exact hashes and dates but never private Storage paths, response headers, or
-- ingestion internals. Unpublished units remain curator-only.
create or replace function public.get_regulatory_lineage(
  target_unit_version_id uuid
)
returns table (
  unit_version_id uuid,
  canonical_citation text,
  heading text,
  jurisdiction_code text,
  source_kind text,
  authority_class text,
  document_title text,
  document_revision text,
  official_url text,
  document_content_sha256 text,
  unit_content_sha256 text,
  raw_source_sha256 text,
  source_published_on date,
  source_effective_on date,
  up_to_date_as_of date,
  retrieved_at timestamptz,
  parser_version text,
  normalization_version text
)
language plpgsql
stable
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.is_regulatory_curator('review')
    and not private.is_regulatory_item_published(
      'unit_version',
      target_unit_version_id
    ) then
    raise exception 'Regulatory unit is not available' using errcode = '42501';
  end if;

  return query
  select
    unit_version.id,
    unit_version.canonical_citation,
    unit_version.heading,
    jurisdiction.code,
    source_record.source_kind,
    source_record.authority_class,
    document_record.title,
    document_version.revision_key,
    document_version.official_url,
    document_version.content_sha256,
    unit_version.content_sha256,
    snapshot.raw_sha256,
    snapshot.source_published_on,
    snapshot.source_effective_on,
    snapshot.up_to_date_as_of,
    snapshot.retrieved_at,
    snapshot.parser_version,
    snapshot.normalization_version
  from public.regulatory_unit_versions unit_version
  join public.regulatory_document_versions document_version
    on document_version.id = unit_version.document_version_id
  join public.regulatory_documents document_record
    on document_record.id = document_version.document_id
  join public.regulatory_sources source_record
    on source_record.id = document_record.source_id
  join public.regulatory_jurisdictions jurisdiction
    on jurisdiction.id = source_record.jurisdiction_id
  join regulatory_private.source_snapshots snapshot
    on snapshot.id = unit_version.source_snapshot_id
  where unit_version.id = target_unit_version_id;
end;
$$;

-- pg_cron may call this database-only enqueue function. A separately deployed
-- Edge Function claims jobs and performs allowlisted HTTP requests. No secret,
-- service key, or arbitrary URL is accepted as an argument.
create or replace function regulatory_private.enqueue_due_sources()
returns integer
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  queued_count integer;
begin
  insert into regulatory_private.fetch_jobs (
    source_id,
    idempotency_key,
    request_spec
  )
  select
    source_record.id,
    source_record.id::text || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24'),
    jsonb_build_object('adapter_key', source_record.adapter_key)
  from public.regulatory_sources source_record
  left join regulatory_private.source_cursors cursor_record
    on cursor_record.source_id = source_record.id
  where source_record.active
    and coalesce(cursor_record.next_check_at, now()) <= now()
  on conflict (idempotency_key) do nothing;

  get diagnostics queued_count = row_count;
  return queued_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Immutability, review, validation, and audit trigger functions
-- ---------------------------------------------------------------------------

create or replace function regulatory_private.reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = public, regulatory_private, pg_temp
as $$
begin
  raise exception '% records are append-only', tg_table_name;
end;
$$;

create or replace function regulatory_private.validate_source_snapshot_lineage()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  document_source_id uuid;
  run_source_id uuid;
begin
  select document_record.source_id
  into document_source_id
  from public.regulatory_documents document_record
  where document_record.id = new.document_id;

  select run_record.source_id
  into run_source_id
  from regulatory_private.sync_runs run_record
  where run_record.id = new.sync_run_id;

  if document_source_id is distinct from new.source_id then
    raise exception 'Source snapshot source does not match its document';
  end if;
  if run_source_id is not null and run_source_id is distinct from new.source_id then
    raise exception 'Source snapshot source does not match its sync run';
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.validate_document_version_lineage()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  snapshot_document_id uuid;
begin
  select snapshot.document_id
  into snapshot_document_id
  from regulatory_private.source_snapshots snapshot
  where snapshot.id = new.source_snapshot_id;

  if snapshot_document_id is distinct from new.document_id then
    raise exception 'Document version snapshot belongs to a different document';
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.validate_unit_version_lineage()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  unit_document_id uuid;
  version_document_id uuid;
  snapshot_document_id uuid;
  parent_document_id uuid;
  parent_document_version_id uuid;
begin
  select unit_record.document_id
  into unit_document_id
  from public.regulatory_units unit_record
  where unit_record.id = new.unit_id;

  select version_record.document_id
  into version_document_id
  from public.regulatory_document_versions version_record
  where version_record.id = new.document_version_id;

  select snapshot.document_id
  into snapshot_document_id
  from regulatory_private.source_snapshots snapshot
  where snapshot.id = new.source_snapshot_id;

  if unit_document_id is distinct from version_document_id
    or unit_document_id is distinct from snapshot_document_id then
    raise exception 'Unit, document version, and snapshot must belong to one document';
  end if;

  if new.parent_unit_version_id is not null then
    if new.parent_unit_version_id = new.id then
      raise exception 'A unit version may not be its own parent';
    end if;

    select parent_unit.document_id, parent_version.document_version_id
    into parent_document_id, parent_document_version_id
    from public.regulatory_unit_versions parent_version
    join public.regulatory_units parent_unit
      on parent_unit.id = parent_version.unit_id
    where parent_version.id = new.parent_unit_version_id;

    if parent_document_id is distinct from unit_document_id
      or parent_document_version_id is distinct from new.document_version_id then
      raise exception 'Parent unit version must belong to the same document version';
    end if;
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.protect_unit_relation()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.review_status = 'reviewed' then
      raise exception 'Reviewed regulatory relations are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.review_status = 'reviewed' then
    raise exception 'Reviewed regulatory relations are immutable';
  end if;

  if new.review_status = 'reviewed'
    and (tg_op = 'INSERT' or old.review_status is distinct from new.review_status) then
    if not private.is_regulatory_curator('review') then
      raise exception 'Regulatory curator review permission required';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.protect_requirement_version()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'retired') then
      raise exception 'Approved requirement versions are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'retired' then
    raise exception 'Retired requirement versions are immutable';
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status <> 'retired' then
      raise exception 'An approved requirement may only advance to retired';
    end if;
    if (
      to_jsonb(new) - array['status', 'updated_at']
    ) is distinct from (
      to_jsonb(old) - array['status', 'updated_at']
    ) then
      raise exception 'Approved requirement content is immutable';
    end if;
  end if;

  if tg_op = 'INSERT' and new.prepared_by is null and auth.uid() is not null then
    new.prepared_by := auth.uid();
  end if;

  if new.status = 'approved'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not private.is_regulatory_curator('approve') then
      raise exception 'Regulatory curator approval permission required';
    end if;
    if new.prepared_by = auth.uid() then
      raise exception 'A preparer may not approve the same requirement version';
    end if;
    if not exists (
      select 1
      from public.requirement_citations citation
      where citation.requirement_version_id = new.id
        and citation.relationship = 'mandatory_authority'
    ) then
      raise exception 'At least one mandatory-authority citation is required';
    end if;

    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;

  new.content_sha256 := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'requirement_id', new.requirement_id,
          'version', new.version,
          'requirement_type', new.requirement_type,
          'plain_language_summary', new.plain_language_summary,
          'duty_holder', new.duty_holder,
          'applicability_rules', new.applicability_rules,
          'exceptions', new.exceptions,
          'trigger_rules', new.trigger_rules,
          'cadence_rules', new.cadence_rules,
          'evidence_expectations', new.evidence_expectations,
          'retention_rules', new.retention_rules
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  return new;
end;
$$;

create or replace function regulatory_private.protect_requirement_citation()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  target_version_id uuid;
  target_status text;
begin
  target_version_id := case
    when tg_op = 'DELETE' then old.requirement_version_id
    else new.requirement_version_id
  end;

  select version_record.status
  into target_status
  from public.compliance_requirement_versions version_record
  where version_record.id = target_version_id
  for update;

  if target_status in ('approved', 'retired') then
    raise exception 'Citations for approved requirement versions are immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.exact_excerpt is not null then
    new.exact_excerpt_sha256 := encode(
      digest(convert_to(new.exact_excerpt, 'UTF8'), 'sha256'),
      'hex'
    );
  else
    new.exact_excerpt_sha256 := null;
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.protect_release()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'Published regulatory releases are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'published' then
    raise exception 'Published regulatory releases are immutable';
  end if;

  if tg_op = 'INSERT' and new.status = 'published' then
    raise exception 'Create a draft release before publishing it';
  end if;

  if tg_op = 'UPDATE'
    and new.status = 'published'
    and old.status is distinct from new.status then
    if not private.is_regulatory_curator('approve') then
      raise exception 'Regulatory curator approval permission required';
    end if;
    if new.created_by = auth.uid() then
      raise exception 'A release creator may not approve the same release';
    end if;
    if new.manifest_sha256 is null or new.manifest_storage_path is null then
      raise exception 'A verified release manifest is required';
    end if;
    if not exists (
      select 1
      from storage.objects object_record
      where object_record.bucket_id = 'regulatory-source-snapshots'
        and object_record.name = new.manifest_storage_path
    ) then
      raise exception 'Release manifest object was not found in private Storage';
    end if;
    if not exists (
      select 1
      from public.regulatory_release_items item
      where item.release_id = new.id
    ) then
      raise exception 'A release must contain at least one item';
    end if;
    if exists (
      select 1
      from public.regulatory_release_items item
      join public.compliance_requirement_versions version_record
        on version_record.id = item.requirement_version_id
      where item.release_id = new.id
        and version_record.status <> 'approved'
    ) then
      raise exception 'All released requirement versions must be approved';
    end if;
    if exists (
      select 1
      from public.regulatory_release_items item
      left join public.regulatory_document_versions document_version
        on document_version.id = item.document_version_id
      left join public.regulatory_unit_versions unit_version
        on unit_version.id = item.unit_version_id
      left join public.compliance_requirement_versions requirement_version
        on requirement_version.id = item.requirement_version_id
      where item.release_id = new.id
        and item.item_sha256 is distinct from coalesce(
          document_version.content_sha256,
          unit_version.content_sha256,
          requirement_version.content_sha256
        )
    ) then
      raise exception 'Release item hash does not match its immutable version';
    end if;
    if exists (
      select 1
      from public.regulatory_release_items unit_item
      join public.regulatory_unit_versions unit_version
        on unit_version.id = unit_item.unit_version_id
      where unit_item.release_id = new.id
        and not private.is_regulatory_item_published(
          'document_version',
          unit_version.document_version_id
        )
        and not exists (
          select 1
          from public.regulatory_release_items document_item
          where document_item.release_id = new.id
            and document_item.document_version_id =
              unit_version.document_version_id
        )
    ) then
      raise exception 'Released units require their document version in this or a prior release';
    end if;
    if exists (
      select 1
      from public.regulatory_release_items requirement_item
      join public.requirement_citations citation
        on citation.requirement_version_id =
          requirement_item.requirement_version_id
      where requirement_item.release_id = new.id
        and not private.is_regulatory_item_published(
          'unit_version',
          citation.unit_version_id
        )
        and not exists (
          select 1
          from public.regulatory_release_items unit_item
          where unit_item.release_id = new.id
            and unit_item.unit_version_id = citation.unit_version_id
        )
    ) then
      raise exception 'Released requirements require every cited unit in this or a prior release';
    end if;

    new.approved_by := auth.uid();
    new.published_at := now();
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.protect_release_item()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  target_release_id uuid;
  target_status text;
begin
  target_release_id := case
    when tg_op = 'DELETE' then old.release_id
    else new.release_id
  end;

  select release_record.status
  into target_status
  from public.regulatory_releases release_record
  where release_record.id = target_release_id
  for update;

  if target_status = 'published' then
    raise exception 'Published release contents are immutable';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function regulatory_private.protect_change_set()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'published', 'rejected') then
      raise exception 'Finalized regulatory change sets are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status in ('published', 'rejected') then
    raise exception 'Finalized regulatory change sets are immutable';
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status <> 'published' then
      raise exception 'An approved change set may only advance to published';
    end if;
    if (
      to_jsonb(new) - array['status', 'published_at', 'updated_at']
    ) is distinct from (
      to_jsonb(old) - array['status', 'published_at', 'updated_at']
    ) then
      raise exception 'Approved change-set content is immutable';
    end if;
  end if;

  if new.status = 'approved'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not private.is_regulatory_curator('approve') then
      raise exception 'Regulatory curator approval permission required';
    end if;
    if new.assigned_to = auth.uid() then
      raise exception 'The assigned reviewer may not self-approve a change set';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif new.status = 'published'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not private.is_regulatory_curator('approve') then
      raise exception 'Regulatory curator approval permission required';
    end if;
    new.published_at := now();
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.protect_change_item()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  target_change_set_id uuid;
  target_status text;
begin
  target_change_set_id := case
    when tg_op = 'DELETE' then old.change_set_id
    else new.change_set_id
  end;

  select change_record.status
  into target_status
  from public.regulatory_change_sets change_record
  where change_record.id = target_change_set_id;

  if target_status in ('approved', 'published', 'rejected') then
    raise exception 'Finalized change-set items are immutable';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function regulatory_private.protect_location_profile()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'superseded') then
      raise exception 'Approved location regulatory profiles are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'superseded' then
    raise exception 'Superseded location regulatory profiles are immutable';
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status <> 'superseded' then
      raise exception 'An approved location profile may only advance to superseded';
    end if;
    if new.valid_to is null then
      raise exception 'A superseded location profile requires valid_to';
    end if;
    if (
      to_jsonb(new) - array['status', 'valid_to', 'updated_at']
    ) is distinct from (
      to_jsonb(old) - array['status', 'valid_to', 'updated_at']
    ) then
      raise exception 'Approved location profile content is immutable';
    end if;
  end if;

  if new.status = 'approved'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not private.can_manage_company(new.company_id) then
      raise exception 'Company safety-management permission required';
    end if;
    if new.prepared_by = auth.uid() then
      raise exception 'A profile preparer may not approve the same profile';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.protect_profile_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  target_profile_id uuid;
  target_status text;
begin
  target_profile_id := case
    when tg_op = 'DELETE' then old.profile_id
    else new.profile_id
  end;

  select profile.status
  into target_status
  from public.location_regulatory_profiles profile
  where profile.id = target_profile_id
  for update;

  if target_status in ('approved', 'superseded') then
    raise exception 'Jurisdiction assignments for approved profiles are immutable';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function regulatory_private.protect_applicability_assessment()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'superseded') then
      raise exception 'Approved applicability assessments are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'superseded' then
    raise exception 'Superseded applicability assessments are immutable';
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status <> 'superseded' then
      raise exception 'An approved applicability assessment may only advance to superseded';
    end if;
    if new.valid_to is null then
      raise exception 'A superseded applicability assessment requires valid_to';
    end if;
    if (
      to_jsonb(new) - array['status', 'valid_to', 'updated_at']
    ) is distinct from (
      to_jsonb(old) - array['status', 'valid_to', 'updated_at']
    ) then
      raise exception 'Approved applicability assessment content is immutable';
    end if;
  end if;

  if new.status = 'approved'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not private.can_manage_company(new.company_id) then
      raise exception 'Company safety-management permission required';
    end if;
    if new.assessed_by = auth.uid() then
      raise exception 'An assessor may not approve the same assessment';
    end if;
    if not private.is_regulatory_item_published(
      'requirement_version',
      new.requirement_version_id
    ) then
      raise exception 'Applicability may only be approved against a published requirement';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  end if;

  new.assessment_sha256 := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'company_id', new.company_id,
          'location_id', new.location_id,
          'profile_id', new.profile_id,
          'requirement_version_id', new.requirement_version_id,
          'applicability_status', new.applicability_status,
          'rationale', new.rationale,
          'input_fact_snapshot', new.input_fact_snapshot,
          'decision_rule_version', new.decision_rule_version,
          'valid_from', new.valid_from,
          'valid_to', new.valid_to
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  return new;
end;
$$;

create or replace function regulatory_private.protect_control_mapping()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  control_is_published boolean := false;
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'superseded') then
      raise exception 'Approved control mappings are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'superseded' then
    raise exception 'Superseded control mappings are immutable';
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status <> 'superseded' then
      raise exception 'An approved control mapping may only advance to superseded';
    end if;
    if new.effective_to is null then
      raise exception 'A superseded control mapping requires effective_to';
    end if;
    if (
      to_jsonb(new) - array['status', 'effective_to', 'updated_at']
    ) is distinct from (
      to_jsonb(old) - array['status', 'effective_to', 'updated_at']
    ) then
      raise exception 'Approved control mapping content is immutable';
    end if;
  end if;

  if new.form_template_version_id is not null then
    select version_record.published
    into control_is_published
    from public.form_template_versions version_record
    where version_record.id = new.form_template_version_id;
  elsif new.training_course_version_id is not null then
    select version_record.published
    into control_is_published
    from public.training_course_versions version_record
    where version_record.id = new.training_course_version_id;
  elsif new.document_version_id is not null then
    select version_record.published
    into control_is_published
    from public.document_versions version_record
    where version_record.id = new.document_version_id;
  end if;

  if new.status = 'approved'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not private.can_manage_company(new.company_id) then
      raise exception 'Company safety-management permission required';
    end if;
    if new.mapped_by = auth.uid() then
      raise exception 'A control mapper may not approve the same mapping';
    end if;
    if not coalesce(control_is_published, false) then
      raise exception 'Control mappings may only approve published control versions';
    end if;
    if not private.is_regulatory_item_published(
      'requirement_version',
      new.requirement_version_id
    ) then
      raise exception 'Control mappings may only approve published requirements';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  end if;

  new.mapping_sha256 := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'company_id', new.company_id,
          'location_id', new.location_id,
          'requirement_version_id', new.requirement_version_id,
          'form_template_version_id', new.form_template_version_id,
          'training_course_version_id', new.training_course_version_id,
          'document_version_id', new.document_version_id,
          'coverage_kind', new.coverage_kind,
          'control_locator', new.control_locator,
          'workflow_effects', new.workflow_effects,
          'rationale', new.rationale,
          'effective_from', new.effective_from,
          'effective_to', new.effective_to
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  return new;
end;
$$;

create or replace function regulatory_private.validate_typed_evidence_link()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  target_company_id uuid;
  target_location_id uuid;
  mapping_company_id uuid;
  mapping_requirement_id uuid;
begin
  if new.inspection_id is not null then
    select inspection.company_id, inspection.location_id
    into target_company_id, target_location_id
    from public.inspections inspection
    where inspection.id = new.inspection_id;
  elsif new.incident_id is not null then
    select incident.company_id, incident.location_id
    into target_company_id, target_location_id
    from public.incidents incident
    where incident.id = new.incident_id;
  elsif new.corrective_action_id is not null then
    select action_record.company_id, action_record.location_id
    into target_company_id, target_location_id
    from public.corrective_actions action_record
    where action_record.id = new.corrective_action_id;
  elsif new.training_assignment_id is not null then
    select assignment.company_id, assignment.location_id
    into target_company_id, target_location_id
    from public.training_assignments assignment
    where assignment.id = new.training_assignment_id;
  elsif new.document_acknowledgement_id is not null then
    select acknowledgement.company_id, null::uuid
    into target_company_id, target_location_id
    from public.document_acknowledgements acknowledgement
    where acknowledgement.id = new.document_acknowledgement_id;
  end if;

  if target_company_id is null then
    raise exception 'Evidence target was not found';
  end if;
  if target_company_id <> new.company_id then
    raise exception 'Evidence target belongs to a different company';
  end if;
  if new.location_id is not null
    and target_location_id is not null
    and new.location_id <> target_location_id then
    raise exception 'Evidence target belongs to a different location';
  end if;
  if new.location_id is null and target_location_id is not null then
    new.location_id := target_location_id;
  end if;

  if new.control_mapping_id is not null then
    select mapping.company_id, mapping.requirement_version_id
    into mapping_company_id, mapping_requirement_id
    from public.control_requirement_mappings mapping
    where mapping.id = new.control_mapping_id;

    if mapping_company_id is null
      or mapping_company_id <> new.company_id
      or mapping_requirement_id <> new.requirement_version_id then
      raise exception 'Evidence control mapping does not match company/requirement';
    end if;
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.validate_change_impact_links()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  action_company_id uuid;
  action_location_id uuid;
  mapping_requirement_id uuid;
  mapping_location_id uuid;
begin
  if new.corrective_action_id is not null then
    select action_record.company_id, action_record.location_id
    into action_company_id, action_location_id
    from public.corrective_actions action_record
    where action_record.id = new.corrective_action_id;

    if action_company_id is null then
      raise exception 'Corrective action was not found';
    end if;
    if action_company_id <> new.company_id then
      raise exception 'Corrective action belongs to a different company';
    end if;
    if new.location_id is not null
      and action_location_id is not null
      and new.location_id <> action_location_id then
      raise exception 'Corrective action belongs to a different location';
    end if;
    if new.location_id is null and action_location_id is not null then
      new.location_id := action_location_id;
    end if;
  end if;

  if new.control_mapping_id is not null then
    select mapping.requirement_version_id, mapping.location_id
    into mapping_requirement_id, mapping_location_id
    from public.control_requirement_mappings mapping
    where mapping.company_id = new.company_id
      and mapping.id = new.control_mapping_id;

    if mapping_requirement_id is null then
      raise exception 'Impact control mapping was not found';
    end if;
    if new.requirement_version_id is not null
      and mapping_requirement_id is distinct from new.requirement_version_id then
      raise exception 'Impact mapping and requirement version do not match';
    end if;
    if new.location_id is not null
      and mapping_location_id is not null
      and new.location_id <> mapping_location_id then
      raise exception 'Impact mapping belongs to a different location';
    end if;
    if new.location_id is null and mapping_location_id is not null then
      new.location_id := mapping_location_id;
    end if;
  end if;

  return new;
end;
$$;

create or replace function regulatory_private.write_regulatory_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  current_record jsonb;
  prior_record jsonb;
  target_company_id uuid;
  target_entity_id uuid;
  target_snapshot_id uuid;
  target_change_set_id uuid;
  target_release_id uuid;
  audit_action text;
  before_hash text;
  after_hash text;
  event_hash text;
  event_time timestamptz := clock_timestamp();
begin
  current_record := case
    when tg_op = 'DELETE' then to_jsonb(old)
    else to_jsonb(new)
  end;
  prior_record := case
    when tg_op = 'UPDATE' or tg_op = 'DELETE' then to_jsonb(old)
    else null
  end;

  target_company_id := nullif(current_record ->> 'company_id', '')::uuid;
  target_entity_id := nullif(current_record ->> 'id', '')::uuid;
  target_snapshot_id := nullif(current_record ->> 'source_snapshot_id', '')::uuid;
  target_change_set_id := coalesce(
    nullif(current_record ->> 'change_set_id', '')::uuid,
    case
      when tg_table_name = 'regulatory_change_sets' then target_entity_id
      else null
    end
  );
  target_release_id := coalesce(
    nullif(current_record ->> 'release_id', '')::uuid,
    case
      when tg_table_name = 'regulatory_releases' then target_entity_id
      else null
    end
  );

  before_hash := case
    when prior_record is null then null
    else encode(
      digest(convert_to(prior_record::text, 'UTF8'), 'sha256'),
      'hex'
    )
  end;
  after_hash := case
    when tg_op = 'DELETE' then null
    else encode(
      digest(convert_to(current_record::text, 'UTF8'), 'sha256'),
      'hex'
    )
  end;

  audit_action := case
    when tg_op = 'INSERT' then 'created'
    when tg_op = 'DELETE' then 'deleted'
    when prior_record ->> 'status' is distinct from current_record ->> 'status'
      then 'status_changed'
    else 'updated'
  end;

  event_hash := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'schema', tg_table_schema,
          'table', tg_table_name,
          'entity_id', target_entity_id,
          'action', audit_action,
          'before', before_hash,
          'after', after_hash,
          'occurred_at', event_time
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.regulatory_audit_events (
    company_id,
    actor_user_id,
    actor_type,
    entity_type,
    entity_id,
    action,
    before_row_sha256,
    after_row_sha256,
    event_sha256,
    source_snapshot_id,
    change_set_id,
    release_id,
    details,
    occurred_at
  )
  values (
    target_company_id,
    auth.uid(),
    case when auth.uid() is null then 'service' else 'user' end,
    tg_table_schema || '.' || tg_table_name,
    target_entity_id,
    audit_action,
    before_hash,
    after_hash,
    event_hash,
    target_snapshot_id,
    target_change_set_id,
    target_release_id,
    jsonb_build_object(
      'operation', tg_op,
      'from_status', prior_record ->> 'status',
      'to_status', current_record ->> 'status'
    ),
    event_time
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger regulatory_jurisdictions_touch_updated_at
before update on public.regulatory_jurisdictions
for each row execute function private.touch_updated_at();

create trigger regulatory_sources_touch_updated_at
before update on public.regulatory_sources
for each row execute function private.touch_updated_at();

create trigger regulatory_documents_touch_updated_at
before update on public.regulatory_documents
for each row execute function private.touch_updated_at();

create trigger system_curators_touch_updated_at
before update on regulatory_private.system_curators
for each row execute function private.touch_updated_at();

create trigger source_cursors_touch_updated_at
before update on regulatory_private.source_cursors
for each row execute function private.touch_updated_at();

create trigger fetch_jobs_touch_updated_at
before update on regulatory_private.fetch_jobs
for each row execute function private.touch_updated_at();

create trigger compliance_requirements_touch_updated_at
before update on public.compliance_requirements
for each row execute function private.touch_updated_at();

create trigger compliance_requirement_versions_touch_updated_at
before update on public.compliance_requirement_versions
for each row execute function private.touch_updated_at();

create trigger regulatory_change_sets_touch_updated_at
before update on public.regulatory_change_sets
for each row execute function private.touch_updated_at();

create trigger location_regulatory_profiles_touch_updated_at
before update on public.location_regulatory_profiles
for each row execute function private.touch_updated_at();

create trigger requirement_applicability_touch_updated_at
before update on public.requirement_applicability_assessments
for each row execute function private.touch_updated_at();

create trigger control_requirement_mappings_touch_updated_at
before update on public.control_requirement_mappings
for each row execute function private.touch_updated_at();

create trigger regulatory_change_impacts_touch_updated_at
before update on public.regulatory_change_impacts
for each row execute function private.touch_updated_at();

create trigger source_snapshots_validate_lineage
before insert on regulatory_private.source_snapshots
for each row execute function regulatory_private.validate_source_snapshot_lineage();

create trigger regulatory_document_versions_validate_lineage
before insert on public.regulatory_document_versions
for each row execute function regulatory_private.validate_document_version_lineage();

create trigger regulatory_unit_versions_validate_lineage
before insert on public.regulatory_unit_versions
for each row execute function regulatory_private.validate_unit_version_lineage();

create trigger source_snapshots_immutable
before update or delete on regulatory_private.source_snapshots
for each row execute function regulatory_private.reject_immutable_mutation();

create trigger regulatory_document_versions_immutable
before update or delete on public.regulatory_document_versions
for each row execute function regulatory_private.reject_immutable_mutation();

create trigger regulatory_unit_versions_immutable
before update or delete on public.regulatory_unit_versions
for each row execute function regulatory_private.reject_immutable_mutation();

create trigger regulatory_corrections_immutable
before update or delete on public.regulatory_corrections
for each row execute function regulatory_private.reject_immutable_mutation();

create trigger compliance_evidence_links_immutable
before update or delete on public.compliance_evidence_links
for each row execute function regulatory_private.reject_immutable_mutation();

create trigger regulatory_audit_events_immutable
before update or delete on public.regulatory_audit_events
for each row execute function regulatory_private.reject_immutable_mutation();

create trigger regulatory_unit_relations_protect
before insert or update or delete on public.regulatory_unit_relations
for each row execute function regulatory_private.protect_unit_relation();

create trigger compliance_requirement_versions_protect
before insert or update or delete on public.compliance_requirement_versions
for each row execute function regulatory_private.protect_requirement_version();

create trigger requirement_citations_protect
before insert or update or delete on public.requirement_citations
for each row execute function regulatory_private.protect_requirement_citation();

create trigger regulatory_releases_protect
before insert or update or delete on public.regulatory_releases
for each row execute function regulatory_private.protect_release();

create trigger regulatory_release_items_protect
before insert or update or delete on public.regulatory_release_items
for each row execute function regulatory_private.protect_release_item();

create trigger regulatory_change_sets_protect
before insert or update or delete on public.regulatory_change_sets
for each row execute function regulatory_private.protect_change_set();

create trigger regulatory_change_items_protect
before insert or update or delete on public.regulatory_change_items
for each row execute function regulatory_private.protect_change_item();

create trigger location_regulatory_profiles_protect
before insert or update or delete on public.location_regulatory_profiles
for each row execute function regulatory_private.protect_location_profile();

create trigger location_jurisdiction_assignments_protect
before insert or update or delete on public.location_jurisdiction_assignments
for each row execute function regulatory_private.protect_profile_assignment();

create trigger requirement_applicability_protect
before insert or update or delete on public.requirement_applicability_assessments
for each row execute function regulatory_private.protect_applicability_assessment();

create trigger control_requirement_mappings_protect
before insert or update or delete on public.control_requirement_mappings
for each row execute function regulatory_private.protect_control_mapping();

create trigger compliance_evidence_links_validate
before insert on public.compliance_evidence_links
for each row execute function regulatory_private.validate_typed_evidence_link();

create trigger regulatory_change_impacts_validate
before insert or update on public.regulatory_change_impacts
for each row execute function regulatory_private.validate_change_impact_links();

-- Audit exact source observations and every reviewed/tenant traceability edge.
create trigger source_snapshots_regulatory_audit
after insert on regulatory_private.source_snapshots
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_documents_regulatory_audit
after insert or update or delete on public.regulatory_documents
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_document_versions_regulatory_audit
after insert on public.regulatory_document_versions
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_unit_versions_regulatory_audit
after insert on public.regulatory_unit_versions
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_unit_relations_regulatory_audit
after insert or update or delete on public.regulatory_unit_relations
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger compliance_requirement_versions_regulatory_audit
after insert or update or delete on public.compliance_requirement_versions
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger requirement_citations_regulatory_audit
after insert or update or delete on public.requirement_citations
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_releases_regulatory_audit
after insert or update or delete on public.regulatory_releases
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_release_items_regulatory_audit
after insert or update or delete on public.regulatory_release_items
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_change_sets_regulatory_audit
after insert or update or delete on public.regulatory_change_sets
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_change_items_regulatory_audit
after insert or update or delete on public.regulatory_change_items
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_corrections_regulatory_audit
after insert on public.regulatory_corrections
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger location_regulatory_profiles_regulatory_audit
after insert or update or delete on public.location_regulatory_profiles
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger location_jurisdiction_assignments_regulatory_audit
after insert or update or delete on public.location_jurisdiction_assignments
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger requirement_applicability_regulatory_audit
after insert or update or delete on public.requirement_applicability_assessments
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger control_requirement_mappings_regulatory_audit
after insert or update or delete on public.control_requirement_mappings
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger compliance_evidence_links_regulatory_audit
after insert on public.compliance_evidence_links
for each row execute function regulatory_private.write_regulatory_audit_event();

create trigger regulatory_change_impacts_regulatory_audit
after insert or update or delete on public.regulatory_change_impacts
for each row execute function regulatory_private.write_regulatory_audit_event();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.regulatory_jurisdictions enable row level security;
alter table public.regulatory_sources enable row level security;
alter table public.regulatory_documents enable row level security;
alter table public.regulatory_document_versions enable row level security;
alter table public.regulatory_units enable row level security;
alter table public.regulatory_unit_versions enable row level security;
alter table public.regulatory_citation_aliases enable row level security;
alter table public.regulatory_unit_relations enable row level security;
alter table public.compliance_requirements enable row level security;
alter table public.compliance_requirement_versions enable row level security;
alter table public.requirement_citations enable row level security;
alter table public.regulatory_releases enable row level security;
alter table public.regulatory_release_items enable row level security;
alter table public.regulatory_change_sets enable row level security;
alter table public.regulatory_change_items enable row level security;
alter table public.regulatory_corrections enable row level security;
alter table public.location_regulatory_profiles enable row level security;
alter table public.location_jurisdiction_assignments enable row level security;
alter table public.requirement_applicability_assessments enable row level security;
alter table public.control_requirement_mappings enable row level security;
alter table public.compliance_evidence_links enable row level security;
alter table public.regulatory_change_impacts enable row level security;
alter table public.regulatory_audit_events enable row level security;

alter table regulatory_private.system_curators enable row level security;
alter table regulatory_private.sync_runs enable row level security;
alter table regulatory_private.source_cursors enable row level security;
alter table regulatory_private.fetch_jobs enable row level security;
alter table regulatory_private.source_snapshots enable row level security;
alter table regulatory_private.parse_runs enable row level security;
alter table regulatory_private.ingestion_rejections enable row level security;

-- Source/jurisdiction metadata is safe for any authenticated company member.
-- Historical inactive rows remain visible so old citations keep context.
create policy regulatory_jurisdictions_select
on public.regulatory_jurisdictions
for select to authenticated
using (true);

create policy regulatory_jurisdictions_curator_write
on public.regulatory_jurisdictions
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_sources_select
on public.regulatory_sources
for select to authenticated
using (true);

create policy regulatory_sources_curator_write
on public.regulatory_sources
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_documents_select
on public.regulatory_documents
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or private.is_regulatory_document_published(id)
);

create policy regulatory_documents_curator_write
on public.regulatory_documents
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_document_versions_select
on public.regulatory_document_versions
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or private.is_regulatory_item_published('document_version', id)
);

create policy regulatory_document_versions_curator_write
on public.regulatory_document_versions
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_units_select
on public.regulatory_units
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or private.is_regulatory_unit_published(id)
);

create policy regulatory_units_curator_write
on public.regulatory_units
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_unit_versions_select
on public.regulatory_unit_versions
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or private.is_regulatory_item_published('unit_version', id)
);

create policy regulatory_unit_versions_curator_write
on public.regulatory_unit_versions
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_citation_aliases_select
on public.regulatory_citation_aliases
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or private.is_regulatory_unit_published(unit_id)
);

create policy regulatory_citation_aliases_curator_write
on public.regulatory_citation_aliases
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_unit_relations_select
on public.regulatory_unit_relations
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or (
    review_status = 'reviewed'
    and private.is_regulatory_unit_published(from_unit_id)
    and private.is_regulatory_unit_published(to_unit_id)
  )
);

create policy regulatory_unit_relations_curator_write
on public.regulatory_unit_relations
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy compliance_requirements_select
on public.compliance_requirements
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or private.is_compliance_requirement_published(id)
);

create policy compliance_requirements_curator_write
on public.compliance_requirements
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy compliance_requirement_versions_select
on public.compliance_requirement_versions
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or private.is_regulatory_item_published('requirement_version', id)
);

create policy compliance_requirement_versions_curator_write
on public.compliance_requirement_versions
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy requirement_citations_select
on public.requirement_citations
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or (
    private.is_regulatory_item_published(
      'requirement_version',
      requirement_version_id
    )
    and private.is_regulatory_item_published('unit_version', unit_version_id)
  )
);

create policy requirement_citations_curator_write
on public.requirement_citations
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_releases_select
on public.regulatory_releases
for select to authenticated
using (
  status = 'published'
  or private.is_regulatory_curator('review')
);

create policy regulatory_releases_curator_write
on public.regulatory_releases
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_release_items_select
on public.regulatory_release_items
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or exists (
    select 1
    from public.regulatory_releases release_record
    where release_record.id = release_id
      and release_record.status = 'published'
  )
);

create policy regulatory_release_items_curator_write
on public.regulatory_release_items
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_change_sets_select
on public.regulatory_change_sets
for select to authenticated
using (
  status in ('approved', 'published')
  or private.is_regulatory_curator('review')
);

create policy regulatory_change_sets_curator_write
on public.regulatory_change_sets
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_change_items_select
on public.regulatory_change_items
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or exists (
    select 1
    from public.regulatory_change_sets change_record
    where change_record.id = change_set_id
      and change_record.status in ('approved', 'published')
  )
);

create policy regulatory_change_items_curator_write
on public.regulatory_change_items
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

create policy regulatory_corrections_select
on public.regulatory_corrections
for select to authenticated
using (true);

create policy regulatory_corrections_curator_write
on public.regulatory_corrections
for all to authenticated
using (private.is_regulatory_curator('review'))
with check (private.is_regulatory_curator('review'));

-- Company-scoped applicability and evidence.
create policy location_regulatory_profiles_select
on public.location_regulatory_profiles
for select to authenticated
using (private.can_access_location(company_id, location_id));

create policy location_regulatory_profiles_insert
on public.location_regulatory_profiles
for insert to authenticated
with check (
  private.can_manage_company(company_id)
  and prepared_by = auth.uid()
);

create policy location_regulatory_profiles_update
on public.location_regulatory_profiles
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy location_regulatory_profiles_delete
on public.location_regulatory_profiles
for delete to authenticated
using (private.can_manage_company(company_id) and status = 'draft');

create policy location_jurisdiction_assignments_select
on public.location_jurisdiction_assignments
for select to authenticated
using (private.can_access_location(company_id, location_id));

create policy location_jurisdiction_assignments_insert
on public.location_jurisdiction_assignments
for insert to authenticated
with check (private.can_manage_company(company_id));

create policy location_jurisdiction_assignments_update
on public.location_jurisdiction_assignments
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy location_jurisdiction_assignments_delete
on public.location_jurisdiction_assignments
for delete to authenticated
using (private.can_manage_company(company_id));

create policy requirement_applicability_select
on public.requirement_applicability_assessments
for select to authenticated
using (private.can_access_location(company_id, location_id));

create policy requirement_applicability_insert
on public.requirement_applicability_assessments
for insert to authenticated
with check (
  private.can_manage_company(company_id)
  and assessed_by = auth.uid()
);

create policy requirement_applicability_update
on public.requirement_applicability_assessments
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy requirement_applicability_delete
on public.requirement_applicability_assessments
for delete to authenticated
using (private.can_manage_company(company_id) and status = 'draft');

create policy control_requirement_mappings_select
on public.control_requirement_mappings
for select to authenticated
using (
  private.is_company_member(company_id)
  and (
    location_id is null
    or private.can_access_location(company_id, location_id)
  )
);

create policy control_requirement_mappings_insert
on public.control_requirement_mappings
for insert to authenticated
with check (
  private.can_manage_company(company_id)
  and mapped_by = auth.uid()
);

create policy control_requirement_mappings_update
on public.control_requirement_mappings
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy control_requirement_mappings_delete
on public.control_requirement_mappings
for delete to authenticated
using (private.can_manage_company(company_id) and status = 'draft');

create policy compliance_evidence_links_select
on public.compliance_evidence_links
for select to authenticated
using (
  private.is_company_member(company_id)
  and (
    location_id is null
    or private.can_access_location(company_id, location_id)
  )
);

-- Submission RPCs should create evidence links in the same transaction as the
-- immutable business record. Direct inserts remain safety-manager only.
create policy compliance_evidence_links_insert
on public.compliance_evidence_links
for insert to authenticated
with check (
  private.can_manage_company(company_id)
  and linked_by = auth.uid()
);

create policy regulatory_change_impacts_select
on public.regulatory_change_impacts
for select to authenticated
using (
  private.is_company_member(company_id)
  and (
    location_id is null
    or private.can_access_location(company_id, location_id)
  )
);

create policy regulatory_change_impacts_insert
on public.regulatory_change_impacts
for insert to authenticated
with check (
  (
    private.can_manage_company(company_id)
    or (
      location_id is not null
      and private.can_write_location(company_id, location_id)
    )
  )
  and created_by = auth.uid()
);

create policy regulatory_change_impacts_update
on public.regulatory_change_impacts
for update to authenticated
using (
  private.can_manage_company(company_id)
  or (
    location_id is not null
    and private.can_write_location(company_id, location_id)
  )
)
with check (
  private.can_manage_company(company_id)
  or (
    location_id is not null
    and private.can_write_location(company_id, location_id)
  )
);

create policy regulatory_audit_events_select
on public.regulatory_audit_events
for select to authenticated
using (
  private.is_regulatory_curator('review')
  or (
    company_id is not null
    and (
      private.can_manage_company(company_id)
      or private.company_role(company_id) = 'auditor'
    )
  )
);

-- ---------------------------------------------------------------------------
-- Private source Storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'regulatory-source-snapshots',
  'regulatory-source-snapshots',
  false,
  104857600,
  array[
    'application/json',
    'application/pdf',
    'application/xml',
    'application/zip',
    'text/html',
    'text/plain',
    'text/xml'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Service role is server-side only and bypasses RLS, but the explicit bucket
-- policy documents the intended boundary. There is intentionally no anon or
-- authenticated policy. Auditor downloads should use short-lived signed URLs
-- created by an authorization-checking Edge Function.
create policy regulatory_snapshot_service_access
on storage.objects
for all to service_role
using (bucket_id = 'regulatory-source-snapshots')
with check (bucket_id = 'regulatory-source-snapshots');

-- Existing audit records must block destructive company deletion. Archiving a
-- company is preferable to erasing its compliance history.
alter table public.audit_events
  drop constraint if exists audit_events_company_id_fkey;

alter table public.audit_events
  add constraint audit_events_company_id_fkey
  foreign key (company_id)
  references public.companies(id)
  on delete restrict;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on table public.regulatory_jurisdictions from anon;
revoke all on table public.regulatory_sources from anon;
revoke all on table public.regulatory_documents from anon;
revoke all on table public.regulatory_document_versions from anon;
revoke all on table public.regulatory_units from anon;
revoke all on table public.regulatory_unit_versions from anon;
revoke all on table public.regulatory_citation_aliases from anon;
revoke all on table public.regulatory_unit_relations from anon;
revoke all on table public.compliance_requirements from anon;
revoke all on table public.compliance_requirement_versions from anon;
revoke all on table public.requirement_citations from anon;
revoke all on table public.regulatory_releases from anon;
revoke all on table public.regulatory_release_items from anon;
revoke all on table public.regulatory_change_sets from anon;
revoke all on table public.regulatory_change_items from anon;
revoke all on table public.regulatory_corrections from anon;
revoke all on table public.location_regulatory_profiles from anon;
revoke all on table public.location_jurisdiction_assignments from anon;
revoke all on table public.requirement_applicability_assessments from anon;
revoke all on table public.control_requirement_mappings from anon;
revoke all on table public.compliance_evidence_links from anon;
revoke all on table public.regulatory_change_impacts from anon;
revoke all on table public.regulatory_audit_events from anon;

grant select, insert, update, delete
on table public.regulatory_jurisdictions,
  public.regulatory_sources,
  public.regulatory_documents,
  public.regulatory_document_versions,
  public.regulatory_units,
  public.regulatory_unit_versions,
  public.regulatory_citation_aliases,
  public.regulatory_unit_relations,
  public.compliance_requirements,
  public.compliance_requirement_versions,
  public.requirement_citations,
  public.regulatory_releases,
  public.regulatory_release_items,
  public.regulatory_change_sets,
  public.regulatory_change_items,
  public.regulatory_corrections
to authenticated;

grant select, insert, update, delete
on table public.location_regulatory_profiles,
  public.location_jurisdiction_assignments,
  public.requirement_applicability_assessments,
  public.control_requirement_mappings,
  public.regulatory_change_impacts
to authenticated;

grant select, insert
on table public.compliance_evidence_links
to authenticated;

grant select
on table public.regulatory_audit_events
to authenticated;

grant all privileges on all tables in schema regulatory_private to service_role;
grant usage, select on all sequences in schema regulatory_private to service_role;

revoke all on all functions in schema regulatory_private
from public, anon, authenticated;

revoke all on function private.is_regulatory_curator(text)
from public, anon, authenticated;
revoke all on function private.is_regulatory_item_published(text, uuid)
from public, anon, authenticated;
revoke all on function private.is_regulatory_document_published(uuid)
from public, anon, authenticated;
revoke all on function private.is_regulatory_unit_published(uuid)
from public, anon, authenticated;
revoke all on function private.is_compliance_requirement_published(uuid)
from public, anon, authenticated;
revoke all on function public.get_regulatory_lineage(uuid)
from public, anon, authenticated;

grant execute on function private.is_regulatory_curator(text)
to authenticated;
grant execute on function private.is_regulatory_item_published(text, uuid)
to authenticated;
grant execute on function private.is_regulatory_document_published(uuid)
to authenticated;
grant execute on function private.is_regulatory_unit_published(uuid)
to authenticated;
grant execute on function private.is_compliance_requirement_published(uuid)
to authenticated;
grant execute on function public.get_regulatory_lineage(uuid)
to authenticated;

grant execute on all functions in schema regulatory_private to service_role;

-- ---------------------------------------------------------------------------
-- Initial official-source registry
-- ---------------------------------------------------------------------------

insert into public.regulatory_jurisdictions (
  code,
  name,
  agency_name,
  agency_url,
  coverage_scope,
  coverage_rules
)
values (
  'US-FED-OSHA',
  'Federal Occupational Safety and Health',
  'Occupational Safety and Health Administration',
  'https://www.osha.gov/',
  'federal',
  jsonb_build_object(
    'state_plan_overlay_required', true,
    'general_duty_clause_requires_separate_review', true
  )
)
on conflict (code) do nothing;

insert into public.regulatory_sources (
  jurisdiction_id,
  source_code,
  name,
  source_kind,
  authority_class,
  base_url,
  adapter_key,
  official,
  poll_interval,
  adapter_config
)
select
  jurisdiction.id,
  source_seed.source_code,
  source_seed.name,
  source_seed.source_kind,
  source_seed.authority_class,
  source_seed.base_url,
  source_seed.adapter_key,
  true,
  source_seed.poll_interval,
  source_seed.adapter_config
from public.regulatory_jurisdictions jurisdiction
cross join (
  values
    (
      'us_ecfr_title_29',
      'eCFR Title 29 - Labor',
      'ecfr',
      'binding_regulation',
      'https://www.ecfr.gov/',
      'ecfr_title',
      interval '1 day',
      jsonb_build_object(
        'title', 29,
        'allowed_hosts', jsonb_build_array('www.ecfr.gov')
      )
    ),
    (
      'us_govinfo_cfr_29',
      'GovInfo Annual CFR Title 29',
      'annual_cfr',
      'binding_regulation',
      'https://www.govinfo.gov/app/collection/cfr',
      'govinfo_cfr',
      interval '7 days',
      jsonb_build_object(
        'title', 29,
        'allowed_hosts', jsonb_build_array('www.govinfo.gov', 'api.govinfo.gov')
      )
    ),
    (
      'us_federal_register_osha',
      'Federal Register - OSHA and Title 29',
      'federal_register',
      'official_rulemaking',
      'https://www.federalregister.gov/',
      'federal_register_documents',
      interval '1 day',
      jsonb_build_object(
        'cfr_title', 29,
        'allowed_hosts', jsonb_build_array(
          'www.federalregister.gov',
          'www.govinfo.gov'
        )
      )
    ),
    (
      'us_osha_standards',
      'OSHA Standards and Regulations',
      'osha_standard',
      'binding_regulation',
      'https://www.osha.gov/laws-regs/regulations',
      'osha_standard_index',
      interval '1 day',
      jsonb_build_object(
        'allowed_hosts', jsonb_build_array('www.osha.gov')
      )
    ),
    (
      'us_osha_interpretations',
      'OSHA Standard Interpretations',
      'osha_interpretation',
      'interpretation',
      'https://www.osha.gov/laws-regs/standardinterpretations',
      'osha_interpretation_index',
      interval '1 day',
      jsonb_build_object(
        'capture_archive_status', true,
        'allowed_hosts', jsonb_build_array('www.osha.gov')
      )
    ),
    (
      'us_osha_directives',
      'OSHA Enforcement Directives',
      'osha_directive',
      'enforcement_policy',
      'https://www.osha.gov/enforcement/directives',
      'osha_directive_index',
      interval '1 day',
      jsonb_build_object(
        'capture_archive_status', true,
        'allowed_hosts', jsonb_build_array('www.osha.gov')
      )
    ),
    (
      'us_osha_publications',
      'OSHA Publications and Training Guidance',
      'osha_publication',
      'guidance',
      'https://www.osha.gov/publications',
      'osha_publication_index',
      interval '7 days',
      jsonb_build_object(
        'allowed_hosts', jsonb_build_array('www.osha.gov')
      )
    )
) as source_seed(
  source_code,
  name,
  source_kind,
  authority_class,
  base_url,
  adapter_key,
  poll_interval,
  adapter_config
)
where jurisdiction.code = 'US-FED-OSHA'
on conflict (source_code) do nothing;

-- Intentional limitations:
--   * State-plan source rows/adapters must be added jurisdiction by jurisdiction;
--     there is no uniform authoritative state API.
--   * Consensus standards incorporated by reference (for example ANSI/NFPA)
--     may be copyrighted. Store citations and licensed-access metadata rather
--     than copying full text without rights.
--   * This migration provides the database boundary and queue only. It does not
--     deploy the Edge Function, Vault secret, or pg_cron schedule.
--   * True legal non-repudiation requires an independent signed/WORM export;
--     PostgreSQL/Supabase administrators remain technically capable of changing
--     database and Storage state.
