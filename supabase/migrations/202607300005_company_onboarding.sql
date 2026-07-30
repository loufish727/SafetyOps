-- Atomic, tenant-safe first-company onboarding.
-- This replaces the baseline RPC so the first owner always receives a usable
-- default location and cannot accidentally create duplicate active companies.

begin;

create or replace function public.create_company_with_owner(
  company_name text,
  company_slug text
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  normalized_name text := trim(company_name);
  normalized_slug text := lower(trim(company_slug));
  new_company_id uuid;
  new_location_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Serialize onboarding attempts for this user. This makes a double-submit
  -- safe even when the requests arrive in separate database transactions.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  if normalized_name is null
    or char_length(normalized_name) < 2
    or char_length(normalized_name) > 160 then
    raise exception 'Company name must be between 2 and 160 characters';
  end if;

  if normalized_slug is null
    or char_length(normalized_slug) < 2
    or char_length(normalized_slug) > 63
    or normalized_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Company slug must be 2-63 lowercase letters, numbers, or hyphen-separated words';
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
  values (normalized_name, normalized_slug, auth.uid())
  returning id into new_company_id;

  insert into public.locations (
    company_id,
    name,
    code,
    created_by
  )
  values (
    new_company_id,
    'Main location',
    'MAIN',
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
      'onboarding_version', 2
    )
  );

  return new_company_id;
end;
$$;

revoke all on function public.create_company_with_owner(text, text) from public;
grant execute on function public.create_company_with_owner(text, text) to authenticated;

commit;
