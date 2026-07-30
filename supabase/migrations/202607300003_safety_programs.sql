-- SafetyOps controlled Safety Programs
--
-- This migration adds a tenant-scoped, versioned content model for written
-- safety programs imported from Drive-like providers. It deliberately keeps:
--   * provider credentials outside PostgreSQL (Edge Function secrets/Vault);
--   * mirrored source bytes and attachments in a private Storage bucket;
--   * approved/published program content immutable;
--   * submissions, signatures, acknowledgements, and audit events append-only
--     after their terminal transition; and
--   * every regulatory claim pinned to an exact requirement and/or source-text
--     version created by 202607300002_regulatory_traceability.sql.

create extension if not exists pgcrypto;
create schema if not exists program_private;

revoke all on schema program_private from public, anon, authenticated;
grant usage on schema program_private to service_role;

-- The service role (normally a narrow Edge Function) owns object movement.
-- There are intentionally no authenticated storage.objects policies here.
insert into storage.buckets (id, name, public, file_size_limit)
values ('safety-program-private', 'safety-program-private', false, 104857600)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------
-- Private object metadata and Drive/source provenance
-- ---------------------------------------------------------------------------

create table public.safety_program_storage_objects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid,
  bucket_id text not null default 'safety-program-private'
    check (bucket_id = 'safety-program-private'),
  object_path text not null unique
    check (
      object_path !~ '(^|/)\.\.(/|$)'
      and object_path like (company_id::text || '/%')
    ),
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  mime_type text not null check (char_length(mime_type) between 3 and 160),
  size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 104857600),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  purpose text not null
    check (purpose in (
      'source_mirror',
      'form_attachment',
      'signature_artifact',
      'program_export'
    )),
  malware_scan_status text not null default 'pending'
    check (malware_scan_status in ('pending', 'clean', 'rejected', 'failed')),
  source_system text not null default 'application'
    check (source_system in ('application', 'google_drive', 'microsoft_drive', 'box', 'manual_import')),
  provider_object_version text,
  uploaded_by uuid references auth.users(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  check (
    (malware_scan_status = 'clean' and verified_at is not null)
    or malware_scan_status <> 'clean'
  )
);

create table public.safety_program_source_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  provider text not null
    check (provider in ('google_drive', 'microsoft_drive', 'box', 'manual_upload')),
  external_drive_id text not null default '',
  external_file_id text not null,
  canonical_url text check (canonical_url is null or canonical_url ~ '^https://'),
  title text not null check (char_length(title) between 1 and 300),
  declared_mime_type text,
  classification text not null default 'internal'
    check (classification in ('internal', 'confidential', 'restricted')),
  source_owner text,
  sync_enabled boolean not null default true,
  active boolean not null default true,
  last_observed_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, provider, external_drive_id, external_file_id)
);

create table public.safety_program_source_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  source_document_id uuid not null,
  provider_revision_id text not null,
  provider_modified_at timestamptz,
  provider_etag text,
  storage_object_id uuid not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_metadata jsonb not null default '{}'::jsonb,
  extraction_metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  imported_by uuid references auth.users(id),
  imported_at timestamptz not null default now(),
  unique (company_id, id),
  unique (source_document_id, provider_revision_id),
  unique (source_document_id, content_sha256),
  foreign key (company_id, source_document_id)
    references public.safety_program_source_documents(company_id, id)
    on delete restrict,
  foreign key (company_id, storage_object_id)
    references public.safety_program_storage_objects(company_id, id)
    on delete restrict,
  check (jsonb_typeof(source_metadata) = 'object'),
  check (jsonb_typeof(extraction_metadata) = 'object')
);

-- The source version's storage_object_id is always the canonical provider
-- revision. Optional renderings/extractions are immutable derived artifacts.
create table public.safety_program_source_version_artifacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  source_version_id uuid not null,
  storage_object_id uuid not null,
  artifact_kind text not null
    check (artifact_kind in (
      'native_companion',
      'rendered_pdf',
      'extracted_text',
      'structured_extraction',
      'spreadsheet_export',
      'thumbnail'
    )),
  derivation_tool text not null,
  derivation_version text not null,
  derivation_metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (source_version_id, storage_object_id, artifact_kind),
  foreign key (company_id, source_version_id)
    references public.safety_program_source_versions(company_id, id) on delete restrict,
  foreign key (company_id, storage_object_id)
    references public.safety_program_storage_objects(company_id, id) on delete restrict,
  check (jsonb_typeof(derivation_metadata) = 'object')
);

-- ---------------------------------------------------------------------------
-- Controlled program editions and section-level source lineage
-- ---------------------------------------------------------------------------

create table public.safety_programs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  program_code text not null check (program_code ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'),
  title text not null check (char_length(title) between 2 and 240),
  description text,
  category text not null default 'General',
  owner_profile_id uuid references public.profiles(id) on delete restrict,
  lifecycle_status text not null default 'active'
    check (lifecycle_status in ('active', 'archived')),
  review_interval_months integer not null default 12
    check (review_interval_months between 1 and 120),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, program_code)
);

create table public.safety_program_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  program_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'published', 'superseded')),
  change_summary text not null default '',
  effective_from date,
  effective_to date,
  next_review_at date,
  source_manifest_sha256 text
    check (source_manifest_sha256 is null or source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  content_manifest_sha256 text
    check (content_manifest_sha256 is null or content_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_by uuid not null references auth.users(id),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  published_by uuid references auth.users(id),
  published_at timestamptz,
  supersedes_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (program_id, version),
  unique (company_id, id),
  unique (company_id, program_id, id),
  foreign key (company_id, program_id)
    references public.safety_programs(company_id, id) on delete restrict,
  foreign key (company_id, supersedes_version_id)
    references public.safety_program_versions(company_id, id) on delete restrict,
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (supersedes_version_id is null or supersedes_version_id <> id),
  check (
    (status in ('approved', 'published', 'superseded') and approved_at is not null and approved_by is not null)
    or status in ('draft', 'in_review')
  ),
  check (
    (status in ('published', 'superseded') and published_at is not null and published_by is not null)
    or status in ('draft', 'in_review', 'approved')
  )
);

create unique index safety_program_one_published_version_idx
  on public.safety_program_versions(program_id)
  where status = 'published';

create table public.safety_program_version_sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  source_version_id uuid not null,
  relationship text not null default 'authoritative_source'
    check (relationship in (
      'authoritative_source',
      'supporting_source',
      'superseded_source',
      'reference_only'
    )),
  source_locator jsonb not null default '{}'::jsonb,
  linked_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (program_version_id, source_version_id, relationship),
  foreign key (company_id, program_version_id)
    references public.safety_program_versions(company_id, id) on delete restrict,
  foreign key (company_id, source_version_id)
    references public.safety_program_source_versions(company_id, id) on delete restrict,
  check (jsonb_typeof(source_locator) = 'object')
);

create table public.safety_program_sections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_id uuid not null,
  section_key text not null
    check (section_key ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  canonical_title text not null check (char_length(canonical_title) between 1 and 240),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, program_id, id),
  unique (program_id, section_key),
  foreign key (company_id, program_id)
    references public.safety_programs(company_id, id) on delete restrict
);

create table public.safety_program_section_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_id uuid not null,
  program_version_id uuid not null,
  section_id uuid not null,
  parent_section_version_id uuid,
  title text not null check (char_length(title) between 1 and 240),
  body_markdown text,
  body_plain_text text,
  section_kind text not null default 'content'
    check (section_kind in ('content', 'procedure', 'responsibility', 'policy', 'appendix')),
  sort_order integer not null check (sort_order >= 0),
  source_version_id uuid,
  source_locator jsonb not null default '{}'::jsonb,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, program_version_id, id),
  unique (program_version_id, section_id),
  unique (program_version_id, sort_order),
  foreign key (company_id, program_id, program_version_id)
    references public.safety_program_versions(company_id, program_id, id) on delete restrict,
  foreign key (company_id, program_id, section_id)
    references public.safety_program_sections(company_id, program_id, id) on delete restrict,
  foreign key (company_id, program_version_id, parent_section_version_id)
    references public.safety_program_section_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, source_version_id)
    references public.safety_program_source_versions(company_id, id) on delete restrict,
  check (body_markdown is not null or body_plain_text is not null),
  check (parent_section_version_id is null or parent_section_version_id <> id),
  check (jsonb_typeof(source_locator) = 'object')
);

-- Every active company location, including the initial five locations, gets a
-- separately reviewed row for each approved program version.
create table public.safety_program_location_applicability (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  location_id uuid not null,
  regulatory_profile_id uuid,
  applicability_status text not null default 'pending_review'
    check (applicability_status in (
      'applies',
      'does_not_apply',
      'conditional',
      'pending_review'
    )),
  rationale text not null default '',
  conditions jsonb not null default '[]'::jsonb,
  local_addenda jsonb not null default '[]'::jsonb,
  review_status text not null default 'draft'
    check (review_status in ('draft', 'reviewed')),
  effective_from date,
  effective_to date,
  assessed_by uuid not null references auth.users(id),
  assessed_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  applicability_sha256 text
    check (applicability_sha256 is null or applicability_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (program_version_id, location_id),
  foreign key (company_id, program_version_id)
    references public.safety_program_versions(company_id, id) on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, location_id, regulatory_profile_id)
    references public.location_regulatory_profiles(company_id, location_id, id)
    on delete restrict,
  check (jsonb_typeof(conditions) = 'array'),
  check (jsonb_typeof(local_addenda) = 'array'),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (
    review_status = 'draft'
    or (
      reviewed_by is not null
      and reviewed_at is not null
      and applicability_status <> 'pending_review'
      and applicability_sha256 is not null
      and char_length(rationale) > 0
    )
  )
);

-- ---------------------------------------------------------------------------
-- Interactive forms embedded in exact program/section versions
-- ---------------------------------------------------------------------------

create table public.safety_program_form_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_id uuid not null,
  template_key text not null
    check (template_key ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  name text not null check (char_length(name) between 2 and 200),
  purpose text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, program_id, id),
  unique (program_id, template_key),
  foreign key (company_id, program_id)
    references public.safety_programs(company_id, id) on delete restrict
);

create table public.safety_program_form_template_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_id uuid not null,
  program_version_id uuid not null,
  template_id uuid not null,
  version integer not null check (version > 0),
  title text not null check (char_length(title) between 2 and 220),
  instructions_markdown text,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  completion_policy jsonb not null default '{}'::jsonb,
  signature_policy jsonb not null default '{}'::jsonb,
  schema_sha256 text check (schema_sha256 is null or schema_sha256 ~ '^[0-9a-f]{64}$'),
  published_by uuid references auth.users(id),
  published_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, program_version_id, id),
  unique (template_id, version),
  foreign key (company_id, program_id, program_version_id)
    references public.safety_program_versions(company_id, program_id, id) on delete restrict,
  foreign key (company_id, program_id, template_id)
    references public.safety_program_form_templates(company_id, program_id, id) on delete restrict,
  check (jsonb_typeof(completion_policy) = 'object'),
  check (jsonb_typeof(signature_policy) = 'object'),
  check (
    (status = 'published' and published_by is not null and published_at is not null and schema_sha256 is not null)
    or status = 'draft'
  )
);

create table public.safety_program_form_fields (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  form_template_version_id uuid not null,
  parent_field_id uuid,
  field_key text not null
    check (field_key ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  field_type text not null
    check (field_type in (
      'instruction',
      'short_text',
      'long_text',
      'number',
      'date',
      'time',
      'datetime',
      'boolean',
      'single_choice',
      'multi_choice',
      'employee',
      'location',
      'file',
      'signature',
      'acknowledgement'
    )),
  label text not null check (char_length(label) between 1 and 300),
  help_text text,
  placeholder text,
  required boolean not null default false,
  sort_order integer not null check (sort_order >= 0),
  options jsonb not null default '[]'::jsonb,
  default_value jsonb,
  validation_rules jsonb not null default '{}'::jsonb,
  display_logic jsonb not null default '{}'::jsonb,
  data_classification text not null default 'internal'
    check (data_classification in ('internal', 'confidential', 'restricted')),
  field_sha256 text not null check (field_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, program_version_id, id),
  unique (company_id, form_template_version_id, id),
  unique (form_template_version_id, field_key),
  unique (form_template_version_id, sort_order),
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, form_template_version_id, parent_field_id)
    references public.safety_program_form_fields(company_id, form_template_version_id, id)
    on delete restrict,
  check (jsonb_typeof(options) = 'array'),
  check (jsonb_typeof(validation_rules) = 'object'),
  check (jsonb_typeof(display_logic) = 'object'),
  check (parent_field_id is null or parent_field_id <> id),
  check (field_type <> 'instruction' or required = false)
);

create table public.safety_program_section_form_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  section_version_id uuid not null,
  form_template_version_id uuid not null,
  presentation text not null default 'embedded'
    check (presentation in ('embedded', 'linked', 'required_after_section')),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (section_version_id, form_template_version_id),
  foreign key (company_id, program_version_id, section_version_id)
    references public.safety_program_section_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(company_id, program_version_id, id)
    on delete restrict
);

-- ---------------------------------------------------------------------------
-- Exact training and OSHA/state trace links
-- ---------------------------------------------------------------------------

create table public.safety_program_training_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  section_version_id uuid,
  location_id uuid,
  training_course_version_id uuid not null,
  relationship text not null
    check (relationship in ('required', 'recommended', 'prerequisite', 'refresher')),
  trigger_rule jsonb not null default '{}'::jsonb,
  completion_effect jsonb not null default '{}'::jsonb,
  rationale text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, program_version_id)
    references public.safety_program_versions(company_id, id) on delete restrict,
  foreign key (company_id, program_version_id, section_version_id)
    references public.safety_program_section_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, training_course_version_id)
    references public.training_course_versions(company_id, id) on delete restrict,
  check (jsonb_typeof(trigger_rule) = 'object'),
  check (jsonb_typeof(completion_effect) = 'object')
);

create unique index safety_program_training_link_identity_idx
  on public.safety_program_training_links (
    program_version_id,
    coalesce(section_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    training_course_version_id,
    relationship
  );

create table public.safety_program_regulatory_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  target_kind text not null
    check (target_kind in ('program_version', 'section_version', 'form_template_version', 'form_field')),
  section_version_id uuid,
  form_template_version_id uuid,
  form_field_id uuid,
  location_id uuid,
  jurisdiction_id uuid references public.regulatory_jurisdictions(id) on delete restrict,
  requirement_version_id uuid
    references public.compliance_requirement_versions(id) on delete restrict,
  regulatory_unit_version_id uuid
    references public.regulatory_unit_versions(id) on delete restrict,
  applicability_assessment_id uuid,
  relationship text not null
    check (relationship in (
      'implements',
      'mandatory_authority',
      'definition',
      'exception',
      'interpretation',
      'guidance',
      'state_overlay',
      'evidence_of_compliance'
    )),
  coverage_kind text not null default 'supporting'
    check (coverage_kind in ('full', 'partial', 'supporting')),
  source_locator jsonb not null default '{}'::jsonb,
  exact_excerpt_sha256 text
    check (exact_excerpt_sha256 is null or exact_excerpt_sha256 ~ '^[0-9a-f]{64}$'),
  rationale text not null,
  trace_sha256 text not null check (trace_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, program_version_id, section_version_id)
    references public.safety_program_section_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, program_version_id, form_field_id)
    references public.safety_program_form_fields(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, applicability_assessment_id)
    references public.requirement_applicability_assessments(company_id, id)
    on delete restrict,
  check (requirement_version_id is not null or regulatory_unit_version_id is not null),
  check (jsonb_typeof(source_locator) = 'object'),
  check (
    (target_kind = 'program_version'
      and num_nonnulls(section_version_id, form_template_version_id, form_field_id) = 0)
    or
    (target_kind = 'section_version'
      and section_version_id is not null
      and num_nonnulls(form_template_version_id, form_field_id) = 0)
    or
    (target_kind = 'form_template_version'
      and form_template_version_id is not null
      and num_nonnulls(section_version_id, form_field_id) = 0)
    or
    (target_kind = 'form_field'
      and form_field_id is not null
      and num_nonnulls(section_version_id, form_template_version_id) = 0)
  )
);

-- ---------------------------------------------------------------------------
-- Assignments, submissions, typed answers, signatures, and acknowledgements
-- ---------------------------------------------------------------------------

create table public.safety_program_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  location_id uuid not null,
  assignee_user_id uuid not null references public.profiles(id) on delete restrict,
  assignment_type text not null
    check (assignment_type in (
      'read_and_acknowledge',
      'complete_form',
      'complete_training',
      'manager_review'
    )),
  form_template_version_id uuid,
  training_course_version_id uuid,
  title text not null check (char_length(title) between 2 and 240),
  instructions text,
  status text not null default 'assigned'
    check (status in ('assigned', 'in_progress', 'completed', 'waived', 'cancelled')),
  assigned_at timestamptz not null default now(),
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  waived_by uuid references auth.users(id),
  waived_at timestamptz,
  waiver_reason text,
  assigned_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, program_version_id, id),
  foreign key (company_id, program_version_id)
    references public.safety_program_versions(company_id, id) on delete restrict,
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, training_course_version_id)
    references public.training_course_versions(company_id, id) on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  check (due_at is null or due_at >= assigned_at),
  check (
    (assignment_type = 'complete_form'
      and form_template_version_id is not null
      and training_course_version_id is null)
    or
    (assignment_type = 'complete_training'
      and training_course_version_id is not null
      and form_template_version_id is null)
    or
    (assignment_type in ('read_and_acknowledge', 'manager_review')
      and form_template_version_id is null
      and training_course_version_id is null)
  ),
  check (
    status <> 'completed'
    or completed_at is not null
  ),
  check (
    status <> 'waived'
    or (
      waived_by is not null
      and waived_at is not null
      and char_length(coalesce(waiver_reason, '')) > 0
    )
  )
);

create unique index safety_program_assignment_identity_idx
  on public.safety_program_assignments (
    program_version_id,
    location_id,
    assignee_user_id,
    assignment_type,
    coalesce(form_template_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(training_course_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status not in ('cancelled', 'waived');

create table public.safety_program_form_submissions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  location_id uuid not null,
  form_template_version_id uuid not null,
  assignment_id uuid,
  submitted_by uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'reviewed', 'rejected')),
  client_submission_key text not null
    check (char_length(client_submission_key) between 8 and 200),
  form_schema_sha256 text not null check (form_schema_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_payload_sha256 text
    check (submitted_payload_sha256 is null or submitted_payload_sha256 ~ '^[0-9a-f]{64}$'),
  submission_context jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, form_template_version_id, id),
  unique (company_id, client_submission_key),
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, program_version_id, assignment_id)
    references public.safety_program_assignments(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  check (jsonb_typeof(submission_context) = 'object'),
  check (
    (status = 'draft' and submitted_at is null and submitted_payload_sha256 is null)
    or (status in ('submitted', 'reviewed', 'rejected')
      and submitted_at is not null
      and submitted_payload_sha256 is not null)
  ),
  check (
    status not in ('reviewed', 'rejected')
    or (reviewed_by is not null and reviewed_at is not null)
  )
);

create table public.safety_program_form_answers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  form_template_version_id uuid not null,
  submission_id uuid not null,
  field_id uuid not null,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_time time,
  value_timestamptz timestamptz,
  value_json jsonb,
  is_not_applicable boolean not null default false,
  not_applicable_reason text,
  field_snapshot jsonb not null,
  answer_sha256 text check (answer_sha256 is null or answer_sha256 ~ '^[0-9a-f]{64}$'),
  answered_by uuid not null references auth.users(id),
  answered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (submission_id, field_id),
  foreign key (company_id, form_template_version_id, submission_id)
    references public.safety_program_form_submissions(company_id, form_template_version_id, id)
    on delete restrict,
  foreign key (company_id, form_template_version_id, field_id)
    references public.safety_program_form_fields(company_id, form_template_version_id, id)
    on delete restrict,
  check (jsonb_typeof(field_snapshot) = 'object'),
  check (
    num_nonnulls(
      value_text,
      value_number,
      value_boolean,
      value_date,
      value_time,
      value_timestamptz,
      value_json
    ) <= 1
  ),
  check (
    (is_not_applicable
      and num_nonnulls(
        value_text,
        value_number,
        value_boolean,
        value_date,
        value_time,
        value_timestamptz,
        value_json
      ) = 0
      and char_length(coalesce(not_applicable_reason, '')) > 0)
    or not is_not_applicable
  )
);

create table public.safety_program_answer_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  answer_id uuid not null,
  storage_object_id uuid not null,
  attachment_kind text not null default 'evidence'
    check (attachment_kind in ('evidence', 'photo', 'document')),
  attached_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (answer_id, storage_object_id),
  foreign key (company_id, answer_id)
    references public.safety_program_form_answers(company_id, id) on delete restrict,
  foreign key (company_id, storage_object_id)
    references public.safety_program_storage_objects(company_id, id) on delete restrict
);

create table public.safety_program_form_signatures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  form_template_version_id uuid not null,
  submission_id uuid not null,
  field_id uuid,
  signer_user_id uuid not null references public.profiles(id) on delete restrict,
  signer_name_snapshot text not null check (char_length(signer_name_snapshot) between 1 and 200),
  signer_role_snapshot text not null,
  signature_method text not null
    check (signature_method in ('typed', 'drawn', 'electronic_ack', 'digital_certificate')),
  signature_intent text not null check (char_length(signature_intent) between 2 and 500),
  signature_storage_object_id uuid,
  signed_payload_sha256 text not null check (signed_payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature_sha256 text not null check (signature_sha256 ~ '^[0-9a-f]{64}$'),
  signature_record jsonb not null default '{}'::jsonb,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (submission_id, field_id, signer_user_id),
  foreign key (company_id, form_template_version_id, submission_id)
    references public.safety_program_form_submissions(company_id, form_template_version_id, id)
    on delete restrict,
  foreign key (company_id, form_template_version_id, field_id)
    references public.safety_program_form_fields(company_id, form_template_version_id, id)
    on delete restrict,
  foreign key (company_id, signature_storage_object_id)
    references public.safety_program_storage_objects(company_id, id) on delete restrict,
  check (jsonb_typeof(signature_record) = 'object'),
  check (
    (signature_method = 'drawn' and signature_storage_object_id is not null)
    or signature_method <> 'drawn'
  )
);

create table public.safety_program_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  location_id uuid not null,
  assignment_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete restrict,
  attestation text not null check (char_length(attestation) between 8 and 1000),
  acknowledged_payload_sha256 text not null check (acknowledged_payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature_method text not null default 'electronic_ack'
    check (signature_method in ('typed', 'electronic_ack', 'digital_certificate')),
  signature_record jsonb not null default '{}'::jsonb,
  signature_sha256 text not null check (signature_sha256 ~ '^[0-9a-f]{64}$'),
  acknowledged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (assignment_id),
  foreign key (company_id, program_version_id, assignment_id)
    references public.safety_program_assignments(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  check (jsonb_typeof(signature_record) = 'object')
);

-- The audit chain is tenant-scoped. The trigger serializes events per company
-- with a transaction advisory lock so previous_event_sha256 is unambiguous.
create table public.safety_program_audit_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid,
  actor_user_id uuid references auth.users(id) on delete restrict,
  actor_type text not null
    check (actor_type in ('authenticated_user', 'service_role', 'system')),
  entity_table text not null,
  entity_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete', 'submit', 'acknowledge')),
  before_sha256 text check (before_sha256 is null or before_sha256 ~ '^[0-9a-f]{64}$'),
  after_sha256 text check (after_sha256 is null or after_sha256 ~ '^[0-9a-f]{64}$'),
  previous_event_sha256 text
    check (previous_event_sha256 is null or previous_event_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 text not null unique check (event_sha256 ~ '^[0-9a-f]{64}$'),
  changed_fields text[] not null default '{}'::text[],
  request_context jsonb not null default '{}'::jsonb,
  transaction_id bigint not null default txid_current(),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  check (jsonb_typeof(request_context) = 'object')
);

-- ---------------------------------------------------------------------------
-- Supporting indexes
-- ---------------------------------------------------------------------------

create index safety_program_source_documents_sync_idx
  on public.safety_program_source_documents(company_id, sync_enabled, active, last_observed_at);
create index safety_program_source_versions_document_idx
  on public.safety_program_source_versions(source_document_id, observed_at desc);
create index safety_program_source_artifacts_version_idx
  on public.safety_program_source_version_artifacts(source_version_id, artifact_kind);
create index safety_program_versions_status_idx
  on public.safety_program_versions(company_id, status, effective_from desc);
create index safety_program_sections_order_idx
  on public.safety_program_section_versions(program_version_id, sort_order);
create index safety_program_applicability_location_idx
  on public.safety_program_location_applicability(company_id, location_id, applicability_status);
create index safety_program_form_fields_order_idx
  on public.safety_program_form_fields(form_template_version_id, sort_order);
create index safety_program_regulatory_requirement_idx
  on public.safety_program_regulatory_links(requirement_version_id, program_version_id);
create index safety_program_regulatory_unit_idx
  on public.safety_program_regulatory_links(regulatory_unit_version_id, program_version_id);
create index safety_program_assignments_user_idx
  on public.safety_program_assignments(company_id, assignee_user_id, status, due_at);
create index safety_program_assignments_location_idx
  on public.safety_program_assignments(company_id, location_id, status, due_at);
create index safety_program_submissions_user_idx
  on public.safety_program_form_submissions(company_id, submitted_by, status, created_at desc);
create index safety_program_submissions_location_idx
  on public.safety_program_form_submissions(company_id, location_id, status, created_at desc);
create index safety_program_audit_company_idx
  on public.safety_program_audit_events(company_id, occurred_at desc, id desc);
create index safety_program_audit_entity_idx
  on public.safety_program_audit_events(company_id, entity_table, entity_id, id desc);

-- ---------------------------------------------------------------------------
-- Invariants and immutable-state guards
-- ---------------------------------------------------------------------------

create or replace function program_private.reject_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception '% is append-only; create a replacement record instead', tg_table_name
    using errcode = '55000';
end;
$$;

create or replace function program_private.guard_program_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from public.safety_program_versions version_record
      where version_record.program_id = old.id
    ) then
      raise exception 'a safety program with version history cannot be deleted'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if new.company_id <> old.company_id
     or new.program_code <> old.program_code then
    raise exception 'company_id and program_code are immutable program identity'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_source_document_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from public.safety_program_source_versions source_version
      where source_version.source_document_id = old.id
    ) then
      raise exception 'a source document with observed versions cannot be deleted'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if new.company_id <> old.company_id
     or new.provider <> old.provider
     or new.external_drive_id <> old.external_drive_id
     or new.external_file_id <> old.external_file_id then
    raise exception 'source provider identity is immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_logical_child_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% identities are append-only', tg_table_name
      using errcode = '55000';
  end if;

  raise exception '% identities are immutable; create a new identity when meaning changes', tg_table_name
    using errcode = '55000';
end;
$$;

create or replace function program_private.guard_program_child()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  child_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  target_program_version_id uuid;
  parent_status text;
begin
  target_program_version_id := (child_row ->> 'program_version_id')::uuid;

  select program_version.status
  into parent_status
  from public.safety_program_versions program_version
  where program_version.id = target_program_version_id
  for update;

  if parent_status is null then
    raise exception 'program version not found'
      using errcode = '23503';
  end if;

  if parent_status in ('approved', 'published', 'superseded') then
    raise exception 'approved or published program content is immutable'
      using errcode = '55000';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function program_private.guard_form_template_version()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  parent_status text;
begin
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a form template version must be created as draft'
      using errcode = '23514';
  end if;

  select program_version.status
  into parent_status
  from public.safety_program_versions program_version
  where program_version.id = coalesce(new.program_version_id, old.program_version_id)
  for update;

  if parent_status in ('approved', 'published', 'superseded') then
    raise exception 'forms under an approved or published program are immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'a published form template version is immutable'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.company_id <> new.company_id
       or old.program_id <> new.program_id
       or old.program_version_id <> new.program_version_id
       or old.template_id <> new.template_id
       or old.version <> new.version then
      raise exception 'form version identity is immutable'
        using errcode = '55000';
    end if;

    if old.status = 'published' then
      raise exception 'a published form template version is immutable'
        using errcode = '55000';
    end if;

    if new.status = 'published' then
      if not private.can_manage_company(new.company_id) then
        raise exception 'only a company safety administrator may publish a form'
          using errcode = '42501';
      end if;

      if not exists (
        select 1
        from public.safety_program_form_fields field_record
        where field_record.form_template_version_id = new.id
      ) then
        raise exception 'a form must have at least one versioned field before publication'
          using errcode = '23514';
      end if;

      if new.schema_sha256 is null then
        raise exception 'schema_sha256 is required before form publication'
          using errcode = '23514';
      end if;

      new.published_by := auth.uid();
      new.published_at := clock_timestamp();
    elsif old.status <> new.status then
      raise exception 'unsupported form status transition'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_form_field()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  form_status text;
  parent_status text;
  row_record jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  select form_version.status, program_version.status
  into form_status, parent_status
  from public.safety_program_form_template_versions form_version
  join public.safety_program_versions program_version
    on program_version.id = form_version.program_version_id
  where form_version.id = (row_record ->> 'form_template_version_id')::uuid
  for update of form_version, program_version;

  if form_status is null then
    raise exception 'form template version not found'
      using errcode = '23503';
  end if;

  if form_status = 'published'
     or parent_status in ('approved', 'published', 'superseded') then
    raise exception 'published form fields are immutable'
      using errcode = '55000';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function program_private.guard_program_version()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a program version must be created as draft'
        using errcode = '23514';
    end if;
    if auth.uid() is not null and new.prepared_by <> auth.uid() then
      raise exception 'prepared_by must be the current user'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'only a draft program version may be deleted'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if old.company_id <> new.company_id
     or old.program_id <> new.program_id
     or old.version <> new.version
     or old.prepared_by <> new.prepared_by then
    raise exception 'program version identity is immutable'
      using errcode = '55000';
  end if;

  if old.status = 'superseded' then
    raise exception 'a superseded program version is immutable'
      using errcode = '55000';
  end if;

  if old.status = 'published' then
    if new.status <> 'superseded'
       or (
         (to_jsonb(new) - array['status', 'effective_to', 'updated_at'])
         is distinct from
         (to_jsonb(old) - array['status', 'effective_to', 'updated_at'])
       ) then
      raise exception 'a published version may only transition to superseded'
        using errcode = '55000';
    end if;
    if new.effective_to is null then
      new.effective_to := current_date;
    end if;
    return new;
  end if;

  if old.status = 'approved'
     and new.status not in ('approved', 'in_review', 'published') then
    raise exception 'unsupported program status transition'
      using errcode = '23514';
  elsif old.status = 'in_review'
     and new.status not in ('in_review', 'draft', 'approved') then
    raise exception 'unsupported program status transition'
      using errcode = '23514';
  elsif old.status = 'draft'
     and new.status not in ('draft', 'in_review') then
    raise exception 'a draft must enter review before approval'
      using errcode = '23514';
  end if;

  if old.status = 'approved' and new.status = 'in_review' then
    new.approved_by := null;
    new.approved_at := null;
  end if;

  if old.status <> 'approved' and new.status = 'approved' then
    if not private.can_manage_company(new.company_id) then
      raise exception 'only a company safety administrator may approve a program'
        using errcode = '42501';
    end if;
    if auth.uid() is null or auth.uid() = new.prepared_by then
      raise exception 'four-eye control requires an approver other than the preparer'
        using errcode = '42501';
    end if;
    if new.source_manifest_sha256 is null or new.content_manifest_sha256 is null then
      raise exception 'source and content manifest hashes are required for approval'
        using errcode = '23514';
    end if;
    if not exists (
      select 1
      from public.safety_program_version_sources source_link
      where source_link.program_version_id = new.id
        and source_link.relationship = 'authoritative_source'
    ) then
      raise exception 'an authoritative immutable source version is required for approval'
        using errcode = '23514';
    end if;
    if not exists (
      select 1
      from public.safety_program_section_versions section_version
      where section_version.program_version_id = new.id
    ) then
      raise exception 'at least one program section is required for approval'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.safety_program_section_versions section_version
      where section_version.program_version_id = new.id
        and (
          section_version.source_version_id is null
          or section_version.source_locator = '{}'::jsonb
        )
    ) then
      raise exception 'every section must retain an exact source version and locator'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.locations location_record
      where location_record.company_id = new.company_id
        and location_record.active
        and not exists (
          select 1
          from public.safety_program_location_applicability applicability
          where applicability.program_version_id = new.id
            and applicability.location_id = location_record.id
            and applicability.review_status = 'reviewed'
            and applicability.applicability_status <> 'pending_review'
        )
    ) then
      raise exception 'every active location requires a reviewed applicability decision'
        using errcode = '23514';
    end if;
    if not exists (
      select 1
      from public.locations location_record
      where location_record.company_id = new.company_id
        and location_record.active
    ) then
      raise exception 'a program cannot be approved without an active location'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.safety_program_form_template_versions form_version
      where form_version.program_version_id = new.id
        and form_version.status <> 'published'
    ) then
      raise exception 'all program forms must be published before program approval'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.safety_program_training_links training_link
      join public.training_course_versions training_version
        on training_version.id = training_link.training_course_version_id
      where training_link.program_version_id = new.id
        and not training_version.published
    ) then
      raise exception 'all linked training course versions must be published'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.safety_program_regulatory_links regulatory_link
      left join public.compliance_requirement_versions requirement_version
        on requirement_version.id = regulatory_link.requirement_version_id
      where regulatory_link.program_version_id = new.id
        and (
          regulatory_link.reviewed_by is null
          or regulatory_link.reviewed_at is null
          or (
            regulatory_link.requirement_version_id is not null
            and requirement_version.status <> 'approved'
          )
        )
    ) then
      raise exception 'all regulatory traces must be human-reviewed and requirements approved'
        using errcode = '23514';
    end if;

    new.reviewed_by := coalesce(new.reviewed_by, auth.uid());
    new.reviewed_at := coalesce(new.reviewed_at, clock_timestamp());
    new.approved_by := auth.uid();
    new.approved_at := clock_timestamp();
  end if;

  if old.status = 'approved' and new.status = 'published' then
    if not private.can_manage_company(new.company_id) then
      raise exception 'only a company safety administrator may publish a program'
        using errcode = '42501';
    end if;
    if new.effective_from is null then
      new.effective_from := current_date;
    end if;
    new.published_by := auth.uid();
    new.published_at := clock_timestamp();

    -- The partial unique index is the final race-safe backstop.
    update public.safety_program_versions previous_version
    set status = 'superseded',
        effective_to = case
          when previous_version.effective_from is null then new.effective_from - 1
          else greatest(previous_version.effective_from, new.effective_from - 1)
        end,
        updated_at = clock_timestamp()
    where previous_version.program_id = new.program_id
      and previous_version.id <> new.id
      and previous_version.status = 'published';
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  version_status text;
  assignee_is_member boolean;
  has_completion_evidence boolean;
begin
  if tg_op = 'INSERT' then
    select program_version.status
    into version_status
    from public.safety_program_versions program_version
    where program_version.id = new.program_version_id;

    if version_status <> 'published' then
      raise exception 'assignments must pin a published program version'
        using errcode = '23514';
    end if;

    select exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = new.company_id
        and membership.user_id = new.assignee_user_id
        and membership.active
    )
    into assignee_is_member;

    if not assignee_is_member then
      raise exception 'assignee is not an active company member'
        using errcode = '23514';
    end if;

    if not exists (
      select 1
      from public.safety_program_location_applicability applicability
      where applicability.program_version_id = new.program_version_id
        and applicability.location_id = new.location_id
        and applicability.review_status = 'reviewed'
        and applicability.applicability_status in ('applies', 'conditional')
    ) then
      raise exception 'the program does not apply at the assignment location'
        using errcode = '23514';
    end if;

    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'assigned' then
      raise exception 'only an untouched assignment may be deleted'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if new.company_id <> old.company_id
     or new.program_version_id <> old.program_version_id
     or new.location_id <> old.location_id
     or new.assignee_user_id <> old.assignee_user_id
     or new.assignment_type <> old.assignment_type
     or new.form_template_version_id is distinct from old.form_template_version_id
     or new.training_course_version_id is distinct from old.training_course_version_id
     or new.assigned_by <> old.assigned_by
     or new.assigned_at <> old.assigned_at then
    raise exception 'assignment identity is immutable'
      using errcode = '55000';
  end if;

  if old.status in ('completed', 'waived', 'cancelled') then
    raise exception 'terminal assignments are immutable'
      using errcode = '55000';
  end if;

  if new.status not in ('assigned', 'in_progress', 'completed', 'waived', 'cancelled') then
    raise exception 'unsupported assignment status transition'
      using errcode = '23514';
  end if;

  if old.status = 'in_progress' and new.status = 'assigned' then
    raise exception 'an in-progress assignment cannot return to assigned'
      using errcode = '23514';
  end if;

  if new.status = 'in_progress' and new.started_at is null then
    new.started_at := clock_timestamp();
  end if;

  if old.status <> 'completed' and new.status = 'completed' then
    has_completion_evidence := case new.assignment_type
      when 'read_and_acknowledge' then exists (
        select 1
        from public.safety_program_acknowledgements acknowledgement
        where acknowledgement.assignment_id = new.id
      )
      when 'complete_form' then exists (
        select 1
        from public.safety_program_form_submissions submission
        where submission.assignment_id = new.id
          and submission.status in ('submitted', 'reviewed')
      )
      when 'complete_training' then exists (
        select 1
        from public.training_course_versions course_version
        join public.training_assignments training_assignment
          on training_assignment.company_id = course_version.company_id
         and training_assignment.course_id = course_version.course_id
         and training_assignment.course_version = course_version.version
        where course_version.id = new.training_course_version_id
          and training_assignment.worker_profile_id = new.assignee_user_id
          and training_assignment.status = 'complete'
          and (
            training_assignment.location_id is null
            or training_assignment.location_id = new.location_id
          )
      )
      when 'manager_review' then true
      else false
    end;

    if not has_completion_evidence then
      raise exception 'completion evidence is required for this assignment'
        using errcode = '23514';
    end if;
    new.completed_at := coalesce(new.completed_at, clock_timestamp());
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_submission()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  form_record public.safety_program_form_template_versions%rowtype;
  assignment_record public.safety_program_assignments%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'submitted forms are immutable'
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a form submission must begin as draft'
        using errcode = '23514';
    end if;
    if auth.uid() is not null and new.submitted_by <> auth.uid() then
      raise exception 'submitted_by must be the current user'
        using errcode = '42501';
    end if;

    select form_version.*
    into form_record
    from public.safety_program_form_template_versions form_version
    where form_version.id = new.form_template_version_id;

    if form_record.status <> 'published'
       or form_record.program_version_id <> new.program_version_id
       or form_record.schema_sha256 <> new.form_schema_sha256 then
      raise exception 'submission must pin the published form and exact schema hash'
        using errcode = '23514';
    end if;

    if not exists (
      select 1
      from public.safety_program_versions program_version
      join public.safety_program_location_applicability applicability
        on applicability.program_version_id = program_version.id
       and applicability.location_id = new.location_id
      where program_version.id = new.program_version_id
        and program_version.status = 'published'
        and applicability.review_status = 'reviewed'
        and applicability.applicability_status in ('applies', 'conditional')
    ) then
      raise exception 'form is not published and applicable at this location'
        using errcode = '23514';
    end if;

    if new.assignment_id is not null then
      select assignment.*
      into assignment_record
      from public.safety_program_assignments assignment
      where assignment.id = new.assignment_id;

      if assignment_record.id is null
         or assignment_record.assignment_type <> 'complete_form'
         or assignment_record.assignee_user_id <> new.submitted_by
         or assignment_record.location_id <> new.location_id
         or assignment_record.form_template_version_id <> new.form_template_version_id
         or assignment_record.status in ('completed', 'waived', 'cancelled') then
        raise exception 'submission does not match an active form assignment'
          using errcode = '23514';
      end if;
    end if;

    return new;
  end if;

  if new.company_id <> old.company_id
     or new.program_version_id <> old.program_version_id
     or new.location_id <> old.location_id
     or new.form_template_version_id <> old.form_template_version_id
     or new.assignment_id is distinct from old.assignment_id
     or new.submitted_by <> old.submitted_by
     or new.client_submission_key <> old.client_submission_key
     or new.form_schema_sha256 <> old.form_schema_sha256
     or new.started_at <> old.started_at then
    raise exception 'submission identity and pinned schema are immutable'
      using errcode = '55000';
  end if;

  if old.status <> 'draft' then
    if new.status not in ('submitted', 'reviewed', 'rejected')
       or (
         (to_jsonb(new) - array['status', 'reviewed_by', 'reviewed_at', 'review_note', 'updated_at'])
         is distinct from
         (to_jsonb(old) - array['status', 'reviewed_by', 'reviewed_at', 'review_note', 'updated_at'])
       ) then
      raise exception 'submitted payload and signatures are immutable'
        using errcode = '55000';
    end if;
    if old.status in ('reviewed', 'rejected') then
      raise exception 'reviewed or rejected submissions are terminal'
        using errcode = '55000';
    end if;
    if new.status in ('reviewed', 'rejected') then
      new.reviewed_by := auth.uid();
      new.reviewed_at := clock_timestamp();
    end if;
    return new;
  end if;

  if new.status not in ('draft', 'submitted') then
    raise exception 'a draft may only transition to submitted'
      using errcode = '23514';
  end if;

  if new.status = 'submitted' then
    if new.submitted_payload_sha256 is null then
      raise exception 'submitted_payload_sha256 is required'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.safety_program_form_fields field_record
      where field_record.form_template_version_id = new.form_template_version_id
        and field_record.required
        and field_record.field_type not in ('instruction', 'signature', 'acknowledgement', 'file')
        and not exists (
          select 1
          from public.safety_program_form_answers answer
          where answer.submission_id = new.id
            and answer.field_id = field_record.id
            and (
              answer.is_not_applicable
              or num_nonnulls(
                answer.value_text,
                answer.value_number,
                answer.value_boolean,
                answer.value_date,
                answer.value_time,
                answer.value_timestamptz,
                answer.value_json
              ) = 1
            )
        )
    ) then
      raise exception 'all required form answers must be complete'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.safety_program_form_fields field_record
      where field_record.form_template_version_id = new.form_template_version_id
        and field_record.required
        and field_record.field_type = 'file'
        and not exists (
          select 1
          from public.safety_program_form_answers answer
          join public.safety_program_answer_files answer_file
            on answer_file.answer_id = answer.id
          where answer.submission_id = new.id
            and answer.field_id = field_record.id
        )
    ) then
      raise exception 'all required file fields must include an attachment'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.safety_program_form_fields field_record
      where field_record.form_template_version_id = new.form_template_version_id
        and field_record.required
        and field_record.field_type in ('signature', 'acknowledgement')
        and not exists (
          select 1
          from public.safety_program_form_signatures signature_record
          where signature_record.submission_id = new.id
            and signature_record.field_id = field_record.id
        )
    ) then
      raise exception 'all required signatures and acknowledgements must be recorded'
        using errcode = '23514';
    end if;

    new.submitted_at := clock_timestamp();
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_answer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  row_record public.safety_program_form_answers%rowtype;
  submission_record public.safety_program_form_submissions%rowtype;
  field_record public.safety_program_form_fields%rowtype;
  value_count integer;
begin
  row_record := case when tg_op = 'DELETE' then old else new end;

  select submission.*
  into submission_record
  from public.safety_program_form_submissions submission
  where submission.id = row_record.submission_id
  for update;

  if submission_record.id is null then
    raise exception 'submission not found'
      using errcode = '23503';
  end if;
  if submission_record.status <> 'draft' then
    raise exception 'answers are immutable after submission'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'UPDATE'
     and (
       new.company_id <> old.company_id
       or new.form_template_version_id <> old.form_template_version_id
       or new.submission_id <> old.submission_id
       or new.field_id <> old.field_id
       or new.answered_by <> old.answered_by
       or new.answered_at <> old.answered_at
     ) then
    raise exception 'answer identity is immutable'
      using errcode = '55000';
  end if;

  select field_value.*
  into field_record
  from public.safety_program_form_fields field_value
  where field_value.id = new.field_id
    and field_value.form_template_version_id = new.form_template_version_id;

  if field_record.id is null then
    raise exception 'answer field is not part of the pinned form version'
      using errcode = '23503';
  end if;
  if field_record.field_type in ('instruction', 'signature', 'acknowledgement') then
    raise exception 'this field type is recorded through its specialized evidence table'
      using errcode = '23514';
  end if;

  value_count := num_nonnulls(
    new.value_text,
    new.value_number,
    new.value_boolean,
    new.value_date,
    new.value_time,
    new.value_timestamptz,
    new.value_json
  );

  if not new.is_not_applicable then
    if field_record.field_type in ('short_text', 'long_text', 'employee', 'location', 'single_choice')
       and not (value_count = 1 and new.value_text is not null) then
      raise exception 'field % requires a text value', field_record.field_key
        using errcode = '23514';
    elsif field_record.field_type = 'number'
       and not (value_count = 1 and new.value_number is not null) then
      raise exception 'field % requires a numeric value', field_record.field_key
        using errcode = '23514';
    elsif field_record.field_type = 'boolean'
       and not (value_count = 1 and new.value_boolean is not null) then
      raise exception 'field % requires a boolean value', field_record.field_key
        using errcode = '23514';
    elsif field_record.field_type = 'date'
       and not (value_count = 1 and new.value_date is not null) then
      raise exception 'field % requires a date value', field_record.field_key
        using errcode = '23514';
    elsif field_record.field_type = 'time'
       and not (value_count = 1 and new.value_time is not null) then
      raise exception 'field % requires a time value', field_record.field_key
        using errcode = '23514';
    elsif field_record.field_type = 'datetime'
       and not (value_count = 1 and new.value_timestamptz is not null) then
      raise exception 'field % requires a timestamp value', field_record.field_key
        using errcode = '23514';
    elsif field_record.field_type = 'multi_choice'
       and not (
         value_count = 1
         and new.value_json is not null
         and jsonb_typeof(new.value_json) = 'array'
       ) then
      raise exception 'field % requires an array value', field_record.field_key
        using errcode = '23514';
    elsif field_record.field_type = 'file'
       and value_count <> 0 then
      raise exception 'file fields use attachment rows rather than scalar values'
        using errcode = '23514';
    end if;
  end if;

  if auth.uid() is not null and tg_op = 'INSERT' and new.answered_by <> auth.uid() then
    raise exception 'answered_by must be the current user'
      using errcode = '42501';
  end if;

  new.field_snapshot := jsonb_build_object(
    'field_id', field_record.id,
    'field_key', field_record.field_key,
    'field_type', field_record.field_type,
    'label', field_record.label,
    'required', field_record.required,
    'field_sha256', field_record.field_sha256
  );
  new.answer_sha256 := encode(
    digest(
      concat_ws(
        '|',
        new.submission_id::text,
        new.field_id::text,
        coalesce(new.value_text, ''),
        coalesce(new.value_number::text, ''),
        coalesce(new.value_boolean::text, ''),
        coalesce(new.value_date::text, ''),
        coalesce(new.value_time::text, ''),
        coalesce(new.value_timestamptz::text, ''),
        coalesce(new.value_json::text, ''),
        new.is_not_applicable::text,
        coalesce(new.not_applicable_reason, ''),
        new.field_snapshot::text
      ),
      'sha256'
    ),
    'hex'
  );

  return new;
end;
$$;

create or replace function program_private.guard_answer_file()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_answer_id uuid := case when tg_op = 'DELETE' then old.answer_id else new.answer_id end;
  submission_status text;
  object_record public.safety_program_storage_objects%rowtype;
begin
  select submission.status
  into submission_status
  from public.safety_program_form_answers answer
  join public.safety_program_form_submissions submission
    on submission.id = answer.submission_id
  where answer.id = target_answer_id
  for update of submission;

  if submission_status <> 'draft' then
    raise exception 'answer attachments are immutable after submission'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'answer file links are immutable'
      using errcode = '55000';
  end if;

  select object_value.*
  into object_record
  from public.safety_program_storage_objects object_value
  where object_value.id = new.storage_object_id;

  if object_record.purpose <> 'form_attachment'
     or object_record.malware_scan_status <> 'clean' then
    raise exception 'only clean form-attachment objects may be attached'
      using errcode = '23514';
  end if;

  if auth.uid() is not null and new.attached_by <> auth.uid() then
    raise exception 'attached_by must be the current user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_signature()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  submission_record public.safety_program_form_submissions%rowtype;
  field_type_value text;
  object_record public.safety_program_storage_objects%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'signature records are append-only'
      using errcode = '55000';
  end if;

  select submission.*
  into submission_record
  from public.safety_program_form_submissions submission
  where submission.id = new.submission_id
  for update;

  if submission_record.status <> 'draft' then
    raise exception 'signatures cannot be added after submission'
      using errcode = '55000';
  end if;
  if submission_record.form_template_version_id <> new.form_template_version_id then
    raise exception 'signature does not match the pinned form version'
      using errcode = '23514';
  end if;
  if auth.uid() is not null and new.signer_user_id <> auth.uid() then
    raise exception 'a user may only create their own signature'
      using errcode = '42501';
  end if;

  if new.field_id is not null then
    select field_record.field_type
    into field_type_value
    from public.safety_program_form_fields field_record
    where field_record.id = new.field_id
      and field_record.form_template_version_id = new.form_template_version_id;

    if field_type_value not in ('signature', 'acknowledgement') then
      raise exception 'field is not a signature or acknowledgement field'
        using errcode = '23514';
    end if;
  end if;

  if new.signature_storage_object_id is not null then
    select object_value.*
    into object_record
    from public.safety_program_storage_objects object_value
    where object_value.id = new.signature_storage_object_id;

    if object_record.purpose <> 'signature_artifact'
       or object_record.malware_scan_status <> 'clean' then
      raise exception 'signature artifact must be a clean private object'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function program_private.guard_storage_insert()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'private storage metadata is append-only'
      using errcode = '55000';
  end if;

  if auth.uid() is not null then
    if new.uploaded_by <> auth.uid() then
      raise exception 'uploaded_by must be the current user'
        using errcode = '42501';
    end if;
    if new.purpose = 'form_attachment' then
      if not private.is_company_member(new.company_id)
         or (
           new.location_id is not null
           and not private.can_access_location(new.company_id, new.location_id)
         ) then
        raise exception 'user cannot create attachment metadata for this tenant/location'
          using errcode = '42501';
      end if;
    elsif not private.can_manage_company(new.company_id) then
      raise exception 'only safety administrators may register source, signature, or export objects'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create or replace function program_private.capture_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_record jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  after_record jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  event_record jsonb := coalesce(after_record, before_record);
  event_company_id uuid := (event_record ->> 'company_id')::uuid;
  event_location_id uuid := nullif(event_record ->> 'location_id', '')::uuid;
  event_entity_id uuid := (event_record ->> 'id')::uuid;
  before_hash text;
  after_hash text;
  previous_hash text;
  event_hash text;
  event_time timestamptz := clock_timestamp();
  changed text[];
  actor_kind text;
begin
  before_hash := case
    when before_record is null then null
    else encode(digest(before_record::text, 'sha256'), 'hex')
  end;
  after_hash := case
    when after_record is null then null
    else encode(digest(after_record::text, 'sha256'), 'hex')
  end;

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(key_name order by key_name), '{}'::text[])
    into changed
    from (
      select key_name
      from (
        select jsonb_object_keys(before_record) as key_name
        union
        select jsonb_object_keys(after_record) as key_name
      ) all_keys
      where before_record -> key_name is distinct from after_record -> key_name
    ) changed_keys;
  else
    changed := '{}'::text[];
  end if;

  perform pg_advisory_xact_lock(hashtextextended(event_company_id::text, 0));

  select audit_event.event_sha256
  into previous_hash
  from public.safety_program_audit_events audit_event
  where audit_event.company_id = event_company_id
  order by audit_event.id desc
  limit 1;

  actor_kind := case
    when auth.uid() is not null then 'authenticated_user'
    when current_user in ('service_role', 'supabase_admin', 'postgres') then 'service_role'
    else 'system'
  end;

  event_hash := encode(
    digest(
      concat_ws(
        '|',
        event_company_id::text,
        coalesce(event_location_id::text, ''),
        tg_table_schema || '.' || tg_table_name,
        event_entity_id::text,
        lower(tg_op),
        coalesce(before_hash, ''),
        coalesce(after_hash, ''),
        coalesce(previous_hash, ''),
        event_time::text,
        txid_current()::text
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.safety_program_audit_events (
    company_id,
    location_id,
    actor_user_id,
    actor_type,
    entity_table,
    entity_id,
    action,
    before_sha256,
    after_sha256,
    previous_event_sha256,
    event_sha256,
    changed_fields,
    request_context,
    occurred_at
  )
  values (
    event_company_id,
    event_location_id,
    auth.uid(),
    actor_kind,
    tg_table_schema || '.' || tg_table_name,
    event_entity_id,
    lower(tg_op),
    before_hash,
    after_hash,
    previous_hash,
    event_hash,
    changed,
    jsonb_build_object(
      'database_role', current_user,
      'application_name', current_setting('application_name', true)
    ),
    event_time
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Security-definer helpers keep RLS policy expressions non-recursive.
create or replace function private.can_view_safety_program_version(target_program_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_program_versions program_version
    where program_version.id = target_program_version_id
      and (
        private.can_manage_company(program_version.company_id)
        or (
          program_version.status = 'published'
          and private.is_company_member(program_version.company_id)
          and (
            private.company_role(program_version.company_id) = 'auditor'
            or exists (
              select 1
              from public.safety_program_location_applicability applicability
              where applicability.program_version_id = program_version.id
                and applicability.review_status = 'reviewed'
                and applicability.applicability_status in ('applies', 'conditional')
                and private.can_access_location(
                  applicability.company_id,
                  applicability.location_id
                )
            )
          )
        )
      )
  );
$$;

create or replace function private.can_access_safety_program_submission(target_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_program_form_submissions submission
    where submission.id = target_submission_id
      and (
        submission.submitted_by = auth.uid()
        or private.can_write_location(submission.company_id, submission.location_id)
        or (
          private.company_role(submission.company_id) = 'auditor'
          and private.can_access_location(submission.company_id, submission.location_id)
        )
      )
  );
$$;

create or replace function private.can_edit_safety_program_submission(target_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_program_form_submissions submission
    where submission.id = target_submission_id
      and submission.status = 'draft'
      and (
        submission.submitted_by = auth.uid()
        or private.can_write_location(submission.company_id, submission.location_id)
      )
  );
$$;

create or replace function private.can_access_safety_program_storage_object(target_object_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_program_storage_objects object_record
    where object_record.id = target_object_id
      and (
        private.can_manage_company(object_record.company_id)
        or object_record.uploaded_by = auth.uid()
        or exists (
          select 1
          from public.safety_program_answer_files answer_file
          join public.safety_program_form_answers answer
            on answer.id = answer_file.answer_id
          where answer_file.storage_object_id = object_record.id
            and private.can_access_safety_program_submission(answer.submission_id)
        )
        or exists (
          select 1
          from public.safety_program_form_signatures signature_record
          where signature_record.signature_storage_object_id = object_record.id
            and private.can_access_safety_program_submission(signature_record.submission_id)
        )
      )
  );
$$;

-- Narrow workflow RPCs make the legal completion events atomic.
create or replace function public.submit_safety_program_form(
  target_submission_id uuid,
  payload_sha256 text
)
returns public.safety_program_form_submissions
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  submission_record public.safety_program_form_submissions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;
  if payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'payload_sha256 must be a lowercase SHA-256 digest'
      using errcode = '22023';
  end if;

  select submission.*
  into submission_record
  from public.safety_program_form_submissions submission
  where submission.id = target_submission_id
  for update;

  if submission_record.id is null then
    raise exception 'submission not found'
      using errcode = 'P0002';
  end if;
  if submission_record.submitted_by <> auth.uid() then
    raise exception 'only the form owner may submit this payload'
      using errcode = '42501';
  end if;
  if submission_record.status <> 'draft' then
    raise exception 'submission is not editable'
      using errcode = '55000';
  end if;

  update public.safety_program_form_submissions
  set status = 'submitted',
      submitted_payload_sha256 = payload_sha256,
      updated_at = clock_timestamp()
  where id = target_submission_id
  returning * into submission_record;

  if submission_record.assignment_id is not null then
    update public.safety_program_assignments
    set status = 'completed',
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = submission_record.assignment_id
      and status in ('assigned', 'in_progress');
  end if;

  return submission_record;
end;
$$;

create or replace function public.acknowledge_safety_program_assignment(
  target_assignment_id uuid,
  attestation_text text,
  payload_sha256 text,
  signature_method_value text,
  signature_record_value jsonb,
  signature_sha256_value text
)
returns public.safety_program_acknowledgements
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  assignment_record public.safety_program_assignments%rowtype;
  program_version_record public.safety_program_versions%rowtype;
  acknowledgement_record public.safety_program_acknowledgements%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;
  if char_length(coalesce(attestation_text, '')) < 8 then
    raise exception 'attestation is required'
      using errcode = '22023';
  end if;
  if payload_sha256 !~ '^[0-9a-f]{64}$'
     or signature_sha256_value !~ '^[0-9a-f]{64}$' then
    raise exception 'payload and signature hashes must be lowercase SHA-256 digests'
      using errcode = '22023';
  end if;
  if signature_method_value not in ('typed', 'electronic_ack', 'digital_certificate') then
    raise exception 'unsupported acknowledgement signature method'
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(signature_record_value, '{}'::jsonb)) <> 'object' then
    raise exception 'signature_record_value must be a JSON object'
      using errcode = '22023';
  end if;

  select assignment.*
  into assignment_record
  from public.safety_program_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if assignment_record.id is null then
    raise exception 'assignment not found'
      using errcode = 'P0002';
  end if;
  if assignment_record.assignee_user_id <> auth.uid()
     or assignment_record.assignment_type <> 'read_and_acknowledge'
     or assignment_record.status not in ('assigned', 'in_progress') then
    raise exception 'assignment is not an active acknowledgement for the current user'
      using errcode = '42501';
  end if;

  select program_version.*
  into program_version_record
  from public.safety_program_versions program_version
  where program_version.id = assignment_record.program_version_id;

  if program_version_record.status <> 'published'
     or program_version_record.content_manifest_sha256 <> payload_sha256 then
    raise exception 'acknowledgement must pin the currently assigned published payload'
      using errcode = '23514';
  end if;

  insert into public.safety_program_acknowledgements (
    company_id,
    program_version_id,
    location_id,
    assignment_id,
    user_id,
    attestation,
    acknowledged_payload_sha256,
    signature_method,
    signature_record,
    signature_sha256
  )
  values (
    assignment_record.company_id,
    assignment_record.program_version_id,
    assignment_record.location_id,
    assignment_record.id,
    auth.uid(),
    attestation_text,
    payload_sha256,
    signature_method_value,
    coalesce(signature_record_value, '{}'::jsonb),
    signature_sha256_value
  )
  returning * into acknowledgement_record;

  update public.safety_program_assignments
  set status = 'completed',
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = assignment_record.id;

  return acknowledgement_record;
end;
$$;

revoke all on function public.submit_safety_program_form(uuid, text)
  from public, anon;
grant execute on function public.submit_safety_program_form(uuid, text)
  to authenticated;

revoke all on function public.acknowledge_safety_program_assignment(
  uuid, text, text, text, jsonb, text
) from public, anon;
grant execute on function public.acknowledge_safety_program_assignment(
  uuid, text, text, text, jsonb, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger safety_program_storage_objects_guard
before insert or update or delete on public.safety_program_storage_objects
for each row execute function program_private.guard_storage_insert();

create trigger safety_program_source_documents_identity
before update or delete on public.safety_program_source_documents
for each row execute function program_private.guard_source_document_identity();

create trigger safety_program_source_documents_touch
before update on public.safety_program_source_documents
for each row execute function private.touch_updated_at();

create trigger safety_program_source_versions_immutable
before update or delete on public.safety_program_source_versions
for each row execute function program_private.reject_mutation();

create trigger safety_program_source_version_artifacts_immutable
before update or delete on public.safety_program_source_version_artifacts
for each row execute function program_private.reject_mutation();

create trigger safety_programs_identity
before update or delete on public.safety_programs
for each row execute function program_private.guard_program_identity();

create trigger safety_programs_touch
before update on public.safety_programs
for each row execute function private.touch_updated_at();

create trigger safety_program_versions_guard
before insert or update or delete on public.safety_program_versions
for each row execute function program_private.guard_program_version();

create trigger safety_program_versions_touch
before update on public.safety_program_versions
for each row execute function private.touch_updated_at();

create trigger safety_program_version_sources_guard
before insert or update or delete on public.safety_program_version_sources
for each row execute function program_private.guard_program_child();

create trigger safety_program_sections_identity
before update or delete on public.safety_program_sections
for each row execute function program_private.guard_logical_child_identity();

create trigger safety_program_section_versions_guard
before insert or update or delete on public.safety_program_section_versions
for each row execute function program_private.guard_program_child();

create trigger safety_program_location_applicability_guard
before insert or update or delete on public.safety_program_location_applicability
for each row execute function program_private.guard_program_child();

create trigger safety_program_location_applicability_touch
before update on public.safety_program_location_applicability
for each row execute function private.touch_updated_at();

create trigger safety_program_form_templates_identity
before update or delete on public.safety_program_form_templates
for each row execute function program_private.guard_logical_child_identity();

create trigger safety_program_form_template_versions_guard
before insert or update or delete on public.safety_program_form_template_versions
for each row execute function program_private.guard_form_template_version();

create trigger safety_program_form_template_versions_touch
before update on public.safety_program_form_template_versions
for each row execute function private.touch_updated_at();

create trigger safety_program_form_fields_guard
before insert or update or delete on public.safety_program_form_fields
for each row execute function program_private.guard_form_field();

create trigger safety_program_section_form_links_guard
before insert or update or delete on public.safety_program_section_form_links
for each row execute function program_private.guard_program_child();

create trigger safety_program_training_links_guard
before insert or update or delete on public.safety_program_training_links
for each row execute function program_private.guard_program_child();

create trigger safety_program_regulatory_links_guard
before insert or update or delete on public.safety_program_regulatory_links
for each row execute function program_private.guard_program_child();

create trigger safety_program_assignments_guard
before insert or update or delete on public.safety_program_assignments
for each row execute function program_private.guard_assignment();

create trigger safety_program_assignments_touch
before update on public.safety_program_assignments
for each row execute function private.touch_updated_at();

create trigger safety_program_submissions_guard
before insert or update or delete on public.safety_program_form_submissions
for each row execute function program_private.guard_submission();

create trigger safety_program_submissions_touch
before update on public.safety_program_form_submissions
for each row execute function private.touch_updated_at();

create trigger safety_program_answers_guard
before insert or update or delete on public.safety_program_form_answers
for each row execute function program_private.guard_answer();

create trigger safety_program_answers_touch
before update on public.safety_program_form_answers
for each row execute function private.touch_updated_at();

create trigger safety_program_answer_files_guard
before insert or update or delete on public.safety_program_answer_files
for each row execute function program_private.guard_answer_file();

create trigger safety_program_signatures_guard
before insert or update or delete on public.safety_program_form_signatures
for each row execute function program_private.guard_signature();

create trigger safety_program_acknowledgements_immutable
before update or delete on public.safety_program_acknowledgements
for each row execute function program_private.reject_mutation();

create trigger safety_program_audit_events_immutable
before update or delete on public.safety_program_audit_events
for each row execute function program_private.reject_mutation();

-- All domain rows have a UUID id and company_id, which the generic audit
-- capture function expects. Audit events themselves are excluded.
do $$
declare
  audited_table text;
begin
  foreach audited_table in array array[
    'safety_program_storage_objects',
    'safety_program_source_documents',
    'safety_program_source_versions',
    'safety_program_source_version_artifacts',
    'safety_programs',
    'safety_program_versions',
    'safety_program_version_sources',
    'safety_program_sections',
    'safety_program_section_versions',
    'safety_program_location_applicability',
    'safety_program_form_templates',
    'safety_program_form_template_versions',
    'safety_program_form_fields',
    'safety_program_section_form_links',
    'safety_program_training_links',
    'safety_program_regulatory_links',
    'safety_program_assignments',
    'safety_program_form_submissions',
    'safety_program_form_answers',
    'safety_program_answer_files',
    'safety_program_form_signatures',
    'safety_program_acknowledgements'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function program_private.capture_audit_event()',
      audited_table || '_audit',
      audited_table
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level tenant and location boundaries
-- ---------------------------------------------------------------------------

alter table public.safety_program_storage_objects enable row level security;
alter table public.safety_program_source_documents enable row level security;
alter table public.safety_program_source_versions enable row level security;
alter table public.safety_program_source_version_artifacts enable row level security;
alter table public.safety_programs enable row level security;
alter table public.safety_program_versions enable row level security;
alter table public.safety_program_version_sources enable row level security;
alter table public.safety_program_sections enable row level security;
alter table public.safety_program_section_versions enable row level security;
alter table public.safety_program_location_applicability enable row level security;
alter table public.safety_program_form_templates enable row level security;
alter table public.safety_program_form_template_versions enable row level security;
alter table public.safety_program_form_fields enable row level security;
alter table public.safety_program_section_form_links enable row level security;
alter table public.safety_program_training_links enable row level security;
alter table public.safety_program_regulatory_links enable row level security;
alter table public.safety_program_assignments enable row level security;
alter table public.safety_program_form_submissions enable row level security;
alter table public.safety_program_form_answers enable row level security;
alter table public.safety_program_answer_files enable row level security;
alter table public.safety_program_form_signatures enable row level security;
alter table public.safety_program_acknowledgements enable row level security;
alter table public.safety_program_audit_events enable row level security;

revoke all on table
  public.safety_program_storage_objects,
  public.safety_program_source_documents,
  public.safety_program_source_versions,
  public.safety_program_source_version_artifacts,
  public.safety_programs,
  public.safety_program_versions,
  public.safety_program_version_sources,
  public.safety_program_sections,
  public.safety_program_section_versions,
  public.safety_program_location_applicability,
  public.safety_program_form_templates,
  public.safety_program_form_template_versions,
  public.safety_program_form_fields,
  public.safety_program_section_form_links,
  public.safety_program_training_links,
  public.safety_program_regulatory_links,
  public.safety_program_assignments,
  public.safety_program_form_submissions,
  public.safety_program_form_answers,
  public.safety_program_answer_files,
  public.safety_program_form_signatures,
  public.safety_program_acknowledgements,
  public.safety_program_audit_events
from anon;

grant select on table
  public.safety_program_storage_objects,
  public.safety_program_source_documents,
  public.safety_program_source_versions,
  public.safety_program_source_version_artifacts,
  public.safety_programs,
  public.safety_program_versions,
  public.safety_program_version_sources,
  public.safety_program_sections,
  public.safety_program_section_versions,
  public.safety_program_location_applicability,
  public.safety_program_form_templates,
  public.safety_program_form_template_versions,
  public.safety_program_form_fields,
  public.safety_program_section_form_links,
  public.safety_program_training_links,
  public.safety_program_regulatory_links,
  public.safety_program_assignments,
  public.safety_program_form_submissions,
  public.safety_program_form_answers,
  public.safety_program_answer_files,
  public.safety_program_form_signatures,
  public.safety_program_acknowledgements,
  public.safety_program_audit_events
to authenticated;

grant insert, update, delete on table public.safety_program_source_documents to authenticated;
grant insert on table public.safety_program_source_versions to authenticated;
grant insert on table public.safety_program_source_version_artifacts to authenticated;
grant insert, update, delete on table public.safety_programs to authenticated;
grant insert, update, delete on table public.safety_program_versions to authenticated;
grant insert, update, delete on table public.safety_program_version_sources to authenticated;
grant insert on table public.safety_program_sections to authenticated;
grant insert, update, delete on table public.safety_program_section_versions to authenticated;
grant insert, update, delete on table public.safety_program_location_applicability to authenticated;
grant insert on table public.safety_program_form_templates to authenticated;
grant insert, update, delete on table public.safety_program_form_template_versions to authenticated;
grant insert, update, delete on table public.safety_program_form_fields to authenticated;
grant insert, update, delete on table public.safety_program_section_form_links to authenticated;
grant insert, update, delete on table public.safety_program_training_links to authenticated;
grant insert, update, delete on table public.safety_program_regulatory_links to authenticated;
grant insert, update, delete on table public.safety_program_assignments to authenticated;
grant insert, update, delete on table public.safety_program_form_submissions to authenticated;
grant insert, update, delete on table public.safety_program_form_answers to authenticated;
grant insert, delete on table public.safety_program_answer_files to authenticated;
grant insert on table public.safety_program_form_signatures to authenticated;

create policy safety_program_storage_objects_select
on public.safety_program_storage_objects
for select
using (private.can_access_safety_program_storage_object(id));

create policy safety_program_source_documents_select
on public.safety_program_source_documents
for select
using (private.can_manage_company(company_id));

create policy safety_program_source_documents_insert
on public.safety_program_source_documents
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_source_documents_update
on public.safety_program_source_documents
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_source_documents_delete
on public.safety_program_source_documents
for delete
using (private.can_manage_company(company_id));

create policy safety_program_source_versions_select
on public.safety_program_source_versions
for select
using (private.can_manage_company(company_id));

create policy safety_program_source_versions_insert
on public.safety_program_source_versions
for insert
with check (
  private.can_manage_company(company_id)
  and (imported_by is null or imported_by = auth.uid())
);

create policy safety_program_source_artifacts_select
on public.safety_program_source_version_artifacts
for select
using (private.can_manage_company(company_id));

create policy safety_program_source_artifacts_insert
on public.safety_program_source_version_artifacts
for insert
with check (
  private.can_manage_company(company_id)
  and (created_by is null or created_by = auth.uid())
);

create policy safety_programs_select
on public.safety_programs
for select
using (
  private.can_manage_company(company_id)
  or exists (
    select 1
    from public.safety_program_versions version_record
    where version_record.program_id = safety_programs.id
      and private.can_view_safety_program_version(version_record.id)
  )
);

create policy safety_programs_insert
on public.safety_programs
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_programs_update
on public.safety_programs
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_programs_delete
on public.safety_programs
for delete
using (private.can_manage_company(company_id));

create policy safety_program_versions_select
on public.safety_program_versions
for select
using (private.can_view_safety_program_version(id));

create policy safety_program_versions_insert
on public.safety_program_versions
for insert
with check (
  private.can_manage_company(company_id)
  and prepared_by = auth.uid()
);

create policy safety_program_versions_update
on public.safety_program_versions
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_versions_delete
on public.safety_program_versions
for delete
using (private.can_manage_company(company_id));

create policy safety_program_version_sources_select
on public.safety_program_version_sources
for select
using (private.can_view_safety_program_version(program_version_id));

create policy safety_program_version_sources_insert
on public.safety_program_version_sources
for insert
with check (
  private.can_manage_company(company_id)
  and linked_by = auth.uid()
);

create policy safety_program_version_sources_update
on public.safety_program_version_sources
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_version_sources_delete
on public.safety_program_version_sources
for delete
using (private.can_manage_company(company_id));

create policy safety_program_sections_select
on public.safety_program_sections
for select
using (
  private.can_manage_company(company_id)
  or exists (
    select 1
    from public.safety_program_section_versions section_version
    where section_version.section_id = safety_program_sections.id
      and private.can_view_safety_program_version(section_version.program_version_id)
  )
);

create policy safety_program_sections_insert
on public.safety_program_sections
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_section_versions_select
on public.safety_program_section_versions
for select
using (private.can_view_safety_program_version(program_version_id));

create policy safety_program_section_versions_insert
on public.safety_program_section_versions
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_section_versions_update
on public.safety_program_section_versions
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_section_versions_delete
on public.safety_program_section_versions
for delete
using (private.can_manage_company(company_id));

create policy safety_program_applicability_select
on public.safety_program_location_applicability
for select
using (
  private.can_manage_company(company_id)
  or (
    private.can_access_location(company_id, location_id)
    and private.can_view_safety_program_version(program_version_id)
  )
);

create policy safety_program_applicability_insert
on public.safety_program_location_applicability
for insert
with check (
  private.can_write_location(company_id, location_id)
  and assessed_by = auth.uid()
);

create policy safety_program_applicability_update
on public.safety_program_location_applicability
for update
using (private.can_write_location(company_id, location_id))
with check (private.can_write_location(company_id, location_id));

create policy safety_program_applicability_delete
on public.safety_program_location_applicability
for delete
using (private.can_write_location(company_id, location_id));

create policy safety_program_form_templates_select
on public.safety_program_form_templates
for select
using (
  private.can_manage_company(company_id)
  or exists (
    select 1
    from public.safety_program_form_template_versions form_version
    where form_version.template_id = safety_program_form_templates.id
      and private.can_view_safety_program_version(form_version.program_version_id)
  )
);

create policy safety_program_form_templates_insert
on public.safety_program_form_templates
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_form_template_versions_select
on public.safety_program_form_template_versions
for select
using (private.can_view_safety_program_version(program_version_id));

create policy safety_program_form_template_versions_insert
on public.safety_program_form_template_versions
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_form_template_versions_update
on public.safety_program_form_template_versions
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_form_template_versions_delete
on public.safety_program_form_template_versions
for delete
using (private.can_manage_company(company_id));

create policy safety_program_form_fields_select
on public.safety_program_form_fields
for select
using (private.can_view_safety_program_version(program_version_id));

create policy safety_program_form_fields_insert
on public.safety_program_form_fields
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_form_fields_update
on public.safety_program_form_fields
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_form_fields_delete
on public.safety_program_form_fields
for delete
using (private.can_manage_company(company_id));

create policy safety_program_section_form_links_select
on public.safety_program_section_form_links
for select
using (private.can_view_safety_program_version(program_version_id));

create policy safety_program_section_form_links_insert
on public.safety_program_section_form_links
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_section_form_links_update
on public.safety_program_section_form_links
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_section_form_links_delete
on public.safety_program_section_form_links
for delete
using (private.can_manage_company(company_id));

create policy safety_program_training_links_select
on public.safety_program_training_links
for select
using (
  private.can_view_safety_program_version(program_version_id)
  and (
    location_id is null
    or private.can_access_location(company_id, location_id)
  )
);

create policy safety_program_training_links_insert
on public.safety_program_training_links
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_training_links_update
on public.safety_program_training_links
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_training_links_delete
on public.safety_program_training_links
for delete
using (private.can_manage_company(company_id));

create policy safety_program_regulatory_links_select
on public.safety_program_regulatory_links
for select
using (
  private.can_view_safety_program_version(program_version_id)
  and (
    location_id is null
    or private.can_access_location(company_id, location_id)
  )
);

create policy safety_program_regulatory_links_insert
on public.safety_program_regulatory_links
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_regulatory_links_update
on public.safety_program_regulatory_links
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_regulatory_links_delete
on public.safety_program_regulatory_links
for delete
using (private.can_manage_company(company_id));

create policy safety_program_assignments_select
on public.safety_program_assignments
for select
using (
  assignee_user_id = auth.uid()
  or private.can_access_location(company_id, location_id)
);

create policy safety_program_assignments_insert
on public.safety_program_assignments
for insert
with check (
  private.can_write_location(company_id, location_id)
  and assigned_by = auth.uid()
);

create policy safety_program_assignments_update
on public.safety_program_assignments
for update
using (private.can_write_location(company_id, location_id))
with check (private.can_write_location(company_id, location_id));

create policy safety_program_assignments_delete
on public.safety_program_assignments
for delete
using (private.can_write_location(company_id, location_id));

create policy safety_program_submissions_select
on public.safety_program_form_submissions
for select
using (private.can_access_safety_program_submission(id));

create policy safety_program_submissions_insert
on public.safety_program_form_submissions
for insert
with check (
  submitted_by = auth.uid()
  and private.can_access_location(company_id, location_id)
  and private.can_view_safety_program_version(program_version_id)
);

create policy safety_program_submissions_owner_update
on public.safety_program_form_submissions
for update
using (
  submitted_by = auth.uid()
  and status = 'draft'
)
with check (submitted_by = auth.uid());

create policy safety_program_submissions_manager_update
on public.safety_program_form_submissions
for update
using (private.can_write_location(company_id, location_id))
with check (private.can_write_location(company_id, location_id));

create policy safety_program_submissions_delete
on public.safety_program_form_submissions
for delete
using (
  status = 'draft'
  and (
    submitted_by = auth.uid()
    or private.can_write_location(company_id, location_id)
  )
);

create policy safety_program_answers_select
on public.safety_program_form_answers
for select
using (private.can_access_safety_program_submission(submission_id));

create policy safety_program_answers_insert
on public.safety_program_form_answers
for insert
with check (
  answered_by = auth.uid()
  and private.can_edit_safety_program_submission(submission_id)
);

create policy safety_program_answers_update
on public.safety_program_form_answers
for update
using (private.can_edit_safety_program_submission(submission_id))
with check (private.can_edit_safety_program_submission(submission_id));

create policy safety_program_answers_delete
on public.safety_program_form_answers
for delete
using (private.can_edit_safety_program_submission(submission_id));

create policy safety_program_answer_files_select
on public.safety_program_answer_files
for select
using (
  exists (
    select 1
    from public.safety_program_form_answers answer
    where answer.id = safety_program_answer_files.answer_id
      and private.can_access_safety_program_submission(answer.submission_id)
  )
);

create policy safety_program_answer_files_insert
on public.safety_program_answer_files
for insert
with check (
  attached_by = auth.uid()
  and exists (
    select 1
    from public.safety_program_form_answers answer
    where answer.id = safety_program_answer_files.answer_id
      and private.can_edit_safety_program_submission(answer.submission_id)
  )
);

create policy safety_program_answer_files_delete
on public.safety_program_answer_files
for delete
using (
  exists (
    select 1
    from public.safety_program_form_answers answer
    where answer.id = safety_program_answer_files.answer_id
      and private.can_edit_safety_program_submission(answer.submission_id)
  )
);

create policy safety_program_signatures_select
on public.safety_program_form_signatures
for select
using (private.can_access_safety_program_submission(submission_id));

create policy safety_program_signatures_insert
on public.safety_program_form_signatures
for insert
with check (
  signer_user_id = auth.uid()
  and private.can_edit_safety_program_submission(submission_id)
);

create policy safety_program_acknowledgements_select
on public.safety_program_acknowledgements
for select
using (
  user_id = auth.uid()
  or private.can_access_location(company_id, location_id)
);

create policy safety_program_audit_events_select
on public.safety_program_audit_events
for select
using (
  private.can_manage_company(company_id)
  or (
    private.company_role(company_id) = 'auditor'
    and (
      location_id is null
      or private.can_access_location(company_id, location_id)
    )
  )
);

comment on table public.safety_program_source_versions is
  'Immutable observations of Drive/provider revisions; credentials stay in Edge secrets.';
comment on table public.safety_program_versions is
  'Controlled written-program editions. Approval requires four-eye review, exact source hashes, and a reviewed applicability row for every active location.';
comment on table public.safety_program_regulatory_links is
  'Exact OSHA/state trace links from program content or controls to immutable requirement/source-text versions.';
comment on table public.safety_program_audit_events is
  'Append-only tenant hash chain. Export signed manifests to independent WORM storage for legal-grade non-repudiation.';
