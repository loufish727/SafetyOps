-- SafetyOps Drive-ingest invalidation ledger
--
-- A frozen ingest run is never rewritten or deleted. If a later review finds
-- its selection or attestation unsuitable, this append-only ledger invalidates
-- that run for download authorization while preserving the original evidence.

create table program_private.safety_program_drive_ingest_run_invalidations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  run_id uuid not null,
  reason_code text not null
    check (reason_code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object')
    check (not program_private.jsonb_has_forbidden_access_key(evidence)),
  invalidation_source text not null default 'service_review'
    check (invalidation_source in ('migration', 'service_review', 'manager')),
  invalidated_by uuid references auth.users(id) on delete restrict,
  invalidated_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  unique (run_id),
  foreign key (company_id, run_id)
    references program_private.safety_program_drive_ingest_runs(company_id, id)
    on delete restrict,
  check (invalidation_source <> 'manager' or invalidated_by is not null)
);

create index safety_program_drive_ingest_invalidations_company_time_idx
  on program_private.safety_program_drive_ingest_run_invalidations(
    company_id,
    invalidated_at desc
  );

create trigger safety_program_drive_ingest_run_invalidations_immutable
before update or delete
on program_private.safety_program_drive_ingest_run_invalidations
for each row execute function program_private.reject_mutation();

alter table program_private.safety_program_drive_ingest_run_invalidations
  enable row level security;

revoke all on table
  program_private.safety_program_drive_ingest_run_invalidations
from public, anon, authenticated, service_role;

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
  join program_private.safety_program_drive_ingest_runs ingest_run
    on ingest_run.id = ingest_item.run_id
   and ingest_run.company_id = ingest_item.company_id
  join public.safety_program_storage_objects storage_object
    on storage_object.id = ingest_item.committed_storage_object_id
   and storage_object.company_id = candidate.company_id
  where candidate.id = target_candidate_id
    and ingest_item.status = 'committed'
    and ingest_run.status = 'committed'
    and candidate.review_status in (
      'pending_review', 'needs_information', 'approved', 'imported'
    )
    and not exists (
      select 1
      from program_private.safety_program_drive_ingest_run_invalidations invalidation
      where invalidation.company_id = ingest_run.company_id
        and invalidation.run_id = ingest_run.id
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
  join program_private.safety_program_drive_ingest_runs ingest_run
    on ingest_run.id = ingest_item.run_id
   and ingest_run.company_id = ingest_item.company_id
  join public.safety_program_storage_objects storage_object
    on storage_object.id = ingest_item.committed_storage_object_id
   and storage_object.company_id = candidate.company_id
  where candidate.id = target_candidate_id
    and ingest_item.status = 'committed'
    and ingest_run.status = 'committed'
    and candidate.review_status in (
      'pending_review', 'needs_information', 'approved', 'imported'
    )
    and not exists (
      select 1
      from program_private.safety_program_drive_ingest_run_invalidations invalidation
      where invalidation.company_id = ingest_run.company_id
        and invalidation.run_id = ingest_run.id
    )
    and storage_object.malware_scan_status = 'clean'
    and storage_object.verified_at is not null
  limit 1;
end;
$$;

revoke all on function
  public.get_safety_program_import_candidate_file_metadata(uuid),
  public.get_safety_program_import_candidate_storage_locator(uuid)
from public, anon, authenticated;

grant execute on function public.get_safety_program_import_candidate_file_metadata(uuid)
  to authenticated;
grant execute on function public.get_safety_program_import_candidate_storage_locator(uuid)
  to service_role;

comment on table program_private.safety_program_drive_ingest_run_invalidations is
  'Append-only invalidations for immutable Drive-ingest runs; invalidated runs cannot authorize candidate downloads.';
comment on function public.get_safety_program_import_candidate_file_metadata(uuid) is
  'Manager authorization metadata for an active candidate backed by a non-invalidated committed run.';
comment on function public.get_safety_program_import_candidate_storage_locator(uuid) is
  'Service-only locator for an active candidate backed by a non-invalidated committed run.';
