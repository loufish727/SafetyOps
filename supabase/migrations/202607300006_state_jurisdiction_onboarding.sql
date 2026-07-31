-- State-plan catalogue seeds and jurisdiction-aware first-company onboarding.
--
-- A submitted state code is only an onboarding fact. It is not enough to decide
-- regulatory applicability. The profile and assignment created below therefore
-- remain draft/requires_review until a qualified reviewer confirms employer
-- type, industry, work activities, and retained federal jurisdiction.
--
-- The existing two-argument create_company_with_owner(text, text) RPC is kept
-- for already-deployed clients. New clients should call the four-argument
-- overload with first_location_name and first_state_code. Legacy workspaces
-- must complete jurisdiction setup separately before treating a state plan as
-- controlling authority.

begin;

do $$
begin
  if not exists (
    select 1
    from public.regulatory_jurisdictions
    where code = 'US-FED-OSHA'
  ) then
    raise exception
      'Federal OSHA jurisdiction seed is missing; apply regulatory traceability migration 202607300002 first';
  end if;
end;
$$;

-- Stable catalogue identifiers match the client jurisdiction catalogue while
-- subdivision_code keeps the postal state code available for onboarding.
with federal as (
  select id
  from public.regulatory_jurisdictions
  where code = 'US-FED-OSHA'
),
jurisdiction_seed (
  code,
  name,
  subdivision_code,
  agency_name,
  agency_url,
  coverage_rules
) as (
  values
    (
      'US-OR',
      'Oregon OSHA State Plan',
      'OR',
      'Oregon Occupational Safety and Health Division',
      'https://osha.oregon.gov/',
      jsonb_build_object(
        'state_plan', true,
        'requires_human_applicability_review', true,
        'retained_federal_jurisdiction_review_required', true,
        'federal_parent_code', 'US-FED-OSHA'
      )
    ),
    (
      'US-WA',
      'Washington DOSH State Plan',
      'WA',
      'Washington Division of Occupational Safety and Health',
      'https://www.lni.wa.gov/safety-health/',
      jsonb_build_object(
        'state_plan', true,
        'requires_human_applicability_review', true,
        'retained_federal_jurisdiction_review_required', true,
        'federal_parent_code', 'US-FED-OSHA'
      )
    ),
    (
      'US-CA',
      'California Cal/OSHA State Plan',
      'CA',
      'California Division of Occupational Safety and Health',
      'https://www.dir.ca.gov/dosh/',
      jsonb_build_object(
        'state_plan', true,
        'requires_human_applicability_review', true,
        'retained_federal_jurisdiction_review_required', true,
        'federal_parent_code', 'US-FED-OSHA'
      )
    )
)
insert into public.regulatory_jurisdictions as existing_jurisdiction (
  parent_id,
  code,
  name,
  country_code,
  subdivision_code,
  agency_name,
  agency_url,
  coverage_scope,
  coverage_rules,
  active
)
select
  federal.id,
  jurisdiction_seed.code,
  jurisdiction_seed.name,
  'US',
  jurisdiction_seed.subdivision_code,
  jurisdiction_seed.agency_name,
  jurisdiction_seed.agency_url,
  'state_private_and_public',
  jurisdiction_seed.coverage_rules,
  true
from jurisdiction_seed
cross join federal
on conflict (code) do update
set
  parent_id = excluded.parent_id,
  name = excluded.name,
  country_code = excluded.country_code,
  subdivision_code = excluded.subdivision_code,
  agency_name = excluded.agency_name,
  agency_url = excluded.agency_url,
  coverage_scope = excluded.coverage_scope,
  coverage_rules =
    existing_jurisdiction.coverage_rules
    || excluded.coverage_rules,
  updated_at = now();

-- These rows register official discovery points. They do not mark any fetched
-- artifact as reviewed or published. State adapters must preserve raw bytes,
-- effective dates, hashes, and legal/convenience-copy distinctions.
with source_seed (
  jurisdiction_code,
  source_code,
  name,
  source_kind,
  authority_class,
  base_url,
  adapter_key,
  poll_interval,
  adapter_config
) as (
  values
    (
      'US-OR',
      'or_oar_chapter_437',
      'Oregon Administrative Rules Chapter 437',
      'state_code',
      'binding_regulation',
      'https://secure.sos.state.or.us/oard/displayChapterRules.action?selectedChapter=437',
      'oregon_oar_chapter',
      interval '1 day',
      jsonb_build_object(
        'chapter', '437',
        'allowed_hosts', jsonb_build_array('secure.sos.state.or.us'),
        'human_review_required', true
      )
    ),
    (
      'US-OR',
      'or_osha_current_rules',
      'Oregon OSHA Chapter 437 Current Final Rules',
      'state_code',
      'binding_regulation',
      'https://osha.oregon.gov/rules/final/Pages/default.aspx',
      'oregon_osha_current_rules',
      interval '1 day',
      jsonb_build_object(
        'allowed_hosts', jsonb_build_array('osha.oregon.gov'),
        'captures_federal_rules_adopted_by_reference', true,
        'human_review_required', true
      )
    ),
    (
      'US-OR',
      'or_osha_rulemaking',
      'Oregon OSHA Adopted and Proposed Rules',
      'state_code',
      'official_rulemaking',
      'https://osha.oregon.gov/rules/making/Pages/adopted.aspx',
      'oregon_osha_rulemaking',
      interval '1 day',
      jsonb_build_object(
        'proposed_rules_url', 'https://osha.oregon.gov/rules/making/Pages/proposed.aspx',
        'allowed_hosts', jsonb_build_array('osha.oregon.gov'),
        'human_review_required', true
      )
    ),
    (
      'US-WA',
      'wa_wac_title_296',
      'Washington Administrative Code Title 296',
      'state_code',
      'binding_regulation',
      'https://app.leg.wa.gov/WAC/default.aspx?cite=296',
      'washington_wac_title',
      interval '1 day',
      jsonb_build_object(
        'title', '296',
        'allowed_hosts', jsonb_build_array('app.leg.wa.gov'),
        'human_review_required', true
      )
    ),
    (
      'US-WA',
      'wa_dosh_rules_by_chapter',
      'Washington DOSH Rules by Chapter',
      'state_guidance',
      'guidance',
      'https://www.lni.wa.gov/safety-health/safety-rules/rules-by-chapter/',
      'washington_dosh_rules_index',
      interval '1 day',
      jsonb_build_object(
        'allowed_hosts', jsonb_build_array('www.lni.wa.gov'),
        'convenience_copies', true,
        'controlling_source_code', 'wa_wac_title_296',
        'human_review_required', true
      )
    ),
    (
      'US-WA',
      'wa_dosh_rulemaking',
      'Washington DOSH Rulemaking',
      'state_guidance',
      'official_rulemaking',
      'https://www.lni.wa.gov/safety-health/safety-rules/rulemaking-stakeholder-information/',
      'washington_dosh_rulemaking',
      interval '1 day',
      jsonb_build_object(
        'allowed_hosts', jsonb_build_array('www.lni.wa.gov'),
        'human_review_required', true
      )
    ),
    (
      'US-CA',
      'ca_ccr_title_8',
      'California Code of Regulations Title 8',
      'state_code',
      'binding_regulation',
      'https://www.dir.ca.gov/title8index/t8index.asp',
      'california_ccr_title_8',
      interval '1 day',
      jsonb_build_object(
        'title', '8',
        'allowed_hosts', jsonb_build_array('www.dir.ca.gov'),
        'linked_third_party_access_requires_rights_review', true,
        'human_review_required', true
      )
    ),
    (
      'US-CA',
      'ca_osha_laws_regulations',
      'Cal/OSHA Laws and Regulations Index',
      'state_guidance',
      'guidance',
      'https://www.dir.ca.gov/dosh/LawsAndRegulations.htm',
      'california_osha_laws_index',
      interval '1 day',
      jsonb_build_object(
        'allowed_hosts', jsonb_build_array('www.dir.ca.gov'),
        'controlling_source_code', 'ca_ccr_title_8',
        'human_review_required', true
      )
    ),
    (
      'US-CA',
      'ca_osha_rulemaking',
      'Cal/OSHA Proposed and Approved Regulations',
      'state_guidance',
      'official_rulemaking',
      'https://www.dir.ca.gov/dosh/LawsAndRegulations.htm',
      'california_osha_rulemaking',
      interval '1 day',
      jsonb_build_object(
        'approved_rules_url', 'https://www.dir.ca.gov/Rulemaking/DIRApproved.html',
        'allowed_hosts', jsonb_build_array('www.dir.ca.gov'),
        'human_review_required', true
      )
    )
)
insert into public.regulatory_sources as existing_source (
  jurisdiction_id,
  source_code,
  name,
  source_kind,
  authority_class,
  base_url,
  adapter_key,
  official,
  poll_interval,
  adapter_config,
  active
)
select
  jurisdiction.id,
  source_seed.source_code,
  source_seed.name,
  source_seed.source_kind,
  source_seed.authority_class,
  source_seed.base_url,
  source_seed.adapter_key,
  true,
  source_seed.poll_interval,
  source_seed.adapter_config,
  true
from source_seed
join public.regulatory_jurisdictions jurisdiction
  on jurisdiction.code = source_seed.jurisdiction_code
on conflict (source_code) do update
set
  jurisdiction_id = excluded.jurisdiction_id,
  name = excluded.name,
  source_kind = excluded.source_kind,
  authority_class = excluded.authority_class,
  base_url = excluded.base_url,
  adapter_key = excluded.adapter_key,
  official = excluded.official,
  poll_interval = excluded.poll_interval,
  adapter_config =
    existing_source.adapter_config
    || excluded.adapter_config,
  updated_at = now();

create or replace function public.create_company_with_owner(
  company_name text,
  company_slug text,
  first_location_name text,
  first_state_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, private, regulatory_private, pg_temp
as $$
declare
  normalized_company_name text := trim(company_name);
  normalized_company_slug text := lower(trim(company_slug));
  normalized_location_name text := trim(first_location_name);
  normalized_state_code text := upper(trim(first_state_code));
  state_jurisdiction_code text;
  state_jurisdiction_id uuid;
  state_jurisdiction_name text;
  new_company_id uuid;
  new_location_id uuid;
  new_profile_id uuid;
  new_assignment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Serialize first-company creation for this user so repeated submissions
  -- cannot create parallel tenant roots.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  if normalized_company_name is null
    or char_length(normalized_company_name) < 2
    or char_length(normalized_company_name) > 160 then
    raise exception 'Company name must be between 2 and 160 characters';
  end if;

  if normalized_company_slug is null
    or char_length(normalized_company_slug) < 2
    or char_length(normalized_company_slug) > 63
    or normalized_company_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception
      'Company slug must be 2-63 lowercase letters, numbers, or hyphen-separated words';
  end if;

  if normalized_location_name is null
    or char_length(normalized_location_name) < 2
    or char_length(normalized_location_name) > 160 then
    raise exception 'First location name must be between 2 and 160 characters';
  end if;

  if normalized_state_code is null
    or normalized_state_code not in ('OR', 'WA', 'CA') then
    raise exception 'First location state code must be OR, WA, or CA';
  end if;

  state_jurisdiction_code := case normalized_state_code
    when 'OR' then 'US-OR'
    when 'WA' then 'US-WA'
    when 'CA' then 'US-CA'
  end;

  select jurisdiction.id, jurisdiction.name
  into state_jurisdiction_id, state_jurisdiction_name
  from public.regulatory_jurisdictions jurisdiction
  where jurisdiction.code = state_jurisdiction_code
    and jurisdiction.active;

  if state_jurisdiction_id is null then
    raise exception
      'Active state-plan jurisdiction is not configured for %',
      normalized_state_code;
  end if;

  if exists (
    select 1
    from public.company_memberships membership
    where membership.user_id = auth.uid()
      and membership.active
  ) then
    raise exception 'This account already belongs to an active company';
  end if;

  insert into public.profiles (id, full_name)
  values (
    auth.uid(),
    coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', '')
  )
  on conflict (id) do update
  set full_name = case
    when public.profiles.full_name = '' then excluded.full_name
    else public.profiles.full_name
  end;

  insert into public.companies (name, slug, created_by)
  values (
    normalized_company_name,
    normalized_company_slug,
    auth.uid()
  )
  returning id into new_company_id;

  insert into public.locations (
    company_id,
    name,
    code,
    timezone,
    created_by
  )
  values (
    new_company_id,
    normalized_location_name,
    'MAIN',
    'America/Los_Angeles',
    auth.uid()
  )
  returning id into new_location_id;

  insert into public.company_memberships (
    company_id,
    user_id,
    role,
    default_location_id
  )
  values (
    new_company_id,
    auth.uid(),
    'corporate_admin',
    new_location_id
  );

  insert into public.location_memberships (
    company_id,
    location_id,
    user_id
  )
  values (
    new_company_id,
    new_location_id,
    auth.uid()
  );

  -- employer_type is deliberately "other": onboarding has not established
  -- whether the employer is private, public, federal, tribal, or otherwise.
  -- Approval requires a separate reviewer under the migration-002 protections.
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
    new_company_id,
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

  -- This is a candidate state-plan assignment, not an applicability decision.
  -- Maritime, federal enclave, tribal, federal-employer, and other coverage
  -- exceptions must be reviewed before coverage_status can become "applies."
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
    new_company_id,
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
    new_company_id,
    new_location_id,
    auth.uid(),
    'company',
    new_company_id,
    'created_with_owner',
    jsonb_build_object(
      'default_location_id', new_location_id,
      'location_state_code', normalized_state_code,
      'regulatory_profile_id', new_profile_id,
      'jurisdiction_assignment_id', new_assignment_id,
      'jurisdiction_code', state_jurisdiction_code,
      'jurisdiction_review_required', true,
      'onboarding_version', 3
    )
  );

  return new_company_id;
end;
$$;

comment on function public.create_company_with_owner(text, text, text, text) is
  'Creates a first company and first_location_name, using first_state_code for a draft, review-required state-plan assignment. State-code onboarding never constitutes an applicability approval.';

revoke all on function public.create_company_with_owner(text, text, text, text)
from public;
grant execute on function public.create_company_with_owner(text, text, text, text)
to authenticated;

commit;
