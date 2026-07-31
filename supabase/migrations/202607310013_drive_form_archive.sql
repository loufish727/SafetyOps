-- SafetyOps Drive ZIP form/archive ingestion.
--
-- The source export available for this import is a pair of Google Drive folder
-- ZIP snapshots, not a per-file Drive API listing. This migration therefore
-- records the honest identity boundary: folder/snapshot identifiers and raw ZIP
-- paths remain service-only (or in the already manager-only source metadata),
-- while the manager archive exposes only a path fingerprint and safe display
-- metadata. Source bytes stay in the private safety-program bucket.
--
-- The prepare/commit protocol is deliberately two-phase:
--   1. prepare validates and freezes the complete clean-scan manifest and
--      creates one quarantine locator per item;
--   2. a narrow service verifies each uploaded object, moves/copies it to the
--      content-addressed final path, and commits exact immutable provenance.
-- Both calls are idempotent. Service events are append-only, manager candidate
-- changes enter the existing tenant hash-chain audit, and file access decisions
-- have their own append-only ledger.

create extension if not exists pgcrypto with schema extensions;

-- Preserve the existing private-bucket controls while admitting every format
-- in the verified archive. ZIP containers themselves are not stored; OOXML
-- files use their exact document MIME rather than application/zip. A legacy
-- group retains its original .dng filenames even though independent signature
-- verification identifies JPEG payloads; those rows must declare image/jpeg.
-- True TIFF/DNG bytes remain supported as image/x-adobe-dng.
update storage.buckets
set public = false,
    file_size_limit = 104857600,
    allowed_mime_types = array[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/json',
      'text/plain',
      'image/jpeg',
      'image/png',
      'image/x-adobe-dng',
      'image/tiff',
      'image/webp',
      'image/bmp'
    ]::text[]
where id = 'safety-program-private';

-- System commits intentionally have no Auth user. Human-created source rows
-- continue to be protected by the existing authenticated insert policy, which
-- requires created_by = auth.uid().
alter table public.safety_program_source_documents
  alter column created_by drop not null;

alter table public.safety_program_source_documents
  add constraint safety_program_source_documents_system_creator_check
  check (
    created_by is not null
    or provider = 'google_drive_zip_snapshot'
  );

alter table public.safety_program_source_documents
  drop constraint if exists safety_program_source_documents_provider_check;

alter table public.safety_program_source_documents
  add constraint safety_program_source_documents_provider_check
  check (provider in (
    'google_drive',
    'google_drive_zip_snapshot',
    'microsoft_drive',
    'box',
    'manual_upload'
  ));

alter table public.safety_program_storage_objects
  drop constraint if exists safety_program_storage_objects_source_system_check;

alter table public.safety_program_storage_objects
  add constraint safety_program_storage_objects_source_system_check
  check (source_system in (
    'application',
    'google_drive',
    'google_drive_zip_snapshot',
    'microsoft_drive',
    'box',
    'manual_import'
  ));

-- Dropping NOT NULL for service-authored ZIP snapshots must not let a human
-- editor erase or replace the creator on an existing source identity.
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
     or new.external_file_id <> old.external_file_id
     or new.created_by is distinct from old.created_by then
    raise exception 'source provider identity and creator provenance are immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-only manifest/run ledger
-- ---------------------------------------------------------------------------

create table program_private.safety_program_drive_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  manifest_id uuid not null,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  scan_attestation jsonb not null
    check (jsonb_typeof(scan_attestation) = 'object'),
  item_count integer not null check (item_count between 1 and 5000),
  total_size_bytes bigint not null
    check (total_size_bytes between 1 and 2147483648),
  status text not null default 'prepared'
    check (status in ('prepared', 'committed')),
  created_at timestamptz not null default clock_timestamp(),
  committed_at timestamptz,
  unique (company_id, id),
  unique (company_id, manifest_id),
  unique (company_id, manifest_sha256),
  check (
    (status = 'prepared' and committed_at is null)
    or (status = 'committed' and committed_at is not null)
  )
);

-- This is the only archive projection used by the web UI. It deliberately has
-- no provider ID, raw source path, bucket name, object path, or storage-object
-- ID. folder_hint is a manager-only classification hint, not an access locator.
create table public.safety_program_import_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  display_name text not null check (char_length(display_name) between 1 and 255),
  folder_hint text not null check (char_length(folder_hint) between 1 and 512),
  candidate_kind text not null check (candidate_kind in (
    'form_template',
    'completed_record',
    'program_document',
    'training_material',
    'reference',
    'evidence',
    'unknown'
  )),
  review_status text not null default 'pending_review' check (review_status in (
    'pending_review',
    'needs_information',
    'approved',
    'rejected',
    'duplicate',
    'imported',
    'superseded'
  )),
  classification text not null default 'internal'
    check (classification in ('internal', 'confidential', 'restricted')),
  language text not null default 'en'
    check (language ~ '^[a-z]{2,3}(?:-[A-Z]{2})?$'),
  proposed_location_codes text[] not null default '{}'::text[]
    check (coalesce(array_ndims(proposed_location_codes), 1) = 1)
    check (cardinality(proposed_location_codes) <= 100)
    check (array_position(proposed_location_codes, null) is null)
    check (
      cardinality(proposed_location_codes) = 0
      or array_to_string(proposed_location_codes, ',')
        ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*(?:,[A-Z0-9]+(?:-[A-Z0-9]+)*)*$'
    ),
  page_count integer check (page_count is null or page_count > 0),
  render_verified boolean not null default false,
  mime_type text not null check (mime_type in (
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg',
    'image/png',
    'image/x-adobe-dng',
    'image/tiff'
  )),
  size_bytes bigint not null check (size_bytes between 1 and 104857600),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_path_sha256 text not null
    check (source_path_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  unique (company_id, content_sha256, source_path_sha256),
  check (
    (mime_type = 'application/pdf' and page_count is not null and render_verified)
    or (mime_type <> 'application/pdf' and page_count is null and not render_verified)
  )
);

create table program_private.safety_program_drive_ingest_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  company_id uuid not null,
  item_key text not null check (item_key ~ '^[0-9a-f]{64}$'),
  snapshot_key text not null check (char_length(snapshot_key) between 1 and 160),
  source_path text not null check (char_length(source_path) between 1 and 4096),
  source_path_sha256 text not null
    check (source_path_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_relative_path text not null
    check (char_length(artifact_relative_path) between 1 and 4096),
  filename text not null check (char_length(filename) between 1 and 255),
  folder_hint text not null check (char_length(folder_hint) between 1 and 512),
  extension text not null check (extension in (
    '.pdf', '.doc', '.docx', '.xlsx', '.pptx',
    '.jpg', '.jpeg', '.png', '.dng', '.tif', '.tiff'
  )),
  expected_mime_type text not null,
  expected_size_bytes bigint not null
    check (expected_size_bytes between 1 and 104857600),
  expected_sha256 text not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_kind text not null check (candidate_kind in (
    'form_template',
    'completed_record',
    'program_document',
    'training_material',
    'reference',
    'evidence',
    'unknown'
  )),
  classification text not null
    check (classification in ('internal', 'confidential', 'restricted')),
  language text not null check (language ~ '^[a-z]{2,3}(?:-[A-Z]{2})?$'),
  proposed_location_codes text[] not null default '{}'::text[],
  page_count integer check (page_count is null or page_count > 0),
  render_verified boolean not null default false,
  quarantine_object_path text not null unique,
  final_object_path text not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'committed')),
  committed_storage_object_id uuid,
  committed_source_document_id uuid,
  committed_source_version_id uuid,
  committed_candidate_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  committed_at timestamptz,
  unique (company_id, id),
  unique (run_id, item_key),
  foreign key (company_id, run_id)
    references program_private.safety_program_drive_ingest_runs(company_id, id)
    on delete restrict,
  foreign key (company_id, committed_storage_object_id)
    references public.safety_program_storage_objects(company_id, id)
    on delete restrict,
  foreign key (company_id, committed_source_document_id)
    references public.safety_program_source_documents(company_id, id)
    on delete restrict,
  foreign key (company_id, committed_source_version_id)
    references public.safety_program_source_versions(company_id, id)
    on delete restrict,
  foreign key (company_id, committed_candidate_id)
    references public.safety_program_import_candidates(company_id, id)
    on delete restrict,
  check (
    source_path !~ '(^/|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|//|[[:cntrl:]])'
  ),
  check (
    artifact_relative_path
      !~ '(^/|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|//|[[:cntrl:]])'
  ),
  check (filename !~ '[/\\[:cntrl:]]'),
  check (
    (extension = '.pdf' and expected_mime_type = 'application/pdf')
    or (extension = '.doc' and expected_mime_type = 'application/msword')
    or (
      extension = '.docx'
      and expected_mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    or (
      extension = '.xlsx'
      and expected_mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    or (
      extension = '.pptx'
      and expected_mime_type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    or (extension in ('.jpg', '.jpeg') and expected_mime_type = 'image/jpeg')
    or (extension = '.png' and expected_mime_type = 'image/png')
    or (
      extension = '.dng'
      and expected_mime_type in ('image/x-adobe-dng', 'image/jpeg')
    )
    or (extension in ('.tif', '.tiff') and expected_mime_type = 'image/tiff')
  ),
  check (
    coalesce(array_ndims(proposed_location_codes), 1) = 1
    and cardinality(proposed_location_codes) <= 100
    and array_position(proposed_location_codes, null) is null
  ),
  check (
    cardinality(proposed_location_codes) = 0
    or array_to_string(proposed_location_codes, ',')
      ~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*(?:,[A-Z0-9]+(?:-[A-Z0-9]+)*)*$'
  ),
  check (
    (expected_mime_type = 'application/pdf' and page_count is not null and render_verified)
    or (
      expected_mime_type <> 'application/pdf'
      and page_count is null
      and not render_verified
    )
  ),
  check (
    quarantine_object_path = company_id::text
      || '/quarantine/drive/' || run_id::text || '/' || id::text
  ),
  check (
    final_object_path = company_id::text
      || '/source-archive/sha256/' || substr(expected_sha256, 1, 2)
      || '/' || expected_sha256
  ),
  check (
    (
      status = 'prepared'
      and committed_storage_object_id is null
      and committed_source_document_id is null
      and committed_source_version_id is null
      and committed_candidate_id is null
      and committed_at is null
    )
    or (
      status = 'committed'
      and committed_storage_object_id is not null
      and committed_source_document_id is not null
      and committed_source_version_id is not null
      and committed_candidate_id is not null
      and committed_at is not null
    )
  )
);

-- Append-only service events are separate from manager-facing audit data so
-- raw provider/path material can never leak through a public RLS projection.
create table program_private.safety_program_drive_ingest_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  run_id uuid not null,
  item_id uuid,
  event_key text not null check (char_length(event_key) between 1 and 200),
  event_type text not null check (event_type in (
    'ingest_prepared',
    'item_committed',
    'ingest_committed'
  )),
  event_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(event_payload) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  unique (run_id, event_key),
  foreign key (company_id, run_id)
    references program_private.safety_program_drive_ingest_runs(company_id, id)
    on delete restrict,
  foreign key (company_id, item_id)
    references program_private.safety_program_drive_ingest_items(company_id, id)
    on delete restrict
);

-- Managers can review this access ledger; only the signing service can append.
-- It contains no object locator, signed URL, bearer value, or provider ID.
create table public.safety_program_candidate_file_access_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  candidate_id uuid not null,
  storage_object_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('allowed', 'denied')),
  reason_code text not null
    check (reason_code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  request_id uuid not null unique,
  signed_url_expires_at timestamptz,
  request_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(request_context) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, candidate_id)
    references public.safety_program_import_candidates(company_id, id)
    on delete restrict,
  foreign key (company_id, storage_object_id)
    references public.safety_program_storage_objects(company_id, id)
    on delete restrict,
  check (
    (
      decision = 'allowed'
      and signed_url_expires_at is not null
      and signed_url_expires_at > occurred_at
      and signed_url_expires_at <= occurred_at + interval '10 minutes'
    )
    or (decision = 'denied' and signed_url_expires_at is null)
  )
);

create index safety_program_drive_ingest_runs_status_idx
  on program_private.safety_program_drive_ingest_runs(company_id, status, created_at);
create index safety_program_drive_ingest_items_status_idx
  on program_private.safety_program_drive_ingest_items(run_id, status, created_at);
create index safety_program_import_candidates_review_idx
  on public.safety_program_import_candidates(company_id, review_status, candidate_kind, created_at);
create index safety_program_candidate_access_company_time_idx
  on public.safety_program_candidate_file_access_events(company_id, occurred_at desc);
create index safety_program_candidate_access_actor_time_idx
  on public.safety_program_candidate_file_access_events(actor_user_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Mutation guards and audit triggers
-- ---------------------------------------------------------------------------

create or replace function program_private.guard_drive_ingest_run()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Drive ingest runs cannot be deleted'
      using errcode = '55000';
  end if;

  if old.status = 'prepared'
     and new.status = 'committed'
     and old.committed_at is null
     and new.committed_at is not null
     and (to_jsonb(new) - array['status', 'committed_at'])
       = (to_jsonb(old) - array['status', 'committed_at']) then
    return new;
  end if;

  raise exception 'Drive ingest runs are immutable except for the final committed transition'
    using errcode = '55000';
end;
$$;

create or replace function program_private.guard_drive_ingest_item()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Drive ingest items cannot be deleted'
      using errcode = '55000';
  end if;

  if old.status = 'prepared'
     and new.status = 'committed'
     and old.committed_at is null
     and new.committed_at is not null
     and new.committed_storage_object_id is not null
     and new.committed_source_document_id is not null
     and new.committed_source_version_id is not null
     and new.committed_candidate_id is not null
     and (
       to_jsonb(new) - array[
         'status',
         'committed_storage_object_id',
         'committed_source_document_id',
         'committed_source_version_id',
         'committed_candidate_id',
         'committed_at'
       ]
     ) = (
       to_jsonb(old) - array[
         'status',
         'committed_storage_object_id',
         'committed_source_document_id',
         'committed_source_version_id',
         'committed_candidate_id',
         'committed_at'
       ]
     ) then
    return new;
  end if;

  raise exception 'Drive ingest items are immutable except for the verified commit transition'
    using errcode = '55000';
end;
$$;

create or replace function program_private.guard_import_candidate()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Import candidates are archived records and cannot be deleted'
      using errcode = '55000';
  end if;

  if auth.role() is distinct from 'service_role'
     and not private.can_manage_company(old.company_id) then
    raise exception 'Only a corporate administrator or safety manager may review an import candidate'
      using errcode = '42501';
  end if;

  if (
    to_jsonb(new) - array[
      'candidate_kind',
      'review_status',
      'classification',
      'language',
      'proposed_location_codes'
    ]
  ) is distinct from (
    to_jsonb(old) - array[
      'candidate_kind',
      'review_status',
      'classification',
      'language',
      'proposed_location_codes'
    ]
  ) then
    raise exception 'Import source identity, hash, size, MIME, and render evidence are immutable'
      using errcode = '55000';
  end if;

  if old.review_status in ('duplicate', 'imported', 'superseded')
     and new.review_status is distinct from old.review_status then
    raise exception 'Terminal import-candidate review states cannot be reopened in place'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from unnest(new.proposed_location_codes) proposed_code
    group by proposed_code
    having count(*) > 1
  ) then
    raise exception 'Proposed location codes must not contain duplicates'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function program_private.jsonb_has_forbidden_access_key(
  target_value jsonb
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
  child_key text;
  child_value jsonb;
begin
  if jsonb_typeof(target_value) = 'object' then
    for child_key, child_value in
      select entry.key, entry.value
      from jsonb_each(target_value) entry
    loop
      if lower(child_key) in (
        'signed_url', 'signedurl', 'access_token', 'accesstoken',
        'refresh_token', 'refreshtoken', 'authorization', 'apikey',
        'token', 'bucket_id', 'bucketid', 'object_path', 'objectpath'
      )
      or lower(child_key) like '%credential%'
      or lower(child_key) like '%secret%' then
        return true;
      end if;
      if program_private.jsonb_has_forbidden_access_key(child_value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(target_value) = 'array' then
    for child_value in
      select element.value
      from jsonb_array_elements(target_value) element
    loop
      if program_private.jsonb_has_forbidden_access_key(child_value) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

create or replace function program_private.guard_candidate_file_access_event()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Candidate file access events are append-only'
      using errcode = '55000';
  end if;

  if auth.role() is distinct from 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Only the signing service may append candidate access events'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from program_private.safety_program_drive_ingest_items ingest_item
    where ingest_item.company_id = new.company_id
      and ingest_item.committed_candidate_id = new.candidate_id
      and ingest_item.committed_storage_object_id = new.storage_object_id
      and ingest_item.status = 'committed'
  ) then
    raise exception 'Candidate and storage object do not match a committed ingest item'
      using errcode = '23514';
  end if;

  if new.decision = 'allowed'
     and not exists (
       select 1
       from public.company_memberships membership
       where membership.company_id = new.company_id
         and membership.user_id = new.actor_user_id
         and membership.active
         and membership.role in ('corporate_admin', 'safety_manager')
     ) then
    raise exception 'Only an active company manager may receive a candidate file URL'
      using errcode = '42501';
  end if;

  if program_private.jsonb_has_forbidden_access_key(new.request_context) then
    raise exception 'Access-event context cannot store a credential or object locator'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger safety_program_drive_ingest_runs_guard
before update or delete on program_private.safety_program_drive_ingest_runs
for each row execute function program_private.guard_drive_ingest_run();

create trigger safety_program_drive_ingest_items_guard
before update or delete on program_private.safety_program_drive_ingest_items
for each row execute function program_private.guard_drive_ingest_item();

create trigger safety_program_drive_ingest_events_immutable
before update or delete on program_private.safety_program_drive_ingest_events
for each row execute function program_private.reject_mutation();

create trigger safety_program_import_candidates_guard
before update or delete on public.safety_program_import_candidates
for each row execute function program_private.guard_import_candidate();

create trigger safety_program_import_candidates_audit
after insert or update on public.safety_program_import_candidates
for each row execute function program_private.capture_audit_event();

create trigger safety_program_candidate_file_access_events_immutable
before update or delete on public.safety_program_candidate_file_access_events
for each row execute function program_private.reject_mutation();

create trigger safety_program_candidate_file_access_events_guard
before insert on public.safety_program_candidate_file_access_events
for each row execute function program_private.guard_candidate_file_access_event();

create trigger safety_program_candidate_file_access_events_audit
after insert on public.safety_program_candidate_file_access_events
for each row execute function program_private.capture_audit_event();

-- ---------------------------------------------------------------------------
-- Stable service snapshots used by prepare/resume
-- ---------------------------------------------------------------------------

create or replace function program_private.drive_ingest_status_snapshot(
  target_run_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
  select jsonb_build_object(
    'runId', ingest_run.id,
    'companyId', ingest_run.company_id,
    'status', ingest_run.status,
    'manifestId', ingest_run.manifest_id,
    'manifestSha256', ingest_run.manifest_sha256,
    'itemCount', ingest_run.item_count,
    'totalSizeBytes', ingest_run.total_size_bytes,
    'bucketId', 'safety-program-private',
    'createdAt', ingest_run.created_at,
    'committedAt', ingest_run.committed_at,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'itemId', ingest_item.id,
          'itemKey', ingest_item.item_key,
          'status', ingest_item.status,
          'candidateId', ingest_item.committed_candidate_id,
          'filename', ingest_item.filename,
          'mimeType', ingest_item.expected_mime_type,
          'sizeBytes', ingest_item.expected_size_bytes,
          'contentSha256', ingest_item.expected_sha256,
          'quarantineObjectPath', ingest_item.quarantine_object_path,
          'finalObjectPath', ingest_item.final_object_path
        )
        order by ingest_item.snapshot_key, ingest_item.source_path_sha256, ingest_item.item_key
      )
      from program_private.safety_program_drive_ingest_items ingest_item
      where ingest_item.run_id = ingest_run.id
    ), '[]'::jsonb)
  )
  from program_private.safety_program_drive_ingest_runs ingest_run
  where ingest_run.id = target_run_id;
$$;

-- ---------------------------------------------------------------------------
-- Idempotent service-only prepare RPC
-- ---------------------------------------------------------------------------

create or replace function public.prepare_safety_program_drive_ingest(
  target_company_id uuid,
  target_manifest_sha256 text,
  target_manifest jsonb,
  target_scan_attestation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  existing_run program_private.safety_program_drive_ingest_runs%rowtype;
  new_run_id uuid := gen_random_uuid();
  new_item_id uuid;
  manifest_id_value uuid;
  manifest_items jsonb;
  manifest_snapshots jsonb;
  manifest_item jsonb;
  snapshot_record jsonb;
  item_count_value integer := 0;
  total_size_value bigint := 0;
  item_size_value bigint;
  item_page_count integer;
  item_render_verified boolean;
  item_location_codes text[];
  item_source_path text;
  item_source_path_sha256 text;
  item_artifact_path text;
  item_filename text;
  item_folder_hint text;
  item_extension text;
  item_mime_type text;
  item_key_value text;
  item_snapshot_key text;
  item_candidate_kind text;
  item_classification text;
  item_language text;
  item_sha256 text;
  snapshot_key_value text;
  snapshot_item_count integer;
  snapshot_total_bytes bigint;
  computed_snapshot_item_count integer;
  computed_snapshot_total_bytes bigint;
  expected_mime_type text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Drive archive prepare is restricted to service_role'
      using errcode = '42501';
  end if;

  if target_company_id is null
     or not exists (
       select 1 from public.companies company where company.id = target_company_id
     ) then
    raise exception 'A valid target company is required'
      using errcode = '23503';
  end if;

  if target_manifest_sha256 is null
     or target_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Manifest SHA-256 must be an exact lowercase digest'
      using errcode = '23514';
  end if;

  if jsonb_typeof(target_manifest) is distinct from 'object'
     or jsonb_typeof(target_scan_attestation) is distinct from 'object' then
    raise exception 'Manifest and scan attestation must be JSON objects'
      using errcode = '22023';
  end if;

  if target_manifest ->> 'manifest_sha256' is distinct from target_manifest_sha256 then
    raise exception 'Manifest digest parameter does not match the frozen manifest assertion'
      using errcode = '22000';
  end if;

  if target_manifest ->> 'company_id' is distinct from target_company_id::text then
    raise exception 'Manifest company does not match the target tenant'
      using errcode = '42501';
  end if;

  if target_manifest ->> 'schema_version' is distinct from '1'
     or target_manifest #>> '{source,provider}' is distinct from 'google_drive'
     or target_manifest #>> '{source,identity_kind}'
       is distinct from 'folder_zip_path_snapshot' then
    raise exception 'Unsupported Drive ZIP snapshot manifest identity'
      using errcode = '22023';
  end if;

  if coalesce(target_manifest ->> 'manifest_id', '')
       !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception 'Manifest ID must be a UUID'
      using errcode = '22023';
  end if;
  manifest_id_value := (target_manifest ->> 'manifest_id')::uuid;

  if target_manifest -> 'scan_attestation' is distinct from target_scan_attestation
     or target_scan_attestation ->> 'result' is distinct from 'clean'
     or coalesce(trim(target_scan_attestation ->> 'provider'), '') = ''
     or coalesce(trim(target_scan_attestation ->> 'recorded_at'), '') = '' then
    raise exception 'A matching clean malware-scan attestation is required'
      using errcode = '23514';
  end if;

  if target_manifest #> '{snapshot,complete}' is distinct from 'true'::jsonb
     or jsonb_typeof(target_manifest #> '{snapshot,snapshots}') is distinct from 'array'
     or jsonb_typeof(target_manifest -> 'items') is distinct from 'array' then
    raise exception 'Only complete snapshot manifests with snapshot and item arrays are accepted'
      using errcode = '22023';
  end if;

  manifest_items := target_manifest -> 'items';
  manifest_snapshots := target_manifest #> '{snapshot,snapshots}';

  if jsonb_array_length(manifest_items) not between 1 and 5000
     or jsonb_array_length(manifest_snapshots) not between 1 and 100 then
    raise exception 'Manifest must contain 1-5000 items and 1-100 snapshots'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(manifest_items) item_value
    group by item_value ->> 'item_key'
    having count(*) > 1
  ) then
    raise exception 'Manifest item keys must be unique'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(manifest_snapshots) snapshot_value
    group by snapshot_value ->> 'snapshot_key'
    having count(*) > 1
  ) then
    raise exception 'Manifest snapshot keys must be unique'
      using errcode = '23505';
  end if;

  for manifest_item in
    select value from jsonb_array_elements(manifest_items)
  loop
    if jsonb_typeof(manifest_item) is distinct from 'object' then
      raise exception 'Every manifest item must be an object'
        using errcode = '22023';
    end if;

    item_key_value := manifest_item ->> 'item_key';
    item_snapshot_key := manifest_item ->> 'snapshot_key';
    item_source_path := manifest_item ->> 'source_path';
    item_source_path_sha256 := manifest_item ->> 'source_path_sha256';
    item_artifact_path := manifest_item ->> 'artifact_relative_path';
    item_filename := manifest_item ->> 'filename';
    item_folder_hint := manifest_item ->> 'folder_hint';
    item_extension := manifest_item ->> 'extension';
    item_mime_type := manifest_item ->> 'mime_type';
    item_candidate_kind := manifest_item ->> 'candidate_kind';
    item_classification := manifest_item ->> 'classification';
    item_language := manifest_item ->> 'language';
    item_sha256 := manifest_item ->> 'content_sha256';

    if coalesce(item_key_value, '') !~ '^[0-9a-f]{64}$'
       or coalesce(item_source_path_sha256, '') !~ '^[0-9a-f]{64}$'
       or coalesce(item_sha256, '') !~ '^[0-9a-f]{64}$' then
      raise exception 'Item %, path, and content hashes must be exact lowercase SHA-256 values', item_count_value + 1
        using errcode = '23514';
    end if;

    if coalesce(char_length(item_snapshot_key), 0) not between 1 and 160
       or coalesce(char_length(item_source_path), 0) not between 1 and 4096
       or item_source_path ~ '(^/|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|//|[[:cntrl:]])'
       or coalesce(char_length(item_artifact_path), 0) not between 1 and 4096
       or item_artifact_path ~ '(^/|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|//|[[:cntrl:]])'
       or coalesce(char_length(item_filename), 0) not between 1 and 255
       or item_filename ~ '[/\\[:cntrl:]]'
       or coalesce(char_length(item_folder_hint), 0) not between 1 and 512 then
      raise exception 'Manifest item % contains an invalid path or display value', item_count_value + 1
        using errcode = '22023';
    end if;

    if encode(extensions.digest(convert_to(item_source_path, 'UTF8'), 'sha256'), 'hex')
         is distinct from item_source_path_sha256 then
      raise exception 'Source path fingerprint mismatch for item %', item_key_value
        using errcode = '22000';
    end if;

    expected_mime_type := case item_extension
      when '.pdf' then 'application/pdf'
      when '.doc' then 'application/msword'
      when '.docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      when '.xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      when '.pptx' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      when '.jpg' then 'image/jpeg'
      when '.jpeg' then 'image/jpeg'
      when '.png' then 'image/png'
      when '.dng' then case
        when item_mime_type in ('image/x-adobe-dng', 'image/jpeg')
          then item_mime_type
        else null
      end
      when '.tif' then 'image/tiff'
      when '.tiff' then 'image/tiff'
      else null
    end;

    if expected_mime_type is null
       or item_mime_type is distinct from expected_mime_type then
      raise exception 'Unsupported or mismatched extension/MIME for item %', item_key_value
        using errcode = '23514';
    end if;

    if coalesce(manifest_item ->> 'size_bytes', '') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'Item % has an invalid byte size', item_key_value
        using errcode = '22023';
    end if;
    item_size_value := (manifest_item ->> 'size_bytes')::bigint;
    if item_size_value > 104857600 then
      raise exception 'Item % exceeds the private-object size limit', item_key_value
        using errcode = '22023';
    end if;

    if item_candidate_kind not in (
         'form_template', 'completed_record', 'program_document',
         'training_material', 'reference', 'evidence', 'unknown'
       )
       or item_classification not in ('internal', 'confidential', 'restricted')
       or coalesce(item_language, '') !~ '^[a-z]{2,3}(?:-[A-Z]{2})?$' then
      raise exception 'Item % has an unsupported candidate classification', item_key_value
        using errcode = '23514';
    end if;

    if jsonb_typeof(manifest_item -> 'proposed_location_codes') is distinct from 'array'
       or exists (
         select 1
         from jsonb_array_elements(manifest_item -> 'proposed_location_codes') code_value
         where jsonb_typeof(code_value) is distinct from 'string'
            or trim(both '"' from code_value::text)
              !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$'
       )
       or exists (
         select 1
         from jsonb_array_elements_text(manifest_item -> 'proposed_location_codes') code_value
         group by code_value
         having count(*) > 1
       ) then
      raise exception 'Item % has invalid or duplicate proposed location codes', item_key_value
        using errcode = '23514';
    end if;
    select coalesce(array_agg(code_value order by code_value), '{}'::text[])
    into item_location_codes
    from jsonb_array_elements_text(manifest_item -> 'proposed_location_codes') code_value;

    if jsonb_typeof(manifest_item -> 'render_verified') is distinct from 'boolean' then
      raise exception 'Item % must include a Boolean render verification assertion', item_key_value
        using errcode = '22023';
    end if;
    item_render_verified := (manifest_item ->> 'render_verified')::boolean;

    if item_mime_type = 'application/pdf' then
      if coalesce(manifest_item ->> 'page_count', '') !~ '^[1-9][0-9]{0,6}$'
         or not item_render_verified then
        raise exception 'PDF item % requires a verified full-document render and positive page count', item_key_value
          using errcode = '23514';
      end if;
      item_page_count := (manifest_item ->> 'page_count')::integer;
    else
      if manifest_item -> 'page_count' is distinct from 'null'::jsonb
         or item_render_verified then
        raise exception 'Non-PDF item % cannot claim PDF page/render evidence', item_key_value
          using errcode = '23514';
      end if;
      item_page_count := null;
    end if;

    item_count_value := item_count_value + 1;
    total_size_value := total_size_value + item_size_value;
  end loop;

  if coalesce(target_manifest ->> 'item_count', '') !~ '^[1-9][0-9]{0,6}$'
     or (target_manifest ->> 'item_count')::integer <> item_count_value
     or coalesce(target_manifest ->> 'total_bytes', '') !~ '^[1-9][0-9]{0,12}$'
     or (target_manifest ->> 'total_bytes')::bigint <> total_size_value then
    raise exception 'Manifest aggregate count or byte total does not match its items'
      using errcode = '22000';
  end if;

  if coalesce(target_scan_attestation ->> 'scanned_item_count', '') !~ '^[1-9][0-9]{0,6}$'
     or (target_scan_attestation ->> 'scanned_item_count')::integer <> item_count_value
     or jsonb_typeof(target_scan_attestation -> 'scanned_snapshot_sha256')
       is distinct from 'array' then
    raise exception 'Scan attestation does not cover every manifest item/snapshot'
      using errcode = '23514';
  end if;

  for snapshot_record in
    select value from jsonb_array_elements(manifest_snapshots)
  loop
    snapshot_key_value := snapshot_record ->> 'snapshot_key';
    if jsonb_typeof(snapshot_record) is distinct from 'object'
       or coalesce(char_length(snapshot_key_value), 0) not between 1 and 160
       or coalesce(char_length(snapshot_record ->> 'folder_id'), 0) not between 1 and 512
       or coalesce(char_length(snapshot_record ->> 'folder_name'), 0) not between 1 and 300
       or coalesce(char_length(snapshot_record ->> 'zip_file'), 0) not between 1 and 255
       or coalesce(snapshot_record ->> 'zip_sha256', '') !~ '^[0-9a-f]{64}$'
       or coalesce(snapshot_record ->> 'zip_bytes', '') !~ '^[1-9][0-9]{0,12}$'
       or coalesce(snapshot_record ->> 'item_count', '') !~ '^[1-9][0-9]{0,6}$'
       or coalesce(snapshot_record ->> 'total_bytes', '') !~ '^[1-9][0-9]{0,12}$' then
      raise exception 'Snapshot metadata is incomplete or invalid'
        using errcode = '22023';
    end if;

    snapshot_item_count := (snapshot_record ->> 'item_count')::integer;
    snapshot_total_bytes := (snapshot_record ->> 'total_bytes')::bigint;
    select count(*), coalesce(sum((item_value ->> 'size_bytes')::bigint), 0)
    into computed_snapshot_item_count, computed_snapshot_total_bytes
    from jsonb_array_elements(manifest_items) item_value
    where item_value ->> 'snapshot_key' = snapshot_key_value;

    if computed_snapshot_item_count <> snapshot_item_count
       or computed_snapshot_total_bytes <> snapshot_total_bytes then
      raise exception 'Snapshot % aggregates do not match its items', snapshot_key_value
        using errcode = '22000';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(manifest_items) item_value
    where not exists (
      select 1
      from jsonb_array_elements(manifest_snapshots) snapshot_value
      where snapshot_value ->> 'snapshot_key' = item_value ->> 'snapshot_key'
    )
  )
  or exists (
    select 1
    from jsonb_array_elements(manifest_snapshots) snapshot_value
    where not exists (
      select 1
      from jsonb_array_elements_text(
        target_scan_attestation -> 'scanned_snapshot_sha256'
      ) scan_hash
      where scan_hash = snapshot_value ->> 'zip_sha256'
    )
  )
  or jsonb_array_length(target_scan_attestation -> 'scanned_snapshot_sha256')
       <> jsonb_array_length(manifest_snapshots) then
    raise exception 'Item snapshot keys or scan snapshot hashes are incomplete'
      using errcode = '23514';
  end if;

  -- Serialize only identical tenant/manifest prepares. A concurrent replay
  -- waits, then returns the frozen run instead of racing the unique indexes.
  perform pg_advisory_xact_lock(
    hashtextextended(target_company_id::text || ':' || target_manifest_sha256, 0)
  );

  select ingest_run.*
  into existing_run
  from program_private.safety_program_drive_ingest_runs ingest_run
  where ingest_run.company_id = target_company_id
    and ingest_run.manifest_sha256 = target_manifest_sha256
  for update;

  if found then
    if existing_run.manifest_id <> manifest_id_value
       or existing_run.manifest is distinct from target_manifest
       or existing_run.scan_attestation is distinct from target_scan_attestation
       or existing_run.item_count <> item_count_value
       or existing_run.total_size_bytes <> total_size_value then
      raise exception 'Manifest replay conflicts with the frozen ingest record'
        using errcode = '22000';
    end if;
    return program_private.drive_ingest_status_snapshot(existing_run.id);
  end if;

  insert into program_private.safety_program_drive_ingest_runs (
    id,
    company_id,
    manifest_id,
    manifest_sha256,
    manifest,
    scan_attestation,
    item_count,
    total_size_bytes
  ) values (
    new_run_id,
    target_company_id,
    manifest_id_value,
    target_manifest_sha256,
    target_manifest,
    target_scan_attestation,
    item_count_value,
    total_size_value
  );

  for manifest_item in
    select value from jsonb_array_elements(manifest_items)
  loop
    new_item_id := gen_random_uuid();
    select coalesce(array_agg(code_value order by code_value), '{}'::text[])
    into item_location_codes
    from jsonb_array_elements_text(manifest_item -> 'proposed_location_codes') code_value;

    item_page_count := case
      when manifest_item -> 'page_count' = 'null'::jsonb then null
      else (manifest_item ->> 'page_count')::integer
    end;

    insert into program_private.safety_program_drive_ingest_items (
      id,
      run_id,
      company_id,
      item_key,
      snapshot_key,
      source_path,
      source_path_sha256,
      artifact_relative_path,
      filename,
      folder_hint,
      extension,
      expected_mime_type,
      expected_size_bytes,
      expected_sha256,
      candidate_kind,
      classification,
      language,
      proposed_location_codes,
      page_count,
      render_verified,
      quarantine_object_path,
      final_object_path
    ) values (
      new_item_id,
      new_run_id,
      target_company_id,
      manifest_item ->> 'item_key',
      manifest_item ->> 'snapshot_key',
      manifest_item ->> 'source_path',
      manifest_item ->> 'source_path_sha256',
      manifest_item ->> 'artifact_relative_path',
      manifest_item ->> 'filename',
      manifest_item ->> 'folder_hint',
      manifest_item ->> 'extension',
      manifest_item ->> 'mime_type',
      (manifest_item ->> 'size_bytes')::bigint,
      manifest_item ->> 'content_sha256',
      manifest_item ->> 'candidate_kind',
      manifest_item ->> 'classification',
      manifest_item ->> 'language',
      item_location_codes,
      item_page_count,
      (manifest_item ->> 'render_verified')::boolean,
      target_company_id::text || '/quarantine/drive/'
        || new_run_id::text || '/' || new_item_id::text,
      target_company_id::text || '/source-archive/sha256/'
        || substr(manifest_item ->> 'content_sha256', 1, 2)
        || '/' || (manifest_item ->> 'content_sha256')
    );
  end loop;

  insert into program_private.safety_program_drive_ingest_events (
    company_id,
    run_id,
    event_key,
    event_type,
    event_payload
  ) values (
    target_company_id,
    new_run_id,
    'prepare:' || target_manifest_sha256,
    'ingest_prepared',
    jsonb_build_object(
      'manifest_sha256', target_manifest_sha256,
      'item_count', item_count_value,
      'total_size_bytes', total_size_value,
      'scan_result', target_scan_attestation ->> 'result'
    )
  );

  return program_private.drive_ingest_status_snapshot(new_run_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Idempotent verified-item commit RPC
-- ---------------------------------------------------------------------------

create or replace function public.commit_safety_program_drive_ingest_item(
  target_item_id uuid,
  verified_size_bytes bigint,
  verified_sha256 text,
  detected_mime_type text,
  final_object_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  ingest_item program_private.safety_program_drive_ingest_items%rowtype;
  ingest_run program_private.safety_program_drive_ingest_runs%rowtype;
  snapshot_record jsonb;
  stored_object_json jsonb;
  stored_object_size_text text;
  stored_object_mime text;
  stored_object_sha256 text;
  storage_object_record public.safety_program_storage_objects%rowtype;
  source_document_record public.safety_program_source_documents%rowtype;
  source_version_record public.safety_program_source_versions%rowtype;
  candidate_record public.safety_program_import_candidates%rowtype;
  prior_candidate_item program_private.safety_program_drive_ingest_items%rowtype;
  synthetic_external_file_id text;
  source_folder_id text;
  remaining_items integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Drive archive commit is restricted to service_role'
      using errcode = '42501';
  end if;

  select item_record.*
  into ingest_item
  from program_private.safety_program_drive_ingest_items item_record
  where item_record.id = target_item_id
  for update;

  if not found then
    raise exception 'Drive ingest item was not found'
      using errcode = 'P0002';
  end if;

  if verified_size_bytes is distinct from ingest_item.expected_size_bytes
     or verified_sha256 is distinct from ingest_item.expected_sha256
     or detected_mime_type is distinct from ingest_item.expected_mime_type
     or final_object_path is distinct from ingest_item.final_object_path then
    raise exception 'Verified size, SHA-256, MIME, or content path differs from the frozen manifest'
      using errcode = '22000';
  end if;

  if ingest_item.status = 'committed' then
    return jsonb_build_object(
      'itemId', ingest_item.id,
      'status', ingest_item.status,
      'candidateId', ingest_item.committed_candidate_id,
      'storageObjectId', ingest_item.committed_storage_object_id,
      'sourceDocumentId', ingest_item.committed_source_document_id,
      'sourceVersionId', ingest_item.committed_source_version_id,
      'contentSha256', ingest_item.expected_sha256
    );
  end if;

  select run_record.*
  into ingest_run
  from program_private.safety_program_drive_ingest_runs run_record
  where run_record.id = ingest_item.run_id
  for update;

  select to_jsonb(storage_object)
  into stored_object_json
  from storage.objects storage_object
  where storage_object.bucket_id = 'safety-program-private'
    and storage_object.name = final_object_path
  limit 1;

  if stored_object_json is null then
    raise exception 'The verified content-addressed Storage object does not exist'
      using errcode = 'P0002';
  end if;

  stored_object_size_text := coalesce(
    stored_object_json #>> '{metadata,size}',
    stored_object_json #>> '{metadata,contentLength}'
  );
  stored_object_mime := coalesce(
    stored_object_json #>> '{metadata,mimetype}',
    stored_object_json #>> '{metadata,contentType}'
  );
  stored_object_sha256 := coalesce(
    stored_object_json #>> '{user_metadata,content_sha256}',
    stored_object_json #>> '{metadata,content_sha256}'
  );

  if coalesce(stored_object_size_text, '') !~ '^[0-9]+$'
     or stored_object_size_text::bigint <> verified_size_bytes
     or stored_object_mime is distinct from detected_mime_type
     or stored_object_sha256 is distinct from verified_sha256 then
    raise exception 'Storage metadata does not attest the exact verified size, MIME, and SHA-256'
      using errcode = '22000';
  end if;

  insert into public.safety_program_storage_objects (
    company_id,
    bucket_id,
    object_path,
    original_filename,
    mime_type,
    size_bytes,
    content_sha256,
    purpose,
    malware_scan_status,
    source_system,
    provider_object_version,
    uploaded_by,
    verified_at
  ) values (
    ingest_item.company_id,
    'safety-program-private',
    ingest_item.final_object_path,
    ingest_item.filename,
    ingest_item.expected_mime_type,
    ingest_item.expected_size_bytes,
    ingest_item.expected_sha256,
    'source_mirror',
    'clean',
    'google_drive_zip_snapshot',
    ingest_run.manifest_sha256,
    null,
    clock_timestamp()
  )
  on conflict (object_path) do nothing;

  select object_record.*
  into storage_object_record
  from public.safety_program_storage_objects object_record
  where object_record.object_path = ingest_item.final_object_path
  for update;

  if storage_object_record.company_id <> ingest_item.company_id
     or storage_object_record.bucket_id <> 'safety-program-private'
     or storage_object_record.mime_type <> ingest_item.expected_mime_type
     or storage_object_record.size_bytes <> ingest_item.expected_size_bytes
     or storage_object_record.content_sha256 <> ingest_item.expected_sha256
     or storage_object_record.purpose <> 'source_mirror'
     or storage_object_record.malware_scan_status <> 'clean'
     or storage_object_record.verified_at is null then
    raise exception 'Existing content-addressed object metadata conflicts with the verified item'
      using errcode = '22000';
  end if;

  select snapshot_value
  into snapshot_record
  from jsonb_array_elements(ingest_run.manifest #> '{snapshot,snapshots}') snapshot_value
  where snapshot_value ->> 'snapshot_key' = ingest_item.snapshot_key
  limit 1;

  if snapshot_record is null then
    raise exception 'Frozen snapshot metadata is missing for the ingest item'
      using errcode = '22000';
  end if;

  source_folder_id := snapshot_record ->> 'folder_id';
  synthetic_external_file_id := 'zip-path-sha256:' || ingest_item.source_path_sha256;

  insert into public.safety_program_source_documents (
    company_id,
    provider,
    external_drive_id,
    external_file_id,
    title,
    declared_mime_type,
    classification,
    sync_enabled,
    active,
    last_observed_at,
    created_by
  ) values (
    ingest_item.company_id,
    'google_drive_zip_snapshot',
    source_folder_id,
    synthetic_external_file_id,
    ingest_item.filename,
    ingest_item.expected_mime_type,
    ingest_item.classification,
    false,
    true,
    clock_timestamp(),
    null
  )
  on conflict (company_id, provider, external_drive_id, external_file_id)
  do nothing;

  select source_document.*
  into source_document_record
  from public.safety_program_source_documents source_document
  where source_document.company_id = ingest_item.company_id
    and source_document.provider = 'google_drive_zip_snapshot'
    and source_document.external_drive_id = source_folder_id
    and source_document.external_file_id = synthetic_external_file_id
  for update;

  if source_document_record.id is null then
    raise exception 'Source document identity could not be resolved'
      using errcode = '22000';
  end if;

  insert into public.safety_program_source_versions (
    company_id,
    source_document_id,
    provider_revision_id,
    storage_object_id,
    content_sha256,
    source_metadata,
    extraction_metadata,
    imported_by
  ) values (
    ingest_item.company_id,
    source_document_record.id,
    'zip-snapshot:' || ingest_run.manifest_sha256 || ':' || ingest_item.item_key,
    storage_object_record.id,
    ingest_item.expected_sha256,
    jsonb_build_object(
      'identity_kind', 'folder_zip_path_snapshot',
      'manifest_id', ingest_run.manifest_id,
      'manifest_sha256', ingest_run.manifest_sha256,
      'root_folder_id', ingest_run.manifest #>> '{source,root_folder_id}',
      'source_folder_id', source_folder_id,
      'snapshot_key', ingest_item.snapshot_key,
      'snapshot_zip_sha256', snapshot_record ->> 'zip_sha256',
      'source_path', ingest_item.source_path,
      'source_path_sha256', ingest_item.source_path_sha256,
      'artifact_relative_path', ingest_item.artifact_relative_path,
      'item_key', ingest_item.item_key
    ),
    jsonb_build_object(
      'declared_mime_type', ingest_item.expected_mime_type,
      'verified_size_bytes', ingest_item.expected_size_bytes,
      'verified_sha256', ingest_item.expected_sha256,
      'page_count', ingest_item.page_count,
      'render_verified', ingest_item.render_verified,
      'scan_attestation', ingest_run.scan_attestation
    ),
    null
  )
  on conflict (source_document_id, content_sha256) do nothing;

  select source_version.*
  into source_version_record
  from public.safety_program_source_versions source_version
  where source_version.source_document_id = source_document_record.id
    and source_version.content_sha256 = ingest_item.expected_sha256;

  if source_version_record.id is null
     or source_version_record.storage_object_id <> storage_object_record.id then
    raise exception 'Source version conflicts with the content-addressed object'
      using errcode = '22000';
  end if;

  insert into public.safety_program_import_candidates (
    company_id,
    display_name,
    folder_hint,
    candidate_kind,
    review_status,
    classification,
    language,
    proposed_location_codes,
    page_count,
    render_verified,
    mime_type,
    size_bytes,
    content_sha256,
    source_path_sha256
  ) values (
    ingest_item.company_id,
    ingest_item.filename,
    ingest_item.folder_hint,
    ingest_item.candidate_kind,
    'pending_review',
    ingest_item.classification,
    ingest_item.language,
    ingest_item.proposed_location_codes,
    ingest_item.page_count,
    ingest_item.render_verified,
    ingest_item.expected_mime_type,
    ingest_item.expected_size_bytes,
    ingest_item.expected_sha256,
    ingest_item.source_path_sha256
  )
  on conflict (company_id, content_sha256, source_path_sha256) do nothing;

  select candidate.*
  into candidate_record
  from public.safety_program_import_candidates candidate
  where candidate.company_id = ingest_item.company_id
    and candidate.content_sha256 = ingest_item.expected_sha256
    and candidate.source_path_sha256 = ingest_item.source_path_sha256;

  if candidate_record.id is null
     or candidate_record.display_name is distinct from ingest_item.filename
     or candidate_record.folder_hint is distinct from ingest_item.folder_hint
     or candidate_record.page_count is distinct from ingest_item.page_count
     or candidate_record.render_verified is distinct from ingest_item.render_verified
     or candidate_record.mime_type is distinct from ingest_item.expected_mime_type
     or candidate_record.size_bytes is distinct from ingest_item.expected_size_bytes
     or candidate_record.content_sha256 is distinct from ingest_item.expected_sha256
     or candidate_record.source_path_sha256 is distinct from ingest_item.source_path_sha256 then
    raise exception 'Import candidate conflicts with the exact source metadata'
      using errcode = '22000';
  end if;

  select prior_item.*
  into prior_candidate_item
  from program_private.safety_program_drive_ingest_items prior_item
  where prior_item.committed_candidate_id = candidate_record.id
    and prior_item.status = 'committed'
  order by prior_item.created_at, prior_item.id
  limit 1;

  if found then
    if prior_candidate_item.filename is distinct from ingest_item.filename
       or prior_candidate_item.folder_hint is distinct from ingest_item.folder_hint
       or prior_candidate_item.candidate_kind is distinct from ingest_item.candidate_kind
       or prior_candidate_item.classification is distinct from ingest_item.classification
       or prior_candidate_item.language is distinct from ingest_item.language
       or prior_candidate_item.proposed_location_codes is distinct from ingest_item.proposed_location_codes
       or prior_candidate_item.page_count is distinct from ingest_item.page_count
       or prior_candidate_item.render_verified is distinct from ingest_item.render_verified
       or prior_candidate_item.expected_mime_type is distinct from ingest_item.expected_mime_type
       or prior_candidate_item.expected_size_bytes is distinct from ingest_item.expected_size_bytes
       or prior_candidate_item.expected_sha256 is distinct from ingest_item.expected_sha256
       or prior_candidate_item.source_path_sha256 is distinct from ingest_item.source_path_sha256 then
      raise exception 'Candidate replay conflicts with its frozen source projection'
        using errcode = '22000';
    end if;
  elsif candidate_record.candidate_kind is distinct from ingest_item.candidate_kind
     or candidate_record.classification is distinct from ingest_item.classification
     or candidate_record.language is distinct from ingest_item.language
     or candidate_record.proposed_location_codes is distinct from ingest_item.proposed_location_codes then
    raise exception 'New import candidate differs from the frozen source projection'
      using errcode = '22000';
  end if;

  update program_private.safety_program_drive_ingest_items
  set status = 'committed',
      committed_storage_object_id = storage_object_record.id,
      committed_source_document_id = source_document_record.id,
      committed_source_version_id = source_version_record.id,
      committed_candidate_id = candidate_record.id,
      committed_at = clock_timestamp()
  where id = ingest_item.id;

  insert into program_private.safety_program_drive_ingest_events (
    company_id,
    run_id,
    item_id,
    event_key,
    event_type,
    event_payload
  ) values (
    ingest_item.company_id,
    ingest_item.run_id,
    ingest_item.id,
    'commit:' || ingest_item.item_key,
    'item_committed',
    jsonb_build_object(
      'item_key', ingest_item.item_key,
      'content_sha256', ingest_item.expected_sha256,
      'size_bytes', ingest_item.expected_size_bytes,
      'mime_type', ingest_item.expected_mime_type,
      'storage_object_id', storage_object_record.id,
      'source_document_id', source_document_record.id,
      'source_version_id', source_version_record.id,
      'candidate_id', candidate_record.id
    )
  )
  on conflict (run_id, event_key) do nothing;

  select count(*)
  into remaining_items
  from program_private.safety_program_drive_ingest_items remaining_item
  where remaining_item.run_id = ingest_item.run_id
    and remaining_item.status <> 'committed';

  if remaining_items = 0 and ingest_run.status = 'prepared' then
    update program_private.safety_program_drive_ingest_runs
    set status = 'committed',
        committed_at = clock_timestamp()
    where id = ingest_run.id;

    insert into program_private.safety_program_drive_ingest_events (
      company_id,
      run_id,
      event_key,
      event_type,
      event_payload
    ) values (
      ingest_item.company_id,
      ingest_item.run_id,
      'complete:' || ingest_run.manifest_sha256,
      'ingest_committed',
      jsonb_build_object(
        'manifest_sha256', ingest_run.manifest_sha256,
        'item_count', ingest_run.item_count,
        'total_size_bytes', ingest_run.total_size_bytes
      )
    )
    on conflict (run_id, event_key) do nothing;
  end if;

  return jsonb_build_object(
    'itemId', ingest_item.id,
    'status', 'committed',
    'candidateId', candidate_record.id,
    'storageObjectId', storage_object_record.id,
    'sourceDocumentId', source_document_record.id,
    'sourceVersionId', source_version_record.id,
    'contentSha256', ingest_item.expected_sha256
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Narrow lookup RPCs
-- ---------------------------------------------------------------------------

create or replace function public.get_safety_program_drive_ingest_status(
  target_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  status_snapshot jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Drive ingest status is restricted to service_role'
      using errcode = '42501';
  end if;

  status_snapshot := program_private.drive_ingest_status_snapshot(target_run_id);
  if status_snapshot is null then
    raise exception 'Drive ingest run was not found'
      using errcode = 'P0002';
  end if;
  return status_snapshot;
end;
$$;

create or replace function public.get_safety_program_drive_ingest_upload_items(
  target_item_ids uuid[]
)
returns table (
  item_id uuid,
  company_id uuid,
  bucket_id text,
  quarantine_object_path text,
  final_object_path text,
  expected_size_bytes bigint,
  expected_sha256 text,
  expected_mime_type text,
  status text
)
language plpgsql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Drive ingest upload lookup is restricted to service_role'
      using errcode = '42501';
  end if;
  if target_item_ids is null
     or cardinality(target_item_ids) not between 1 and 1000
     or array_position(target_item_ids, null) is not null then
    raise exception '1-1000 explicit item IDs are required'
      using errcode = '22023';
  end if;

  return query
  select
    ingest_item.id,
    ingest_item.company_id,
    'safety-program-private'::text,
    ingest_item.quarantine_object_path,
    ingest_item.final_object_path,
    ingest_item.expected_size_bytes,
    ingest_item.expected_sha256,
    ingest_item.expected_mime_type,
    ingest_item.status
  from program_private.safety_program_drive_ingest_items ingest_item
  where ingest_item.id = any(target_item_ids)
  order by ingest_item.id;
end;
$$;

-- Authenticated managers receive only non-locator metadata. The Edge Function
-- signs by candidate ID and performs its separate service-only locator lookup.
create or replace function public.get_safety_program_import_candidate_file_metadata(
  target_candidate_id uuid
)
returns table (
  candidate_id uuid,
  filename text,
  mime_type text,
  size_bytes bigint,
  content_sha256 text,
  page_count integer,
  render_verified boolean
)
language sql
stable
security definer
set search_path = public, private, program_private, pg_temp
as $$
  select
    candidate.id,
    candidate.display_name,
    storage_object.mime_type,
    storage_object.size_bytes,
    storage_object.content_sha256,
    candidate.page_count,
    candidate.render_verified
  from public.safety_program_import_candidates candidate
  join program_private.safety_program_drive_ingest_items ingest_item
    on ingest_item.committed_candidate_id = candidate.id
   and ingest_item.company_id = candidate.company_id
  join public.safety_program_storage_objects storage_object
    on storage_object.id = ingest_item.committed_storage_object_id
   and storage_object.company_id = candidate.company_id
  where candidate.id = target_candidate_id
    and ingest_item.status = 'committed'
    and candidate.review_status in (
      'pending_review', 'needs_information', 'approved', 'imported'
    )
    and storage_object.malware_scan_status = 'clean'
    and storage_object.verified_at is not null
    and private.can_manage_company(candidate.company_id)
  limit 1;
$$;

create or replace function public.get_safety_program_import_candidate_storage_locator(
  target_candidate_id uuid
)
returns table (
  candidate_id uuid,
  item_id uuid,
  company_id uuid,
  storage_object_id uuid,
  bucket_id text,
  object_path text,
  filename text,
  mime_type text,
  size_bytes bigint,
  content_sha256 text
)
language plpgsql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Candidate storage lookup is restricted to service_role'
      using errcode = '42501';
  end if;

  return query
  select
    candidate.id,
    ingest_item.id,
    candidate.company_id,
    storage_object.id,
    storage_object.bucket_id,
    storage_object.object_path,
    candidate.display_name,
    storage_object.mime_type,
    storage_object.size_bytes,
    storage_object.content_sha256
  from public.safety_program_import_candidates candidate
  join program_private.safety_program_drive_ingest_items ingest_item
    on ingest_item.committed_candidate_id = candidate.id
   and ingest_item.company_id = candidate.company_id
  join public.safety_program_storage_objects storage_object
    on storage_object.id = ingest_item.committed_storage_object_id
   and storage_object.company_id = candidate.company_id
  where candidate.id = target_candidate_id
    and ingest_item.status = 'committed'
    and candidate.review_status in (
      'pending_review', 'needs_information', 'approved', 'imported'
    )
    and storage_object.malware_scan_status = 'clean'
    and storage_object.verified_at is not null
  limit 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------

alter table program_private.safety_program_drive_ingest_runs enable row level security;
alter table program_private.safety_program_drive_ingest_items enable row level security;
alter table program_private.safety_program_drive_ingest_events enable row level security;
alter table public.safety_program_import_candidates enable row level security;
alter table public.safety_program_candidate_file_access_events enable row level security;

revoke all on table
  program_private.safety_program_drive_ingest_runs,
  program_private.safety_program_drive_ingest_items,
  program_private.safety_program_drive_ingest_events
from public, anon, authenticated;

revoke all on table
  program_private.safety_program_drive_ingest_runs,
  program_private.safety_program_drive_ingest_items,
  program_private.safety_program_drive_ingest_events
from service_role;

-- No direct service-role DML is granted on the ingest ledger. All mutation and
-- reads flow through the validation RPCs below, which are SECURITY DEFINER.

revoke all on table
  public.safety_program_import_candidates,
  public.safety_program_candidate_file_access_events
from public, anon, authenticated;

revoke all on table
  public.safety_program_import_candidates,
  public.safety_program_candidate_file_access_events
from service_role;

grant select, update
  on table public.safety_program_import_candidates
  to authenticated;
grant select
  on table public.safety_program_candidate_file_access_events
  to authenticated;
grant insert
  on table public.safety_program_candidate_file_access_events
  to service_role;

create policy safety_program_import_candidates_manager_select
on public.safety_program_import_candidates
for select
using (private.can_manage_company(company_id));

create policy safety_program_import_candidates_manager_update
on public.safety_program_import_candidates
for update
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy safety_program_candidate_access_manager_select
on public.safety_program_candidate_file_access_events
for select
using (private.can_manage_company(company_id));

revoke all on function
  program_private.jsonb_has_forbidden_access_key(jsonb),
  program_private.drive_ingest_status_snapshot(uuid),
  public.prepare_safety_program_drive_ingest(uuid, text, jsonb, jsonb),
  public.commit_safety_program_drive_ingest_item(uuid, bigint, text, text, text),
  public.get_safety_program_drive_ingest_status(uuid),
  public.get_safety_program_drive_ingest_upload_items(uuid[]),
  public.get_safety_program_import_candidate_file_metadata(uuid),
  public.get_safety_program_import_candidate_storage_locator(uuid)
from public, anon, authenticated;

grant execute on function program_private.drive_ingest_status_snapshot(uuid)
  to service_role;
grant execute on function public.prepare_safety_program_drive_ingest(uuid, text, jsonb, jsonb)
  to service_role;
grant execute on function public.commit_safety_program_drive_ingest_item(uuid, bigint, text, text, text)
  to service_role;
grant execute on function public.get_safety_program_drive_ingest_status(uuid)
  to service_role;
grant execute on function public.get_safety_program_drive_ingest_upload_items(uuid[])
  to service_role;
grant execute on function public.get_safety_program_import_candidate_storage_locator(uuid)
  to service_role;
grant execute on function public.get_safety_program_import_candidate_file_metadata(uuid)
  to authenticated;

comment on table program_private.safety_program_drive_ingest_runs is
  'Service-only immutable Drive ZIP snapshot manifests and clean-scan attestations; exact company/hash replay key.';
comment on table program_private.safety_program_drive_ingest_items is
  'Service-only per-item ZIP path provenance, exact hash/MIME/size expectations, quarantine locator, and content-addressed commit ledger; legacy .dng filenames may attest independently detected JPEG bytes.';
comment on table program_private.safety_program_drive_ingest_events is
  'Append-only service event ledger for prepare, item commit, and run completion.';
comment on table public.safety_program_import_candidates is
  'Manager-only Drive archive review projection; intentionally omits raw paths, provider IDs, bucket names, and object locators.';
comment on table public.safety_program_candidate_file_access_events is
  'Append-only manager-visible allow/deny ledger for candidate downloads; contains no signed URL, credential, or object locator.';
comment on function public.prepare_safety_program_drive_ingest(uuid, text, jsonb, jsonb) is
  'Service-role-only idempotent validation/freeze of a complete clean Drive ZIP-snapshot manifest; returns quarantine and content-addressed item locators.';
comment on function public.commit_safety_program_drive_ingest_item(uuid, bigint, text, text, text) is
  'Service-role-only idempotent exact-byte commit; requires matching size, SHA-256, MIME, content path, and Storage metadata.';
comment on function public.get_safety_program_import_candidate_file_metadata(uuid) is
  'Authenticated-manager authorization RPC returning only filename, MIME, size, SHA-256, and PDF completeness evidence; never bucket/object path.';
