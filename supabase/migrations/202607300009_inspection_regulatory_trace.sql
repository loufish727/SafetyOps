-- SafetyOps inspection regulatory trace
--
-- A submitted inspection and its regulatory evidence must be one database
-- transaction. Browser-provided citation strings are intentionally not accepted
-- by the submission RPC. The database derives every trace edge from:
--   * the exact published form_template_version;
--   * an approved/effective control_requirement_mapping;
--   * the current location_regulatory_profile state at submission;
--   * an approved applicability assessment for that exact profile/requirement;
--   * a published regulatory release containing the requirement version; and
--   * immutable requirement citations and source snapshots.
--
-- Mappings that are absent, not applicable, or unresolved are preserved in an
-- append-only context manifest. They are never emitted as compliance evidence.

-- ---------------------------------------------------------------------------
-- Submission identity and typed inspection evidence lineage
-- ---------------------------------------------------------------------------

alter table public.inspections
  add column client_submission_key text;

alter table public.inspections
  add constraint inspections_client_submission_key_format
  check (
    client_submission_key is null
    or char_length(client_submission_key) between 8 and 200
  );

create unique index inspections_submission_idempotency_idx
  on public.inspections(company_id, created_by, client_submission_key)
  where client_submission_key is not null;

alter table public.compliance_evidence_links
  add column regulatory_profile_id uuid,
  add column applicability_assessment_id uuid,
  add column regulatory_release_id uuid
    references public.regulatory_releases(id) on delete restrict,
  add column trace_sha256 text
    check (trace_sha256 is null or trace_sha256 ~ '^[0-9a-f]{64}$');

alter table public.compliance_evidence_links
  add constraint compliance_evidence_profile_fk
  foreign key (company_id, location_id, regulatory_profile_id)
  references public.location_regulatory_profiles(company_id, location_id, id)
  on delete restrict,
  add constraint compliance_evidence_applicability_fk
  foreign key (company_id, applicability_assessment_id)
  references public.requirement_applicability_assessments(company_id, id)
  on delete restrict;

-- Legacy evidence rows remain readable. Every new inspection-evidence row is
-- required to carry the complete typed trace.
alter table public.compliance_evidence_links
  add constraint compliance_evidence_inspection_trace_complete
  check (
    inspection_id is null
    or (
      control_mapping_id is not null
      and regulatory_profile_id is not null
      and applicability_assessment_id is not null
      and regulatory_release_id is not null
      and trace_sha256 is not null
    )
  ) not valid;

create unique index compliance_evidence_inspection_mapping_idx
  on public.compliance_evidence_links(inspection_id, control_mapping_id)
  where inspection_id is not null and control_mapping_id is not null;

create index compliance_evidence_inspection_idx
  on public.compliance_evidence_links(company_id, inspection_id, observed_at);

-- One append-only, server-generated regulatory context is required for every
-- newly submitted inspection. This also records an honest "review_required",
-- "unmapped", or "unresolved" result when no compliance-evidence edge can be
-- established.
create table public.inspection_regulatory_contexts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  inspection_id uuid not null,
  location_id uuid not null,
  template_version_id uuid not null,
  regulatory_profile_id uuid,
  trace_status text not null
    check (
      trace_status in (
        'verified',
        'partial',
        'unresolved',
        'unmapped',
        'review_required'
      )
    ),
  template_schema_sha256 text not null
    check (template_schema_sha256 ~ '^[0-9a-f]{64}$'),
  submission_payload_sha256 text not null
    check (submission_payload_sha256 ~ '^[0-9a-f]{64}$'),
  profile_sha256 text
    check (profile_sha256 is null or profile_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_count integer not null check (mapping_count >= 0),
  evidence_count integer not null check (evidence_count >= 0),
  excluded_count integer not null check (excluded_count >= 0),
  unresolved_count integer not null check (unresolved_count >= 0),
  context_manifest jsonb not null check (jsonb_typeof(context_manifest) = 'object'),
  context_sha256 text not null check (context_sha256 ~ '^[0-9a-f]{64}$'),
  captured_by uuid not null references auth.users(id) on delete restrict,
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (company_id, inspection_id),
  foreign key (company_id, inspection_id)
    references public.inspections(company_id, id) on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, template_version_id)
    references public.form_template_versions(company_id, id) on delete restrict,
  foreign key (company_id, location_id, regulatory_profile_id)
    references public.location_regulatory_profiles(company_id, location_id, id)
    on delete restrict,
  check (
    mapping_count = evidence_count + excluded_count + unresolved_count
  )
);

create index inspection_regulatory_context_location_idx
  on public.inspection_regulatory_contexts(company_id, location_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Trace validation helpers
-- ---------------------------------------------------------------------------

-- Recognized stable locator shapes. An empty result means that the mapping
-- applies to the template as a whole.
create or replace function regulatory_private.control_locator_keys(
  target_locator jsonb
)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct locator_key order by locator_key), array[]::text[])
  from (
    select nullif(target_locator ->> 'questionKey', '') as locator_key
    union all
    select nullif(target_locator ->> 'question_key', '')
    union all
    select nullif(target_locator ->> 'fieldKey', '')
    union all
    select nullif(target_locator ->> 'field_key', '')
    union all
    select value
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(target_locator -> 'questionKeys') = 'array'
          then target_locator -> 'questionKeys'
        else '[]'::jsonb
      end
    ) as item(value)
    union all
    select value
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(target_locator -> 'question_keys') = 'array'
          then target_locator -> 'question_keys'
        else '[]'::jsonb
      end
    ) as item(value)
    union all
    select value
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(target_locator -> 'fieldKeys') = 'array'
          then target_locator -> 'fieldKeys'
        else '[]'::jsonb
      end
    ) as item(value)
    union all
    select value
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(target_locator -> 'field_keys') = 'array'
          then target_locator -> 'field_keys'
        else '[]'::jsonb
      end
    ) as item(value)
  ) locator_values
  where locator_key is not null;
$$;

-- This trigger makes direct evidence inserts obey the same typed invariants as
-- the RPC. It also replaces evidence_locator with a database-derived manifest;
-- callers cannot smuggle unverified citation or hash claims into the row.
create or replace function regulatory_private.validate_inspection_evidence_trace()
returns trigger
language plpgsql
security definer
set search_path = public, private, regulatory_private, pg_temp
as $$
declare
  inspection_record public.inspections%rowtype;
  mapping_record public.control_requirement_mappings%rowtype;
  profile_record public.location_regulatory_profiles%rowtype;
  assessment_record public.requirement_applicability_assessments%rowtype;
  release_record public.regulatory_releases%rowtype;
  requirement_status text;
  requirement_content_sha256 text;
  template_schema_sha256 text;
  responses_sha256 text;
  profile_sha256 text;
  citation_manifest jsonb;
begin
  if new.inspection_id is null then
    return new;
  end if;

  select inspection_value.*
  into inspection_record
  from public.inspections inspection_value
  where inspection_value.id = new.inspection_id;

  if not found
     or inspection_record.status <> 'submitted'
     or inspection_record.submitted_at is null then
    raise exception 'inspection evidence requires an existing submitted inspection'
      using errcode = '23514';
  end if;
  if inspection_record.company_id <> new.company_id
     or inspection_record.location_id <> new.location_id then
    raise exception 'inspection evidence company/location does not match inspection'
      using errcode = '23514';
  end if;
  if new.observed_at is distinct from inspection_record.submitted_at then
    raise exception 'inspection evidence observed_at must equal submitted_at'
      using errcode = '23514';
  end if;
  if new.linked_by <> inspection_record.created_by then
    raise exception 'inspection evidence linker must be the inspection submitter'
      using errcode = '23514';
  end if;

  select mapping_value.*
  into mapping_record
  from public.control_requirement_mappings mapping_value
  where mapping_value.id = new.control_mapping_id;

  if not found
     or mapping_record.company_id <> new.company_id
     or mapping_record.requirement_version_id <> new.requirement_version_id
     or mapping_record.form_template_version_id
       is distinct from inspection_record.template_version_id
     or mapping_record.status <> 'approved'
     or (
       mapping_record.location_id is not null
       and mapping_record.location_id <> new.location_id
     )
     or (
       mapping_record.effective_from is not null
       and mapping_record.effective_from > new.observed_at
     )
     or (
       mapping_record.effective_to is not null
       and mapping_record.effective_to < new.observed_at
     ) then
    raise exception 'inspection evidence mapping is not approved/effective for this submission'
      using errcode = '23514';
  end if;

  select requirement_value.status, requirement_value.content_sha256
  into requirement_status, requirement_content_sha256
  from public.compliance_requirement_versions requirement_value
  where requirement_value.id = new.requirement_version_id;

  if requirement_status <> 'approved'
     or requirement_content_sha256 is null
     or not private.is_regulatory_item_published(
       'requirement_version',
       new.requirement_version_id
     ) then
    raise exception 'inspection evidence requires an approved published requirement'
      using errcode = '23514';
  end if;

  select profile_value.*
  into profile_record
  from public.location_regulatory_profiles profile_value
  where profile_value.id = new.regulatory_profile_id;

  if not found
     or profile_record.company_id <> new.company_id
     or profile_record.location_id <> new.location_id
     or profile_record.status <> 'approved'
     or profile_record.reviewed_by is null
     or profile_record.reviewed_at is null
     or (
       profile_record.effective_from is not null
       and profile_record.effective_from > new.observed_at::date
     )
     or (
       profile_record.effective_to is not null
       and profile_record.effective_to < new.observed_at::date
     ) then
    raise exception 'inspection evidence requires the reviewed profile in force'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.location_jurisdiction_assignments assignment
    where assignment.profile_id = profile_record.id
      and assignment.reviewed_by is not null
      and assignment.reviewed_at is not null
      and assignment.coverage_status in ('applies', 'partial')
      and (
        assignment.valid_from is null
        or assignment.valid_from <= new.observed_at::date
      )
      and (
        assignment.valid_to is null
        or assignment.valid_to >= new.observed_at::date
      )
  ) or exists (
    select 1
    from public.location_jurisdiction_assignments assignment
    where assignment.profile_id = profile_record.id
      and (
        assignment.reviewed_by is null
        or assignment.reviewed_at is null
        or assignment.coverage_status = 'requires_review'
      )
  ) then
    raise exception 'inspection evidence requires fully reviewed jurisdiction assignments'
      using errcode = '23514';
  end if;

  select assessment_value.*
  into assessment_record
  from public.requirement_applicability_assessments assessment_value
  where assessment_value.id = new.applicability_assessment_id;

  if not found
     or assessment_record.company_id <> new.company_id
     or assessment_record.location_id <> new.location_id
     or assessment_record.profile_id <> new.regulatory_profile_id
     or assessment_record.requirement_version_id <> new.requirement_version_id
     or assessment_record.status <> 'approved'
     or assessment_record.applicability_status not in ('applies', 'conditional')
     or assessment_record.reviewed_by is null
     or assessment_record.reviewed_at is null
     or assessment_record.assessment_sha256 is null
     or (
       assessment_record.valid_from is not null
       and assessment_record.valid_from > new.observed_at::date
     )
     or (
       assessment_record.valid_to is not null
       and assessment_record.valid_to < new.observed_at::date
     ) then
    raise exception 'inspection evidence requires an approved applicable assessment'
      using errcode = '23514';
  end if;

  select release_value.*
  into release_record
  from public.regulatory_releases release_value
  where release_value.id = new.regulatory_release_id;

  if not found
     or release_record.status <> 'published'
     or release_record.published_at is null
     or release_record.published_at > new.observed_at
     or release_record.manifest_sha256 is null
     or not exists (
       select 1
       from public.regulatory_release_items release_item
       where release_item.release_id = release_record.id
         and release_item.requirement_version_id = new.requirement_version_id
         and release_item.item_sha256 = requirement_content_sha256
     ) then
    raise exception 'inspection evidence requires the published requirement release'
      using errcode = '23514';
  end if;

  select encode(
    extensions.digest(convert_to(version_value.schema_json::text, 'UTF8'), 'sha256'),
    'hex'
  )
  into template_schema_sha256
  from public.form_template_versions version_value
  where version_value.id = inspection_record.template_version_id
    and version_value.company_id = inspection_record.company_id
    and version_value.published;

  if template_schema_sha256 is null then
    raise exception 'inspection template version is no longer published'
      using errcode = '23514';
  end if;

  responses_sha256 := encode(
    extensions.digest(convert_to(inspection_record.responses::text, 'UTF8'), 'sha256'),
    'hex'
  );
  profile_sha256 := encode(
    extensions.digest(convert_to(to_jsonb(profile_record)::text, 'UTF8'), 'sha256'),
    'hex'
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'requirementCitationId', citation.id,
        'relationship', citation.relationship,
        'isPrimary', citation.is_primary,
        'exactExcerptSha256', citation.exact_excerpt_sha256,
        'regulatoryUnitVersionId', unit_version.id,
        'canonicalCitation', unit_version.canonical_citation,
        'unitContentSha256', unit_version.content_sha256,
        'documentVersionId', document_version.id,
        'documentContentSha256', document_version.content_sha256,
        'officialUrl', document_version.official_url,
        'jurisdictionCode', jurisdiction.code,
        'sourceCode', source_record.source_code,
        'sourceSnapshotId', source_snapshot.id,
        'rawSourceSha256', source_snapshot.raw_sha256,
        'retrievedAt', source_snapshot.retrieved_at,
        'upToDateAsOf', source_snapshot.up_to_date_as_of
      )
      order by citation.is_primary desc, unit_version.canonical_citation, citation.id
    ),
    '[]'::jsonb
  )
  into citation_manifest
  from public.requirement_citations citation
  join public.regulatory_unit_versions unit_version
    on unit_version.id = citation.unit_version_id
  join public.regulatory_document_versions document_version
    on document_version.id = unit_version.document_version_id
  join public.regulatory_documents document_record
    on document_record.id = document_version.document_id
  join public.regulatory_sources source_record
    on source_record.id = document_record.source_id
  join public.regulatory_jurisdictions jurisdiction
    on jurisdiction.id = source_record.jurisdiction_id
  join regulatory_private.source_snapshots source_snapshot
    on source_snapshot.id = unit_version.source_snapshot_id
  where citation.requirement_version_id = new.requirement_version_id;

  new.evidence_locator := jsonb_build_object(
    'schema', 'safetyops.inspection-evidence/v1',
    'templateVersionId', inspection_record.template_version_id,
    'templateSchemaSha256', template_schema_sha256,
    'controlLocator', mapping_record.control_locator,
    'mappingSha256', mapping_record.mapping_sha256,
    'requirementContentSha256', requirement_content_sha256,
    'regulatoryProfileId', profile_record.id,
    'regulatoryProfileSha256', profile_sha256,
    'applicabilityAssessmentSha256', assessment_record.assessment_sha256,
    'applicabilityStatus', assessment_record.applicability_status,
    'regulatoryReleaseManifestSha256', release_record.manifest_sha256,
    'inspectionResponsesSha256', responses_sha256,
    'citations', citation_manifest
  );

  new.trace_sha256 := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'companyId', new.company_id,
          'locationId', new.location_id,
          'inspectionId', new.inspection_id,
          'requirementVersionId', new.requirement_version_id,
          'controlMappingId', new.control_mapping_id,
          'regulatoryProfileId', new.regulatory_profile_id,
          'applicabilityAssessmentId', new.applicability_assessment_id,
          'regulatoryReleaseId', new.regulatory_release_id,
          'evidenceLocator', new.evidence_locator,
          'observedAt', new.observed_at,
          'linkedBy', new.linked_by
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

create trigger compliance_evidence_links_inspection_trace_validate
before insert on public.compliance_evidence_links
for each row execute function regulatory_private.validate_inspection_evidence_trace();

create or replace function regulatory_private.require_submitted_inspection_context()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
begin
  if new.status in ('submitted', 'under_review', 'complete', 'closed')
     and not exists (
       select 1
       from public.inspection_regulatory_contexts context_record
       where context_record.company_id = new.company_id
         and context_record.inspection_id = new.id
     ) then
    raise exception 'submitted inspection requires a transactional regulatory context'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create constraint trigger inspections_require_regulatory_context
after insert or update on public.inspections
deferrable initially deferred
for each row execute function regulatory_private.require_submitted_inspection_context();

create trigger inspection_regulatory_contexts_immutable
before update or delete on public.inspection_regulatory_contexts
for each row execute function regulatory_private.reject_immutable_mutation();

create trigger inspection_regulatory_contexts_regulatory_audit
after insert on public.inspection_regulatory_contexts
for each row execute function regulatory_private.write_regulatory_audit_event();

-- Acknowledgements are insert-only evidence. The baseline schema did not attach
-- its generic tenant audit trigger, so add the missing LFES audit edge here.
create trigger document_acknowledgements_audit
after insert on public.document_acknowledgements
for each row execute function private.write_audit_event();

-- ---------------------------------------------------------------------------
-- Atomic submission RPC
-- ---------------------------------------------------------------------------

create or replace function public.submit_inspection_with_regulatory_evidence(
  target_company_id uuid,
  target_location_id uuid,
  target_template_version_id uuid,
  target_area_or_asset text,
  target_answers jsonb,
  target_client_submission_key text,
  target_notes text default null
)
returns table (
  inspection_id uuid,
  evidence_count integer
)
language plpgsql
security definer
set search_path = public, private, regulatory_private, pg_temp
as $$
declare
  actor_user_id uuid := auth.uid();
  submitted_time timestamptz := clock_timestamp();
  submitted_date date;
  location_timezone text;
  template_record record;
  profile_record public.location_regulatory_profiles%rowtype;
  mapping_record record;
  assessment_record public.requirement_applicability_assessments%rowtype;
  release_record public.regulatory_releases%rowtype;
  existing_record record;
  inserted_inspection_id uuid;
  inserted_evidence_id uuid;
  inserted_trace_sha256 text;
  actor_full_name text;
  expected_question_keys text[] := array[]::text[];
  answer_keys text[] := array[]::text[];
  locator_keys text[] := array[]::text[];
  question_count integer := 0;
  distinct_question_count integer := 0;
  passing_count integer := 0;
  failing_count integer := 0;
  computed_score numeric(5,2);
  template_schema_sha256 text;
  submission_payload_sha256 text;
  profile_sha256 text;
  jurisdiction_context jsonb := '[]'::jsonb;
  jurisdiction_count integer := 0;
  jurisdiction_unresolved_count integer := 0;
  jurisdiction_applicable_count integer := 0;
  profile_present boolean := false;
  profile_review_ready boolean := false;
  jurisdiction_review_ready boolean := false;
  total_mapping_count integer := 0;
  linked_evidence_count integer := 0;
  excluded_mapping_count integer := 0;
  unresolved_mapping_count integer := 0;
  resolved_details jsonb := '[]'::jsonb;
  excluded_details jsonb := '[]'::jsonb;
  unresolved_details jsonb := '[]'::jsonb;
  context_status text;
  context_manifest jsonb;
  context_sha256 text;
  requirement_status text;
  requirement_content_sha256 text;
  requirement_code text;
  requirement_title text;
begin
  if actor_user_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;
  if target_company_id is null
     or target_location_id is null
     or target_template_version_id is null then
    raise exception 'company, location, and exact template version are required'
      using errcode = '22004';
  end if;
  if not private.can_access_location(target_company_id, target_location_id) then
    raise exception 'location access denied'
      using errcode = '42501';
  end if;
  if char_length(trim(coalesce(target_area_or_asset, ''))) not between 1 and 240 then
    raise exception 'area or asset must contain 1 to 240 characters'
      using errcode = '22023';
  end if;
  if char_length(coalesce(target_notes, '')) > 20000 then
    raise exception 'inspection notes exceed 20000 characters'
      using errcode = '22023';
  end if;
  if char_length(trim(coalesce(target_client_submission_key, ''))) not between 8 and 200 then
    raise exception 'client submission key must contain 8 to 200 characters'
      using errcode = '22023';
  end if;
  if jsonb_typeof(target_answers) <> 'object' then
    raise exception 'inspection answers must be a JSON object'
      using errcode = '22023';
  end if;

  select location_record.timezone
  into location_timezone
    from public.locations location_record
    where location_record.company_id = target_company_id
      and location_record.id = target_location_id
      and location_record.active;

  if location_timezone is null then
    raise exception 'active company location not found'
      using errcode = '23503';
  end if;
  submitted_date := timezone(location_timezone, submitted_time)::date;

  select
    version_record.id,
    version_record.template_id,
    version_record.version,
    version_record.schema_json,
    version_record.published,
    version_record.published_at,
    template_identity.name,
    template_identity.active
  into template_record
  from public.form_template_versions version_record
  join public.form_templates template_identity
    on template_identity.company_id = version_record.company_id
   and template_identity.id = version_record.template_id
  where version_record.company_id = target_company_id
    and version_record.id = target_template_version_id;

  if not found
     or not template_record.published
     or not template_record.active then
    raise exception 'exact published active template version not found'
      using errcode = '23503';
  end if;

  select
    coalesce(array_agg(question_key order by question_key), array[]::text[]),
    count(*)::integer,
    count(distinct question_key)::integer
  into expected_question_keys, question_count, distinct_question_count
  from (
    select coalesce(
      nullif(question.value ->> 'key', ''),
      nullif(question.value ->> 'id', ''),
      nullif(question.value ->> 'name', ''),
      'q' || (question.ordinality - 1)::text
    ) as question_key
    from jsonb_array_elements(
      case
        when jsonb_typeof(template_record.schema_json -> 'questions') = 'array'
          then template_record.schema_json -> 'questions'
        when jsonb_typeof(template_record.schema_json -> 'fields') = 'array'
          then template_record.schema_json -> 'fields'
        else '[]'::jsonb
      end
    ) with ordinality as question(value, ordinality)
  ) schema_questions;

  if question_count = 0 then
    raise exception 'published inspection template contains no versioned questions'
      using errcode = '23514';
  end if;
  if distinct_question_count <> question_count then
    raise exception 'published inspection template contains duplicate question keys'
      using errcode = '23514';
  end if;

  select coalesce(array_agg(answer_key order by answer_key), array[]::text[])
  into answer_keys
  from jsonb_object_keys(target_answers) as submitted_answers(answer_key);

  if answer_keys is distinct from expected_question_keys then
    raise exception 'answers do not exactly match the published template question keys'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_each(target_answers) answer
    where lower(coalesce(answer.value ->> 'value', answer.value #>> '{}', ''))
      not in ('pass', 'fail', 'na')
  ) then
    raise exception 'inspection answers must be pass, fail, or na'
      using errcode = '23514';
  end if;

  select
    count(*) filter (where answer_value = 'pass')::integer,
    count(*) filter (where answer_value = 'fail')::integer
  into passing_count, failing_count
  from (
    select lower(
      coalesce(answer.value ->> 'value', answer.value #>> '{}', '')
    ) as answer_value
    from jsonb_each(target_answers) answer
  ) normalized_answers;

  computed_score := case
    when passing_count + failing_count = 0 then null
    else round(
      (passing_count::numeric / (passing_count + failing_count)::numeric) * 100,
      2
    )
  end;

  template_schema_sha256 := encode(
    extensions.digest(convert_to(template_record.schema_json::text, 'UTF8'), 'sha256'),
    'hex'
  );
  submission_payload_sha256 := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'companyId', target_company_id,
          'locationId', target_location_id,
          'templateVersionId', target_template_version_id,
          'areaOrAsset', trim(target_area_or_asset),
          'answers', target_answers,
          'notes', coalesce(target_notes, '')
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- Serialize retries for the same user/company/idempotency key.
  perform pg_advisory_xact_lock(
    hashtextextended(
      target_company_id::text
      || ':' || actor_user_id::text
      || ':' || trim(target_client_submission_key),
      0
    )
  );

  select
    inspection_record.id,
    context_record.submission_payload_sha256,
    context_record.evidence_count
  into existing_record
  from public.inspections inspection_record
  left join public.inspection_regulatory_contexts context_record
    on context_record.company_id = inspection_record.company_id
   and context_record.inspection_id = inspection_record.id
  where inspection_record.company_id = target_company_id
    and inspection_record.created_by = actor_user_id
    and inspection_record.client_submission_key = trim(target_client_submission_key);

  if found then
    if existing_record.submission_payload_sha256 is null then
      raise exception 'existing submission is missing its regulatory context'
        using errcode = '23514';
    end if;
    if existing_record.submission_payload_sha256 <> submission_payload_sha256 then
      raise exception 'client submission key was already used for different content'
        using errcode = '23505';
    end if;

    return query
    select existing_record.id, existing_record.evidence_count::integer;
    return;
  end if;

  select coalesce(nullif(trim(profile.full_name), ''), 'SafetyOps user')
  into actor_full_name
  from public.profiles profile
  where profile.id = actor_user_id;

  if actor_full_name is null then
    raise exception 'current user profile not found'
      using errcode = '23503';
  end if;

  select profile_value.*
  into profile_record
  from public.location_regulatory_profiles profile_value
  where profile_value.company_id = target_company_id
    and profile_value.location_id = target_location_id
  order by
    case
      when (
        profile_value.effective_from is null
        or profile_value.effective_from <= submitted_date
      )
      and (
        profile_value.effective_to is null
        or profile_value.effective_to >= submitted_date
      )
        then 0
      else 1
    end,
    profile_value.version desc
  limit 1;

  profile_present := found;
  if profile_present then
    profile_review_ready :=
      profile_record.status = 'approved'
      and profile_record.reviewed_by is not null
      and profile_record.reviewed_at is not null
      and (
        profile_record.effective_from is null
        or profile_record.effective_from <= submitted_date
      )
      and (
        profile_record.effective_to is null
        or profile_record.effective_to >= submitted_date
      );

    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'assignmentId', assignment.id,
            'jurisdictionId', assignment.jurisdiction_id,
            'jurisdictionCode', jurisdiction.code,
            'jurisdictionName', jurisdiction.name,
            'coverageStatus', assignment.coverage_status,
            'coverageRationale', assignment.coverage_rationale,
            'carveOuts', assignment.carve_outs,
            'validFrom', assignment.valid_from,
            'validTo', assignment.valid_to,
            'reviewedBy', assignment.reviewed_by,
            'reviewedAt', assignment.reviewed_at
          )
          order by jurisdiction.code
        ),
        '[]'::jsonb
      ),
      count(*)::integer,
      count(*) filter (
        where assignment.reviewed_by is null
           or assignment.reviewed_at is null
           or assignment.coverage_status = 'requires_review'
           or (
             assignment.valid_from is not null
             and assignment.valid_from > submitted_date
           )
           or (
             assignment.valid_to is not null
             and assignment.valid_to < submitted_date
           )
      )::integer,
      count(*) filter (
        where assignment.coverage_status in ('applies', 'partial')
          and assignment.reviewed_by is not null
          and assignment.reviewed_at is not null
          and (
            assignment.valid_from is null
            or assignment.valid_from <= submitted_date
          )
          and (
            assignment.valid_to is null
            or assignment.valid_to >= submitted_date
          )
      )::integer
    into
      jurisdiction_context,
      jurisdiction_count,
      jurisdiction_unresolved_count,
      jurisdiction_applicable_count
    from public.location_jurisdiction_assignments assignment
    join public.regulatory_jurisdictions jurisdiction
      on jurisdiction.id = assignment.jurisdiction_id
    where assignment.company_id = target_company_id
      and assignment.location_id = target_location_id
      and assignment.profile_id = profile_record.id;

    profile_sha256 := encode(
      extensions.digest(convert_to(to_jsonb(profile_record)::text, 'UTF8'), 'sha256'),
      'hex'
    );
  end if;

  jurisdiction_review_ready :=
    profile_present
    and jurisdiction_count > 0
    and jurisdiction_unresolved_count = 0
    and jurisdiction_applicable_count > 0;

  insert into public.inspections (
    company_id,
    location_id,
    template_id,
    template_version_id,
    title,
    area_or_asset,
    status,
    started_at,
    submitted_at,
    score,
    responses,
    signed_by,
    signature_record,
    created_by,
    client_submission_key
  )
  values (
    target_company_id,
    target_location_id,
    template_record.template_id,
    target_template_version_id,
    template_record.name,
    trim(target_area_or_asset),
    'submitted',
    submitted_time,
    submitted_time,
    computed_score,
    jsonb_build_object(
      'answers', target_answers,
      'notes', coalesce(target_notes, '')
    ),
    actor_user_id,
    jsonb_build_object(
      'schema', 'safetyops.inspection-signature/v1',
      'signerUserId', actor_user_id,
      'signerName', actor_full_name,
      'signedAt', submitted_time,
      'attestation', 'I certify that these responses are complete and accurate to the best of my knowledge.',
      'submissionPayloadSha256', submission_payload_sha256
    ),
    actor_user_id,
    trim(target_client_submission_key)
  )
  returning id into inserted_inspection_id;

  for mapping_record in
    select mapping_value.*
    from public.control_requirement_mappings mapping_value
    where mapping_value.company_id = target_company_id
      and mapping_value.form_template_version_id = target_template_version_id
      and mapping_value.status = 'approved'
      and (
        mapping_value.location_id is null
        or mapping_value.location_id = target_location_id
      )
      and (
        mapping_value.effective_from is null
        or mapping_value.effective_from <= submitted_time
      )
      and (
        mapping_value.effective_to is null
        or mapping_value.effective_to >= submitted_time
      )
    order by mapping_value.id
  loop
    total_mapping_count := total_mapping_count + 1;

    if not profile_review_ready or not jurisdiction_review_ready then
      unresolved_mapping_count := unresolved_mapping_count + 1;
      unresolved_details := unresolved_details || jsonb_build_array(
        jsonb_build_object(
          'controlMappingId', mapping_record.id,
          'requirementVersionId', mapping_record.requirement_version_id,
          'reason',
            case
              when not profile_present
                then 'regulatory_profile_missing'
              when not profile_review_ready
                then 'regulatory_profile_review_required'
              else 'jurisdiction_assignment_review_required'
            end
        )
      );
      continue;
    end if;

    locator_keys := regulatory_private.control_locator_keys(
      mapping_record.control_locator
    );

    if cardinality(locator_keys) > 0
       and not (locator_keys <@ expected_question_keys) then
      unresolved_mapping_count := unresolved_mapping_count + 1;
      unresolved_details := unresolved_details || jsonb_build_array(
        jsonb_build_object(
          'controlMappingId', mapping_record.id,
          'requirementVersionId', mapping_record.requirement_version_id,
          'reason', 'control_locator_not_in_template',
          'locatorKeys', to_jsonb(locator_keys)
        )
      );
      continue;
    end if;

    select
      requirement_version.status,
      requirement_version.content_sha256,
      requirement_identity.requirement_code,
      requirement_identity.title
    into
      requirement_status,
      requirement_content_sha256,
      requirement_code,
      requirement_title
    from public.compliance_requirement_versions requirement_version
    join public.compliance_requirements requirement_identity
      on requirement_identity.id = requirement_version.requirement_id
    where requirement_version.id = mapping_record.requirement_version_id;

    if requirement_status <> 'approved'
       or requirement_content_sha256 is null
       or not private.is_regulatory_item_published(
         'requirement_version',
         mapping_record.requirement_version_id
       ) then
      unresolved_mapping_count := unresolved_mapping_count + 1;
      unresolved_details := unresolved_details || jsonb_build_array(
        jsonb_build_object(
          'controlMappingId', mapping_record.id,
          'requirementVersionId', mapping_record.requirement_version_id,
          'reason', 'requirement_not_approved_and_published'
        )
      );
      continue;
    end if;

    select assessment_value.*
    into assessment_record
    from public.requirement_applicability_assessments assessment_value
    where assessment_value.company_id = target_company_id
      and assessment_value.location_id = target_location_id
      and assessment_value.profile_id = profile_record.id
      and assessment_value.requirement_version_id =
        mapping_record.requirement_version_id
      and assessment_value.status = 'approved'
      and assessment_value.reviewed_by is not null
      and assessment_value.reviewed_at is not null
      and (
        assessment_value.valid_from is null
        or assessment_value.valid_from <= submitted_date
      )
      and (
        assessment_value.valid_to is null
        or assessment_value.valid_to >= submitted_date
      )
    order by assessment_value.assessed_at desc, assessment_value.created_at desc
    limit 1;

    if not found then
      unresolved_mapping_count := unresolved_mapping_count + 1;
      unresolved_details := unresolved_details || jsonb_build_array(
        jsonb_build_object(
          'controlMappingId', mapping_record.id,
          'requirementVersionId', mapping_record.requirement_version_id,
          'requirementCode', requirement_code,
          'reason', 'approved_applicability_assessment_missing'
        )
      );
      continue;
    end if;

    if assessment_record.applicability_status = 'does_not_apply' then
      excluded_mapping_count := excluded_mapping_count + 1;
      excluded_details := excluded_details || jsonb_build_array(
        jsonb_build_object(
          'controlMappingId', mapping_record.id,
          'requirementVersionId', mapping_record.requirement_version_id,
          'requirementCode', requirement_code,
          'applicabilityAssessmentId', assessment_record.id,
          'assessmentSha256', assessment_record.assessment_sha256,
          'reason', 'reviewed_does_not_apply'
        )
      );
      continue;
    end if;

    if assessment_record.applicability_status not in ('applies', 'conditional')
       or assessment_record.assessment_sha256 is null then
      unresolved_mapping_count := unresolved_mapping_count + 1;
      unresolved_details := unresolved_details || jsonb_build_array(
        jsonb_build_object(
          'controlMappingId', mapping_record.id,
          'requirementVersionId', mapping_record.requirement_version_id,
          'requirementCode', requirement_code,
          'applicabilityAssessmentId', assessment_record.id,
          'reason', 'applicability_not_resolved'
        )
      );
      continue;
    end if;

    select release_value.*
    into release_record
    from public.regulatory_releases release_value
    join public.regulatory_release_items release_item
      on release_item.release_id = release_value.id
     and release_item.requirement_version_id =
       mapping_record.requirement_version_id
     and release_item.item_sha256 = requirement_content_sha256
    where release_value.status = 'published'
      and release_value.published_at is not null
      and release_value.published_at <= submitted_time
      and release_value.manifest_sha256 is not null
    order by release_value.published_at desc, release_value.id
    limit 1;

    if not found then
      unresolved_mapping_count := unresolved_mapping_count + 1;
      unresolved_details := unresolved_details || jsonb_build_array(
        jsonb_build_object(
          'controlMappingId', mapping_record.id,
          'requirementVersionId', mapping_record.requirement_version_id,
          'requirementCode', requirement_code,
          'reason', 'published_regulatory_release_missing'
        )
      );
      continue;
    end if;

    insert into public.compliance_evidence_links (
      company_id,
      location_id,
      requirement_version_id,
      control_mapping_id,
      inspection_id,
      regulatory_profile_id,
      applicability_assessment_id,
      regulatory_release_id,
      evidence_locator,
      observed_at,
      linked_by
    )
    values (
      target_company_id,
      target_location_id,
      mapping_record.requirement_version_id,
      mapping_record.id,
      inserted_inspection_id,
      profile_record.id,
      assessment_record.id,
      release_record.id,
      '{}'::jsonb,
      submitted_time,
      actor_user_id
    )
    returning id, trace_sha256
    into inserted_evidence_id, inserted_trace_sha256;

    linked_evidence_count := linked_evidence_count + 1;
    resolved_details := resolved_details || jsonb_build_array(
      jsonb_build_object(
        'evidenceLinkId', inserted_evidence_id,
        'evidenceTraceSha256', inserted_trace_sha256,
        'controlMappingId', mapping_record.id,
        'mappingSha256', mapping_record.mapping_sha256,
        'requirementVersionId', mapping_record.requirement_version_id,
        'requirementCode', requirement_code,
        'requirementTitle', requirement_title,
        'requirementContentSha256', requirement_content_sha256,
        'applicabilityAssessmentId', assessment_record.id,
        'assessmentSha256', assessment_record.assessment_sha256,
        'applicabilityStatus', assessment_record.applicability_status,
        'regulatoryReleaseId', release_record.id,
        'regulatoryReleaseManifestSha256', release_record.manifest_sha256
      )
    );
  end loop;

  context_status := case
    when not profile_review_ready or not jurisdiction_review_ready
      then 'review_required'
    when total_mapping_count = 0 then 'unmapped'
    when unresolved_mapping_count = 0 then 'verified'
    when linked_evidence_count > 0 then 'partial'
    else 'unresolved'
  end;

  context_manifest := jsonb_build_object(
    'schema', 'safetyops.inspection-regulatory-context/v1',
    'capturedAt', submitted_time,
    'companyId', target_company_id,
    'locationId', target_location_id,
    'inspectionId', inserted_inspection_id,
    'template', jsonb_build_object(
      'templateId', template_record.template_id,
      'templateVersionId', target_template_version_id,
      'version', template_record.version,
      'schemaSha256', template_schema_sha256
    ),
    'submissionPayloadSha256', submission_payload_sha256,
    'regulatoryProfile',
      case
        when profile_present then jsonb_build_object(
          'profileId', profile_record.id,
          'version', profile_record.version,
          'stateCode', profile_record.state_code,
          'employerType', profile_record.employer_type,
          'status', profile_record.status,
          'effectiveFrom', profile_record.effective_from,
          'effectiveTo', profile_record.effective_to,
          'reviewedBy', profile_record.reviewed_by,
          'reviewedAt', profile_record.reviewed_at,
          'profileSha256', profile_sha256
        )
        else 'null'::jsonb
      end,
    'jurisdictionAssignments', jurisdiction_context,
    'reviewReadiness', jsonb_build_object(
      'profilePresent', profile_present,
      'profileApprovedAndEffective', profile_review_ready,
      'jurisdictionsReviewedAndEffective', jurisdiction_review_ready,
      'evidenceEmissionAllowed',
        profile_review_ready and jurisdiction_review_ready
    ),
    'traceStatus', context_status,
    'counts', jsonb_build_object(
      'mappings', total_mapping_count,
      'evidence', linked_evidence_count,
      'excluded', excluded_mapping_count,
      'unresolved', unresolved_mapping_count
    ),
    'resolvedMappings', resolved_details,
    'excludedMappings', excluded_details,
    'unresolvedMappings', unresolved_details
  );
  context_sha256 := encode(
    extensions.digest(convert_to(context_manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into public.inspection_regulatory_contexts (
    company_id,
    inspection_id,
    location_id,
    template_version_id,
    regulatory_profile_id,
    trace_status,
    template_schema_sha256,
    submission_payload_sha256,
    profile_sha256,
    mapping_count,
    evidence_count,
    excluded_count,
    unresolved_count,
    context_manifest,
    context_sha256,
    captured_by,
    captured_at
  )
  values (
    target_company_id,
    inserted_inspection_id,
    target_location_id,
    target_template_version_id,
    profile_record.id,
    context_status,
    template_schema_sha256,
    submission_payload_sha256,
    profile_sha256,
    total_mapping_count,
    linked_evidence_count,
    excluded_mapping_count,
    unresolved_mapping_count,
    context_manifest,
    context_sha256,
    actor_user_id,
    submitted_time
  );

  return query
  select inserted_inspection_id, linked_evidence_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS, privileges, and comments
-- ---------------------------------------------------------------------------

alter table public.inspection_regulatory_contexts enable row level security;

create policy inspection_regulatory_contexts_select
on public.inspection_regulatory_contexts
for select to authenticated
using (private.can_access_location(company_id, location_id));

revoke all on table public.inspection_regulatory_contexts from public, anon;
grant select on table public.inspection_regulatory_contexts to authenticated;
grant all on table public.inspection_regulatory_contexts to service_role;

revoke all on function regulatory_private.control_locator_keys(jsonb)
from public, anon, authenticated;
revoke all on function regulatory_private.validate_inspection_evidence_trace()
from public, anon, authenticated;
revoke all on function regulatory_private.require_submitted_inspection_context()
from public, anon, authenticated;

grant execute on function regulatory_private.control_locator_keys(jsonb)
to service_role;
grant execute on function regulatory_private.validate_inspection_evidence_trace()
to service_role;
grant execute on function regulatory_private.require_submitted_inspection_context()
to service_role;

revoke all on function public.submit_inspection_with_regulatory_evidence(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text,
  text
) from public, anon;

grant execute on function public.submit_inspection_with_regulatory_evidence(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text,
  text
) to authenticated, service_role;

comment on table public.inspection_regulatory_contexts is
  'Append-only server-derived profile, jurisdiction, mapping, and evidence manifest captured atomically with a submitted inspection.';

comment on function public.submit_inspection_with_regulatory_evidence(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text,
  text
) is
  'Submits an exact published inspection version and creates only database-resolved regulatory evidence. Returns inspection_id and evidence_count.';
