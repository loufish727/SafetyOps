-- SafetyOps archive download review-state guard
--
-- A manager may inspect a pending/approved/imported candidate, but rejected,
-- duplicate, and superseded candidates must never resolve to a signed object.

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

revoke all on function
  public.get_safety_program_import_candidate_file_metadata(uuid),
  public.get_safety_program_import_candidate_storage_locator(uuid)
from public, anon, authenticated;

grant execute on function public.get_safety_program_import_candidate_file_metadata(uuid)
  to authenticated;
grant execute on function public.get_safety_program_import_candidate_storage_locator(uuid)
  to service_role;

comment on function public.get_safety_program_import_candidate_file_metadata(uuid) is
  'Manager authorization metadata for an active review candidate; rejected, duplicate, and superseded candidates are unavailable.';
comment on function public.get_safety_program_import_candidate_storage_locator(uuid) is
  'Service-only locator for an active review candidate; rejected, duplicate, and superseded candidates are unavailable.';
