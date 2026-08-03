-- SafetyOps import-candidate access scope and review controls
--
-- Candidate metadata may be visible to active company members only when a
-- safety administrator has classified the material as reusable internal
-- company content. Completed/personnel records and uncertain or restricted
-- material fail closed to safety administrators. Raw Storage locators remain
-- service-only and are never projected through the authenticated RPC.

alter table public.safety_program_import_candidates
  add column access_scope text not null default 'company'
    check (access_scope in ('company', 'safety_admin_private'));

create or replace function program_private.import_candidate_company_scope_allowed(
  target_candidate_kind text,
  target_classification text
)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    target_classification = 'internal'
      and target_candidate_kind in (
        'form_template',
        'program_document',
        'training_material',
        'reference'
      ),
    false
  );
$$;

-- The table default makes reusable internal imports company-visible. This
-- trigger is the fail-closed boundary for every service-side INSERT/UPDATE:
-- completed records, evidence, unknown kinds, and non-internal material can
-- never retain company scope even if a caller supplies that value explicitly.
create or replace function program_private.normalize_import_candidate_access_scope()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if new.access_scope is null then
    new.access_scope := 'company';
  end if;

  if not program_private.import_candidate_company_scope_allowed(
    new.candidate_kind,
    new.classification
  ) then
    new.access_scope := 'safety_admin_private';
  end if;

  return new;
end;
$$;

-- access_scope is review metadata. Source identity, exact bytes, MIME, size,
-- render evidence, and original timestamps remain immutable.
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
     and session_user not in ('postgres', 'supabase_admin')
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
      'proposed_location_codes',
      'access_scope'
    ]
  ) is distinct from (
    to_jsonb(old) - array[
      'candidate_kind',
      'review_status',
      'classification',
      'language',
      'proposed_location_codes',
      'access_scope'
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

create trigger safety_program_import_candidates_access_scope_normalize
before insert or update on public.safety_program_import_candidates
for each row execute function program_private.normalize_import_candidate_access_scope();

-- Human-readable append-only companion to the existing tenant hash-chain.
-- It records the precise before/after review decision while the generic audit
-- trigger independently records immutable row hashes and transaction order.
create table public.safety_program_import_candidate_review_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  candidate_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete restrict,
  actor_role_snapshot text not null
    check (char_length(actor_role_snapshot) between 1 and 80),
  previous_access_scope text not null
    check (previous_access_scope in ('company', 'safety_admin_private')),
  new_access_scope text not null
    check (new_access_scope in ('company', 'safety_admin_private')),
  previous_review_status text not null check (previous_review_status in (
    'pending_review', 'needs_information', 'approved', 'rejected',
    'duplicate', 'imported', 'superseded'
  )),
  new_review_status text not null check (new_review_status in (
    'pending_review', 'needs_information', 'approved', 'rejected',
    'duplicate', 'imported', 'superseded'
  )),
  changed_fields text[] not null
    check (cardinality(changed_fields) between 1 and 2)
    check (changed_fields <@ array['access_scope', 'review_status']::text[]),
  change_source text not null check (change_source in (
    'authenticated_review', 'service_role', 'database_migration'
  )),
  occurred_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, candidate_id)
    references public.safety_program_import_candidates(company_id, id)
    on delete restrict,
  check (
    previous_access_scope is distinct from new_access_scope
    or previous_review_status is distinct from new_review_status
  ),
  check (
    cardinality(changed_fields)
      = case
          when previous_access_scope is distinct from new_access_scope then 1
          else 0
        end
        + case
            when previous_review_status is distinct from new_review_status then 1
            else 0
          end
    and ('access_scope' = any(changed_fields))
      = (previous_access_scope is distinct from new_access_scope)
    and ('review_status' = any(changed_fields))
      = (previous_review_status is distinct from new_review_status)
  )
);

create index safety_program_import_candidate_scope_review_idx
  on public.safety_program_import_candidates(
    company_id,
    access_scope,
    review_status,
    candidate_kind,
    created_at
  );

create index safety_program_import_candidate_review_events_idx
  on public.safety_program_import_candidate_review_events(
    company_id,
    candidate_id,
    occurred_at desc
  );

create or replace function program_private.capture_import_candidate_review_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  changed_columns text[] := '{}'::text[];
  actor_role_value text;
  change_source_value text;
begin
  if old.access_scope is distinct from new.access_scope then
    changed_columns := array_append(changed_columns, 'access_scope');
  end if;
  if old.review_status is distinct from new.review_status then
    changed_columns := array_append(changed_columns, 'review_status');
  end if;

  if cardinality(changed_columns) = 0 then
    return new;
  end if;

  actor_role_value := coalesce(
    private.company_role(new.company_id)::text,
    auth.role(),
    'database_administrator'
  );
  change_source_value := case
    when auth.uid() is not null then 'authenticated_review'
    when auth.role() = 'service_role' then 'service_role'
    else 'database_migration'
  end;

  insert into public.safety_program_import_candidate_review_events (
    company_id,
    candidate_id,
    actor_user_id,
    actor_role_snapshot,
    previous_access_scope,
    new_access_scope,
    previous_review_status,
    new_review_status,
    changed_fields,
    change_source
  ) values (
    new.company_id,
    new.id,
    auth.uid(),
    actor_role_value,
    old.access_scope,
    new.access_scope,
    old.review_status,
    new.review_status,
    changed_columns,
    change_source_value
  );

  return new;
end;
$$;

create trigger safety_program_import_candidate_review_events_immutable
before update or delete on public.safety_program_import_candidate_review_events
for each row execute function program_private.reject_mutation();

create trigger safety_program_import_candidate_review_events_audit
after insert on public.safety_program_import_candidate_review_events
for each row execute function program_private.capture_audit_event();

create trigger safety_program_import_candidates_review_event
after update on public.safety_program_import_candidates
for each row execute function program_private.capture_import_candidate_review_event();

-- Existing candidates become company-visible only when their current kind and
-- classification positively identify reusable internal material. Everything
-- else is rewritten to the private scope inside this atomic migration.
update public.safety_program_import_candidates candidate
set access_scope = case
  when program_private.import_candidate_company_scope_allowed(
    candidate.candidate_kind,
    candidate.classification
  ) then 'company'
  else 'safety_admin_private'
end
where candidate.access_scope is distinct from case
  when program_private.import_candidate_company_scope_allowed(
    candidate.candidate_kind,
    candidate.classification
  ) then 'company'
  else 'safety_admin_private'
end;

-- Keep the same fail-closed rule as a declarative table invariant so an
-- unsafe company scope cannot survive even if a future write path omits the
-- normalization trigger.
alter table public.safety_program_import_candidates
  add constraint safety_program_import_candidates_company_scope_check
  check (
    access_scope = 'safety_admin_private'
    or (
      access_scope = 'company'
      and classification = 'internal'
      and candidate_kind in (
        'form_template',
        'program_document',
        'training_material',
        'reference'
      )
    )
  );

-- Authenticated reviewers must use this narrow RPC. It updates only the two
-- review fields, takes a row lock, applies role checks under the caller JWT,
-- and refuses to manufacture service-owned imported/superseded transitions.
create or replace function public.update_safety_program_import_candidate_review(
  target_candidate_id uuid,
  target_access_scope text,
  target_review_status text
)
returns table (
  candidate_id uuid,
  access_scope text,
  review_status text
)
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  candidate_record public.safety_program_import_candidates%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to review an import candidate'
      using errcode = '42501';
  end if;

  if target_access_scope is null
     or target_access_scope not in ('company', 'safety_admin_private') then
    raise exception 'Candidate access scope must be company or safety_admin_private'
      using errcode = '22023';
  end if;

  if target_review_status is null
     or target_review_status not in (
       'pending_review', 'needs_information', 'approved', 'rejected',
       'duplicate', 'imported', 'superseded'
     ) then
    raise exception 'Unsupported import-candidate review status'
      using errcode = '22023';
  end if;

  select candidate.*
  into candidate_record
  from public.safety_program_import_candidates candidate
  where candidate.id = target_candidate_id
    and private.can_manage_company(candidate.company_id)
  for update;

  if not found then
    raise exception 'Import candidate is unavailable to this reviewer'
      using errcode = '42501';
  end if;

  if target_access_scope = 'company'
     and not program_private.import_candidate_company_scope_allowed(
       candidate_record.candidate_kind,
       candidate_record.classification
     ) then
    raise exception 'Only reusable internal material may be company-visible'
      using errcode = '23514';
  end if;

  if target_review_status in ('imported', 'superseded')
     and target_review_status is distinct from candidate_record.review_status then
    raise exception 'Imported and superseded transitions are service-owned'
      using errcode = '42501';
  end if;

  if target_access_scope is not distinct from candidate_record.access_scope
     and target_review_status is not distinct from candidate_record.review_status then
    return query values (
      candidate_record.id,
      candidate_record.access_scope,
      candidate_record.review_status
    );
    return;
  end if;

  update public.safety_program_import_candidates candidate
  set access_scope = target_access_scope,
      review_status = target_review_status
  where candidate.id = candidate_record.id
  returning candidate.* into candidate_record;

  return query values (
    candidate_record.id,
    candidate_record.access_scope,
    candidate_record.review_status
  );
end;
$$;

-- Signing remains a two-stage process: the caller-scoped metadata RPC decides
-- authorization without returning a locator; only service_role can resolve the
-- exact committed object after that decision.
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
    and candidate.content_sha256 = ingest_item.expected_sha256
    and candidate.content_sha256 = storage_object.content_sha256
    and candidate.size_bytes = ingest_item.expected_size_bytes
    and candidate.size_bytes = storage_object.size_bytes
    and candidate.mime_type = ingest_item.expected_mime_type
    and candidate.mime_type = storage_object.mime_type
    and candidate.source_path_sha256 = ingest_item.source_path_sha256
    and private.is_company_member(candidate.company_id)
    and (
      candidate.access_scope = 'company'
      or (
        candidate.access_scope = 'safety_admin_private'
        and private.can_manage_company(candidate.company_id)
      )
    )
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
    and candidate.content_sha256 = ingest_item.expected_sha256
    and candidate.content_sha256 = storage_object.content_sha256
    and candidate.size_bytes = ingest_item.expected_size_bytes
    and candidate.size_bytes = storage_object.size_bytes
    and candidate.mime_type = ingest_item.expected_mime_type
    and candidate.mime_type = storage_object.mime_type
    and candidate.source_path_sha256 = ingest_item.source_path_sha256
  limit 1;
end;
$$;

-- Re-check current scope, membership, review state, and exact committed bytes
-- when the service appends an allowed event. This closes races between the
-- caller metadata decision and signed-URL issuance.
create or replace function program_private.guard_candidate_file_access_event()
returns trigger
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Candidate file access events are append-only'
      using errcode = '55000';
  end if;

  if auth.role() is distinct from 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Only the signing service may append candidate access events'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from program_private.safety_program_drive_ingest_items ingest_item
    join program_private.safety_program_drive_ingest_runs ingest_run
      on ingest_run.id = ingest_item.run_id
     and ingest_run.company_id = ingest_item.company_id
    where ingest_item.company_id = new.company_id
      and ingest_item.committed_candidate_id = new.candidate_id
      and ingest_item.committed_storage_object_id = new.storage_object_id
      and ingest_item.status = 'committed'
      and ingest_run.status = 'committed'
      and not exists (
        select 1
        from program_private.safety_program_drive_ingest_run_invalidations invalidation
        where invalidation.company_id = ingest_run.company_id
          and invalidation.run_id = ingest_run.id
      )
  ) then
    raise exception 'Candidate and storage object do not match an active committed ingest item'
      using errcode = '23514';
  end if;

  if new.decision = 'allowed'
     and not exists (
       select 1
       from public.safety_program_import_candidates candidate
       join public.company_memberships membership
         on membership.company_id = candidate.company_id
        and membership.user_id = new.actor_user_id
        and membership.active
       join program_private.safety_program_drive_ingest_items ingest_item
         on ingest_item.company_id = candidate.company_id
        and ingest_item.committed_candidate_id = candidate.id
        and ingest_item.committed_storage_object_id = new.storage_object_id
        and ingest_item.status = 'committed'
       join program_private.safety_program_drive_ingest_runs ingest_run
         on ingest_run.company_id = ingest_item.company_id
        and ingest_run.id = ingest_item.run_id
        and ingest_run.status = 'committed'
       join public.safety_program_storage_objects storage_object
         on storage_object.company_id = candidate.company_id
        and storage_object.id = new.storage_object_id
       where candidate.company_id = new.company_id
         and candidate.id = new.candidate_id
         and candidate.review_status in (
           'pending_review', 'needs_information', 'approved', 'imported'
         )
         and storage_object.malware_scan_status = 'clean'
         and storage_object.verified_at is not null
         and candidate.content_sha256 = ingest_item.expected_sha256
         and candidate.content_sha256 = storage_object.content_sha256
         and candidate.size_bytes = ingest_item.expected_size_bytes
         and candidate.size_bytes = storage_object.size_bytes
         and candidate.mime_type = ingest_item.expected_mime_type
         and candidate.mime_type = storage_object.mime_type
         and candidate.source_path_sha256 = ingest_item.source_path_sha256
         and not exists (
           select 1
           from program_private.safety_program_drive_ingest_run_invalidations invalidation
           where invalidation.company_id = ingest_run.company_id
             and invalidation.run_id = ingest_run.id
         )
         and (
           candidate.access_scope = 'company'
           or (
             candidate.access_scope = 'safety_admin_private'
             and membership.role in ('corporate_admin', 'safety_manager')
           )
         )
     ) then
    raise exception 'The active company member is not authorized for this candidate scope'
      using errcode = '42501';
  end if;

  if program_private.jsonb_has_forbidden_access_key(new.request_context) then
    raise exception 'Access-event context cannot store a credential or object locator'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Company members can list only active company-scoped review projections.
-- Safety administrators retain full review visibility. No user receives raw
-- paths because this table does not contain Storage locators.
drop policy if exists safety_program_import_candidates_manager_select
  on public.safety_program_import_candidates;
drop policy if exists safety_program_import_candidates_manager_update
  on public.safety_program_import_candidates;

create policy safety_program_import_candidates_scope_select
on public.safety_program_import_candidates
for select to authenticated
using (
  private.can_manage_company(company_id)
  or (
    access_scope = 'company'
    and review_status in (
      'pending_review', 'needs_information', 'approved', 'imported'
    )
    and private.is_company_member(company_id)
  )
);

create policy safety_program_import_candidates_manager_update
on public.safety_program_import_candidates
for update to authenticated
using (private.can_manage_company(company_id))
with check (
  private.can_manage_company(company_id)
  and (
    access_scope = 'safety_admin_private'
    or (
      access_scope = 'company'
      and classification = 'internal'
      and candidate_kind in (
        'form_template',
        'program_document',
        'training_material',
        'reference'
      )
    )
  )
);

alter table public.safety_program_import_candidate_review_events
  enable row level security;

create policy safety_program_import_candidate_review_events_manager_select
on public.safety_program_import_candidate_review_events
for select to authenticated
using (private.can_manage_company(company_id));

revoke all on table
  public.safety_program_import_candidates,
  public.safety_program_import_candidate_review_events
from public, anon, authenticated, service_role;

grant select on table
  public.safety_program_import_candidates,
  public.safety_program_import_candidate_review_events
to authenticated;

revoke all on function
  program_private.import_candidate_company_scope_allowed(text, text),
  program_private.normalize_import_candidate_access_scope(),
  program_private.capture_import_candidate_review_event(),
  program_private.guard_import_candidate(),
  program_private.guard_candidate_file_access_event()
from public, anon, authenticated, service_role;

revoke all on function
  public.update_safety_program_import_candidate_review(uuid, text, text),
  public.get_safety_program_import_candidate_file_metadata(uuid),
  public.get_safety_program_import_candidate_storage_locator(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.update_safety_program_import_candidate_review(uuid, text, text),
  public.get_safety_program_import_candidate_file_metadata(uuid)
to authenticated;

grant execute on function
  public.get_safety_program_import_candidate_storage_locator(uuid)
to service_role;

comment on column public.safety_program_import_candidates.access_scope is
  'Company scope permits active tenant members; safety_admin_private permits corporate administrators and safety managers only.';
comment on table public.safety_program_import_candidate_review_events is
  'Append-only readable access-scope/review-status decisions, also captured in the tenant hash-chained safety-program audit ledger.';
comment on table public.safety_program_import_candidates is
  'Access-scoped Drive archive review projection; intentionally omits raw paths, provider IDs, bucket names, and object locators.';
comment on function public.update_safety_program_import_candidate_review(uuid, text, text) is
  'Manager-only candidate review RPC; changes only access scope and review status, with fail-closed reusable-material enforcement.';
comment on function public.get_safety_program_import_candidate_file_metadata(uuid) is
  'Caller-authorized exact-byte metadata for active company or safety-admin-private candidates; never returns bucket/object paths.';
comment on function public.get_safety_program_import_candidate_storage_locator(uuid) is
  'Service-only exact-byte locator for an active candidate backed by a non-invalidated committed ingest run.';
