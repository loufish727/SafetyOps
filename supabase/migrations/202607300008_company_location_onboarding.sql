-- Tenant-safe location creation for an established SafetyOps company.
--
-- A state selection creates only a draft regulatory profile and a
-- requires_review jurisdiction assignment. It never approves applicability.

begin;

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
  if target_company_id is null or not private.can_manage_company(target_company_id) then
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
    raise exception 'Location code must be 2-32 letters, numbers, or hyphen-separated words'
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
  )
  values (
    target_company_id,
    normalized_name,
    normalized_code,
    normalized_address,
    normalized_timezone,
    auth.uid()
  )
  returning id into new_location_id;

  insert into public.location_memberships (
    company_id,
    location_id,
    user_id
  )
  values (
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
  )
  values (
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
  )
  returning id into new_profile_id;

  insert into public.location_jurisdiction_assignments (
    company_id,
    location_id,
    profile_id,
    jurisdiction_id,
    coverage_status,
    coverage_rationale,
    carve_outs
  )
  values (
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
  )
  returning id into new_assignment_id;

  insert into public.audit_events (
    company_id,
    location_id,
    actor_user_id,
    entity_type,
    entity_id,
    action,
    details
  )
  values (
    target_company_id,
    new_location_id,
    auth.uid(),
    'location',
    new_location_id,
    'created',
    jsonb_build_object(
      'location_state_code', normalized_state_code,
      'regulatory_profile_id', new_profile_id,
      'jurisdiction_assignment_id', new_assignment_id,
      'jurisdiction_code', state_jurisdiction_code,
      'jurisdiction_review_required', true,
      'onboarding_version', 1
    )
  );

  return new_location_id;
end;
$$;

comment on function public.create_company_location(
  uuid, text, text, text, text, text
) is
  'Creates a tenant location and draft, review-required state-plan profile. Company/location authority is enforced server-side.';

revoke all on function public.create_company_location(
  uuid, text, text, text, text, text
) from public, anon;
grant execute on function public.create_company_location(
  uuid, text, text, text, text, text
) to authenticated;

commit;
