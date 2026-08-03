-- SafetyOps immutable Drive source-collection projection
--
-- The UI needs a stable, human-readable top-level collection without exposing
-- the raw ZIP path. The collection is derived only from frozen ingest evidence:
-- an item's snapshot_key resolves to snapshot.folder_name in its run manifest.
-- Invalidated runs remain immutable provenance, so the backfill intentionally
-- considers every committed history row and does not consult the invalidation
-- ledger. A historical Google ZIP exported "Forms & Appendices /..." with one
-- delimiter-adjacent space; btrim(first path segment) is therefore the frozen-
-- manifest-compatible comparison used here and by both ingest validators.

alter table public.safety_program_import_candidates
  add column source_collection text;

-- Fail closed if a prior migration renamed or disabled the one guard that this
-- bounded identity backfill must briefly bypass. Every other candidate trigger
-- (normalization, review events, and hash-chain audit) remains enabled.
do $$
begin
  if not exists (
    select 1
    from pg_trigger trigger_record
    where trigger_record.tgrelid =
            'public.safety_program_import_candidates'::regclass
      and trigger_record.tgname = 'safety_program_import_candidates_guard'
      and not trigger_record.tgisinternal
      and trigger_record.tgenabled = 'O'
  ) then
    raise exception 'The import-candidate guard must exist and be enabled before source-collection backfill'
      using errcode = '55000';
  end if;
end;
$$;

-- This temporary projection contains only the candidate key and sanitized
-- folder name. Raw source paths never enter a public relation.
create temporary table safety_program_candidate_collection_backfill
on commit drop
as
select
  candidate.id as candidate_id,
  min(snapshot_value.value ->> 'folder_name') as source_collection,
  count(*) as evidence_row_count,
  count(distinct snapshot_value.value ->> 'folder_name') as collection_count
from public.safety_program_import_candidates candidate
join program_private.safety_program_drive_ingest_items ingest_item
  on ingest_item.company_id = candidate.company_id
 and ingest_item.committed_candidate_id = candidate.id
 and ingest_item.status = 'committed'
join program_private.safety_program_drive_ingest_runs ingest_run
  on ingest_run.company_id = ingest_item.company_id
 and ingest_run.id = ingest_item.run_id
join lateral jsonb_array_elements(
  case
    when jsonb_typeof(ingest_run.manifest #> '{snapshot,snapshots}') = 'array'
      then ingest_run.manifest #> '{snapshot,snapshots}'
    else '[]'::jsonb
  end
) snapshot_value(value)
  on snapshot_value.value ->> 'snapshot_key' = ingest_item.snapshot_key
group by candidate.id;

do $$
begin
  -- Every committed candidate evidence row must resolve its snapshot key once,
  -- not merely leave the candidate with one successful mapping among others.
  if exists (
    select 1
    from public.safety_program_import_candidates candidate
    join program_private.safety_program_drive_ingest_items ingest_item
      on ingest_item.company_id = candidate.company_id
     and ingest_item.committed_candidate_id = candidate.id
     and ingest_item.status = 'committed'
    join program_private.safety_program_drive_ingest_runs ingest_run
      on ingest_run.company_id = ingest_item.company_id
     and ingest_run.id = ingest_item.run_id
    where (
      select count(*)
      from jsonb_array_elements(
        case
          when jsonb_typeof(
            ingest_run.manifest #> '{snapshot,snapshots}'
          ) = 'array'
            then ingest_run.manifest #> '{snapshot,snapshots}'
          else '[]'::jsonb
        end
      ) snapshot_value(value)
      where snapshot_value.value ->> 'snapshot_key' = ingest_item.snapshot_key
    ) <> 1
  ) then
    raise exception 'Every committed candidate item must resolve exactly one frozen snapshot'
      using errcode = '23514';
  end if;

  -- folder_name is the only source lineage projected publicly. It must already
  -- be a display-safe, canonical segment, and it must equal the normalized
  -- first segment of the immutable source path.
  if exists (
    select 1
    from public.safety_program_import_candidates candidate
    join program_private.safety_program_drive_ingest_items ingest_item
      on ingest_item.company_id = candidate.company_id
     and ingest_item.committed_candidate_id = candidate.id
     and ingest_item.status = 'committed'
    join program_private.safety_program_drive_ingest_runs ingest_run
      on ingest_run.company_id = ingest_item.company_id
     and ingest_run.id = ingest_item.run_id
    join lateral jsonb_array_elements(
      case
        when jsonb_typeof(
          ingest_run.manifest #> '{snapshot,snapshots}'
        ) = 'array'
          then ingest_run.manifest #> '{snapshot,snapshots}'
        else '[]'::jsonb
      end
    ) snapshot_value(value)
      on snapshot_value.value ->> 'snapshot_key' = ingest_item.snapshot_key
    where coalesce(
            char_length(snapshot_value.value ->> 'folder_name'), 0
          ) not between 1 and 255
       or snapshot_value.value ->> 'folder_name'
            is distinct from btrim(snapshot_value.value ->> 'folder_name')
       or snapshot_value.value ->> 'folder_name' ~ '[/\\[:cntrl:]]'
       or btrim(split_part(ingest_item.source_path, '/', 1))
            is distinct from snapshot_value.value ->> 'folder_name'
  ) then
    raise exception 'Frozen snapshot folders must be sanitized and match their source-path root'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.safety_program_import_candidates candidate
    left join safety_program_candidate_collection_backfill backfill
      on backfill.candidate_id = candidate.id
    where backfill.candidate_id is null
       or backfill.collection_count <> 1
  ) then
    raise exception 'Every import candidate must have exactly one consistent source collection across committed history'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.safety_program_import_candidates
  disable trigger safety_program_import_candidates_guard;

update public.safety_program_import_candidates candidate
set source_collection = backfill.source_collection
from safety_program_candidate_collection_backfill backfill
where backfill.candidate_id = candidate.id
  and candidate.source_collection is null;

alter table public.safety_program_import_candidates
  enable trigger safety_program_import_candidates_guard;

do $$
begin
  if exists (
    select 1
    from public.safety_program_import_candidates candidate
    join safety_program_candidate_collection_backfill backfill
      on backfill.candidate_id = candidate.id
    where candidate.source_collection is distinct from backfill.source_collection
  )
  or exists (
    select 1
    from public.safety_program_import_candidates candidate
    where candidate.source_collection is null
  ) then
    raise exception 'Source-collection backfill did not update the exact candidate set'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_record
    where trigger_record.tgrelid =
            'public.safety_program_import_candidates'::regclass
      and trigger_record.tgname = 'safety_program_import_candidates_guard'
      and not trigger_record.tgisinternal
      and trigger_record.tgenabled = 'O'
  ) then
    raise exception 'The import-candidate guard was not re-enabled after source-collection backfill'
      using errcode = '55000';
  end if;
end;
$$;

alter table public.safety_program_import_candidates
  alter column source_collection set not null,
  add constraint safety_program_import_candidates_source_collection_check
    check (
      char_length(source_collection) between 1 and 255
      and source_collection = btrim(source_collection)
      and source_collection !~ '[/\\[:cntrl:]]'
    );

-- Candidate INSERT occurs while the current ingest item is still prepared, so
-- matching is by its immutable tenant/content/path identity rather than by the
-- committed_candidate_id that is assigned later in the same commit routine.
-- All frozen matching runs are considered; conflicting historical evidence is
-- rejected rather than choosing whichever run happened to be newest.
create or replace function program_private.derive_import_candidate_source_collection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, program_private, pg_temp
as $$
declare
  evidence_count bigint;
  distinct_collection_count bigint;
  derived_collection text;
begin
  select count(*)
  into evidence_count
  from program_private.safety_program_drive_ingest_items ingest_item
  join program_private.safety_program_drive_ingest_runs ingest_run
    on ingest_run.company_id = ingest_item.company_id
   and ingest_run.id = ingest_item.run_id
  where ingest_item.company_id = new.company_id
    and ingest_item.expected_sha256 = new.content_sha256
    and ingest_item.source_path_sha256 = new.source_path_sha256;

  if evidence_count = 0 then
    raise exception 'Import candidate source collection requires matching frozen ingest evidence'
      using errcode = '23503';
  end if;

  if exists (
    select 1
    from program_private.safety_program_drive_ingest_items ingest_item
    join program_private.safety_program_drive_ingest_runs ingest_run
      on ingest_run.company_id = ingest_item.company_id
     and ingest_run.id = ingest_item.run_id
    where ingest_item.company_id = new.company_id
      and ingest_item.expected_sha256 = new.content_sha256
      and ingest_item.source_path_sha256 = new.source_path_sha256
      and (
        select count(*)
        from jsonb_array_elements(
          case
            when jsonb_typeof(
              ingest_run.manifest #> '{snapshot,snapshots}'
            ) = 'array'
              then ingest_run.manifest #> '{snapshot,snapshots}'
            else '[]'::jsonb
          end
        ) snapshot_value(value)
        where snapshot_value.value ->> 'snapshot_key' = ingest_item.snapshot_key
      ) <> 1
  ) then
    raise exception 'Import candidate evidence has an ambiguous or missing snapshot mapping'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from program_private.safety_program_drive_ingest_items ingest_item
    join program_private.safety_program_drive_ingest_runs ingest_run
      on ingest_run.company_id = ingest_item.company_id
     and ingest_run.id = ingest_item.run_id
    join lateral jsonb_array_elements(
      case
        when jsonb_typeof(
          ingest_run.manifest #> '{snapshot,snapshots}'
        ) = 'array'
          then ingest_run.manifest #> '{snapshot,snapshots}'
        else '[]'::jsonb
      end
    ) snapshot_value(value)
      on snapshot_value.value ->> 'snapshot_key' = ingest_item.snapshot_key
    where ingest_item.company_id = new.company_id
      and ingest_item.expected_sha256 = new.content_sha256
      and ingest_item.source_path_sha256 = new.source_path_sha256
      and (
        coalesce(
          char_length(snapshot_value.value ->> 'folder_name'), 0
        ) not between 1 and 255
        or snapshot_value.value ->> 'folder_name'
             is distinct from btrim(snapshot_value.value ->> 'folder_name')
        or snapshot_value.value ->> 'folder_name' ~ '[/\\[:cntrl:]]'
        or btrim(split_part(ingest_item.source_path, '/', 1))
             is distinct from snapshot_value.value ->> 'folder_name'
      )
  ) then
    raise exception 'Import candidate evidence has an invalid or mismatched source collection'
      using errcode = '23514';
  end if;

  select
    count(distinct snapshot_value.value ->> 'folder_name'),
    min(snapshot_value.value ->> 'folder_name')
  into distinct_collection_count, derived_collection
  from program_private.safety_program_drive_ingest_items ingest_item
  join program_private.safety_program_drive_ingest_runs ingest_run
    on ingest_run.company_id = ingest_item.company_id
   and ingest_run.id = ingest_item.run_id
  join lateral jsonb_array_elements(
    case
      when jsonb_typeof(ingest_run.manifest #> '{snapshot,snapshots}') = 'array'
        then ingest_run.manifest #> '{snapshot,snapshots}'
      else '[]'::jsonb
    end
  ) snapshot_value(value)
    on snapshot_value.value ->> 'snapshot_key' = ingest_item.snapshot_key
  where ingest_item.company_id = new.company_id
    and ingest_item.expected_sha256 = new.content_sha256
    and ingest_item.source_path_sha256 = new.source_path_sha256;

  if distinct_collection_count <> 1 or derived_collection is null then
    raise exception 'Import candidate evidence must resolve one consistent source collection'
      using errcode = '23514';
  end if;

  if new.source_collection is not null
     and new.source_collection is distinct from derived_collection then
    raise exception 'Supplied source collection does not match frozen ingest evidence'
      using errcode = '23514';
  end if;

  new.source_collection := derived_collection;
  return new;
end;
$$;

create trigger safety_program_import_candidates_source_collection
before insert on public.safety_program_import_candidates
for each row execute function
  program_private.derive_import_candidate_source_collection();

revoke all on function
  program_private.derive_import_candidate_source_collection()
from public, anon, authenticated, service_role;

comment on column public.safety_program_import_candidates.source_collection is
  'Immutable sanitized top-level Drive snapshot folder derived server-side from frozen ingest evidence; never a raw source path.';
