-- SafetyOps private form originals and template-file lineage
-- Depends on:
--   202607300001_initial_safetyops.sql
--   202607300002_regulatory_traceability.sql
--   202607300003_safety_programs.sql
--
-- This migration keeps uploaded originals out of the public site bundle. A
-- narrow Edge Function prepares signed uploads, scans and verifies the bytes,
-- then commits immutable source/object metadata and the exact template link.

create extension if not exists pgcrypto with schema extensions;

-- The bucket remains nonpublic and service-controlled. This allowlist covers
-- canonical forms plus the derived artifact kinds supported by the Drive
-- importer. The manual-upload endpoint should enforce its smaller allowlist.
update storage.buckets
set public = false,
    file_size_limit = 104857600,
    allowed_mime_types = array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/json',
      'text/plain',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/bmp'
    ]::text[]
where id = 'safety-program-private';

alter table public.safety_program_storage_objects
  drop constraint if exists safety_program_storage_objects_purpose_check;

alter table public.safety_program_storage_objects
  add constraint safety_program_storage_objects_purpose_check
  check (purpose in (
    'source_mirror',
    'form_original',
    'form_template_export',
    'form_attachment',
    'signature_artifact',
    'program_export'
  ));

alter table public.safety_program_form_template_versions
  add column origin_kind text not null default 'native',
  add column source_manifest_sha256 text,
  add constraint safety_program_form_template_versions_origin_kind_check
    check (origin_kind in ('native', 'manual_upload', 'drive_import')),
  add constraint safety_program_form_template_versions_source_manifest_check
    check (
      source_manifest_sha256 is null
      or source_manifest_sha256 ~ '^[0-9a-f]{64}$'
    );

-- A row pins one exact downloadable byte object to one exact form-template
-- version and its immutable source revision. "Original" must be the canonical
-- source object; other roles may select the canonical object or a recorded
-- derived artifact.
create table public.safety_program_form_template_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  program_version_id uuid not null,
  form_template_version_id uuid not null,
  source_version_id uuid not null,
  storage_object_id uuid not null,
  file_role text not null
    check (file_role in (
      'original',
      'fillable_pdf',
      'printable_copy',
      'editable_source',
      'preview'
    )),
  is_primary boolean not null default false,
  source_locator jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (
    company_id,
    program_version_id,
    form_template_version_id,
    id
  ),
  unique (
    form_template_version_id,
    source_version_id,
    storage_object_id,
    file_role
  ),
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(
      company_id,
      program_version_id,
      id
    )
    on delete restrict,
  foreign key (company_id, source_version_id)
    references public.safety_program_source_versions(company_id, id)
    on delete restrict,
  foreign key (company_id, storage_object_id)
    references public.safety_program_storage_objects(company_id, id)
    on delete restrict,
  check (jsonb_typeof(source_locator) = 'object')
);

create unique index safety_program_form_template_files_primary_role_idx
  on public.safety_program_form_template_files(
    form_template_version_id,
    file_role
  )
  where is_primary;

create index safety_program_form_template_files_template_idx
  on public.safety_program_form_template_files(
    company_id,
    form_template_version_id,
    file_role
  );

-- Upload preparation is durable and idempotent, but deliberately lives in the
-- service-only schema. It is not exposed through the Data API.
create table program_private.form_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  program_version_id uuid not null,
  form_template_version_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null
    check (char_length(idempotency_key) between 8 and 200),
  original_filename text not null
    check (char_length(original_filename) between 1 and 255),
  declared_mime_type text not null
    check (declared_mime_type in (
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png'
    )),
  classification text not null default 'internal'
    check (classification in ('internal', 'confidential', 'restricted')),
  expected_size_bytes bigint not null
    check (expected_size_bytes between 1 and 26214400),
  expected_sha256 text not null
    check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  quarantine_object_path text not null unique
    check (
      quarantine_object_path !~ '(^|/)\.\.(/|$)'
      and quarantine_object_path like (company_id::text || '/quarantine/forms/%')
    ),
  status text not null default 'prepared'
    check (status in (
      'prepared',
      'uploaded',
      'scanning',
      'committed',
      'rejected',
      'expired'
    )),
  rejection_reason text,
  expires_at timestamptz not null,
  committed_storage_object_id uuid,
  committed_source_document_id uuid,
  committed_source_version_id uuid,
  committed_form_file_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, requested_by, idempotency_key),
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(
      company_id,
      program_version_id,
      id
    )
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
  foreign key (
    company_id,
    program_version_id,
    form_template_version_id,
    committed_form_file_id
  )
    references public.safety_program_form_template_files(
      company_id,
      program_version_id,
      form_template_version_id,
      id
    )
    on delete restrict,
  check (expires_at > created_at),
  check (
    (
      status = 'committed'
      and committed_storage_object_id is not null
      and committed_source_document_id is not null
      and committed_source_version_id is not null
      and committed_form_file_id is not null
    )
    or (
      status <> 'committed'
      and committed_storage_object_id is null
      and committed_source_document_id is null
      and committed_source_version_id is null
      and committed_form_file_id is null
    )
  ),
  check (
    (
      status = 'rejected'
      and rejection_reason is not null
      and char_length(trim(rejection_reason)) > 0
    )
    or (
      status <> 'rejected'
      and rejection_reason is null
    )
  )
);

create index form_upload_sessions_status_expiry_idx
  on program_private.form_upload_sessions(status, expires_at);

revoke all on table program_private.form_upload_sessions
  from public, anon, authenticated;
grant select, insert, update
  on table program_private.form_upload_sessions
  to service_role;

create or replace function program_private.guard_form_upload_session()
returns trigger
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  target_form_status text;
  result_is_consistent boolean;
  requester_is_manager boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'form upload sessions are retained as an immutable workflow ledger'
      using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'prepared' then
      raise exception 'an upload session must begin in prepared status'
        using errcode = '23514';
    end if;

    if new.expires_at <= clock_timestamp() then
      raise exception 'an upload session must expire in the future'
        using errcode = '23514';
    end if;

    select exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = new.company_id
        and membership.user_id = new.requested_by
        and membership.active
        and membership.role in ('corporate_admin', 'safety_manager')
    )
    into requester_is_manager;

    if not requester_is_manager then
      raise exception 'only an active company safety administrator may upload form originals'
        using errcode = '42501';
    end if;

    select form_version.status
    into target_form_status
    from public.safety_program_form_template_versions form_version
    where form_version.company_id = new.company_id
      and form_version.program_version_id = new.program_version_id
      and form_version.id = new.form_template_version_id;

    if target_form_status is distinct from 'draft' then
      raise exception 'uploads may target only a draft form-template version'
        using errcode = '23514';
    end if;

    return new;
  end if;

  if old.company_id <> new.company_id
     or old.program_version_id <> new.program_version_id
     or old.form_template_version_id <> new.form_template_version_id
     or old.requested_by <> new.requested_by
     or old.idempotency_key <> new.idempotency_key
     or old.original_filename <> new.original_filename
     or old.declared_mime_type <> new.declared_mime_type
     or old.classification <> new.classification
     or old.expected_size_bytes <> new.expected_size_bytes
     or old.expected_sha256 <> new.expected_sha256
     or old.quarantine_object_path <> new.quarantine_object_path
     or old.expires_at <> new.expires_at
     or old.created_at <> new.created_at then
    raise exception 'upload-session identity and expected bytes are immutable'
      using errcode = '55000';
  end if;

  if old.status in ('committed', 'rejected', 'expired') then
    raise exception 'a terminal upload session is immutable'
      using errcode = '55000';
  end if;

  if new.status not in ('rejected', 'expired') then
    select exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = new.company_id
        and membership.user_id = new.requested_by
        and membership.active
        and membership.role in ('corporate_admin', 'safety_manager')
    )
    into requester_is_manager;

    if not requester_is_manager then
      raise exception 'upload requester no longer has form-administration authority'
        using errcode = '42501';
    end if;
  end if;

  if not (
    (old.status = 'prepared' and new.status in ('uploaded', 'rejected', 'expired'))
    or (old.status = 'uploaded' and new.status in ('scanning', 'rejected', 'expired'))
    or (old.status = 'scanning' and new.status in ('committed', 'rejected', 'expired'))
  ) then
    raise exception 'unsupported upload-session status transition'
      using errcode = '23514';
  end if;

  if new.status = 'committed' then
    select exists (
      select 1
      from public.safety_program_form_template_files file_link
      join public.safety_program_source_versions source_version
        on source_version.id = file_link.source_version_id
      join public.safety_program_source_documents source_document
        on source_document.id = source_version.source_document_id
      join public.safety_program_storage_objects storage_object
        on storage_object.id = file_link.storage_object_id
      where file_link.id = new.committed_form_file_id
        and file_link.company_id = new.company_id
        and file_link.program_version_id = new.program_version_id
        and file_link.form_template_version_id = new.form_template_version_id
        and file_link.storage_object_id = new.committed_storage_object_id
        and file_link.source_version_id = new.committed_source_version_id
        and source_version.source_document_id = new.committed_source_document_id
        and file_link.file_role = 'original'
        and file_link.is_primary
        and file_link.created_by = new.requested_by
        and source_document.provider = 'manual_upload'
        and source_document.classification = new.classification
        and source_document.created_by = new.requested_by
        and source_version.imported_by = new.requested_by
        and source_version.content_sha256 = new.expected_sha256
        and storage_object.purpose = 'form_original'
        and storage_object.source_system = 'manual_import'
        and storage_object.uploaded_by = new.requested_by
        and storage_object.content_sha256 = new.expected_sha256
        and storage_object.size_bytes = new.expected_size_bytes
        and storage_object.mime_type = new.declared_mime_type
        and storage_object.malware_scan_status = 'clean'
        and storage_object.verified_at is not null
    )
    into result_is_consistent;

    if not result_is_consistent then
      raise exception 'committed upload results do not match the target template and source chain'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger form_upload_sessions_guard
before insert or update or delete on program_private.form_upload_sessions
for each row execute function program_private.guard_form_upload_session();

create trigger form_upload_sessions_touch
before update on program_private.form_upload_sessions
for each row execute function private.touch_updated_at();

create or replace function program_private.guard_form_template_file()
returns trigger
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  row_record public.safety_program_form_template_files%rowtype;
  form_status text;
  parent_status text;
  canonical_storage_object_id uuid;
  source_object_is_valid boolean;
  object_record public.safety_program_storage_objects%rowtype;
begin
  if tg_op = 'DELETE' then
    row_record := old;
  else
    row_record := new;
  end if;

  select form_version.status, program_version.status
  into form_status, parent_status
  from public.safety_program_form_template_versions form_version
  join public.safety_program_versions program_version
    on program_version.id = form_version.program_version_id
  where form_version.id = row_record.form_template_version_id
    and form_version.company_id = row_record.company_id
    and form_version.program_version_id = row_record.program_version_id
  for update of form_version, program_version;

  if form_status is null then
    raise exception 'form template version not found'
      using errcode = '23503';
  end if;

  if form_status = 'published'
     or parent_status in ('approved', 'published', 'superseded') then
    raise exception 'files pinned to published form content are immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'form-template file links are immutable; replace the draft link'
      using errcode = '55000';
  end if;

  select source_version.storage_object_id
  into canonical_storage_object_id
  from public.safety_program_source_versions source_version
  where source_version.id = new.source_version_id
    and source_version.company_id = new.company_id;

  select object_value.*
  into object_record
  from public.safety_program_storage_objects object_value
  where object_value.id = new.storage_object_id
    and object_value.company_id = new.company_id;

  source_object_is_valid :=
    new.storage_object_id = canonical_storage_object_id
    or exists (
      select 1
      from public.safety_program_source_version_artifacts artifact
      where artifact.company_id = new.company_id
        and artifact.source_version_id = new.source_version_id
        and artifact.storage_object_id = new.storage_object_id
    );

  if canonical_storage_object_id is null
     or object_record.id is null
     or not source_object_is_valid then
    raise exception 'file must pin the canonical source bytes or a recorded source artifact'
      using errcode = '23514';
  end if;

  if new.file_role = 'original'
     and new.storage_object_id <> canonical_storage_object_id then
    raise exception 'the original role must pin the canonical source object'
      using errcode = '23514';
  end if;

  if object_record.malware_scan_status <> 'clean'
     or object_record.verified_at is null then
    raise exception 'only clean, verified source objects may be linked to templates'
      using errcode = '23514';
  end if;

  if object_record.purpose not in (
    'source_mirror',
    'form_original',
    'form_template_export'
  ) then
    raise exception 'storage object purpose is not valid for a form template'
      using errcode = '23514';
  end if;

  if auth.uid() is not null and new.created_by <> auth.uid() then
    raise exception 'created_by must be the current user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- This trigger runs after the original "..._guard" trigger by name. On the
-- draft-to-published transition it calculates the source manifest itself so a
-- client cannot assert an arbitrary source hash.
create or replace function program_private.guard_form_template_sources()
returns trigger
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  linked_file_count integer;
  primary_original_count integer;
  calculated_manifest_sha256 text;
begin
  if new.status = 'draft' then
    new.source_manifest_sha256 := null;
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'draft'
     and new.status = 'published' then
    select
      count(*)::integer,
      count(*) filter (
        where file_link.file_role = 'original'
          and file_link.is_primary
      )::integer,
      encode(
        extensions.digest(
          coalesce(
            string_agg(
              concat_ws(
                '|',
                file_link.file_role,
                file_link.is_primary::text,
                source_version.content_sha256,
                storage_object.content_sha256,
                encode(
                  convert_to(file_link.source_locator::text, 'UTF8'),
                  'hex'
                )
              ),
              E'\n'
              order by
                file_link.file_role,
                storage_object.content_sha256,
                source_version.content_sha256,
                file_link.id
            ),
            ''
          ),
          'sha256'
        ),
        'hex'
      )
    into
      linked_file_count,
      primary_original_count,
      calculated_manifest_sha256
    from public.safety_program_form_template_files file_link
    join public.safety_program_source_versions source_version
      on source_version.id = file_link.source_version_id
    join public.safety_program_storage_objects storage_object
      on storage_object.id = file_link.storage_object_id
    where file_link.form_template_version_id = new.id
      and file_link.company_id = new.company_id
      and storage_object.malware_scan_status = 'clean'
      and storage_object.verified_at is not null;

    if new.origin_kind in ('manual_upload', 'drive_import') then
      if linked_file_count = 0 or primary_original_count <> 1 then
        raise exception 'a source-backed form requires exactly one clean primary original'
          using errcode = '23514';
      end if;
      new.source_manifest_sha256 := calculated_manifest_sha256;
    elsif linked_file_count > 0 then
      raise exception 'a form with linked source files must declare a source-backed origin'
        using errcode = '23514';
    else
      new.source_manifest_sha256 := null;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function program_private.guard_form_upload_session()
  from public, anon, authenticated;
revoke all on function program_private.guard_form_template_file()
  from public, anon, authenticated;
revoke all on function program_private.guard_form_template_sources()
  from public, anon, authenticated;

create trigger safety_program_form_template_files_guard
before insert or update or delete
on public.safety_program_form_template_files
for each row execute function program_private.guard_form_template_file();

create trigger safety_program_form_template_versions_z_source_guard
before insert or update
on public.safety_program_form_template_versions
for each row execute function program_private.guard_form_template_sources();

create trigger safety_program_form_template_files_audit
after insert or update or delete
on public.safety_program_form_template_files
for each row execute function program_private.capture_audit_event();

-- Download authorization is distinct from metadata visibility. Every path
-- must be clean, and non-managers may only retrieve an internal original from
-- a published form under a program version they can already view.
create or replace function private.can_download_safety_program_form_file(
  target_form_file_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_program_form_template_files file_link
    join public.safety_program_form_template_versions form_version
      on form_version.id = file_link.form_template_version_id
    join public.safety_program_source_versions source_version
      on source_version.id = file_link.source_version_id
    join public.safety_program_source_documents source_document
      on source_document.id = source_version.source_document_id
    join public.safety_program_storage_objects storage_object
      on storage_object.id = file_link.storage_object_id
    where file_link.id = target_form_file_id
      and storage_object.malware_scan_status = 'clean'
      and storage_object.verified_at is not null
      and (
        private.can_manage_company(file_link.company_id)
        or (
          form_version.status = 'published'
          and source_document.active
          and source_document.classification = 'internal'
          and private.can_view_safety_program_version(
            file_link.program_version_id
          )
          and (
            storage_object.location_id is null
            or private.can_access_location(
              storage_object.company_id,
              storage_object.location_id
            )
          )
        )
      )
  );
$$;

-- This RPC intentionally omits bucket/object paths. The Edge Function invokes
-- it under the caller's JWT, then uses its own service client to look up and
-- sign the exact object after a successful authorization result.
create or replace function public.get_safety_program_form_file_metadata(
  target_form_file_id uuid
)
returns table (
  form_file_id uuid,
  file_role text,
  filename text,
  mime_type text,
  size_bytes bigint,
  content_sha256 text
)
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select
    file_link.id,
    file_link.file_role,
    storage_object.original_filename,
    storage_object.mime_type,
    storage_object.size_bytes,
    storage_object.content_sha256
  from public.safety_program_form_template_files file_link
  join public.safety_program_storage_objects storage_object
    on storage_object.id = file_link.storage_object_id
  where file_link.id = target_form_file_id
    and private.can_download_safety_program_form_file(file_link.id);
$$;

alter table public.safety_program_form_template_files
  enable row level security;

revoke all on table public.safety_program_form_template_files
  from public, anon;
grant select, insert, delete
  on table public.safety_program_form_template_files
  to authenticated;

create policy safety_program_form_template_files_select
on public.safety_program_form_template_files
for select
using (
  private.can_manage_company(company_id)
  or private.can_download_safety_program_form_file(id)
);

create policy safety_program_form_template_files_insert
on public.safety_program_form_template_files
for insert
with check (
  private.can_manage_company(company_id)
  and created_by = auth.uid()
);

create policy safety_program_form_template_files_delete
on public.safety_program_form_template_files
for delete
using (private.can_manage_company(company_id));

revoke all on function public.get_safety_program_form_file_metadata(uuid)
  from public, anon;
grant execute on function public.get_safety_program_form_file_metadata(uuid)
  to authenticated;

revoke all on function private.can_download_safety_program_form_file(uuid)
  from public, anon;
grant execute on function private.can_download_safety_program_form_file(uuid)
  to authenticated;

comment on table public.safety_program_form_template_files is
  'Exact immutable source/object links for downloadable form-template originals and approved renderings.';
comment on table program_private.form_upload_sessions is
  'Service-only, expiring prepare/upload/scan/commit ledger for idempotent private form uploads.';
comment on function public.get_safety_program_form_file_metadata(uuid) is
  'Returns authorized form-file metadata without revealing a bucket or object path; signing remains an Edge Function responsibility.';
