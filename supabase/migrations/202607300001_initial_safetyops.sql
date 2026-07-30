-- SafetyOps baseline schema
-- Designed for one company with multiple locations while preserving tenant
-- isolation for future companies. Apply through the Supabase CLI or SQL editor.

create extension if not exists pgcrypto;
create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

create type public.safetyops_role as enum (
  'corporate_admin',
  'safety_manager',
  'location_manager',
  'supervisor',
  'worker',
  'auditor'
);

create type public.record_status as enum (
  'draft',
  'scheduled',
  'in_progress',
  'submitted',
  'under_review',
  'complete',
  'closed',
  'cancelled'
);

create type public.action_status as enum (
  'open',
  'in_progress',
  'ready_for_review',
  'closed',
  'cancelled'
);

create type public.priority_level as enum ('low', 'medium', 'high', 'critical');
create type public.assignment_status as enum ('assigned', 'in_progress', 'complete', 'waived', 'expired');
create type public.document_visibility as enum ('company', 'locations', 'restricted');

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  timezone text not null default 'America/Los_Angeles',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_memberships (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.safetyops_role not null default 'worker',
  active boolean not null default true,
  default_location_id uuid,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 160),
  code text not null check (char_length(code) between 2 and 32),
  address text,
  timezone text not null default 'America/Los_Angeles',
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, code)
);

alter table public.company_memberships
  add constraint company_memberships_default_location_fk
  foreign key (company_id, default_location_id)
  references public.locations(company_id, id);

create table public.location_memberships (
  company_id uuid not null,
  location_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (location_id, user_id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
    on delete cascade,
  foreign key (company_id, user_id)
    references public.company_memberships(company_id, user_id)
    on delete cascade
);

create table public.form_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 180),
  category text not null default 'General',
  current_version integer not null default 1 check (current_version > 0),
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, name)
);

create table public.form_template_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  template_id uuid not null,
  version integer not null check (version > 0),
  schema_json jsonb not null default '{}'::jsonb,
  published boolean not null default false,
  published_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (template_id, version),
  unique (company_id, id),
  unique (company_id, template_id, id),
  foreign key (company_id, template_id)
    references public.form_templates(company_id, id)
    on delete cascade
);

create table public.template_location_assignments (
  company_id uuid not null,
  template_id uuid not null,
  location_id uuid not null,
  schedule_rule jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (template_id, location_id),
  foreign key (company_id, template_id)
    references public.form_templates(company_id, id)
    on delete cascade,
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
    on delete cascade
);

create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid not null,
  template_id uuid not null,
  template_version_id uuid not null,
  title text not null,
  area_or_asset text,
  status public.record_status not null default 'draft',
  scheduled_for timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  score numeric(5,2) check (score is null or score between 0 and 100),
  responses jsonb not null default '{}'::jsonb,
  signed_by uuid references public.profiles(id),
  signature_record jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id),
  foreign key (company_id, template_id)
    references public.form_templates(company_id, id),
  foreign key (company_id, template_id, template_version_id)
    references public.form_template_versions(company_id, template_id, id)
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid not null,
  incident_number bigint generated always as identity,
  title text not null check (char_length(title) between 3 and 240),
  incident_type text not null,
  potential_severity public.priority_level not null default 'medium',
  status public.record_status not null default 'submitted',
  occurred_at timestamptz not null,
  description text not null,
  immediate_controls text,
  investigation jsonb not null default '{}'::jsonb,
  reported_by uuid not null references public.profiles(id),
  assigned_to uuid references public.profiles(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
);

create table public.corrective_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid not null,
  source_type text not null check (source_type in ('inspection', 'incident', 'hazard', 'document', 'direct')),
  source_id uuid,
  title text not null check (char_length(title) between 3 and 240),
  description text,
  priority public.priority_level not null default 'medium',
  status public.action_status not null default 'open',
  assigned_to uuid references public.profiles(id),
  due_at timestamptz,
  required_evidence text,
  closeout_note text,
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
);

create table public.training_courses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 200),
  category text not null default 'General',
  description text,
  estimated_minutes integer not null default 10 check (estimated_minutes between 1 and 1440),
  active boolean not null default true,
  current_version integer not null default 1 check (current_version > 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create table public.training_course_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  course_id uuid not null,
  version integer not null check (version > 0),
  content jsonb not null default '{}'::jsonb,
  passing_score numeric(5,2) check (passing_score is null or passing_score between 0 and 100),
  practical_verification_required boolean not null default false,
  published boolean not null default false,
  published_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (course_id, version),
  unique (company_id, id),
  unique (company_id, course_id, version),
  foreign key (company_id, course_id)
    references public.training_courses(company_id, id)
    on delete cascade
);

create table public.training_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid,
  course_id uuid not null,
  course_version integer not null check (course_version > 0),
  worker_profile_id uuid not null references public.profiles(id) on delete cascade,
  status public.assignment_status not null default 'assigned',
  assigned_at timestamptz not null default now(),
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  quiz_score numeric(5,2) check (quiz_score is null or quiz_score between 0 and 100),
  completion_record jsonb not null default '{}'::jsonb,
  assigned_by uuid not null references auth.users(id),
  unique (course_id, course_version, worker_profile_id, due_at),
  foreign key (company_id, course_id, course_version)
    references public.training_course_versions(company_id, course_id, version),
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
);

create table public.certifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  worker_profile_id uuid not null references public.profiles(id) on delete cascade,
  location_id uuid,
  certification_type text not null,
  credential_number text,
  issued_at date,
  expires_at date,
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected', 'expired')),
  evidence_path text,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 220),
  document_type text not null default 'Procedure',
  owner_profile_id uuid references public.profiles(id),
  visibility public.document_visibility not null default 'company',
  current_version integer not null default 1 check (current_version > 0),
  acknowledgement_required boolean not null default false,
  effective_at date,
  review_at date,
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);

create table public.document_location_access (
  company_id uuid not null,
  document_id uuid not null,
  location_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (document_id, location_id),
  foreign key (company_id, document_id)
    references public.documents(company_id, id)
    on delete cascade,
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
    on delete cascade
);

create table public.document_user_access (
  company_id uuid not null,
  document_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (document_id, user_id),
  foreign key (company_id, document_id)
    references public.documents(company_id, id)
    on delete cascade
);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid not null,
  version integer not null check (version > 0),
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  checksum_sha256 text,
  change_summary text,
  published boolean not null default false,
  published_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (document_id, version),
  unique (company_id, id),
  unique (company_id, document_id, id),
  foreign key (company_id, document_id)
    references public.documents(company_id, id)
    on delete cascade
);

create table public.document_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid not null,
  document_version_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  acknowledgement_record jsonb not null default '{}'::jsonb,
  unique (document_version_id, user_id),
  foreign key (company_id, document_id, document_version_id)
    references public.document_versions(company_id, document_id, id)
);

create table public.evidence_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid,
  parent_type text not null check (parent_type in ('inspection', 'incident', 'action', 'certification')),
  parent_id uuid not null,
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid,
  actor_user_id uuid references auth.users(id),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (company_id, location_id)
    references public.locations(company_id, id)
);

create index company_memberships_user_idx on public.company_memberships(user_id, active);
create index location_memberships_user_idx on public.location_memberships(user_id, location_id);
create index inspections_company_location_idx on public.inspections(company_id, location_id, created_at desc);
create index inspections_status_idx on public.inspections(company_id, status, scheduled_for);
create index incidents_company_location_idx on public.incidents(company_id, location_id, occurred_at desc);
create index incidents_status_idx on public.incidents(company_id, status);
create index corrective_actions_due_idx on public.corrective_actions(company_id, status, due_at);
create index training_assignments_worker_idx on public.training_assignments(company_id, worker_profile_id, status);
create index training_assignments_due_idx on public.training_assignments(company_id, status, due_at);
create index certifications_expiry_idx on public.certifications(company_id, expires_at);
create index documents_review_idx on public.documents(company_id, review_at);
create index audit_events_company_time_idx on public.audit_events(company_id, occurred_at desc);

create or replace function private.is_company_member(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = target_company_id
      and membership.user_id = auth.uid()
      and membership.active
  );
$$;

create or replace function private.company_role(target_company_id uuid)
returns public.safetyops_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select membership.role
  from public.company_memberships membership
  where membership.company_id = target_company_id
    and membership.user_id = auth.uid()
    and membership.active
  limit 1;
$$;

create or replace function private.can_manage_company(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.company_role(target_company_id) in ('corporate_admin', 'safety_manager');
$$;

create or replace function private.can_access_location(target_company_id uuid, target_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    private.is_company_member(target_company_id)
    and (
      private.company_role(target_company_id) in ('corporate_admin', 'safety_manager', 'auditor')
      or exists (
        select 1
        from public.location_memberships location_membership
        where location_membership.company_id = target_company_id
          and location_membership.location_id = target_location_id
          and location_membership.user_id = auth.uid()
      )
    );
$$;

create or replace function private.can_write_location(target_company_id uuid, target_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    private.is_company_member(target_company_id)
    and (
      private.company_role(target_company_id) in ('corporate_admin', 'safety_manager')
      or (
        private.company_role(target_company_id) in ('location_manager', 'supervisor')
        and exists (
          select 1
          from public.location_memberships location_membership
          where location_membership.company_id = target_company_id
            and location_membership.location_id = target_location_id
            and location_membership.user_id = auth.uid()
        )
      )
    );
$$;

create or replace function private.shares_company(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.company_memberships mine
    join public.company_memberships theirs
      on theirs.company_id = mine.company_id
     and theirs.active
    where mine.user_id = auth.uid()
      and mine.active
      and theirs.user_id = target_user_id
  );
$$;

create or replace function private.can_access_document(target_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.documents document_record
    where document_record.id = target_document_id
      and document_record.active
      and private.is_company_member(document_record.company_id)
      and (
        document_record.visibility = 'company'
        or private.can_manage_company(document_record.company_id)
        or (
          document_record.visibility = 'locations'
          and exists (
            select 1
            from public.document_location_access access_record
            where access_record.document_id = document_record.id
              and private.can_access_location(access_record.company_id, access_record.location_id)
          )
        )
        or (
          document_record.visibility = 'restricted'
          and exists (
            select 1
            from public.document_user_access user_access
            where user_access.document_id = document_record.id
              and user_access.user_id = auth.uid()
          )
        )
      )
  );
$$;

create or replace function private.can_access_storage_object(target_path text)
returns boolean
language sql
stable
security definer
set search_path = public, storage, pg_temp
as $$
  select
    exists (
      select 1
      from public.document_versions version_record
      where version_record.storage_path = target_path
        and version_record.published
        and private.can_access_document(version_record.document_id)
    )
    or exists (
      select 1
      from public.evidence_files file_record
      where file_record.storage_path = target_path
        and (
          (file_record.location_id is not null and private.can_access_location(file_record.company_id, file_record.location_id))
          or (file_record.location_id is null and private.is_company_member(file_record.company_id))
        )
    );
$$;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.prevent_submitted_inspection_changes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('submitted', 'under_review', 'complete', 'closed') then
    raise exception 'Submitted inspection snapshots are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.prevent_published_version_changes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.published then
    raise exception 'Published versions are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.write_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_record jsonb;
  prior_record jsonb;
  audit_action text;
  audit_details jsonb := '{}'::jsonb;
begin
  current_record := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  prior_record := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;

  -- Parent-company deletion cascades should not recreate child audit rows.
  if not exists (
    select 1
    from public.companies
    where id = (current_record ->> 'company_id')::uuid
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    audit_action := 'created';
  elsif tg_op = 'DELETE' then
    audit_action := 'deleted';
  elsif prior_record ->> 'status' is distinct from current_record ->> 'status' then
    audit_action := 'status_changed';
    audit_details := jsonb_build_object(
      'from', prior_record ->> 'status',
      'to', current_record ->> 'status'
    );
  elsif prior_record ->> 'published' is distinct from current_record ->> 'published'
    and current_record ->> 'published' = 'true' then
    audit_action := 'published';
  else
    audit_action := 'updated';
  end if;

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
    (current_record ->> 'company_id')::uuid,
    nullif(current_record ->> 'location_id', '')::uuid,
    auth.uid(),
    tg_table_name,
    nullif(current_record ->> 'id', '')::uuid,
    audit_action,
    audit_details
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger companies_touch_updated_at before update on public.companies
for each row execute function private.touch_updated_at();
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function private.touch_updated_at();
create trigger company_memberships_touch_updated_at before update on public.company_memberships
for each row execute function private.touch_updated_at();
create trigger locations_touch_updated_at before update on public.locations
for each row execute function private.touch_updated_at();
create trigger form_templates_touch_updated_at before update on public.form_templates
for each row execute function private.touch_updated_at();
create trigger inspections_touch_updated_at before update on public.inspections
for each row execute function private.touch_updated_at();
create trigger incidents_touch_updated_at before update on public.incidents
for each row execute function private.touch_updated_at();
create trigger corrective_actions_touch_updated_at before update on public.corrective_actions
for each row execute function private.touch_updated_at();
create trigger training_courses_touch_updated_at before update on public.training_courses
for each row execute function private.touch_updated_at();
create trigger certifications_touch_updated_at before update on public.certifications
for each row execute function private.touch_updated_at();
create trigger documents_touch_updated_at before update on public.documents
for each row execute function private.touch_updated_at();

create trigger inspections_immutable_after_submit
before update or delete on public.inspections
for each row execute function private.prevent_submitted_inspection_changes();

create trigger form_versions_immutable_after_publish
before update or delete on public.form_template_versions
for each row execute function private.prevent_published_version_changes();

create trigger document_versions_immutable_after_publish
before update or delete on public.document_versions
for each row execute function private.prevent_published_version_changes();

create trigger training_course_versions_immutable_after_publish
before update or delete on public.training_course_versions
for each row execute function private.prevent_published_version_changes();

create trigger inspections_audit after insert or update or delete on public.inspections
for each row execute function private.write_audit_event();
create trigger incidents_audit after insert or update or delete on public.incidents
for each row execute function private.write_audit_event();
create trigger corrective_actions_audit after insert or update or delete on public.corrective_actions
for each row execute function private.write_audit_event();
create trigger training_assignments_audit after insert or update or delete on public.training_assignments
for each row execute function private.write_audit_event();
create trigger certifications_audit after insert or update or delete on public.certifications
for each row execute function private.write_audit_event();
create trigger documents_audit after insert or update or delete on public.documents
for each row execute function private.write_audit_event();
create trigger form_template_versions_audit after insert or update or delete on public.form_template_versions
for each row execute function private.write_audit_event();
create trigger training_course_versions_audit after insert or update or delete on public.training_course_versions
for each row execute function private.write_audit_event();
create trigger document_versions_audit after insert or update or delete on public.document_versions
for each row execute function private.write_audit_event();
create trigger evidence_files_audit after insert or update or delete on public.evidence_files
for each row execute function private.write_audit_event();

create or replace function public.create_company_with_owner(company_name text, company_slug text)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  new_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.profiles (id, full_name)
  values (auth.uid(), coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', ''))
  on conflict (id) do nothing;

  insert into public.companies (name, slug, created_by)
  values (trim(company_name), lower(trim(company_slug)), auth.uid())
  returning id into new_company_id;

  insert into public.company_memberships (company_id, user_id, role)
  values (new_company_id, auth.uid(), 'corporate_admin');

  insert into public.audit_events (company_id, actor_user_id, entity_type, entity_id, action)
  values (new_company_id, auth.uid(), 'company', new_company_id, 'created');

  return new_company_id;
end;
$$;

create or replace function public.complete_my_training_assignment(
  target_assignment_id uuid,
  target_quiz_score numeric default null,
  target_completion_record jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  assignment_record public.training_assignments;
begin
  select *
  into assignment_record
  from public.training_assignments
  where id = target_assignment_id
  for update;

  if assignment_record.id is null
    or assignment_record.worker_profile_id <> auth.uid()
    or not private.is_company_member(assignment_record.company_id) then
    raise exception 'Assignment not available';
  end if;

  update public.training_assignments
  set status = 'complete',
      completed_at = now(),
      quiz_score = target_quiz_score,
      completion_record = coalesce(target_completion_record, '{}'::jsonb)
  where id = target_assignment_id;
end;
$$;

create or replace function public.update_my_corrective_action(
  target_action_id uuid,
  target_status public.action_status,
  target_closeout_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  action_record public.corrective_actions;
begin
  select *
  into action_record
  from public.corrective_actions
  where id = target_action_id
  for update;

  if action_record.id is null
    or action_record.assigned_to <> auth.uid()
    or not private.can_access_location(action_record.company_id, action_record.location_id) then
    raise exception 'Corrective action not available';
  end if;

  if target_status not in ('in_progress', 'ready_for_review') then
    raise exception 'Assignees may only start an action or submit it for review';
  end if;

  update public.corrective_actions
  set status = target_status,
      closeout_note = nullif(trim(target_closeout_note), '')
  where id = target_action_id;
end;
$$;

alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.company_memberships enable row level security;
alter table public.locations enable row level security;
alter table public.location_memberships enable row level security;
alter table public.form_templates enable row level security;
alter table public.form_template_versions enable row level security;
alter table public.template_location_assignments enable row level security;
alter table public.inspections enable row level security;
alter table public.incidents enable row level security;
alter table public.corrective_actions enable row level security;
alter table public.training_courses enable row level security;
alter table public.training_course_versions enable row level security;
alter table public.training_assignments enable row level security;
alter table public.certifications enable row level security;
alter table public.documents enable row level security;
alter table public.document_location_access enable row level security;
alter table public.document_user_access enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_acknowledgements enable row level security;
alter table public.evidence_files enable row level security;
alter table public.audit_events enable row level security;

create policy companies_select on public.companies
for select to authenticated
using (private.is_company_member(id));
create policy companies_update on public.companies
for update to authenticated
using (private.company_role(id) = 'corporate_admin')
with check (private.company_role(id) = 'corporate_admin');

create policy profiles_select on public.profiles
for select to authenticated
using (id = auth.uid() or private.shares_company(id));
create policy profiles_insert_self on public.profiles
for insert to authenticated
with check (id = auth.uid());
create policy profiles_update_self on public.profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy company_memberships_select on public.company_memberships
for select to authenticated
using (private.is_company_member(company_id));
create policy company_memberships_insert on public.company_memberships
for insert to authenticated
with check (private.company_role(company_id) = 'corporate_admin');
create policy company_memberships_update on public.company_memberships
for update to authenticated
using (private.company_role(company_id) = 'corporate_admin')
with check (private.company_role(company_id) = 'corporate_admin');
create policy company_memberships_delete on public.company_memberships
for delete to authenticated
using (private.company_role(company_id) = 'corporate_admin' and user_id <> auth.uid());

create policy locations_select on public.locations
for select to authenticated
using (private.can_access_location(company_id, id));
create policy locations_insert on public.locations
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy locations_update on public.locations
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy locations_delete on public.locations
for delete to authenticated
using (private.company_role(company_id) = 'corporate_admin');

create policy location_memberships_select on public.location_memberships
for select to authenticated
using (user_id = auth.uid() or private.can_manage_company(company_id) or private.can_write_location(company_id, location_id));
create policy location_memberships_insert on public.location_memberships
for insert to authenticated
with check (private.can_manage_company(company_id) or private.can_write_location(company_id, location_id));
create policy location_memberships_delete on public.location_memberships
for delete to authenticated
using (private.can_manage_company(company_id) or private.can_write_location(company_id, location_id));

create policy form_templates_select on public.form_templates
for select to authenticated
using (private.is_company_member(company_id));
create policy form_templates_insert on public.form_templates
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy form_templates_update on public.form_templates
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy form_templates_delete on public.form_templates
for delete to authenticated
using (private.can_manage_company(company_id));

create policy form_template_versions_select on public.form_template_versions
for select to authenticated
using (private.is_company_member(company_id));
create policy form_template_versions_insert on public.form_template_versions
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy form_template_versions_update on public.form_template_versions
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy form_template_versions_delete on public.form_template_versions
for delete to authenticated
using (private.can_manage_company(company_id));

create policy template_location_assignments_select on public.template_location_assignments
for select to authenticated
using (private.can_access_location(company_id, location_id));
create policy template_location_assignments_insert on public.template_location_assignments
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy template_location_assignments_update on public.template_location_assignments
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy template_location_assignments_delete on public.template_location_assignments
for delete to authenticated
using (private.can_manage_company(company_id));

create policy inspections_select on public.inspections
for select to authenticated
using (private.can_access_location(company_id, location_id));
create policy inspections_insert on public.inspections
for insert to authenticated
with check (private.can_access_location(company_id, location_id) and created_by = auth.uid());
create policy inspections_update on public.inspections
for update to authenticated
using (
  private.can_write_location(company_id, location_id)
  or (created_by = auth.uid() and status in ('draft', 'in_progress'))
)
with check (
  private.can_write_location(company_id, location_id)
  or created_by = auth.uid()
);
create policy inspections_delete_drafts on public.inspections
for delete to authenticated
using (
  status = 'draft'
  and (private.can_write_location(company_id, location_id) or created_by = auth.uid())
);

create policy incidents_select on public.incidents
for select to authenticated
using (private.can_access_location(company_id, location_id));
create policy incidents_insert on public.incidents
for insert to authenticated
with check (
  private.can_access_location(company_id, location_id)
  and reported_by = auth.uid()
);
create policy incidents_update on public.incidents
for update to authenticated
using (private.can_write_location(company_id, location_id))
with check (private.can_write_location(company_id, location_id));

create policy corrective_actions_select on public.corrective_actions
for select to authenticated
using (
  private.can_access_location(company_id, location_id)
  and (assigned_to = auth.uid() or private.can_write_location(company_id, location_id) or private.can_manage_company(company_id))
);
create policy corrective_actions_insert on public.corrective_actions
for insert to authenticated
with check (private.can_write_location(company_id, location_id) and created_by = auth.uid());
create policy corrective_actions_update on public.corrective_actions
for update to authenticated
using (private.can_write_location(company_id, location_id))
with check (private.can_write_location(company_id, location_id));

create policy training_courses_select on public.training_courses
for select to authenticated
using (private.is_company_member(company_id));
create policy training_courses_insert on public.training_courses
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy training_courses_update on public.training_courses
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy training_courses_delete on public.training_courses
for delete to authenticated
using (private.can_manage_company(company_id));

create policy training_course_versions_select on public.training_course_versions
for select to authenticated
using (private.is_company_member(company_id));
create policy training_course_versions_insert on public.training_course_versions
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy training_course_versions_update on public.training_course_versions
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy training_course_versions_delete on public.training_course_versions
for delete to authenticated
using (private.can_manage_company(company_id));

create policy training_assignments_select on public.training_assignments
for select to authenticated
using (
  private.is_company_member(company_id)
  and (
    worker_profile_id = auth.uid()
    or private.can_manage_company(company_id)
    or (location_id is not null and private.can_write_location(company_id, location_id))
  )
);
create policy training_assignments_insert on public.training_assignments
for insert to authenticated
with check (
  private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
);
create policy training_assignments_update on public.training_assignments
for update to authenticated
using (
  private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
)
with check (
  private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
);

create policy certifications_select on public.certifications
for select to authenticated
using (
  worker_profile_id = auth.uid()
  or private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
);
create policy certifications_insert on public.certifications
for insert to authenticated
with check (
  (
    worker_profile_id = auth.uid()
    and private.is_company_member(company_id)
    and verification_status = 'pending'
    and verified_by is null
    and verified_at is null
  )
  or private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
);
create policy certifications_update on public.certifications
for update to authenticated
using (
  private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
)
with check (
  private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
);

create policy documents_select on public.documents
for select to authenticated
using (private.can_access_document(id));
create policy documents_insert on public.documents
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy documents_update on public.documents
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy documents_delete on public.documents
for delete to authenticated
using (private.can_manage_company(company_id));

create policy document_location_access_select on public.document_location_access
for select to authenticated
using (private.can_access_document(document_id));
create policy document_location_access_write on public.document_location_access
for all to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy document_user_access_select on public.document_user_access
for select to authenticated
using (user_id = auth.uid() or private.can_manage_company(company_id));
create policy document_user_access_write on public.document_user_access
for all to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));

create policy document_versions_select on public.document_versions
for select to authenticated
using (private.can_access_document(document_id));
create policy document_versions_insert on public.document_versions
for insert to authenticated
with check (private.can_manage_company(company_id));
create policy document_versions_update on public.document_versions
for update to authenticated
using (private.can_manage_company(company_id))
with check (private.can_manage_company(company_id));
create policy document_versions_delete on public.document_versions
for delete to authenticated
using (private.can_manage_company(company_id));

create policy document_acknowledgements_select on public.document_acknowledgements
for select to authenticated
using (user_id = auth.uid() or private.can_manage_company(company_id));
create policy document_acknowledgements_insert on public.document_acknowledgements
for insert to authenticated
with check (
  user_id = auth.uid()
  and private.can_access_document(document_id)
);

create policy evidence_files_select on public.evidence_files
for select to authenticated
using (
  (location_id is null and private.is_company_member(company_id))
  or (location_id is not null and private.can_access_location(company_id, location_id))
);
create policy evidence_files_insert on public.evidence_files
for insert to authenticated
with check (
  uploaded_by = auth.uid()
  and (
    (location_id is null and private.is_company_member(company_id))
    or (location_id is not null and private.can_access_location(company_id, location_id))
  )
);
create policy evidence_files_delete on public.evidence_files
for delete to authenticated
using (uploaded_by = auth.uid() or private.can_manage_company(company_id));

create policy audit_events_select on public.audit_events
for select to authenticated
using (
  private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
  or private.company_role(company_id) = 'auditor'
);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'safetyops-private',
  'safetyops-private',
  false,
  26214400,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'text/csv'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy safetyops_storage_select on storage.objects
for select to authenticated
using (
  bucket_id = 'safetyops-private'
  and private.can_access_storage_object(name)
);

create policy safetyops_storage_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'safetyops-private'
  and private.is_company_member((storage.foldername(name))[1]::uuid)
);

create policy safetyops_storage_update on storage.objects
for update to authenticated
using (
  bucket_id = 'safetyops-private'
  and owner_id = auth.uid()::text
)
with check (
  bucket_id = 'safetyops-private'
  and owner_id = auth.uid()::text
);

create policy safetyops_storage_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'safetyops-private'
  and (
    owner_id = auth.uid()::text
    or private.can_manage_company((storage.foldername(name))[1]::uuid)
  )
);

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

grant select, insert, update, delete on public.companies to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.company_memberships to authenticated;
grant select, insert, update, delete on public.locations to authenticated;
grant select, insert, delete on public.location_memberships to authenticated;
grant select, insert, update, delete on public.form_templates to authenticated;
grant select, insert, update, delete on public.form_template_versions to authenticated;
grant select, insert, update, delete on public.template_location_assignments to authenticated;
grant select, insert, update, delete on public.inspections to authenticated;
grant select, insert, update on public.incidents to authenticated;
grant select, insert, update on public.corrective_actions to authenticated;
grant select, insert, update, delete on public.training_courses to authenticated;
grant select, insert, update, delete on public.training_course_versions to authenticated;
grant select, insert, update on public.training_assignments to authenticated;
grant select, insert, update on public.certifications to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, update, delete on public.document_location_access to authenticated;
grant select, insert, update, delete on public.document_user_access to authenticated;
grant select, insert, update, delete on public.document_versions to authenticated;
grant select, insert on public.document_acknowledgements to authenticated;
grant select, insert, delete on public.evidence_files to authenticated;
grant select on public.audit_events to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke all on function public.create_company_with_owner(text, text) from public;
revoke all on function public.complete_my_training_assignment(uuid, numeric, jsonb) from public;
revoke all on function public.update_my_corrective_action(uuid, public.action_status, text) from public;
grant execute on function public.create_company_with_owner(text, text) to authenticated;
grant execute on function public.complete_my_training_assignment(uuid, numeric, jsonb) to authenticated;
grant execute on function public.update_my_corrective_action(uuid, public.action_status, text) to authenticated;

revoke all on all functions in schema private from public;
grant execute on function private.is_company_member(uuid) to authenticated;
grant execute on function private.company_role(uuid) to authenticated;
grant execute on function private.can_manage_company(uuid) to authenticated;
grant execute on function private.can_access_location(uuid, uuid) to authenticated;
grant execute on function private.can_write_location(uuid, uuid) to authenticated;
grant execute on function private.shares_company(uuid) to authenticated;
grant execute on function private.can_access_document(uuid) to authenticated;
grant execute on function private.can_access_storage_object(text) to authenticated;
