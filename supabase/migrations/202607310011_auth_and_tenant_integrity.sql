-- Invite-only authentication and first-tenant integrity hardening.
--
-- This migration removes the obsolete onboarding overload, prevents a user
-- from holding two active tenant memberships, protects the final corporate
-- administrator, fixes the location-profile supersession column name, and
-- provides one service-role-only transaction for an invited first owner.

begin;

-- Company creation is an administrator-controlled provisioning operation.
-- Neither historical browser-callable overload may survive in a real
-- invite-only deployment: the two-argument overload skips regulatory setup,
-- while the four-argument overload lets any authenticated, tenantless account
-- create a company without an administrator reviewing the request.
revoke all on function public.create_company_with_owner(text, text)
from public, anon, authenticated;
drop function public.create_company_with_owner(text, text);

revoke all on function public.create_company_with_owner(text, text, text, text)
from public, anon, authenticated;
drop function public.create_company_with_owner(text, text, text, text);

-- Fail with an actionable message before adding validated invariants to any
-- environment that already contains incompatible records. A fresh SafetyOps
-- project has no tenant records, but an operator must never get a partial or
-- ambiguous upgrade on an reused database.
do $$
begin
  if exists (
    select 1
    from public.company_memberships
    where active
    group by user_id
    having count(*) > 1
  ) then
    raise exception
      'Migration 011 requires at most one active company membership per user; resolve duplicates before retrying';
  end if;

  if exists (
    select 1
    from public.locations
    where timezone not in ('America/Los_Angeles', 'America/Boise')
  ) then
    raise exception
      'Migration 011 supports America/Los_Angeles and America/Boise for OR/WA/CA; correct existing location timezones before retrying';
  end if;

  if exists (
    select 1
    from public.locations location_record
    join lateral (
      select profile.state_code
      from public.location_regulatory_profiles profile
      where profile.company_id = location_record.company_id
        and profile.location_id = location_record.id
      order by profile.version desc
      limit 1
    ) latest_profile on true
    where latest_profile.state_code in ('WA', 'CA')
      and location_record.timezone <> 'America/Los_Angeles'
  ) then
    raise exception
      'Migration 011 found a WA/CA location outside America/Los_Angeles; correct state/timezone evidence before retrying';
  end if;

  if exists (
    select 1
    from public.location_jurisdiction_assignments assignment
    where assignment.reviewed_by is not null
       or assignment.reviewed_at is not null
  ) or exists (
    select 1
    from public.location_regulatory_profiles profile
    where profile.status in ('approved', 'superseded')
       or profile.reviewed_by is not null
       or profile.reviewed_at is not null
  ) then
    raise exception
      'Migration 011 cannot attest pre-authoritative regulatory reviews; complete a reviewed legacy-evidence remediation before retrying';
  end if;
end;
$$;

-- The browser loads one active company. Make that product invariant explicit
-- in PostgreSQL so a second active membership cannot be hidden by query order.
create unique index company_memberships_one_active_company_per_user
on public.company_memberships(user_id)
where active;

alter table public.locations
  add constraint locations_supported_timezone
  check (timezone in ('America/Los_Angeles', 'America/Boise'));

-- A service-controlled first-tenant bootstrap has no human actor inside the
-- new tenant. NULL is intentionally more truthful than attributing those
-- records to the invited owner before that person has accepted or acted.
alter table public.companies alter column created_by drop not null;
alter table public.locations alter column created_by drop not null;
alter table public.location_regulatory_profiles
  alter column prepared_by drop not null;

comment on column public.companies.created_by is
'Human creator when user-authored; NULL for an administrator-controlled system bootstrap, whose provenance is recorded in audit_events.';
comment on column public.locations.created_by is
'Human creator when user-authored; NULL for an administrator-controlled system bootstrap, whose provenance is recorded in audit_events.';
comment on column public.location_regulatory_profiles.prepared_by is
'Human preparer when user-authored; NULL for an unreviewed system-generated onboarding draft.';

-- Location creation must use the state-aware RPCs that also create a draft
-- regulatory profile and review-required jurisdiction assignment.
revoke insert on public.locations from authenticated;

create or replace function private.protect_company_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.id <> old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Company identity and creation provenance are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.protect_location_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.id <> old.id
     or new.company_id <> old.company_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Location identity and creation provenance are immutable'
      using errcode = '23514';
  end if;
  if new.timezone is distinct from old.timezone then
    raise exception
      'Location timezone changes require a state-aware reprofiling workflow'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.write_tenant_configuration_audit()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_company_id uuid := case
    when tg_table_name = 'companies' then new.id else new.company_id
  end;
  target_location_id uuid := case
    when tg_table_name = 'locations' then new.id else null
  end;
begin
  insert into public.audit_events (
    company_id,
    location_id,
    actor_user_id,
    entity_type,
    entity_id,
    action,
    details
  ) values (
    target_company_id,
    target_location_id,
    auth.uid(),
    tg_table_name,
    new.id,
    tg_table_name || '_configuration_updated',
    jsonb_build_object(
      'before', to_jsonb(old) - 'updated_at',
      'after', to_jsonb(new) - 'updated_at',
      'actor_auth_role', coalesce(auth.role(), 'database_administrator')
    )
  );
  return new;
end;
$$;

drop trigger if exists companies_provenance_guard on public.companies;
create trigger companies_provenance_guard
before update on public.companies
for each row execute function private.protect_company_provenance();

drop trigger if exists locations_provenance_guard on public.locations;
create trigger locations_provenance_guard
before update on public.locations
for each row execute function private.protect_location_provenance();

drop trigger if exists companies_configuration_audit on public.companies;
create trigger companies_configuration_audit
after update on public.companies
for each row execute function private.write_tenant_configuration_audit();

drop trigger if exists locations_configuration_audit on public.locations;
create trigger locations_configuration_audit
after update on public.locations
for each row execute function private.write_tenant_configuration_audit();

create or replace function private.protect_company_membership_integrity()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_company_id uuid := case
    when tg_op = 'INSERT' then new.company_id else old.company_id
  end;
  removes_corporate_admin boolean;
begin
  if tg_op = 'INSERT' then
    -- For human-authored membership grants, PostgreSQL records the real actor.
    -- A service bootstrap has no user subject and therefore records NULL.
    new.invited_by := auth.uid();
    return new;
  end if;

  if tg_op = 'DELETE' and not exists (
    select 1 from public.companies company_record
    where company_record.id = old.company_id
  ) then
    -- Permit an administrator-controlled parent-company teardown. Ordinary
    -- users have no company DELETE policy, while direct membership removal
    -- still passes through the last-admin rule below.
    return old;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_company_id::text, 0));

  if tg_op = 'UPDATE'
     and (
       new.company_id <> old.company_id
       or new.user_id <> old.user_id
       or new.invited_by is distinct from old.invited_by
       or new.created_at is distinct from old.created_at
     ) then
    raise exception 'Company membership identity and invitation provenance are immutable'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    removes_corporate_admin := old.active
      and old.role = 'corporate_admin';
  else
    removes_corporate_admin := old.active
      and old.role = 'corporate_admin'
      and (not new.active or new.role <> 'corporate_admin');
  end if;

  if removes_corporate_admin and not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = target_company_id
      and membership.user_id <> old.user_id
      and membership.active
      and membership.role = 'corporate_admin'
  ) then
    raise exception 'A company must retain at least one active corporate administrator'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function private.write_company_membership_audit()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_company_id uuid := case
    when tg_op = 'DELETE' then old.company_id else new.company_id
  end;
  target_user_id uuid := case
    when tg_op = 'DELETE' then old.user_id else new.user_id
  end;
  prior_record jsonb := case
    when tg_op in ('UPDATE', 'DELETE') then jsonb_build_object(
      'role', old.role,
      'active', old.active,
      'default_location_id', old.default_location_id,
      'invited_by', old.invited_by,
      'created_at', old.created_at
    )
    else null
  end;
  current_record jsonb := case
    when tg_op in ('INSERT', 'UPDATE') then jsonb_build_object(
      'role', new.role,
      'active', new.active,
      'default_location_id', new.default_location_id,
      'invited_by', new.invited_by,
      'created_at', new.created_at
    )
    else null
  end;
  audit_action text;
begin
  if not exists (
    select 1 from public.companies company_record
    where company_record.id = target_company_id
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  audit_action := case
    when tg_op = 'INSERT' then 'membership_created'
    when tg_op = 'DELETE' then 'membership_deleted'
    when old.role is distinct from new.role then 'membership_role_changed'
    when old.active is distinct from new.active then 'membership_access_changed'
    when old.default_location_id is distinct from new.default_location_id
      then 'membership_default_location_changed'
    else 'membership_updated'
  end;

  insert into public.audit_events (
    company_id,
    actor_user_id,
    entity_type,
    entity_id,
    action,
    details
  ) values (
    target_company_id,
    auth.uid(),
    'company_membership',
    target_user_id,
    audit_action,
    jsonb_build_object(
      'subject_user_id', target_user_id,
      'before', prior_record,
      'after', current_record,
      'actor_auth_role', coalesce(auth.role(), 'database_administrator')
    )
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists company_memberships_integrity
on public.company_memberships;
create trigger company_memberships_integrity
before insert or update or delete on public.company_memberships
for each row execute function private.protect_company_membership_integrity();

drop trigger if exists company_memberships_audit
on public.company_memberships;
create trigger company_memberships_audit
after insert or update or delete on public.company_memberships
for each row execute function private.write_company_membership_audit();

-- Migration 002 used valid_to for this table even though the column is named
-- effective_to. Replacing the function makes approved-profile supersession
-- executable while keeping every other immutable-content rule intact.
create or replace function regulatory_private.protect_location_profile()
returns trigger
language plpgsql
security definer
set search_path = public, regulatory_private, pg_temp
as $$
declare
  location_timezone text;
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'superseded') then
      raise exception 'Approved location regulatory profiles are immutable';
    end if;
    return old;
  end if;

  select location_record.timezone
  into location_timezone
  from public.locations location_record
  where location_record.company_id = new.company_id
    and location_record.id = new.location_id;

  if location_timezone is null then
    raise exception 'An existing tenant location is required for a regulatory profile'
      using errcode = '23503';
  end if;
  if new.state_code not in ('OR', 'WA', 'CA') then
    raise exception 'Regulatory profile state must be OR, WA, or CA'
      using errcode = '23514';
  end if;
  if new.state_code in ('WA', 'CA')
     and location_timezone <> 'America/Los_Angeles' then
    raise exception 'WA and CA regulatory profiles require America/Los_Angeles'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and (
    new.id <> old.id
    or new.company_id <> old.company_id
    or new.location_id <> old.location_id
    or new.version <> old.version
    or new.state_code <> old.state_code
    or (
      old.prepared_by is not null
      and new.prepared_by is distinct from old.prepared_by
    )
  ) then
    raise exception 'Regulatory profile identity and human preparer are immutable'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and old.prepared_by is null
     and auth.uid() is not null
     and (
       to_jsonb(new) - array[
         'status', 'reviewed_by', 'reviewed_at', 'updated_at'
       ]
     ) is distinct from (
       to_jsonb(old) - array[
         'status', 'reviewed_by', 'reviewed_at', 'updated_at'
       ]
     ) then
    -- Editing a system draft is a human preparation act. Bind that act to the
    -- authenticated editor so the same person cannot later self-approve it.
    new.prepared_by := auth.uid();
  end if;

  if tg_op = 'UPDATE' and old.status = 'superseded' then
    raise exception 'Superseded location regulatory profiles are immutable';
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status <> 'superseded' then
      raise exception 'An approved location profile may only advance to superseded';
    end if;
    if new.effective_to is null then
      raise exception 'A superseded location profile requires effective_to';
    end if;
    if (
      to_jsonb(new) - array['status', 'effective_to', 'updated_at']
    ) is distinct from (
      to_jsonb(old) - array['status', 'effective_to', 'updated_at']
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
    if new.employer_type = 'other'
       or not (new.operation_facts @> jsonb_build_object(
         'employer_type_confirmed', true,
         'industry_and_naics_confirmed', true,
         'retained_federal_jurisdiction_reviewed', true
       ))
       or coalesce(new.hazard_facts ->> 'review_required', 'true') <> 'false'
       or coalesce(new.workforce_facts ->> 'review_required', 'true') <> 'false' then
      raise exception
        'Employer, industry, federal-jurisdiction, hazard, and workforce facts must be prepared before profile approval';
    end if;
    if not exists (
      select 1
      from public.location_jurisdiction_assignments assignment
      where assignment.company_id = new.company_id
        and assignment.location_id = new.location_id
        and assignment.profile_id = new.id
        and assignment.coverage_status in ('applies', 'partial')
        and assignment.reviewed_by is not null
        and assignment.reviewed_at is not null
    ) then
      raise exception
        'At least one applicable jurisdiction must be authoritatively reviewed before profile approval';
    end if;
    if exists (
      select 1
      from public.location_jurisdiction_assignments assignment
      where assignment.company_id = new.company_id
        and assignment.location_id = new.location_id
        and assignment.profile_id = new.id
        and (
          assignment.coverage_status = 'requires_review'
          or assignment.reviewed_by is null
          or assignment.reviewed_at is null
        )
    ) then
      raise exception
        'Every jurisdiction assignment must be authoritatively reviewed before profile approval';
    end if;
    if new.prepared_by is not null and exists (
      select 1
      from public.location_jurisdiction_assignments assignment
      where assignment.company_id = new.company_id
        and assignment.location_id = new.location_id
        and assignment.profile_id = new.id
        and assignment.reviewed_by = new.prepared_by
    ) then
      raise exception
        'A human profile preparer may not also review its jurisdiction assignments';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  elsif new.status in ('draft', 'in_review') then
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;

  return new;
end;
$$;

-- Browser-supplied reviewer UUIDs and timestamps are not evidence. This
-- replacement derives both values from the authenticated database context,
-- requires a safety-management role, and enforces separation from a human
-- profile preparer. System-generated drafts have prepared_by NULL and may be
-- reviewed by the first corporate administrator.
create or replace function regulatory_private.protect_profile_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, private, regulatory_private, pg_temp
as $$
declare
  target_profile_id uuid := case
    when tg_op = 'DELETE' then old.profile_id else new.profile_id
  end;
  profile_record public.location_regulatory_profiles;
begin
  select profile.*
  into profile_record
  from public.location_regulatory_profiles profile
  where profile.id = target_profile_id
  for update;

  if profile_record.status in ('approved', 'superseded') then
    raise exception 'Jurisdiction assignments for approved profiles are immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'UPDATE' and (
    new.company_id <> old.company_id
    or new.location_id <> old.location_id
    or new.profile_id <> old.profile_id
    or new.jurisdiction_id <> old.jurisdiction_id
  ) then
    raise exception 'Jurisdiction assignment identity is immutable'
      using errcode = '23514';
  end if;

  if new.coverage_status = 'requires_review' then
    new.reviewed_by := null;
    new.reviewed_at := null;
    return new;
  end if;

  if auth.uid() is null
     or not private.can_manage_company(new.company_id) then
    raise exception 'Company safety-management permission required for jurisdiction review'
      using errcode = '42501';
  end if;
  if profile_record.prepared_by = auth.uid() then
    raise exception 'A human profile preparer may not review its jurisdiction assignments'
      using errcode = '23514';
  end if;

  new.reviewed_by := auth.uid();
  new.reviewed_at := now();
  return new;
end;
$$;

create or replace function regulatory_private.profile_has_resolved_jurisdiction(
  target_company_id uuid,
  target_location_id uuid,
  target_profile_id uuid,
  target_date date
)
returns boolean
language sql
stable
security definer
set search_path = public, regulatory_private, pg_temp
as $$
  select
    exists (
      select 1
      from public.location_jurisdiction_assignments assignment
      where assignment.company_id = target_company_id
        and assignment.location_id = target_location_id
        and assignment.profile_id = target_profile_id
        and assignment.coverage_status in ('applies', 'partial')
        and assignment.reviewed_by is not null
        and assignment.reviewed_at is not null
        and (assignment.valid_from is null or assignment.valid_from <= target_date)
        and (assignment.valid_to is null or assignment.valid_to >= target_date)
    )
    and not exists (
      select 1
      from public.location_jurisdiction_assignments assignment
      where assignment.company_id = target_company_id
        and assignment.location_id = target_location_id
        and assignment.profile_id = target_profile_id
        and (assignment.valid_from is null or assignment.valid_from <= target_date)
        and (assignment.valid_to is null or assignment.valid_to >= target_date)
        and (
          assignment.coverage_status = 'requires_review'
          or assignment.reviewed_by is null
          or assignment.reviewed_at is null
        )
    );
$$;

create or replace function program_private.require_current_program_applicability(
  target_company_id uuid,
  target_program_version_id uuid,
  target_location_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, program_private, regulatory_private, pg_temp
as $$
declare
  location_date date;
begin
  select timezone(location_record.timezone, statement_timestamp())::date
  into location_date
  from public.locations location_record
  where location_record.id = target_location_id
    and location_record.company_id = target_company_id
    and location_record.active;

  if location_date is null then
    raise exception 'an active tenant location is required'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.safety_program_versions program_version
    join public.safety_program_location_applicability applicability
      on applicability.program_version_id = program_version.id
     and applicability.company_id = program_version.company_id
     and applicability.location_id = target_location_id
    join public.location_regulatory_profiles profile_record
      on profile_record.company_id = applicability.company_id
     and profile_record.location_id = applicability.location_id
     and profile_record.id = applicability.regulatory_profile_id
    where program_version.id = target_program_version_id
      and program_version.company_id = target_company_id
      and program_version.status = 'published'
      and (program_version.effective_from is null or program_version.effective_from <= location_date)
      and (program_version.effective_to is null or program_version.effective_to >= location_date)
      and applicability.review_status = 'reviewed'
      and applicability.applicability_status in ('applies', 'conditional')
      and (applicability.effective_from is null or applicability.effective_from <= location_date)
      and (applicability.effective_to is null or applicability.effective_to >= location_date)
      and profile_record.status = 'approved'
      and profile_record.reviewed_by is not null
      and profile_record.reviewed_at is not null
      and (profile_record.effective_from is null or profile_record.effective_from <= location_date)
      and (profile_record.effective_to is null or profile_record.effective_to >= location_date)
      and regulatory_private.profile_has_resolved_jurisdiction(
        target_company_id,
        target_location_id,
        profile_record.id,
        location_date
      )
  ) then
    raise exception
      'program applicability, regulatory profile, and jurisdiction are not reviewed and effective at this location'
      using errcode = '23514';
  end if;
end;
$$;

-- Reinstall the state-aware location RPC in this migration as well as the
-- clean-history source migration. This makes an upgrade safe when migration
-- 008 was already recorded with the former Denver value.
create or replace function public.create_company_location(
  target_company_id uuid,
  location_name text,
  location_code text,
  state_code text,
  location_address text default null,
  location_timezone text default 'America/Los_Angeles'
)
returns uuid
language plpgsql
security definer
set search_path = public, private, regulatory_private, pg_temp
as $$
declare
  normalized_name text := trim(location_name);
  normalized_code text := upper(
    regexp_replace(trim(location_code), '[^A-Za-z0-9]+', '-', 'g')
  );
  normalized_state_code text := upper(trim(state_code));
  normalized_address text := nullif(trim(location_address), '');
  normalized_timezone text := trim(location_timezone);
  state_jurisdiction_code text;
  state_jurisdiction_id uuid;
  state_jurisdiction_name text;
  new_location_id uuid;
  new_profile_id uuid;
  new_assignment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;
  if target_company_id is null
     or not private.can_manage_company(target_company_id) then
    raise exception 'Company safety-administrator access is required'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(target_company_id::text || ':' || normalized_code, 0)
  );

  if normalized_name is null
     or char_length(normalized_name) < 2
     or char_length(normalized_name) > 160 then
    raise exception 'Location name must be between 2 and 160 characters'
      using errcode = '22023';
  end if;
  if normalized_code is null
     or char_length(normalized_code) < 2
     or char_length(normalized_code) > 32
     or normalized_code !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' then
    raise exception
      'Location code must be 2-32 letters, numbers, or hyphen-separated words'
      using errcode = '22023';
  end if;
  if normalized_state_code not in ('OR', 'WA', 'CA') then
    raise exception 'Location state code must be OR, WA, or CA'
      using errcode = '22023';
  end if;
  if normalized_timezone not in (
    'America/Los_Angeles',
    'America/Boise'
  ) then
    raise exception 'Location timezone is not supported'
      using errcode = '22023';
  end if;
  if normalized_state_code in ('WA', 'CA')
     and normalized_timezone <> 'America/Los_Angeles' then
    raise exception 'Location timezone is inconsistent with state %',
      normalized_state_code
      using errcode = '22023';
  end if;

  state_jurisdiction_code := 'US-' || normalized_state_code;
  select jurisdiction.id, jurisdiction.name
  into state_jurisdiction_id, state_jurisdiction_name
  from public.regulatory_jurisdictions jurisdiction
  where jurisdiction.code = state_jurisdiction_code
    and jurisdiction.active;

  if state_jurisdiction_id is null then
    raise exception 'Active state-plan jurisdiction is not configured for %',
      normalized_state_code
      using errcode = '55000';
  end if;

  insert into public.locations (
    company_id,
    name,
    code,
    address,
    timezone,
    created_by
  ) values (
    target_company_id,
    normalized_name,
    normalized_code,
    normalized_address,
    normalized_timezone,
    auth.uid()
  ) returning id into new_location_id;

  insert into public.location_memberships (
    company_id,
    location_id,
    user_id
  ) values (
    target_company_id,
    new_location_id,
    auth.uid()
  );

  insert into public.location_regulatory_profiles (
    company_id,
    location_id,
    version,
    state_code,
    employer_type,
    operation_facts,
    hazard_facts,
    workforce_facts,
    status,
    prepared_by
  ) values (
    target_company_id,
    new_location_id,
    1,
    normalized_state_code,
    'other',
    jsonb_build_object(
      'onboarding_source', 'user_submitted_state_code',
      'human_applicability_review_required', true,
      'employer_type_confirmed', false,
      'industry_and_naics_confirmed', false,
      'retained_federal_jurisdiction_reviewed', false
    ),
    jsonb_build_object('review_required', true),
    jsonb_build_object('review_required', true),
    'draft',
    auth.uid()
  ) returning id into new_profile_id;

  insert into public.location_jurisdiction_assignments (
    company_id,
    location_id,
    profile_id,
    jurisdiction_id,
    coverage_status,
    coverage_rationale,
    carve_outs
  ) values (
    target_company_id,
    new_location_id,
    new_profile_id,
    state_jurisdiction_id,
    'requires_review',
    format(
      'Candidate %s assignment based only on submitted state code %s. Human review of employer type, industry, work activities, and retained federal jurisdiction is required.',
      state_jurisdiction_name,
      normalized_state_code
    ),
    '[]'::jsonb
  ) returning id into new_assignment_id;

  insert into public.audit_events (
    company_id,
    location_id,
    actor_user_id,
    entity_type,
    entity_id,
    action,
    details
  ) values (
    target_company_id,
    new_location_id,
    auth.uid(),
    'location',
    new_location_id,
    'created',
    jsonb_build_object(
      'location_state_code', normalized_state_code,
      'location_timezone', normalized_timezone,
      'regulatory_profile_id', new_profile_id,
      'jurisdiction_assignment_id', new_assignment_id,
      'jurisdiction_code', state_jurisdiction_code,
      'jurisdiction_review_required', true,
      'onboarding_version', 2
    )
  );

  return new_location_id;
end;
$$;

-- This function is called only with a service-role JWT after Auth has created
-- the invited owner. It provisions the company and all initial locations in a
-- single transaction. Tenant names and addresses are supplied at runtime and
-- never stored in the public repository.
create or replace function public.bootstrap_invited_company_owner(
  target_owner_user_id uuid,
  company_name text,
  company_slug text,
  initial_locations jsonb,
  provisioning_reference uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, regulatory_private, auth, pg_temp
as $$
declare
  normalized_company_name text := trim(company_name);
  normalized_company_slug text := lower(trim(company_slug));
  location_record jsonb;
  normalized_location_name text;
  normalized_location_code text;
  normalized_state_code text;
  normalized_address text;
  normalized_timezone text;
  state_jurisdiction_id uuid;
  state_jurisdiction_name text;
  new_company_id uuid;
  new_location_id uuid;
  new_profile_id uuid;
  first_location_id uuid;
  location_ids jsonb := '[]'::jsonb;
  location_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service-role authorization required'
      using errcode = '42501';
  end if;
  if target_owner_user_id is null or not exists (
    select 1
    from auth.users user_record
    where user_record.id = target_owner_user_id
      and user_record.email is not null
      and (
        user_record.invited_at is not null
        or user_record.email_confirmed_at is not null
      )
  ) then
    raise exception 'The administrator-created or invited Auth user is unavailable'
      using errcode = '23503';
  end if;
  if provisioning_reference is null then
    raise exception 'A provisioning correlation reference is required'
      using errcode = '22023';
  end if;
  if normalized_company_name is null
     or char_length(normalized_company_name) < 2
     or char_length(normalized_company_name) > 160 then
    raise exception 'Company name must be between 2 and 160 characters'
      using errcode = '22023';
  end if;
  if normalized_company_slug is null
     or char_length(normalized_company_slug) < 2
     or char_length(normalized_company_slug) > 63
     or normalized_company_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Company slug is invalid'
      using errcode = '22023';
  end if;
  if initial_locations is null
     or jsonb_typeof(initial_locations) is distinct from 'array' then
    raise exception 'Initial locations must be a JSON array containing 1 to 100 records'
      using errcode = '22023';
  end if;
  if jsonb_array_length(initial_locations) not between 1 and 100 then
    raise exception 'Initial locations must be a JSON array containing 1 to 100 records'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_owner_user_id::text, 0));
  if exists (
    select 1 from public.company_memberships membership
    where membership.user_id = target_owner_user_id and membership.active
  ) then
    raise exception 'The invited owner already belongs to an active company'
      using errcode = '23505';
  end if;

  insert into public.profiles (id, full_name)
  select
    user_record.id,
    coalesce(user_record.raw_user_meta_data ->> 'full_name', '')
  from auth.users user_record
  where user_record.id = target_owner_user_id
  on conflict (id) do update
  set full_name = case
    when public.profiles.full_name = '' then excluded.full_name
    else public.profiles.full_name
  end;

  insert into public.companies (name, slug, created_by)
  values (normalized_company_name, normalized_company_slug, null)
  returning id into new_company_id;

  for location_record in
    select value from jsonb_array_elements(initial_locations)
  loop
    location_count := location_count + 1;
    if jsonb_typeof(location_record) is distinct from 'object' then
      raise exception 'Location % must be a JSON object', location_count
        using errcode = '22023';
    end if;
    normalized_location_name := trim(location_record ->> 'name');
    normalized_location_code := upper(regexp_replace(
      trim(location_record ->> 'code'), '[^A-Za-z0-9]+', '-', 'g'
    ));
    normalized_state_code := upper(trim(location_record ->> 'stateCode'));
    normalized_address := nullif(trim(location_record ->> 'address'), '');
    normalized_timezone := coalesce(
      nullif(trim(location_record ->> 'timezone'), ''),
      'America/Los_Angeles'
    );

    if normalized_location_name is null
       or char_length(normalized_location_name) < 2
       or char_length(normalized_location_name) > 160 then
      raise exception 'Location % has an invalid name', location_count
        using errcode = '22023';
    end if;
    if normalized_location_code is null
       or char_length(normalized_location_code) < 2
       or char_length(normalized_location_code) > 32
       or normalized_location_code !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' then
      raise exception 'Location % has an invalid code', location_count
        using errcode = '22023';
    end if;
    if normalized_state_code not in ('OR', 'WA', 'CA') then
      raise exception 'Location % state must be OR, WA, or CA', location_count
        using errcode = '22023';
    end if;
    if normalized_timezone not in ('America/Los_Angeles', 'America/Boise') then
      raise exception 'Location % timezone is unsupported', location_count
        using errcode = '22023';
    end if;
    if normalized_state_code in ('WA', 'CA')
       and normalized_timezone <> 'America/Los_Angeles' then
      raise exception 'Location % timezone is inconsistent with state %',
        location_count, normalized_state_code
        using errcode = '22023';
    end if;

    select jurisdiction.id, jurisdiction.name
    into state_jurisdiction_id, state_jurisdiction_name
    from public.regulatory_jurisdictions jurisdiction
    where jurisdiction.code = 'US-' || normalized_state_code
      and jurisdiction.active;
    if state_jurisdiction_id is null then
      raise exception 'The state jurisdiction for location % is unavailable', location_count
        using errcode = '55000';
    end if;

    insert into public.locations (
      company_id, name, code, address, timezone, created_by
    ) values (
      new_company_id,
      normalized_location_name,
      normalized_location_code,
      normalized_address,
      normalized_timezone,
      null
    ) returning id into new_location_id;

    if first_location_id is null then
      first_location_id := new_location_id;
      insert into public.company_memberships (
        company_id, user_id, role, default_location_id, invited_by
      ) values (
        new_company_id,
        target_owner_user_id,
        'corporate_admin',
        first_location_id,
        null
      );
    end if;

    insert into public.location_memberships (
      company_id, location_id, user_id
    ) values (
      new_company_id, new_location_id, target_owner_user_id
    );

    insert into public.location_regulatory_profiles (
      company_id,
      location_id,
      version,
      state_code,
      employer_type,
      operation_facts,
      hazard_facts,
      workforce_facts,
      status,
      prepared_by
    ) values (
      new_company_id,
      new_location_id,
      1,
      normalized_state_code,
      'other',
      jsonb_build_object(
        'onboarding_source', 'service_role_verified_company_bootstrap',
        'human_applicability_review_required', true,
        'employer_type_confirmed', false,
        'industry_and_naics_confirmed', false,
        'retained_federal_jurisdiction_reviewed', false
      ),
      jsonb_build_object('review_required', true),
      jsonb_build_object('review_required', true),
      'draft',
      null
    ) returning id into new_profile_id;

    insert into public.location_jurisdiction_assignments (
      company_id,
      location_id,
      profile_id,
      jurisdiction_id,
      coverage_status,
      coverage_rationale,
      carve_outs
    ) values (
      new_company_id,
      new_location_id,
      new_profile_id,
      state_jurisdiction_id,
      'requires_review',
      format(
        'Candidate %s assignment based on verified branch state %s. Human review of employer type, industry, work activities, and retained federal jurisdiction is required.',
        state_jurisdiction_name,
        normalized_state_code
      ),
      '[]'::jsonb
    );

    insert into public.audit_events (
      company_id,
      location_id,
      actor_user_id,
      entity_type,
      entity_id,
      action,
      details
    ) values (
      new_company_id,
      new_location_id,
      null,
      'location',
      new_location_id,
      'bootstrapped_for_invited_owner',
      jsonb_build_object(
        'provisioning_actor_type', 'service_role',
        'provisioning_reference', provisioning_reference,
        'owner_user_id', target_owner_user_id,
        'state_code', normalized_state_code,
        'regulatory_profile_id', new_profile_id,
        'jurisdiction_code', 'US-' || normalized_state_code,
        'jurisdiction_review_required', true,
        'onboarding_version', 5
      )
    );
    location_ids := location_ids || jsonb_build_array(new_location_id);
  end loop;

  insert into public.audit_events (
    company_id,
    actor_user_id,
    entity_type,
    entity_id,
    action,
    details
  ) values (
    new_company_id,
    null,
    'company',
    new_company_id,
    'bootstrapped_for_invited_owner',
    jsonb_build_object(
      'provisioning_actor_type', 'service_role',
      'provisioning_reference', provisioning_reference,
      'owner_user_id', target_owner_user_id,
      'default_location_id', first_location_id,
      'location_count', location_count,
      'onboarding_version', 5
    )
  );

  return jsonb_build_object(
    'companyId', new_company_id,
    'defaultLocationId', first_location_id,
    'locationIds', location_ids,
    'provisioningReference', provisioning_reference
  );
end;
$$;

comment on function public.bootstrap_invited_company_owner(uuid, text, text, jsonb, uuid)
is 'Service-role-only atomic bootstrap for an administrator-created or invited Auth owner, reviewed initial-location list, and external provisioning correlation reference.';

revoke all on function public.bootstrap_invited_company_owner(uuid, text, text, jsonb, uuid)
from public, anon, authenticated;
grant execute on function public.bootstrap_invited_company_owner(uuid, text, text, jsonb, uuid)
to service_role;

commit;
