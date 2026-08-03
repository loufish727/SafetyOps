-- SafetyOps employee-centered safety-management workflows
--
-- Adds a workforce directory independent from Auth accounts, safety committee
-- minutes, employee-owned action/training records, immutable completion and
-- electronic-acknowledgement evidence, and a service-controlled PDF upload
-- boundary. Existing company and location isolation remains authoritative.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Employees are business records. An employee may be linked to Auth later.
-- ---------------------------------------------------------------------------

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  user_id uuid references public.profiles(id) on delete restrict,
  employee_number text,
  full_name text not null check (char_length(trim(full_name)) between 2 and 160),
  work_email text,
  job_title text,
  department text,
  employment_status text not null default 'active'
    check (employment_status in ('active', 'leave', 'separated')),
  hired_on date,
  separated_on date,
  primary_location_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, primary_location_id)
    references public.locations(company_id, id) on delete restrict,
  check (work_email is null or work_email = lower(trim(work_email))),
  check (
    (employment_status = 'separated' and separated_on is not null)
    or employment_status <> 'separated'
  )
);

create unique index employees_company_user_unique
  on public.employees(company_id, user_id)
  where user_id is not null;

create unique index employees_company_number_unique
  on public.employees(company_id, employee_number)
  where employee_number is not null;

create index employees_company_status_idx
  on public.employees(company_id, employment_status, full_name);

create table public.employee_location_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  employee_id uuid not null,
  location_id uuid not null,
  is_primary boolean not null default false,
  assigned_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  unique (company_id, id),
  unique (employee_id, location_id),
  foreign key (company_id, employee_id)
    references public.employees(company_id, id) on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict
);

create unique index employee_location_one_primary
  on public.employee_location_assignments(employee_id)
  where is_primary;

create index employee_location_location_idx
  on public.employee_location_assignments(company_id, location_id, employee_id);

-- Install audit capture before the membership backfill so bootstrap employee
-- identities and all five initial location assignments enter the same
-- company hash chain as later records.
create trigger safetyops_workflow_employees_audit
after insert or update or delete on public.employees
for each row execute function program_private.capture_audit_event();
create trigger safetyops_workflow_employee_location_assignments_audit
after insert or update or delete on public.employee_location_assignments
for each row execute function program_private.capture_audit_event();

insert into public.employees (
  company_id,
  user_id,
  full_name,
  work_email,
  job_title,
  employment_status,
  primary_location_id,
  created_by
)
select
  membership.company_id,
  membership.user_id,
  coalesce(nullif(trim(profile.full_name), ''), split_part(auth_user.email, '@', 1), 'Employee record'),
  lower(auth_user.email),
  initcap(replace(membership.role::text, '_', ' ')),
  case when membership.active then 'active' else 'leave' end,
  membership.default_location_id,
  coalesce(membership.invited_by, membership.user_id)
from public.company_memberships membership
join public.profiles profile on profile.id = membership.user_id
left join auth.users auth_user on auth_user.id = membership.user_id
on conflict (company_id, user_id) where user_id is not null do nothing;

insert into public.employee_location_assignments (
  company_id,
  employee_id,
  location_id,
  is_primary,
  created_by
)
select
  location_membership.company_id,
  employee.id,
  location_membership.location_id,
  location_membership.location_id = employee.primary_location_id,
  employee.created_by
from public.location_memberships location_membership
join public.employees employee
  on employee.company_id = location_membership.company_id
 and employee.user_id = location_membership.user_id
on conflict (employee_id, location_id) do nothing;

insert into public.employee_location_assignments (
  company_id,
  employee_id,
  location_id,
  is_primary,
  created_by
)
select
  employee.company_id,
  employee.id,
  employee.primary_location_id,
  true,
  employee.created_by
from public.employees employee
where employee.primary_location_id is not null
on conflict (employee_id, location_id) do update set is_primary = true;

create or replace function private.employee_for_current_user(target_company_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select employee.id
  from public.employees employee
  where employee.company_id = target_company_id
    and employee.user_id = auth.uid()
  limit 1;
$$;

create or replace function private.can_view_employee(
  target_company_id uuid,
  target_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.employees employee
    where employee.company_id = target_company_id
      and employee.id = target_employee_id
      and private.is_company_member(target_company_id)
      and (
        employee.user_id = auth.uid()
        or private.company_role(target_company_id) in (
          'corporate_admin', 'safety_manager', 'auditor'
        )
        or (
          private.company_role(target_company_id) in ('location_manager', 'supervisor')
          and exists (
            select 1
            from public.employee_location_assignments employee_location
            where employee_location.company_id = target_company_id
              and employee_location.employee_id = target_employee_id
              and private.can_write_location(
                target_company_id,
                employee_location.location_id
              )
          )
        )
      )
  );
$$;

create or replace function private.can_manage_employee(
  target_company_id uuid,
  target_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.employees employee
    where employee.company_id = target_company_id
      and employee.id = target_employee_id
      and (
        private.can_manage_company(target_company_id)
        or (
          private.company_role(target_company_id) in ('location_manager', 'supervisor')
          and exists (
            select 1
            from public.employee_location_assignments employee_location
            where employee_location.company_id = target_company_id
              and employee_location.employee_id = target_employee_id
              and private.can_write_location(
                target_company_id,
                employee_location.location_id
              )
          )
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Safety committee minutes and attendance.
-- ---------------------------------------------------------------------------

create table public.safety_committee_meetings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid,
  scope text not null default 'location'
    check (scope in ('company', 'location')),
  title text not null check (char_length(trim(title)) between 3 and 220),
  meeting_date date not null,
  status text not null default 'draft'
    check (status in ('draft', 'finalized', 'cancelled')),
  chair_employee_id uuid,
  agenda text,
  notes text not null default '',
  decisions text,
  next_meeting_at timestamptz,
  prepared_by uuid not null references auth.users(id) on delete restrict,
  finalized_by uuid references auth.users(id) on delete restrict,
  finalized_at timestamptz,
  minutes_manifest jsonb,
  minutes_sha256 text check (minutes_sha256 is null or minutes_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, chair_employee_id)
    references public.employees(company_id, id) on delete restrict,
  check (
    (scope = 'company' and location_id is null)
    or (scope = 'location' and location_id is not null)
  ),
  check (
    (status = 'finalized' and finalized_by is not null and finalized_at is not null
      and minutes_manifest is not null and minutes_sha256 is not null)
    or status <> 'finalized'
  )
);

create index safety_committee_meetings_company_date_idx
  on public.safety_committee_meetings(company_id, meeting_date desc);
create index safety_committee_meetings_location_idx
  on public.safety_committee_meetings(company_id, location_id, status, meeting_date desc);

create table public.safety_committee_attendees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  meeting_id uuid not null,
  employee_id uuid not null,
  committee_role text not null default 'member'
    check (committee_role in ('chair', 'member', 'secretary', 'guest')),
  attendance_status text not null default 'attended'
    check (attendance_status in ('invited', 'attended', 'absent', 'excused')),
  attendance_method text not null default 'in_person'
    check (attendance_method in ('in_person', 'video', 'phone', 'other')),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (meeting_id, employee_id),
  foreign key (company_id, meeting_id)
    references public.safety_committee_meetings(company_id, id) on delete restrict,
  foreign key (company_id, employee_id)
    references public.employees(company_id, id) on delete restrict
);

create index safety_committee_attendees_employee_idx
  on public.safety_committee_attendees(company_id, employee_id, meeting_id);

create or replace function private.can_view_committee_meeting(target_meeting_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_committee_meetings meeting
    where meeting.id = target_meeting_id
      and private.is_company_member(meeting.company_id)
      and (
        private.company_role(meeting.company_id) in (
          'corporate_admin', 'safety_manager', 'auditor'
        )
        or (meeting.location_id is not null
          and private.can_access_location(meeting.company_id, meeting.location_id))
        or exists (
          select 1
          from public.safety_committee_attendees attendee
          join public.employees employee
            on employee.company_id = attendee.company_id
           and employee.id = attendee.employee_id
          where attendee.meeting_id = meeting.id
            and employee.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function private.can_write_committee_meeting(target_meeting_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_committee_meetings meeting
    where meeting.id = target_meeting_id
      and (
        private.can_manage_company(meeting.company_id)
        or (meeting.location_id is not null
          and private.can_write_location(meeting.company_id, meeting.location_id))
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Employee-owned corrective actions and committee trace.
-- ---------------------------------------------------------------------------

alter table public.corrective_actions
  add column assigned_employee_id uuid,
  add column committee_meeting_id uuid;

insert into public.employees (
  company_id,
  user_id,
  full_name,
  employment_status,
  created_by
)
select distinct
  action.company_id,
  action.assigned_to,
  coalesce(nullif(trim(profile.full_name), ''), 'Employee record'),
  'active',
  action.created_by
from public.corrective_actions action
join public.profiles profile on profile.id = action.assigned_to
left join public.employees employee
  on employee.company_id = action.company_id
 and employee.user_id = action.assigned_to
where action.assigned_to is not null
  and employee.id is null
on conflict (company_id, user_id) where user_id is not null do nothing;

update public.corrective_actions action
set assigned_employee_id = employee.id
from public.employees employee
where employee.company_id = action.company_id
  and employee.user_id = action.assigned_to
  and action.assigned_employee_id is null;

alter table public.corrective_actions
  add constraint corrective_actions_assigned_employee_fk
  foreign key (company_id, assigned_employee_id)
  references public.employees(company_id, id) on delete restrict,
  add constraint corrective_actions_committee_meeting_fk
  foreign key (company_id, committee_meeting_id)
  references public.safety_committee_meetings(company_id, id) on delete restrict;

alter table public.corrective_actions
  drop constraint if exists corrective_actions_source_type_check;

alter table public.corrective_actions
  add constraint corrective_actions_source_type_check
  check (source_type in (
    'inspection', 'incident', 'hazard', 'document', 'direct', 'committee_meeting'
  ));

alter table public.corrective_actions
  add constraint corrective_actions_committee_trace_check
  check (
    (source_type = 'committee_meeting'
      and committee_meeting_id is not null
      and source_id = committee_meeting_id)
    or (source_type <> 'committee_meeting' and committee_meeting_id is null)
  );

create index corrective_actions_employee_idx
  on public.corrective_actions(company_id, assigned_employee_id, status, due_at);
create index corrective_actions_committee_idx
  on public.corrective_actions(company_id, committee_meeting_id)
  where committee_meeting_id is not null;

-- ---------------------------------------------------------------------------
-- Training requirements and immutable completion evidence.
-- ---------------------------------------------------------------------------

alter table public.training_courses
  add column validity_months integer
    check (validity_months is null or validity_months between 1 and 240),
  add column default_retention_months integer
    check (default_retention_months is null or default_retention_months between 1 and 1200),
  add column retention_basis jsonb not null default '{"status":"review_required"}'::jsonb,
  add constraint training_courses_retention_basis_object
    check (jsonb_typeof(retention_basis) = 'object');

create table public.training_requirements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid not null,
  employee_id uuid not null,
  course_id uuid not null,
  requirement_reason text not null default 'Company safety requirement',
  cadence_months integer check (cadence_months is null or cadence_months between 1 and 240),
  retention_months integer check (retention_months is null or retention_months between 1 and 1200),
  retention_basis jsonb not null default '{"status":"review_required"}'::jsonb,
  regulatory_basis jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, employee_id)
    references public.employees(company_id, id) on delete restrict,
  foreign key (company_id, course_id)
    references public.training_courses(company_id, id) on delete restrict,
  check (jsonb_typeof(retention_basis) = 'object'),
  check (jsonb_typeof(regulatory_basis) = 'array')
);

create unique index training_requirements_active_unique
  on public.training_requirements(company_id, location_id, employee_id, course_id)
  where active;

create index training_requirements_employee_idx
  on public.training_requirements(company_id, employee_id, active);

alter table public.training_assignments
  add column employee_id uuid,
  add column requirement_id uuid,
  add column valid_until timestamptz,
  add column retain_until date,
  add column retention_status text not null default 'review_required'
    check (retention_status in ('review_required', 'calculated', 'legal_hold'));

insert into public.employees (
  company_id,
  user_id,
  full_name,
  employment_status,
  created_by
)
select distinct
  assignment.company_id,
  assignment.worker_profile_id,
  coalesce(nullif(trim(profile.full_name), ''), 'Employee record'),
  'active',
  assignment.assigned_by
from public.training_assignments assignment
join public.profiles profile on profile.id = assignment.worker_profile_id
left join public.employees employee
  on employee.company_id = assignment.company_id
 and employee.user_id = assignment.worker_profile_id
where employee.id is null
on conflict (company_id, user_id) where user_id is not null do nothing;

update public.training_assignments assignment
set employee_id = employee.id
from public.employees employee
where employee.company_id = assignment.company_id
  and employee.user_id = assignment.worker_profile_id
  and assignment.employee_id is null;

alter table public.training_assignments
  alter column worker_profile_id drop not null,
  alter column employee_id set not null,
  add constraint training_assignments_employee_fk
    foreign key (company_id, employee_id)
    references public.employees(company_id, id) on delete restrict,
  add constraint training_assignments_requirement_fk
    foreign key (company_id, requirement_id)
    references public.training_requirements(company_id, id) on delete restrict;

create index training_assignments_employee_idx
  on public.training_assignments(company_id, employee_id, status, due_at);

create table public.training_completions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid not null,
  assignment_id uuid not null unique,
  employee_id uuid not null,
  course_id uuid not null,
  course_version integer not null check (course_version > 0),
  requirement_id uuid,
  completed_at timestamptz not null,
  valid_until timestamptz,
  retain_until date,
  retention_status text not null
    check (retention_status in ('review_required', 'calculated', 'legal_hold')),
  completion_method text not null
    check (completion_method in ('in_app', 'instructor_led', 'external_record', 'practical_evaluation')),
  quiz_score numeric(5,2) check (quiz_score is null or quiz_score between 0 and 100),
  instructor_name text,
  verified_by uuid not null references auth.users(id) on delete restrict,
  requirement_snapshot jsonb not null,
  completion_manifest jsonb not null,
  completion_sha256 text not null check (completion_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, employee_id)
    references public.employees(company_id, id) on delete restrict,
  foreign key (company_id, course_id, course_version)
    references public.training_course_versions(company_id, course_id, version) on delete restrict,
  foreign key (company_id, requirement_id)
    references public.training_requirements(company_id, id) on delete restrict,
  check (jsonb_typeof(requirement_snapshot) = 'object'),
  check (jsonb_typeof(completion_manifest) = 'object')
);

create index training_completions_employee_idx
  on public.training_completions(company_id, employee_id, completed_at desc);
create index training_completions_retention_idx
  on public.training_completions(company_id, retain_until)
  where retain_until is not null;

-- ---------------------------------------------------------------------------
-- Private employee PDFs and electronic acknowledgement evidence.
-- ---------------------------------------------------------------------------

create table public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid not null,
  employee_id uuid not null,
  document_kind text not null
    check (document_kind in ('signature_request', 'signed_upload')),
  title text not null check (char_length(trim(title)) between 3 and 220),
  document_date date not null default current_date,
  status text not null default 'upload_pending'
    check (status in (
      'upload_pending', 'awaiting_signature', 'signed', 'signed_upload', 'rejected', 'void'
    )),
  original_filename text not null,
  mime_type text not null default 'application/pdf'
    check (mime_type = 'application/pdf'),
  size_bytes bigint check (size_bytes is null or size_bytes between 1 and 10485760),
  storage_path text unique,
  document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$'),
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'format_verified', 'rejected')),
  malware_scan_status text not null default 'not_scanned'
    check (malware_scan_status in ('not_scanned', 'pending', 'clean', 'rejected', 'unavailable')),
  validation_record jsonb not null default '{}'::jsonb,
  signature_intent text,
  consent_version text,
  signature_due_at timestamptz,
  retention_basis jsonb not null default '{"status":"review_required"}'::jsonb,
  retain_until date,
  legal_hold boolean not null default false,
  employee_can_view boolean not null default true,
  manager_visibility text not null default 'safety_admin_only'
    check (manager_visibility in ('safety_admin_only', 'location_management')),
  audit_visible boolean not null default false,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, employee_id)
    references public.employees(company_id, id) on delete restrict,
  check (jsonb_typeof(validation_record) = 'object'),
  check (jsonb_typeof(retention_basis) = 'object'),
  check (original_filename !~ '[/\\[:cntrl:]]'),
  check (lower(original_filename) like '%.pdf'),
  check (
    (document_kind = 'signature_request'
      and signature_intent is not null
      and consent_version is not null)
    or document_kind = 'signed_upload'
  )
);

create index employee_documents_employee_idx
  on public.employee_documents(company_id, employee_id, created_at desc);
create index employee_documents_signature_queue_idx
  on public.employee_documents(company_id, status, signature_due_at)
  where document_kind = 'signature_request';
create index employee_documents_retention_idx
  on public.employee_documents(company_id, retain_until, legal_hold)
  where retain_until is not null;

create table public.employee_document_signatures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  employee_document_id uuid not null unique,
  employee_id uuid not null,
  authenticated_actor_user_id uuid not null references auth.users(id) on delete restrict,
  facilitator_user_id uuid references auth.users(id) on delete restrict,
  signer_name_snapshot text not null,
  authenticated_actor_role_snapshot text not null,
  signature_method text not null
    check (signature_method in (
      'self_authenticated_typed_ack',
      'facilitated_in_person_typed_ack'
    )),
  identity_verification_method text not null
    check (identity_verification_method in (
      'linked_authenticated_account',
      'in_person_facilitator_attestation'
    )),
  facilitator_attestation text,
  signature_intent text not null,
  consent_version text not null,
  typed_name_confirmation text not null,
  signed_source_sha256 text not null check (signed_source_sha256 ~ '^[0-9a-f]{64}$'),
  auth_assurance jsonb not null default '{}'::jsonb,
  signature_record jsonb not null,
  signature_sha256 text not null unique check (signature_sha256 ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, employee_document_id)
    references public.employee_documents(company_id, id) on delete restrict,
  foreign key (company_id, employee_id)
    references public.employees(company_id, id) on delete restrict,
  check (jsonb_typeof(auth_assurance) = 'object'),
  check (jsonb_typeof(signature_record) = 'object')
);

create table public.employee_document_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  employee_document_id uuid not null unique,
  requested_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  state text not null default 'prepared'
    check (state in ('prepared', 'uploaded', 'committed', 'rejected', 'expired')),
  quarantine_path text not null unique,
  final_path text unique,
  declared_size_bytes bigint not null check (declared_size_bytes between 1 and 10485760),
  observed_size_bytes bigint,
  observed_sha256 text check (observed_sha256 is null or observed_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  processing_expires_at timestamptz,
  processing_token uuid,
  committed_at timestamptz,
  rejection_code text,
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, requested_by, idempotency_key),
  foreign key (company_id, employee_document_id)
    references public.employee_documents(company_id, id) on delete restrict
);

create index employee_document_upload_expiry_idx
  on public.employee_document_upload_sessions(state, expires_at);
create index employee_document_upload_processing_expiry_idx
  on public.employee_document_upload_sessions(state, processing_expires_at)
  where state = 'uploaded';

create table public.employee_document_file_access_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  employee_document_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('allowed', 'denied')),
  reason_code text not null check (reason_code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  request_id uuid not null unique,
  signed_url_expires_at timestamptz,
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (company_id, employee_document_id)
    references public.employee_documents(company_id, id) on delete restrict,
  check (
    (decision = 'allowed' and signed_url_expires_at is not null)
    or (decision = 'denied' and signed_url_expires_at is null)
  )
);

create index employee_document_access_company_idx
  on public.employee_document_file_access_events(company_id, occurred_at desc);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'employee-records-private',
  'employee-records-private',
  false,
  10485760,
  array['application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- No authenticated storage.objects policy is created for this bucket. Upload
-- tokens and five-minute download URLs are issued only by the Edge authority.

create or replace function private.can_view_employee_document(target_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.employee_documents document_record
    join public.employees employee
      on employee.company_id = document_record.company_id
     and employee.id = document_record.employee_id
    where document_record.id = target_document_id
      and private.is_company_member(document_record.company_id)
      and (
        (document_record.employee_can_view and employee.user_id = auth.uid())
        or private.can_manage_company(document_record.company_id)
        or (
          document_record.manager_visibility = 'location_management'
          and private.company_role(document_record.company_id) in ('location_manager', 'supervisor')
          and private.can_write_location(
            document_record.company_id,
            document_record.location_id
          )
        )
        or (
          document_record.audit_visible
          and private.company_role(document_record.company_id) = 'auditor'
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Guards and server-derived workflow RPCs.
-- ---------------------------------------------------------------------------

create or replace function private.guard_employee_location_consistency()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if new.is_primary then
    update public.employee_location_assignments existing
    set is_primary = false
    where existing.employee_id = new.employee_id
      and existing.id <> new.id
      and existing.is_primary;
    update public.employees
    set primary_location_id = new.location_id
    where id = new.employee_id;
  end if;
  return new;
end;
$$;

create or replace function private.guard_corrective_action_employee()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  linked_user_id uuid;
  meeting_record public.safety_committee_meetings;
begin
  if new.assigned_employee_id is not null then
    select employee.user_id
    into linked_user_id
    from public.employees employee
    where employee.company_id = new.company_id
      and employee.id = new.assigned_employee_id;
    if not found then
      raise exception 'Action owner is not an employee of this company';
    end if;
    new.assigned_to := linked_user_id;
  end if;

  if new.committee_meeting_id is not null then
    select * into meeting_record
    from public.safety_committee_meetings meeting
    where meeting.company_id = new.company_id
      and meeting.id = new.committee_meeting_id
    for key share;
    if not found
       or meeting_record.location_id is distinct from new.location_id then
      raise exception 'Committee action company and location must match the meeting';
    end if;
    if meeting_record.status = 'finalized' then
      if tg_op = 'INSERT' then
        raise exception 'Finalized meeting minutes cannot receive new action items';
      elsif old.committee_meeting_id is distinct from new.committee_meeting_id then
        raise exception 'Finalized meeting minutes cannot receive new action items';
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' and old.status = 'closed' then
    raise exception 'Closed action evidence is immutable; create an audited replacement action';
  end if;
  return new;
end;
$$;

create or replace function private.guard_finalized_committee_content()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  target_meeting_id uuid;
  target_status text;
begin
  if tg_table_name = 'safety_committee_meetings' then
    if tg_op in ('UPDATE', 'DELETE') and old.status = 'finalized' then
      raise exception 'Finalized committee minutes are immutable; create a replacement meeting record';
    end if;
    if tg_op = 'UPDATE' and new.status = 'finalized'
       and (new.minutes_manifest is null or new.minutes_sha256 is null) then
      raise exception 'Finalized minutes require the server-derived manifest and hash';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  target_meeting_id := case when tg_op = 'DELETE' then old.meeting_id else new.meeting_id end;
  select status into target_status
  from public.safety_committee_meetings
  where id = target_meeting_id
  for key share;
  if target_status = 'finalized' then
    raise exception 'Finalized committee attendance is immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function private.guard_employee_document_identity()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Employee documents are retained records; void or supersede instead';
  end if;
  if old.validation_status = 'format_verified' and (
    new.company_id is distinct from old.company_id
    or new.location_id is distinct from old.location_id
    or new.employee_id is distinct from old.employee_id
    or new.document_kind is distinct from old.document_kind
    or new.document_date is distinct from old.document_date
    or new.original_filename is distinct from old.original_filename
    or new.mime_type is distinct from old.mime_type
    or new.size_bytes is distinct from old.size_bytes
    or new.storage_path is distinct from old.storage_path
    or new.document_sha256 is distinct from old.document_sha256
    or new.signature_intent is distinct from old.signature_intent
    or new.consent_version is distinct from old.consent_version
    or new.retention_basis is distinct from old.retention_basis
    or new.retain_until is distinct from old.retain_until
  ) then
    raise exception 'Verified employee document identity and retention evidence are immutable';
  end if;
  if old.status in ('signed', 'signed_upload', 'void')
     and new.status is distinct from old.status then
    raise exception 'Terminal employee document status is immutable';
  end if;
  return new;
end;
$$;

create or replace function private.guard_training_assignment_completion()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.status = 'complete' and old.status <> 'complete'
     and not exists (
       select 1 from public.training_completions completion
       where completion.assignment_id = new.id
     ) then
    raise exception 'A completed assignment requires immutable completion evidence';
  end if;
  if tg_op = 'UPDATE' and old.status = 'complete' and (
    new.company_id is distinct from old.company_id
    or new.location_id is distinct from old.location_id
    or new.course_id is distinct from old.course_id
    or new.course_version is distinct from old.course_version
    or new.employee_id is distinct from old.employee_id
    or new.requirement_id is distinct from old.requirement_id
    or new.completed_at is distinct from old.completed_at
    or new.valid_until is distinct from old.valid_until
    or new.retain_until is distinct from old.retain_until
    or new.retention_status is distinct from old.retention_status
    or new.status is distinct from old.status
    or new.quiz_score is distinct from old.quiz_score
    or new.completion_record is distinct from old.completion_record
    or new.assigned_at is distinct from old.assigned_at
    or new.due_at is distinct from old.due_at
    or new.started_at is distinct from old.started_at
    or new.assigned_by is distinct from old.assigned_by
  ) then
    raise exception 'Completed training evidence is immutable';
  end if;
  return new;
end;
$$;

create trigger employees_touch_updated_at
before update on public.employees
for each row execute function private.touch_updated_at();

create trigger employee_location_primary_guard
before insert or update of is_primary on public.employee_location_assignments
for each row execute function private.guard_employee_location_consistency();

create trigger safety_committee_meetings_touch_updated_at
before update on public.safety_committee_meetings
for each row execute function private.touch_updated_at();

create trigger safety_committee_meetings_finalized_guard
before update or delete on public.safety_committee_meetings
for each row execute function private.guard_finalized_committee_content();

create trigger safety_committee_attendees_finalized_guard
before insert or update or delete on public.safety_committee_attendees
for each row execute function private.guard_finalized_committee_content();

create trigger corrective_actions_employee_guard
before insert or update on public.corrective_actions
for each row execute function private.guard_corrective_action_employee();

create trigger training_requirements_touch_updated_at
before update on public.training_requirements
for each row execute function private.touch_updated_at();

create trigger training_assignments_completion_guard
before update on public.training_assignments
for each row execute function private.guard_training_assignment_completion();

create trigger training_completions_append_only
before update or delete on public.training_completions
for each row execute function program_private.reject_mutation();

create trigger employee_documents_touch_updated_at
before update on public.employee_documents
for each row execute function private.touch_updated_at();

create trigger employee_documents_identity_guard
before update or delete on public.employee_documents
for each row execute function private.guard_employee_document_identity();

create trigger employee_document_signatures_append_only
before update or delete on public.employee_document_signatures
for each row execute function program_private.reject_mutation();

create trigger employee_document_access_append_only
before update or delete on public.employee_document_file_access_events
for each row execute function program_private.reject_mutation();

create or replace function private.guard_employee_document_upload_session()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Employee document upload sessions are retained security records';
  end if;
  if new.company_id is distinct from old.company_id
     or new.employee_document_id is distinct from old.employee_document_id
     or new.requested_by is distinct from old.requested_by
     or new.idempotency_key is distinct from old.idempotency_key
     or new.quarantine_path is distinct from old.quarantine_path
     or new.declared_size_bytes is distinct from old.declared_size_bytes
     or new.expires_at is distinct from old.expires_at then
    raise exception 'Employee document upload identity is immutable';
  end if;
  if old.state in ('committed', 'rejected', 'expired') then
    raise exception 'Terminal employee document upload sessions are immutable';
  end if;
  if not (
    (old.state = 'prepared' and new.state in ('uploaded', 'committed', 'rejected', 'expired'))
    or (old.state = 'uploaded' and new.state in ('committed', 'rejected', 'expired'))
    or old.state = new.state
  ) then
    raise exception 'Invalid employee document upload state transition';
  end if;
  return new;
end;
$$;

create trigger employee_document_upload_identity_guard
before update or delete on public.employee_document_upload_sessions
for each row execute function private.guard_employee_document_upload_session();

create or replace function public.create_employee(
  employee_full_name text,
  employee_location_id uuid,
  employee_number text default null,
  employee_work_email text default null,
  employee_job_title text default null,
  employee_department text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_company_id uuid;
  new_employee_id uuid;
begin
  select location.company_id
  into target_company_id
  from public.locations location
  where location.id = employee_location_id
    and location.active;

  if target_company_id is null or not private.can_manage_company(target_company_id) then
    raise exception 'Company safety-management permission is required';
  end if;
  if char_length(trim(coalesce(employee_full_name, ''))) not between 2 and 160 then
    raise exception 'Employee name must contain 2 to 160 characters';
  end if;
  if employee_work_email is not null
     and trim(employee_work_email) !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'Employee work email is invalid';
  end if;

  insert into public.employees (
    company_id,
    employee_number,
    full_name,
    work_email,
    job_title,
    department,
    primary_location_id,
    created_by
  ) values (
    target_company_id,
    nullif(trim(employee_number), ''),
    trim(employee_full_name),
    lower(nullif(trim(employee_work_email), '')),
    nullif(trim(employee_job_title), ''),
    nullif(trim(employee_department), ''),
    employee_location_id,
    auth.uid()
  )
  returning id into new_employee_id;

  insert into public.employee_location_assignments (
    company_id,
    employee_id,
    location_id,
    is_primary,
    created_by
  ) values (
    target_company_id,
    new_employee_id,
    employee_location_id,
    true,
    auth.uid()
  );

  return new_employee_id;
end;
$$;

create or replace function public.create_safety_committee_meeting(
  target_location_id uuid,
  target_title text,
  target_meeting_date date,
  target_chair_employee_id uuid,
  target_attendee_ids uuid[],
  target_agenda text default null,
  target_notes text default null,
  target_decisions text default null,
  target_next_meeting_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_company_id uuid;
  new_meeting_id uuid;
  attendee_id uuid;
begin
  select location.company_id
  into target_company_id
  from public.locations location
  where location.id = target_location_id
    and location.active;

  if target_company_id is null
     or not private.can_write_location(target_company_id, target_location_id) then
    raise exception 'Location safety-management permission is required';
  end if;
  if char_length(trim(coalesce(target_title, ''))) not between 3 and 220 then
    raise exception 'Meeting title must contain 3 to 220 characters';
  end if;
  if target_meeting_date is null
     or target_meeting_date > current_date + 366 then
    raise exception 'Meeting date is invalid';
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.company_id = target_company_id
      and employee.id = target_chair_employee_id
      and employee.employment_status <> 'separated'
  ) then
    raise exception 'Meeting chair must be an active company employee';
  end if;

  insert into public.safety_committee_meetings (
    company_id,
    location_id,
    scope,
    title,
    meeting_date,
    chair_employee_id,
    agenda,
    notes,
    decisions,
    next_meeting_at,
    prepared_by
  ) values (
    target_company_id,
    target_location_id,
    'location',
    trim(target_title),
    target_meeting_date,
    target_chair_employee_id,
    nullif(trim(target_agenda), ''),
    coalesce(trim(target_notes), ''),
    nullif(trim(target_decisions), ''),
    target_next_meeting_at,
    auth.uid()
  )
  returning id into new_meeting_id;

  foreach attendee_id in array coalesce(target_attendee_ids, '{}'::uuid[])
  loop
    if not exists (
      select 1 from public.employees employee
      where employee.company_id = target_company_id
        and employee.id = attendee_id
    ) then
      raise exception 'Every attendee must be an employee of this company';
    end if;
    insert into public.safety_committee_attendees (
      company_id,
      meeting_id,
      employee_id,
      committee_role,
      attendance_status
    ) values (
      target_company_id,
      new_meeting_id,
      attendee_id,
      case when attendee_id = target_chair_employee_id then 'chair' else 'member' end,
      'attended'
    )
    on conflict (meeting_id, employee_id) do nothing;
  end loop;

  insert into public.safety_committee_attendees (
    company_id,
    meeting_id,
    employee_id,
    committee_role,
    attendance_status
  ) values (
    target_company_id,
    new_meeting_id,
    target_chair_employee_id,
    'chair',
    'attended'
  )
  on conflict (meeting_id, employee_id) do update
    set committee_role = 'chair', attendance_status = 'attended';

  return new_meeting_id;
end;
$$;

create or replace function public.finalize_safety_committee_meeting(target_meeting_id uuid)
returns table (meeting_id uuid, minutes_sha256 text)
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  meeting_record public.safety_committee_meetings;
  manifest jsonb;
  manifest_sha256 text;
  finalized_time timestamptz := clock_timestamp();
begin
  select * into meeting_record
  from public.safety_committee_meetings meeting
  where meeting.id = target_meeting_id
  for update;

  if meeting_record.id is null
     or not private.can_write_committee_meeting(meeting_record.id) then
    raise exception 'Committee meeting is not available';
  end if;
  if meeting_record.status <> 'draft' then
    raise exception 'Only draft meeting minutes can be finalized';
  end if;
  if char_length(trim(meeting_record.notes)) < 3 then
    raise exception 'Meeting notes are required before finalization';
  end if;

  manifest := jsonb_build_object(
    'manifestVersion', 'safetyops-committee-minutes-v1',
    'meetingId', meeting_record.id,
    'companyId', meeting_record.company_id,
    'locationId', meeting_record.location_id,
    'meetingDate', meeting_record.meeting_date,
    'title', meeting_record.title,
    'chairEmployeeId', meeting_record.chair_employee_id,
    'agenda', meeting_record.agenda,
    'notes', meeting_record.notes,
    'decisions', meeting_record.decisions,
    'nextMeetingAt', meeting_record.next_meeting_at,
    'attendees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employeeId', attendee.employee_id,
        'role', attendee.committee_role,
        'attendanceStatus', attendee.attendance_status,
        'attendanceMethod', attendee.attendance_method
      ) order by attendee.employee_id)
      from public.safety_committee_attendees attendee
      where attendee.meeting_id = meeting_record.id
    ), '[]'::jsonb),
    'actionItems', coalesce((
      select jsonb_agg(jsonb_build_object(
        'actionId', action.id,
        'title', action.title,
        'assignedEmployeeId', action.assigned_employee_id,
        'dueAt', action.due_at,
        'priority', action.priority,
        'status', action.status
      ) order by action.created_at, action.id)
      from public.corrective_actions action
      where action.committee_meeting_id = meeting_record.id
    ), '[]'::jsonb),
    'finalizedBy', auth.uid(),
    'finalizedAt', to_char(finalized_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
  manifest_sha256 := encode(
    extensions.digest(convert_to(manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );

  update public.safety_committee_meetings
  set status = 'finalized',
      finalized_by = auth.uid(),
      finalized_at = finalized_time,
      minutes_manifest = manifest,
      minutes_sha256 = manifest_sha256
  where id = meeting_record.id;

  return query select meeting_record.id, manifest_sha256;
end;
$$;

create or replace function public.create_employee_corrective_action(
  target_location_id uuid,
  target_employee_id uuid,
  target_title text,
  target_description text default null,
  target_priority public.priority_level default 'medium',
  target_due_at timestamptz default null,
  target_required_evidence text default null,
  target_committee_meeting_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_company_id uuid;
  linked_user_id uuid;
  new_action_id uuid;
begin
  select location.company_id into target_company_id
  from public.locations location
  where location.id = target_location_id and location.active;

  if target_company_id is null
     or not private.can_write_location(target_company_id, target_location_id) then
    raise exception 'Location safety-management permission is required';
  end if;
  select employee.user_id into linked_user_id
  from public.employees employee
  where employee.company_id = target_company_id
    and employee.id = target_employee_id;
  if not found then
    raise exception 'Action owner must be a company employee';
  end if;
  if not exists (
    select 1 from public.employee_location_assignments assignment
    where assignment.company_id = target_company_id
      and assignment.employee_id = target_employee_id
      and assignment.location_id = target_location_id
  ) and not private.can_manage_company(target_company_id) then
    raise exception 'Action owner is outside the authorized location';
  end if;

  insert into public.corrective_actions (
    company_id,
    location_id,
    source_type,
    source_id,
    committee_meeting_id,
    title,
    description,
    priority,
    assigned_employee_id,
    assigned_to,
    due_at,
    required_evidence,
    created_by
  ) values (
    target_company_id,
    target_location_id,
    case when target_committee_meeting_id is null then 'direct' else 'committee_meeting' end,
    target_committee_meeting_id,
    target_committee_meeting_id,
    trim(target_title),
    nullif(trim(target_description), ''),
    target_priority,
    target_employee_id,
    linked_user_id,
    target_due_at,
    nullif(trim(target_required_evidence), ''),
    auth.uid()
  )
  returning id into new_action_id;

  return new_action_id;
end;
$$;

create or replace function public.assign_training_requirements(
  target_employee_ids uuid[],
  target_course_id uuid,
  target_location_id uuid,
  target_due_at timestamptz,
  target_reason text default 'Company safety requirement',
  target_cadence_months integer default null,
  target_retention_months integer default null,
  target_retention_basis jsonb default '{"status":"review_required"}'::jsonb,
  target_regulatory_basis jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  target_company_id uuid;
  current_course_version integer;
  employee_record public.employees;
  requirement_record public.training_requirements;
  inserted_count integer := 0;
begin
  select location.company_id into target_company_id
  from public.locations location
  where location.id = target_location_id and location.active;

  if target_company_id is null
     or not private.can_write_location(target_company_id, target_location_id) then
    raise exception 'Location safety-management permission is required';
  end if;
  if coalesce(array_length(target_employee_ids, 1), 0) = 0
     or array_length(target_employee_ids, 1) > 500 then
    raise exception 'Select between 1 and 500 employees';
  end if;
  if target_due_at is null then
    raise exception 'Training due date is required';
  end if;
  if target_cadence_months is not null
     and target_cadence_months not between 1 and 240 then
    raise exception 'Training cadence must be between 1 and 240 months';
  end if;
  if target_retention_months is not null
     and target_retention_months not between 1 and 1200 then
    raise exception 'Training retention must be between 1 and 1200 months';
  end if;
  if jsonb_typeof(coalesce(target_retention_basis, '{}'::jsonb)) <> 'object' then
    raise exception 'Training retention basis must be an object';
  end if;
  if jsonb_typeof(coalesce(target_regulatory_basis, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(target_regulatory_basis, '[]'::jsonb)) > 100
     or exists (
       select 1
       from jsonb_array_elements(coalesce(target_regulatory_basis, '[]'::jsonb)) basis
       where jsonb_typeof(basis) <> 'object'
     ) then
    raise exception 'Training regulatory basis must be an array of at most 100 trace objects';
  end if;

  select course.current_version
  into current_course_version
  from public.training_courses course
  join public.training_course_versions version_record
    on version_record.company_id = course.company_id
   and version_record.course_id = course.id
   and version_record.version = course.current_version
   and version_record.published
  where course.company_id = target_company_id
    and course.id = target_course_id
    and course.active;
  if current_course_version is null then
    raise exception 'A published current course version is required';
  end if;

  for employee_record in
    select employee.*
    from public.employees employee
    where employee.company_id = target_company_id
      and employee.id = any(target_employee_ids)
      and employee.employment_status <> 'separated'
  loop
    if not exists (
      select 1 from public.employee_location_assignments employee_location
      where employee_location.company_id = target_company_id
        and employee_location.employee_id = employee_record.id
        and employee_location.location_id = target_location_id
    ) then
      continue;
    end if;

    select requirement.* into requirement_record
    from public.training_requirements requirement
    where requirement.company_id = target_company_id
      and requirement.location_id = target_location_id
      and requirement.employee_id = employee_record.id
      and requirement.course_id = target_course_id
      and requirement.active
    for update;

    if requirement_record.id is null then
      insert into public.training_requirements (
        company_id,
        location_id,
        employee_id,
        course_id,
        requirement_reason,
        cadence_months,
        retention_months,
        retention_basis,
        regulatory_basis,
        created_by
      ) values (
        target_company_id,
        target_location_id,
        employee_record.id,
        target_course_id,
        coalesce(nullif(trim(target_reason), ''), 'Company safety requirement'),
        target_cadence_months,
        target_retention_months,
        case
          when target_retention_months is null
            then coalesce(target_retention_basis, '{"status":"review_required"}'::jsonb)
          else coalesce(target_retention_basis, '{}'::jsonb)
            || jsonb_build_object('status', 'reviewed', 'durationMonths', target_retention_months)
        end,
        coalesce(target_regulatory_basis, '[]'::jsonb),
        auth.uid()
      )
      returning * into requirement_record;
    else
      update public.training_requirements
      set requirement_reason = coalesce(nullif(trim(target_reason), ''), requirement_reason),
          cadence_months = target_cadence_months,
          retention_months = target_retention_months,
          retention_basis = case
            when target_retention_months is null
              then coalesce(target_retention_basis, '{"status":"review_required"}'::jsonb)
            else coalesce(target_retention_basis, '{}'::jsonb)
              || jsonb_build_object('status', 'reviewed', 'durationMonths', target_retention_months)
          end,
          regulatory_basis = coalesce(target_regulatory_basis, '[]'::jsonb)
      where id = requirement_record.id
      returning * into requirement_record;
    end if;

    if not exists (
      select 1 from public.training_assignments assignment
      where assignment.company_id = target_company_id
        and assignment.requirement_id = requirement_record.id
        and assignment.status in ('assigned', 'in_progress')
    ) then
      insert into public.training_assignments (
        company_id,
        location_id,
        course_id,
        course_version,
        employee_id,
        worker_profile_id,
        requirement_id,
        due_at,
        assigned_by
      ) values (
        target_company_id,
        target_location_id,
        target_course_id,
        current_course_version,
        employee_record.id,
        employee_record.user_id,
        requirement_record.id,
        target_due_at,
        auth.uid()
      );
      inserted_count := inserted_count + 1;
    end if;
  end loop;

  return inserted_count;
end;
$$;

create or replace function public.record_training_completion(
  target_assignment_id uuid,
  target_completed_at timestamptz,
  target_completion_method text,
  target_quiz_score numeric default null,
  target_instructor_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  assignment_record public.training_assignments;
  employee_record public.employees;
  requirement_record public.training_requirements;
  course_record public.training_courses;
  course_version_record public.training_course_versions;
  actor_role public.safetyops_role;
  completion_time timestamptz;
  calculated_valid_until timestamptz;
  calculated_retain_until date;
  calculated_retention_status text;
  requirement_snapshot jsonb;
  completion_manifest jsonb;
  completion_hash text;
  new_completion_id uuid := gen_random_uuid();
begin
  select * into assignment_record
  from public.training_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if assignment_record.id is null then
    raise exception 'Training assignment is not available';
  end if;
  select * into employee_record
  from public.employees employee
  where employee.company_id = assignment_record.company_id
    and employee.id = assignment_record.employee_id;
  actor_role := private.company_role(assignment_record.company_id);
  if not private.is_company_member(assignment_record.company_id)
     or (
       employee_record.user_id is distinct from auth.uid()
       and not (
         private.can_manage_company(assignment_record.company_id)
         or (
           private.can_manage_employee(
             assignment_record.company_id,
             assignment_record.employee_id
           )
           and private.can_write_location(
             assignment_record.company_id,
             assignment_record.location_id
           )
         )
       )
     ) then
    raise exception 'Training assignment is not available';
  end if;
  if actor_role = 'auditor' then
    raise exception 'Auditor role is read-only';
  end if;
  if assignment_record.status in ('complete', 'waived', 'expired')
     or exists (
       select 1 from public.training_completions completion
       where completion.assignment_id = assignment_record.id
     ) then
    raise exception 'Training assignment already has terminal evidence';
  end if;
  if target_completion_method not in (
    'in_app', 'instructor_led', 'external_record', 'practical_evaluation'
  ) then
    raise exception 'Completion method is invalid';
  end if;
  if employee_record.user_id = auth.uid()
     and not private.can_manage_employee(
       assignment_record.company_id,
       assignment_record.employee_id
     )
     and target_completion_method <> 'in_app' then
    raise exception 'Employees may only complete an in-app training assignment for themselves';
  end if;
  completion_time := coalesce(target_completed_at, clock_timestamp());
  if completion_time > clock_timestamp() + interval '5 minutes' then
    raise exception 'Training completion cannot be in the future';
  end if;

  select * into requirement_record
  from public.training_requirements requirement
  where requirement.id = assignment_record.requirement_id;
  select * into course_record
  from public.training_courses course
  where course.id = assignment_record.course_id;
  select * into course_version_record
  from public.training_course_versions course_version
  where course_version.company_id = assignment_record.company_id
    and course_version.course_id = assignment_record.course_id
    and course_version.version = assignment_record.course_version
    and course_version.published;
  if course_version_record.id is null then
    raise exception 'The pinned published course version is unavailable';
  end if;
  if course_version_record.passing_score is not null
     and (target_quiz_score is null
       or target_quiz_score < course_version_record.passing_score) then
    raise exception 'The recorded score does not meet the pinned course passing score';
  end if;
  if course_version_record.practical_verification_required
     and (
       target_completion_method <> 'practical_evaluation'
       or nullif(trim(target_instructor_name), '') is null
     ) then
    raise exception 'This course version requires a named practical evaluator';
  end if;

  calculated_valid_until := case
    when coalesce(requirement_record.cadence_months, course_record.validity_months) is null
      then null
    else completion_time + make_interval(
      months => coalesce(requirement_record.cadence_months, course_record.validity_months)
    )
  end;
  calculated_retain_until := case
    when coalesce(requirement_record.retention_months, course_record.default_retention_months) is null
      then null
    else (
      completion_time + make_interval(
        months => coalesce(
          requirement_record.retention_months,
          course_record.default_retention_months
        )
      )
    )::date
  end;
  calculated_retention_status := case
    when calculated_retain_until is null then 'review_required'
    else 'calculated'
  end;
  requirement_snapshot := jsonb_build_object(
    'requirementId', requirement_record.id,
    'reason', requirement_record.requirement_reason,
    'cadenceMonths', coalesce(requirement_record.cadence_months, course_record.validity_months),
    'retentionMonths', coalesce(
      requirement_record.retention_months,
      course_record.default_retention_months
    ),
    'retentionBasis', coalesce(requirement_record.retention_basis, course_record.retention_basis),
    'regulatoryBasis', coalesce(requirement_record.regulatory_basis, '[]'::jsonb)
  );
  completion_manifest := jsonb_build_object(
    'manifestVersion', 'safetyops-training-completion-v1',
    'completionId', new_completion_id,
    'assignmentId', assignment_record.id,
    'companyId', assignment_record.company_id,
    'locationId', assignment_record.location_id,
    'employeeId', assignment_record.employee_id,
    'employeeNameSnapshot', employee_record.full_name,
    'courseId', assignment_record.course_id,
    'courseTitleSnapshot', course_record.title,
    'courseVersion', assignment_record.course_version,
    'completionRules', jsonb_build_object(
      'passingScore', course_version_record.passing_score,
      'practicalVerificationRequired', course_version_record.practical_verification_required
    ),
    'completedAt', to_char(completion_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'validUntil', calculated_valid_until,
    'retainUntil', calculated_retain_until,
    'completionMethod', target_completion_method,
    'quizScore', target_quiz_score,
    'instructorName', nullif(trim(target_instructor_name), ''),
    'verifiedBy', auth.uid(),
    'verifierRole', actor_role,
    'requirement', requirement_snapshot
  );
  completion_hash := encode(
    extensions.digest(convert_to(completion_manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into public.training_completions (
    id,
    company_id,
    location_id,
    assignment_id,
    employee_id,
    course_id,
    course_version,
    requirement_id,
    completed_at,
    valid_until,
    retain_until,
    retention_status,
    completion_method,
    quiz_score,
    instructor_name,
    verified_by,
    requirement_snapshot,
    completion_manifest,
    completion_sha256
  ) values (
    new_completion_id,
    assignment_record.company_id,
    assignment_record.location_id,
    assignment_record.id,
    assignment_record.employee_id,
    assignment_record.course_id,
    assignment_record.course_version,
    assignment_record.requirement_id,
    completion_time,
    calculated_valid_until,
    calculated_retain_until,
    calculated_retention_status,
    target_completion_method,
    target_quiz_score,
    nullif(trim(target_instructor_name), ''),
    auth.uid(),
    requirement_snapshot,
    completion_manifest,
    completion_hash
  );

  update public.training_assignments
  set status = 'complete',
      completed_at = completion_time,
      quiz_score = target_quiz_score,
      valid_until = calculated_valid_until,
      retain_until = calculated_retain_until,
      retention_status = calculated_retention_status,
      completion_record = jsonb_build_object(
        'completionId', new_completion_id,
        'completionSha256', completion_hash
      )
  where id = assignment_record.id;

  return new_completion_id;
end;
$$;

create or replace function public.prepare_employee_document_upload(
  target_employee_id uuid,
  target_location_id uuid,
  target_document_kind text,
  target_title text,
  target_filename text,
  target_declared_size_bytes bigint,
  target_document_date date default current_date,
  target_signature_due_at timestamptz default null,
  target_signature_intent text default null,
  target_retention_months integer default null,
  target_retention_basis jsonb default '{"status":"review_required"}'::jsonb,
  target_employee_can_view boolean default true,
  target_manager_visibility text default 'safety_admin_only',
  target_idempotency_key uuid default gen_random_uuid()
)
returns table (
  upload_session_id uuid,
  employee_document_id uuid,
  bucket_id text,
  quarantine_path text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  employee_record public.employees;
  existing_session public.employee_document_upload_sessions;
  new_document_id uuid := gen_random_uuid();
  new_session_id uuid := gen_random_uuid();
  session_expiry timestamptz := clock_timestamp() + interval '10 minutes';
  object_path text;
  calculated_retain_until date;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id;
  if employee_record.id is null
     or not private.can_manage_employee(employee_record.company_id, employee_record.id)
     or not private.can_write_location(employee_record.company_id, target_location_id) then
    raise exception 'Employee document upload is not authorized';
  end if;
  if not exists (
    select 1 from public.employee_location_assignments employee_location
    where employee_location.company_id = employee_record.company_id
      and employee_location.employee_id = employee_record.id
      and employee_location.location_id = target_location_id
  ) and not private.can_manage_company(employee_record.company_id) then
    raise exception 'Employee is outside the authorized location';
  end if;
  if target_document_kind not in ('signature_request', 'signed_upload') then
    raise exception 'Employee document kind is invalid';
  end if;
  if target_document_kind = 'signature_request'
     and char_length(trim(coalesce(target_signature_intent, ''))) < 10 then
    raise exception 'Electronic acknowledgement intent is required';
  end if;
  if char_length(trim(coalesce(target_title, ''))) not between 3 and 220 then
    raise exception 'Document title must contain 3 to 220 characters';
  end if;
  if char_length(target_filename) not between 5 and 255
     or target_filename ~ '[/\\[:cntrl:]]'
     or lower(target_filename) not like '%.pdf' then
    raise exception 'Only a safely named PDF can be uploaded';
  end if;
  if target_declared_size_bytes not between 1 and 10485760 then
    raise exception 'Employee PDF must be between 1 byte and 10 MB';
  end if;
  if target_retention_months is not null
     and target_retention_months not between 1 and 1200 then
    raise exception 'Document retention must be between 1 and 1200 months';
  end if;
  if jsonb_typeof(coalesce(target_retention_basis, '{}'::jsonb)) <> 'object' then
    raise exception 'Document retention basis must be an object';
  end if;
  if target_manager_visibility not in ('safety_admin_only', 'location_management') then
    raise exception 'Document manager visibility is invalid';
  end if;

  select session.* into existing_session
  from public.employee_document_upload_sessions session
  where session.company_id = employee_record.company_id
    and session.requested_by = auth.uid()
    and session.idempotency_key = target_idempotency_key;
  if existing_session.id is not null then
    if existing_session.state <> 'prepared'
       or existing_session.expires_at <= clock_timestamp() then
      raise exception 'Upload idempotency key has already reached a terminal state';
    end if;
    return query select
      existing_session.id,
      existing_session.employee_document_id,
      'employee-records-private'::text,
      existing_session.quarantine_path,
      existing_session.expires_at;
    return;
  end if;

  calculated_retain_until := case
    when target_retention_months is null then null
    else (
      coalesce(target_document_date, current_date)::timestamptz
      + make_interval(months => target_retention_months)
    )::date
  end;
  object_path := concat_ws(
    '/',
    employee_record.company_id::text,
    'quarantine',
    'employee-documents',
    new_session_id::text,
    gen_random_uuid()::text || '.pdf'
  );

  insert into public.employee_documents (
    id,
    company_id,
    location_id,
    employee_id,
    document_kind,
    title,
    document_date,
    original_filename,
    size_bytes,
    signature_intent,
    consent_version,
    signature_due_at,
    retention_basis,
    retain_until,
    employee_can_view,
    manager_visibility,
    uploaded_by,
    created_by
  ) values (
    new_document_id,
    employee_record.company_id,
    target_location_id,
    employee_record.id,
    target_document_kind,
    trim(target_title),
    coalesce(target_document_date, current_date),
    target_filename,
    target_declared_size_bytes,
    case when target_document_kind = 'signature_request'
      then trim(target_signature_intent) else null end,
    case when target_document_kind = 'signature_request'
      then 'safetyops-electronic-ack-v1' else null end,
    target_signature_due_at,
    case
      when target_retention_months is null
        then coalesce(target_retention_basis, '{"status":"review_required"}'::jsonb)
      else coalesce(target_retention_basis, '{}'::jsonb)
        || jsonb_build_object('status', 'reviewed', 'durationMonths', target_retention_months)
    end,
    calculated_retain_until,
    target_employee_can_view,
    target_manager_visibility,
    auth.uid(),
    auth.uid()
  );

  insert into public.employee_document_upload_sessions (
    id,
    company_id,
    employee_document_id,
    requested_by,
    idempotency_key,
    quarantine_path,
    declared_size_bytes,
    expires_at
  ) values (
    new_session_id,
    employee_record.company_id,
    new_document_id,
    auth.uid(),
    target_idempotency_key,
    object_path,
    target_declared_size_bytes,
    session_expiry
  );

  return query select
    new_session_id,
    new_document_id,
    'employee-records-private'::text,
    object_path,
    session_expiry;
end;
$$;

create or replace function public.authorize_employee_document_upload_session(
  target_upload_session_id uuid
)
returns table (
  upload_session_id uuid,
  employee_document_id uuid,
  company_id uuid,
  quarantine_path text,
  declared_size_bytes bigint,
  expires_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, private, pg_temp
as $$
declare
  session_record public.employee_document_upload_sessions;
begin
  select * into session_record
  from public.employee_document_upload_sessions session
  where session.id = target_upload_session_id;

  if session_record.id is null
     or session_record.requested_by <> auth.uid()
     or not (
       (session_record.state = 'prepared'
         and session_record.expires_at > clock_timestamp())
       or
       (session_record.state = 'uploaded'
         and session_record.claimed_at > clock_timestamp() - interval '1 hour')
     )
     or not exists (
       select 1
        from public.employee_documents document_record
        where document_record.id = session_record.employee_document_id
          and (
            private.can_manage_company(document_record.company_id)
            or (
              private.can_manage_employee(
                document_record.company_id,
                document_record.employee_id
              )
              and private.can_write_location(
                document_record.company_id,
                document_record.location_id
              )
            )
          )
      ) then
    raise exception 'Employee document upload session is not available';
  end if;

  return query select
    session_record.id,
    session_record.employee_document_id,
    session_record.company_id,
    session_record.quarantine_path,
    session_record.declared_size_bytes,
    case
      when session_record.state = 'uploaded'
        then session_record.processing_expires_at
      else session_record.expires_at
    end;
end;
$$;

create or replace function public.commit_employee_document_upload_internal(
  target_upload_session_id uuid,
  target_processing_token uuid,
  target_final_path text,
  target_observed_size_bytes bigint,
  target_observed_sha256 text,
  target_validation_record jsonb
)
returns table (employee_document_id uuid, document_status text)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  session_record public.employee_document_upload_sessions;
  document_record public.employee_documents;
  resulting_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  select * into session_record
  from public.employee_document_upload_sessions session
  where session.id = target_upload_session_id
  for update;
  if session_record.id is null
     or session_record.state <> 'uploaded'
     or session_record.processing_token is distinct from target_processing_token
     or session_record.processing_expires_at <= clock_timestamp() then
    raise exception 'Employee document upload session cannot be committed';
  end if;
  if target_observed_size_bytes not between 1 and 10485760
     or target_observed_size_bytes <> session_record.declared_size_bytes
     or target_observed_sha256 !~ '^[0-9a-f]{64}$'
     or target_final_path !~ ('^' || session_record.company_id::text
       || '/employee-documents/[0-9a-f-]{36}/[0-9a-f]{64}[.]pdf$')
     or jsonb_typeof(coalesce(target_validation_record, '{}'::jsonb)) <> 'object' then
    raise exception 'Verified employee document metadata is invalid';
  end if;

  select * into document_record
  from public.employee_documents document_value
  where document_value.id = session_record.employee_document_id
  for update;
  -- Format verification is not malware scanning. Until a scanner or approved
  -- sanitization service attests these exact bytes, retain the document in its
  -- non-releasable upload_pending state.
  resulting_status := 'upload_pending';

  update public.employee_documents
  set status = resulting_status,
      size_bytes = target_observed_size_bytes,
      storage_path = target_final_path,
      document_sha256 = target_observed_sha256,
      validation_status = 'format_verified',
      malware_scan_status = 'unavailable',
      validation_record = target_validation_record
        || jsonb_build_object(
          'verifiedAt', clock_timestamp(),
          'malwareScanStatus', 'unavailable'
        )
  where id = document_record.id;

  update public.employee_document_upload_sessions
  set state = 'committed',
      final_path = target_final_path,
      observed_size_bytes = target_observed_size_bytes,
      observed_sha256 = target_observed_sha256,
      committed_at = clock_timestamp()
  where id = session_record.id;

  return query select document_record.id, resulting_status;
end;
$$;

create or replace function public.reject_employee_document_upload_internal(
  target_upload_session_id uuid,
  target_processing_token uuid,
  target_rejection_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  session_record public.employee_document_upload_sessions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  select * into session_record
  from public.employee_document_upload_sessions session
  where session.id = target_upload_session_id
  for update;
  if session_record.id is null
     or session_record.state in ('committed', 'rejected', 'expired') then
    return false;
  end if;
  if session_record.state = 'uploaded'
     and session_record.processing_token is distinct from target_processing_token then
    raise exception 'A stale upload worker cannot reject the active processing lease';
  end if;
  update public.employee_document_upload_sessions
  set state = 'rejected', rejection_code = target_rejection_code
  where id = session_record.id;
  update public.employee_documents
  set status = 'rejected',
      validation_status = 'rejected',
      malware_scan_status = 'rejected',
      validation_record = jsonb_build_object('rejectionCode', target_rejection_code)
  where id = session_record.employee_document_id;
  return true;
end;
$$;

create or replace function public.attest_employee_document_malware_rejection_internal(
  target_upload_session_id uuid,
  target_processing_token uuid,
  target_observed_size_bytes bigint,
  target_observed_sha256 text,
  target_validation_record jsonb,
  target_scan_record jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  session_record public.employee_document_upload_sessions;
  document_record public.employee_documents;
  scan_sha256 text := lower(trim(coalesce(target_scan_record ->> 'sha256', '')));
  scan_time timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if target_observed_size_bytes not between 1 and 10485760
     or target_observed_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(coalesce(target_validation_record, '{}'::jsonb)) <> 'object'
     or target_validation_record ->> 'validationVersion'
       <> 'safetyops-employee-pdf-format-v1'
     or target_validation_record -> 'exactBytesPreserved' <> 'true'::jsonb
     or jsonb_typeof(coalesce(target_scan_record, '{}'::jsonb)) <> 'object'
     or lower(trim(coalesce(target_scan_record ->> 'status', ''))) <> 'rejected'
     or scan_sha256 <> target_observed_sha256
     or char_length(trim(coalesce(target_scan_record ->> 'engine', ''))) not between 2 and 120
     or char_length(trim(coalesce(target_scan_record ->> 'engineVersion', ''))) not between 1 and 120
     or char_length(trim(coalesce(target_scan_record ->> 'signatureDatabaseVersion', ''))) not between 1 and 160
     or char_length(trim(coalesce(target_scan_record ->> 'scanId', ''))) not between 8 and 240 then
    raise exception 'Malware rejection attestation is incomplete or invalid';
  end if;
  begin
    scan_time := (target_scan_record ->> 'scannedAt')::timestamptz;
  exception when others then
    raise exception 'Malware scan timestamp is invalid';
  end;
  if scan_time is null
     or scan_time > clock_timestamp() + interval '5 minutes'
     or scan_time < clock_timestamp() - interval '24 hours' then
    raise exception 'Malware scan timestamp is outside the accepted window';
  end if;

  select session.* into session_record
  from public.employee_document_upload_sessions session
  where session.id = target_upload_session_id
  for update;
  if session_record.id is null
     or session_record.state <> 'uploaded'
     or session_record.processing_token is distinct from target_processing_token
     or session_record.processing_expires_at <= clock_timestamp()
     or session_record.declared_size_bytes <> target_observed_size_bytes then
    raise exception 'The upload worker does not own the active processing lease';
  end if;

  select document_value.* into document_record
  from public.employee_documents document_value
  where document_value.id = session_record.employee_document_id
  for update;
  if document_record.id is null or document_record.status <> 'upload_pending' then
    raise exception 'Employee document cannot receive malware rejection evidence';
  end if;

  update public.employee_documents
  set status = 'rejected',
      size_bytes = target_observed_size_bytes,
      document_sha256 = target_observed_sha256,
      validation_status = 'format_verified',
      malware_scan_status = 'rejected',
      validation_record = target_validation_record || jsonb_build_object(
        'verifiedAt', clock_timestamp(),
        'malwareScanStatus', 'rejected',
        'malwareScan', target_scan_record,
        'malwareScannedAt', scan_time
      )
  where id = document_record.id;

  update public.employee_document_upload_sessions
  set state = 'rejected',
      observed_size_bytes = target_observed_size_bytes,
      observed_sha256 = target_observed_sha256,
      rejection_code = 'malware_scan_rejected'
  where id = session_record.id;
  return true;
end;
$$;

-- Only the server-side file authority may convert format-verified bytes from
-- quarantine into a signable/downloadable employee record. The attestation is
-- bound to the exact SHA-256 already committed for the object.
create or replace function public.attest_employee_document_malware_scan_internal(
  target_employee_document_id uuid,
  target_document_sha256 text,
  target_scan_record jsonb
)
returns table (
  employee_document_id uuid,
  document_status text,
  malware_scan_status text
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  document_record public.employee_documents;
  scan_status text := lower(trim(coalesce(target_scan_record ->> 'status', '')));
  scan_sha256 text := lower(trim(coalesce(target_scan_record ->> 'sha256', '')));
  scan_engine text := trim(coalesce(target_scan_record ->> 'engine', ''));
  scan_engine_version text := trim(coalesce(target_scan_record ->> 'engineVersion', ''));
  scan_signature_version text := trim(coalesce(target_scan_record ->> 'signatureDatabaseVersion', ''));
  scan_id text := trim(coalesce(target_scan_record ->> 'scanId', ''));
  scan_time timestamptz;
  resulting_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(target_scan_record, '{}'::jsonb)) <> 'object'
     or scan_status not in ('clean', 'rejected')
     or scan_sha256 !~ '^[0-9a-f]{64}$'
     or scan_sha256 <> lower(coalesce(target_document_sha256, ''))
     or char_length(scan_engine) not between 2 and 120
     or char_length(scan_engine_version) not between 1 and 120
     or char_length(scan_signature_version) not between 1 and 160
     or char_length(scan_id) not between 8 and 240 then
    raise exception 'Malware scan attestation is incomplete or invalid';
  end if;
  begin
    scan_time := (target_scan_record ->> 'scannedAt')::timestamptz;
  exception when others then
    raise exception 'Malware scan timestamp is invalid';
  end;
  if scan_time is null
     or scan_time > clock_timestamp() + interval '5 minutes'
     or scan_time < clock_timestamp() - interval '24 hours' then
    raise exception 'Malware scan timestamp is outside the accepted window';
  end if;

  select document_value.* into document_record
  from public.employee_documents document_value
  where document_value.id = target_employee_document_id
  for update;
  if document_record.id is null
     or document_record.document_sha256 is distinct from scan_sha256
     or document_record.validation_status <> 'format_verified'
     or document_record.storage_path is null
     or document_record.status not in (
       'upload_pending', 'awaiting_signature', 'signed_upload'
     ) then
    raise exception 'Employee document is not eligible for this scan attestation';
  end if;

  if document_record.malware_scan_status = 'clean' then
    if scan_status <> 'clean' then
      raise exception 'A clean released document cannot be downgraded by a later scan';
    end if;
    return query select
      document_record.id,
      document_record.status,
      document_record.malware_scan_status;
    return;
  end if;
  if document_record.status <> 'upload_pending'
     or document_record.malware_scan_status not in ('not_scanned', 'pending', 'unavailable') then
    raise exception 'Employee document scan state is terminal';
  end if;

  resulting_status := case
    when scan_status = 'rejected' then 'rejected'
    when document_record.document_kind = 'signature_request' then 'awaiting_signature'
    else 'signed_upload'
  end;

  update public.employee_documents
  set status = resulting_status,
      malware_scan_status = scan_status,
      audit_visible = (scan_status = 'clean'),
      validation_record = validation_record || jsonb_build_object(
        'malwareScanStatus', scan_status,
        'malwareScan', target_scan_record,
        'malwareScannedAt', scan_time
      )
  where id = document_record.id;

  return query select document_record.id, resulting_status, scan_status;
end;
$$;

create or replace function public.authorize_employee_document_scan(
  target_employee_document_id uuid
)
returns table (
  employee_document_id uuid,
  company_id uuid,
  expected_size_bytes bigint,
  expected_sha256 text
)
language plpgsql
security definer
stable
set search_path = public, private, pg_temp
as $$
declare
  document_record public.employee_documents;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select document_value.* into document_record
  from public.employee_documents document_value
  where document_value.id = target_employee_document_id;
  if document_record.id is null
     or document_record.status <> 'upload_pending'
     or document_record.validation_status <> 'format_verified'
     or document_record.malware_scan_status not in ('not_scanned', 'pending', 'unavailable')
     or document_record.storage_path is null
     or document_record.document_sha256 is null
     or not (
       private.can_manage_company(document_record.company_id)
       or (
         private.can_manage_employee(document_record.company_id, document_record.employee_id)
         and private.can_write_location(document_record.company_id, document_record.location_id)
       )
     ) then
    raise exception 'Employee document scan is not authorized';
  end if;
  return query select
    document_record.id,
    document_record.company_id,
    document_record.size_bytes,
    document_record.document_sha256;
end;
$$;

create or replace function public.sign_employee_document(
  target_employee_document_id uuid,
  typed_name text,
  consent_confirmed boolean,
  facilitator_confirmed boolean default false
)
returns table (signature_id uuid, signature_sha256 text)
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  document_record public.employee_documents;
  employee_record public.employees;
  signer_role public.safetyops_role;
  signature_method_value text;
  identity_verification_value text;
  facilitator_user_value uuid;
  facilitator_attestation_value text;
  signed_time timestamptz := clock_timestamp();
  new_signature_id uuid := gen_random_uuid();
  normalized_typed_name text;
  normalized_employee_name text;
  assurance jsonb;
  signature_manifest jsonb;
  signature_hash text;
begin
  select * into document_record
  from public.employee_documents document_value
  where document_value.id = target_employee_document_id
  for update;

  if document_record.id is null
     or document_record.document_kind <> 'signature_request'
     or document_record.status <> 'awaiting_signature'
     or document_record.validation_status <> 'format_verified'
     or document_record.malware_scan_status <> 'clean'
     or document_record.document_sha256 is null then
    raise exception 'Electronic acknowledgement request is not available';
  end if;
  select * into employee_record
  from public.employees employee
  where employee.company_id = document_record.company_id
    and employee.id = document_record.employee_id;
  if not private.is_company_member(document_record.company_id)
     or employee_record.employment_status = 'separated'
     or (
       employee_record.user_id is distinct from auth.uid()
       and not (
         private.can_manage_company(document_record.company_id)
         or (
           private.can_manage_employee(
             document_record.company_id,
             document_record.employee_id
           )
           and private.can_write_location(
             document_record.company_id,
             document_record.location_id
           )
         )
       )
     ) then
    raise exception 'Electronic acknowledgement request is not available';
  end if;
  if not consent_confirmed then
    raise exception 'Electronic acknowledgement consent is required';
  end if;
  if employee_record.user_id = auth.uid() then
    signature_method_value := 'self_authenticated_typed_ack';
    identity_verification_value := 'linked_authenticated_account';
    facilitator_user_value := null;
    facilitator_attestation_value := null;
  else
    if not facilitator_confirmed then
      raise exception 'The authenticated facilitator must attest that the employee is present';
    end if;
    signature_method_value := 'facilitated_in_person_typed_ack';
    identity_verification_value := 'in_person_facilitator_attestation';
    facilitator_user_value := auth.uid();
    facilitator_attestation_value :=
      'Authenticated facilitator confirms the named employee was present and entered the acknowledgement on this device.';
  end if;

  normalized_typed_name := lower(regexp_replace(trim(coalesce(typed_name, '')), '\s+', ' ', 'g'));
  normalized_employee_name := lower(regexp_replace(trim(employee_record.full_name), '\s+', ' ', 'g'));
  if normalized_typed_name <> normalized_employee_name then
    raise exception 'Typed name must match the linked employee record';
  end if;
  signer_role := private.company_role(document_record.company_id);
  assurance := jsonb_build_object(
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'amr', coalesce(auth.jwt() -> 'amr', '[]'::jsonb)
  );
  signature_manifest := jsonb_build_object(
    'recordVersion', 'safetyops-employee-electronic-ack-v1',
    'signatureId', new_signature_id,
    'employeeDocumentId', document_record.id,
    'companyId', document_record.company_id,
    'locationId', document_record.location_id,
    'employeeId', employee_record.id,
    'authenticatedActorUserId', auth.uid(),
    'facilitatorUserId', facilitator_user_value,
    'signerNameSnapshot', employee_record.full_name,
    'authenticatedActorRoleSnapshot', signer_role,
    'signatureMethod', signature_method_value,
    'identityVerificationMethod', identity_verification_value,
    'facilitatorAttestation', facilitator_attestation_value,
    'signatureIntent', document_record.signature_intent,
    'consentVersion', document_record.consent_version,
    'typedNameConfirmation', trim(typed_name),
    'signedSourceSha256', document_record.document_sha256,
    'signatureDueAt', document_record.signature_due_at,
    'wasOverdue', document_record.signature_due_at is not null
      and document_record.signature_due_at < signed_time,
    'authAssurance', assurance,
    'signedAt', to_char(signed_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
  signature_hash := encode(
    extensions.digest(convert_to(signature_manifest::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into public.employee_document_signatures (
    id,
    company_id,
    employee_document_id,
    employee_id,
    authenticated_actor_user_id,
    facilitator_user_id,
    signer_name_snapshot,
    authenticated_actor_role_snapshot,
    signature_method,
    identity_verification_method,
    facilitator_attestation,
    signature_intent,
    consent_version,
    typed_name_confirmation,
    signed_source_sha256,
    auth_assurance,
    signature_record,
    signature_sha256,
    signed_at
  ) values (
    new_signature_id,
    document_record.company_id,
    document_record.id,
    employee_record.id,
    auth.uid(),
    facilitator_user_value,
    employee_record.full_name,
    signer_role::text,
    signature_method_value,
    identity_verification_value,
    facilitator_attestation_value,
    document_record.signature_intent,
    document_record.consent_version,
    trim(typed_name),
    document_record.document_sha256,
    assurance,
    signature_manifest,
    signature_hash,
    signed_time
  );

  update public.employee_documents
  set status = 'signed', signed_at = signed_time
  where id = document_record.id;

  return query select new_signature_id, signature_hash;
end;
$$;

create or replace function public.authorize_employee_document_download(
  target_employee_document_id uuid
)
returns table (
  employee_document_id uuid,
  company_id uuid,
  filename text,
  mime_type text,
  size_bytes bigint,
  content_sha256 text,
  document_status text
)
language plpgsql
security definer
stable
set search_path = public, private, pg_temp
as $$
declare
  document_record public.employee_documents;
begin
  select * into document_record
  from public.employee_documents document_value
  where document_value.id = target_employee_document_id;
  if document_record.id is null
     or not private.can_view_employee_document(document_record.id)
     or document_record.validation_status <> 'format_verified'
     or document_record.malware_scan_status <> 'clean'
     or document_record.status not in ('awaiting_signature', 'signed', 'signed_upload')
     or document_record.storage_path is null
     or document_record.document_sha256 is null then
    raise exception 'Employee document is not available';
  end if;
  return query select
    document_record.id,
    document_record.company_id,
    document_record.original_filename,
    document_record.mime_type,
    document_record.size_bytes,
    document_record.document_sha256,
    document_record.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and privileges. Personnel files expose metadata columns only; raw
-- object paths stay service-side.
-- ---------------------------------------------------------------------------

alter table public.employees enable row level security;
alter table public.employee_location_assignments enable row level security;
alter table public.safety_committee_meetings enable row level security;
alter table public.safety_committee_attendees enable row level security;
alter table public.training_requirements enable row level security;
alter table public.training_completions enable row level security;
alter table public.employee_documents enable row level security;
alter table public.employee_document_signatures enable row level security;
alter table public.employee_document_upload_sessions enable row level security;
alter table public.employee_document_file_access_events enable row level security;

create policy employees_select on public.employees
for select to authenticated
using (private.can_view_employee(company_id, id));
create policy employees_insert on public.employees
for insert to authenticated
with check (private.can_manage_company(company_id) and created_by = auth.uid());
create policy employees_update on public.employees
for update to authenticated
using (private.can_manage_employee(company_id, id))
with check (private.can_manage_employee(company_id, id));

create policy employee_location_assignments_select
on public.employee_location_assignments
for select to authenticated
using (private.can_view_employee(company_id, employee_id));
create policy employee_location_assignments_insert
on public.employee_location_assignments
for insert to authenticated
with check (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
  and created_by = auth.uid()
);
create policy employee_location_assignments_update
on public.employee_location_assignments
for update to authenticated
using (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
)
with check (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
);

create policy safety_committee_meetings_select
on public.safety_committee_meetings
for select to authenticated
using (private.can_view_committee_meeting(id));
create policy safety_committee_meetings_insert
on public.safety_committee_meetings
for insert to authenticated
with check (
  prepared_by = auth.uid()
  and (
    private.can_manage_company(company_id)
    or (location_id is not null and private.can_write_location(company_id, location_id))
  )
);
create policy safety_committee_meetings_update
on public.safety_committee_meetings
for update to authenticated
using (private.can_write_committee_meeting(id))
with check (
  private.can_manage_company(company_id)
  or (location_id is not null and private.can_write_location(company_id, location_id))
);

create policy safety_committee_attendees_select
on public.safety_committee_attendees
for select to authenticated
using (private.can_view_committee_meeting(meeting_id));
create policy safety_committee_attendees_insert
on public.safety_committee_attendees
for insert to authenticated
with check (private.can_write_committee_meeting(meeting_id));
create policy safety_committee_attendees_update
on public.safety_committee_attendees
for update to authenticated
using (private.can_write_committee_meeting(meeting_id))
with check (private.can_write_committee_meeting(meeting_id));

drop policy if exists corrective_actions_select on public.corrective_actions;
create policy corrective_actions_select on public.corrective_actions
for select to authenticated
using (
  private.can_access_location(company_id, location_id)
  and (
    assigned_to = auth.uid()
    or exists (
      select 1 from public.employees employee
      where employee.company_id = corrective_actions.company_id
        and employee.id = corrective_actions.assigned_employee_id
        and employee.user_id = auth.uid()
    )
    or private.can_write_location(company_id, location_id)
    or private.can_manage_company(company_id)
    or private.company_role(company_id) = 'auditor'
  )
);

create policy training_requirements_select on public.training_requirements
for select to authenticated
using (private.can_view_employee(company_id, employee_id));
create policy training_requirements_insert on public.training_requirements
for insert to authenticated
with check (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
  and created_by = auth.uid()
);
create policy training_requirements_update on public.training_requirements
for update to authenticated
using (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
)
with check (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
);

drop policy if exists training_assignments_select on public.training_assignments;
create policy training_assignments_select on public.training_assignments
for select to authenticated
using (private.can_view_employee(company_id, employee_id));

drop policy if exists training_assignments_insert on public.training_assignments;
create policy training_assignments_insert on public.training_assignments
for insert to authenticated
with check (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
);

drop policy if exists training_assignments_update on public.training_assignments;
create policy training_assignments_update on public.training_assignments
for update to authenticated
using (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
)
with check (
  private.can_manage_employee(company_id, employee_id)
  and private.can_write_location(company_id, location_id)
);

create policy training_completions_select on public.training_completions
for select to authenticated
using (private.can_view_employee(company_id, employee_id));

create policy employee_documents_select on public.employee_documents
for select to authenticated
using (private.can_view_employee_document(id));

create policy employee_document_signatures_select
on public.employee_document_signatures
for select to authenticated
using (private.can_view_employee_document(employee_document_id));

-- Upload sessions and file-access events intentionally have no authenticated
-- policies. Only security-definer RPCs and the service Edge authority use them.

revoke all on table public.employee_document_upload_sessions
  from public, anon, authenticated;
revoke all on table public.employee_document_file_access_events
  from public, anon, authenticated;
grant select, insert, update on table public.employee_document_upload_sessions
  to service_role;
grant select, insert on table public.employee_document_file_access_events
  to service_role;
grant select, insert, update on table public.employee_documents to service_role;

grant select, insert, update on table public.employees to authenticated;
grant select, insert, update on table public.employee_location_assignments to authenticated;
grant select, insert, update on table public.safety_committee_meetings to authenticated;
grant select, insert, update on table public.safety_committee_attendees to authenticated;
grant select, insert, update on table public.training_requirements to authenticated;
grant select on table public.training_completions to authenticated;

revoke all on table public.employee_documents from public, anon, authenticated;
grant select (
  id, company_id, location_id, employee_id, document_kind, title,
  document_date, status, original_filename, mime_type, size_bytes,
  document_sha256, validation_status, malware_scan_status,
  signature_intent, consent_version, signature_due_at, retention_basis,
  retain_until, legal_hold, employee_can_view, manager_visibility,
  audit_visible, uploaded_by, created_by, signed_at, created_at, updated_at
) on table public.employee_documents to authenticated;
grant select on table public.employee_document_signatures to authenticated;

revoke all on function public.create_employee(text, uuid, text, text, text, text) from public;
revoke all on function public.create_safety_committee_meeting(uuid, text, date, uuid, uuid[], text, text, text, timestamptz) from public;
revoke all on function public.finalize_safety_committee_meeting(uuid) from public;
revoke all on function public.create_employee_corrective_action(uuid, uuid, text, text, public.priority_level, timestamptz, text, uuid) from public;
revoke all on function public.assign_training_requirements(uuid[], uuid, uuid, timestamptz, text, integer, integer, jsonb, jsonb) from public;
revoke all on function public.record_training_completion(uuid, timestamptz, text, numeric, text) from public;
revoke all on function public.prepare_employee_document_upload(uuid, uuid, text, text, text, bigint, date, timestamptz, text, integer, jsonb, boolean, text, uuid) from public;
revoke all on function public.authorize_employee_document_upload_session(uuid) from public;
revoke all on function public.commit_employee_document_upload_internal(uuid, uuid, text, bigint, text, jsonb) from public;
revoke all on function public.reject_employee_document_upload_internal(uuid, uuid, text) from public;
revoke all on function public.attest_employee_document_malware_rejection_internal(uuid, uuid, bigint, text, jsonb, jsonb) from public;
revoke all on function public.attest_employee_document_malware_scan_internal(uuid, text, jsonb) from public;
revoke all on function public.authorize_employee_document_scan(uuid) from public;
revoke all on function public.sign_employee_document(uuid, text, boolean, boolean) from public;
revoke all on function public.authorize_employee_document_download(uuid) from public;

grant execute on function public.create_employee(text, uuid, text, text, text, text) to authenticated;
grant execute on function public.create_safety_committee_meeting(uuid, text, date, uuid, uuid[], text, text, text, timestamptz) to authenticated;
grant execute on function public.finalize_safety_committee_meeting(uuid) to authenticated;
grant execute on function public.create_employee_corrective_action(uuid, uuid, text, text, public.priority_level, timestamptz, text, uuid) to authenticated;
grant execute on function public.assign_training_requirements(uuid[], uuid, uuid, timestamptz, text, integer, integer, jsonb, jsonb) to authenticated;
grant execute on function public.record_training_completion(uuid, timestamptz, text, numeric, text) to authenticated;
grant execute on function public.prepare_employee_document_upload(uuid, uuid, text, text, text, bigint, date, timestamptz, text, integer, jsonb, boolean, text, uuid) to authenticated;
grant execute on function public.authorize_employee_document_upload_session(uuid) to authenticated;
grant execute on function public.sign_employee_document(uuid, text, boolean, boolean) to authenticated;
grant execute on function public.authorize_employee_document_download(uuid) to authenticated;
grant execute on function public.commit_employee_document_upload_internal(uuid, uuid, text, bigint, text, jsonb) to service_role;
grant execute on function public.reject_employee_document_upload_internal(uuid, uuid, text) to service_role;
grant execute on function public.attest_employee_document_malware_rejection_internal(uuid, uuid, bigint, text, jsonb, jsonb) to service_role;
grant execute on function public.attest_employee_document_malware_scan_internal(uuid, text, jsonb) to service_role;
grant execute on function public.authorize_employee_document_scan(uuid) to authenticated;

-- The legacy self-completion RPC accepts caller-authored evidence JSON. The new
-- completion RPC creates a server-owned immutable manifest instead.
revoke execute on function public.complete_my_training_assignment(uuid, numeric, jsonb)
  from authenticated;

-- Auditors are database-authoritatively read-only on every new mutable table.
do $$
declare
  guarded_table text;
begin
  foreach guarded_table in array array[
    'employees',
    'employee_location_assignments',
    'safety_committee_meetings',
    'safety_committee_attendees',
    'training_requirements',
    'training_completions',
    'employee_documents',
    'employee_document_signatures'
  ]
  loop
    execute format(
      'create trigger %I before insert or update or delete on public.%I for each row execute function private.prevent_auditor_operational_write()',
      'lfes_prevent_auditor_write',
      guarded_table
    );
  end loop;
end;
$$;

-- Add workflow records to the existing company hash-chain audit ledger. Raw
-- note/file content is represented by row digests, not copied into the event.
do $$
declare
  audited_table text;
begin
  foreach audited_table in array array[
    'safety_committee_meetings',
    'safety_committee_attendees',
    'training_requirements',
    'training_completions',
    'employee_documents',
    'employee_document_signatures'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function program_private.capture_audit_event()',
      'safetyops_workflow_' || audited_table || '_audit',
      audited_table
    );
  end loop;
end;
$$;

create trigger safetyops_workflow_corrective_actions_audit
after insert or update or delete on public.corrective_actions
for each row execute function program_private.capture_audit_event();

create trigger safetyops_workflow_training_assignments_audit
after insert or update or delete on public.training_assignments
for each row execute function program_private.capture_audit_event();

comment on table public.employees is
  'Tenant employee directory; user_id is optional so safety records do not require an Auth account.';
comment on table public.training_completions is
  'Append-only, server-derived training completion and retention evidence.';
comment on table public.employee_document_signatures is
  'Append-only electronic acknowledgement evidence bound to an exact employee PDF SHA-256.';
comment on column public.employee_documents.malware_scan_status is
  'Format verification is not malware scanning. unavailable must remain visible until a scanner attests clean bytes.';

-- ---------------------------------------------------------------------------
-- Facilitated employee forms.
--
-- The safety user starts a short-lived, one-time ceremony in a separate
-- no-opener browser tab. That tab uses only the anonymous publishable key and
-- the ceremony capability; it never receives the facilitator's authenticated
-- Supabase session. The employee therefore does not need an Auth account.
-- ---------------------------------------------------------------------------

create unique index employee_location_company_employee_location_unique
  on public.employee_location_assignments(company_id, employee_id, location_id);

create table public.employee_form_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid not null,
  employee_id uuid not null,
  program_version_id uuid not null,
  form_template_version_id uuid not null,
  title text not null check (char_length(trim(title)) between 2 and 220),
  instructions text not null default '',
  status text not null default 'assigned'
    check (status in ('assigned', 'in_progress', 'completed', 'cancelled', 'expired')),
  due_at timestamptz,
  assigned_by uuid not null references auth.users(id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, employee_id, location_id)
    references public.employee_location_assignments(company_id, employee_id, location_id)
    on delete restrict,
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(company_id, program_version_id, id)
    on delete restrict,
  check (
    (status = 'assigned' and started_at is null and completed_at is null)
    or (status = 'in_progress' and started_at is not null and completed_at is null)
    or (status = 'completed' and started_at is not null and completed_at is not null)
    or status in ('cancelled', 'expired')
  )
);

create index employee_form_assignments_queue_idx
  on public.employee_form_assignments(company_id, location_id, status, due_at);
create index employee_form_assignments_employee_idx
  on public.employee_form_assignments(company_id, employee_id, assigned_at desc);
create unique index employee_form_assignments_one_open_idx
  on public.employee_form_assignments(employee_id, location_id, form_template_version_id)
  where status in ('assigned', 'in_progress');

create table public.employee_form_handoff_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  assignment_id uuid not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'consumed', 'revoked', 'expired')),
  facilitator_user_id uuid not null references auth.users(id) on delete restrict,
  facilitator_name_snapshot text not null,
  facilitator_role_snapshot text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  unique (company_id, id),
  foreign key (company_id, assignment_id)
    references public.employee_form_assignments(company_id, id) on delete restrict,
  check (expires_at > created_at),
  check ((status = 'consumed' and consumed_at is not null) or status <> 'consumed')
);

create unique index employee_form_handoff_one_active_idx
  on public.employee_form_handoff_sessions(assignment_id)
  where status = 'active';
create index employee_form_handoff_expiry_idx
  on public.employee_form_handoff_sessions(status, expires_at);

create table public.employee_form_submissions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid not null,
  assignment_id uuid not null unique,
  employee_id uuid not null,
  program_version_id uuid not null,
  form_template_version_id uuid not null,
  handoff_session_id uuid not null unique,
  facilitator_user_id uuid not null references auth.users(id) on delete restrict,
  employee_name_snapshot text not null,
  employee_number_snapshot text,
  facilitator_name_snapshot text not null,
  facilitator_role_snapshot text not null,
  identity_verification_method text not null default 'in_person_one_time_handoff'
    check (identity_verification_method = 'in_person_one_time_handoff'),
  form_schema_sha256 text not null check (form_schema_sha256 ~ '^[0-9a-f]{64}$'),
  field_evidence jsonb not null,
  answers jsonb not null,
  signature_intent text not null,
  consent_version text not null,
  typed_name_confirmation text not null,
  employee_attestation text not null,
  was_overdue boolean not null,
  submitted_at timestamptz not null default clock_timestamp(),
  submission_manifest jsonb not null,
  submission_sha256 text not null unique check (submission_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, assignment_id)
    references public.employee_form_assignments(company_id, id) on delete restrict,
  foreign key (company_id, employee_id, location_id)
    references public.employee_location_assignments(company_id, employee_id, location_id)
    on delete restrict,
  foreign key (company_id, program_version_id, form_template_version_id)
    references public.safety_program_form_template_versions(company_id, program_version_id, id)
    on delete restrict,
  foreign key (company_id, handoff_session_id)
    references public.employee_form_handoff_sessions(company_id, id) on delete restrict,
  check (jsonb_typeof(field_evidence) = 'array'),
  check (jsonb_typeof(answers) = 'object'),
  check (jsonb_typeof(submission_manifest) = 'object')
);

create index employee_form_submissions_employee_idx
  on public.employee_form_submissions(company_id, employee_id, submitted_at desc);

create or replace function private.can_view_employee_at_location(
  target_company_id uuid,
  target_employee_id uuid,
  target_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.employees employee
    join public.employee_location_assignments employee_location
      on employee_location.company_id = employee.company_id
     and employee_location.employee_id = employee.id
     and employee_location.location_id = target_location_id
    where employee.company_id = target_company_id
      and employee.id = target_employee_id
      and private.is_company_member(target_company_id)
      and (
        employee.user_id = auth.uid()
        or private.company_role(target_company_id) in (
          'corporate_admin', 'safety_manager', 'auditor'
        )
        or (
          private.company_role(target_company_id) in ('location_manager', 'supervisor')
          and private.can_write_location(target_company_id, target_location_id)
        )
      )
  );
$$;

create or replace function private.guard_employee_form_assignment()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Employee form assignments are retained records';
  end if;
  if new.company_id is distinct from old.company_id
     or new.location_id is distinct from old.location_id
     or new.employee_id is distinct from old.employee_id
     or new.program_version_id is distinct from old.program_version_id
     or new.form_template_version_id is distinct from old.form_template_version_id
     or new.assigned_by is distinct from old.assigned_by
     or new.assigned_at is distinct from old.assigned_at then
    raise exception 'Employee form assignment identity is immutable';
  end if;
  if old.status in ('completed', 'cancelled', 'expired') then
    raise exception 'Terminal employee form assignments are immutable';
  end if;
  if not (
    old.status = new.status
    or (old.status = 'assigned' and new.status in ('in_progress', 'cancelled', 'expired'))
    or (old.status = 'in_progress' and new.status in ('completed', 'cancelled', 'expired'))
  ) then
    raise exception 'Invalid employee form assignment state transition';
  end if;
  return new;
end;
$$;

create or replace function private.guard_employee_form_handoff()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Employee handoff sessions are retained security records';
  end if;
  if new.company_id is distinct from old.company_id
     or new.assignment_id is distinct from old.assignment_id
     or new.token_sha256 is distinct from old.token_sha256
     or new.facilitator_user_id is distinct from old.facilitator_user_id
     or new.facilitator_name_snapshot is distinct from old.facilitator_name_snapshot
     or new.facilitator_role_snapshot is distinct from old.facilitator_role_snapshot
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Employee handoff identity is immutable';
  end if;
  if old.status <> 'active' and new is distinct from old then
    raise exception 'Terminal employee handoff sessions are immutable';
  end if;
  if old.status = 'active' and new.status not in ('active', 'consumed', 'revoked', 'expired') then
    raise exception 'Invalid employee handoff state transition';
  end if;
  return new;
end;
$$;

create trigger employee_form_assignments_touch
before update on public.employee_form_assignments
for each row execute function private.touch_updated_at();

create trigger employee_form_assignments_guard
before update or delete on public.employee_form_assignments
for each row execute function private.guard_employee_form_assignment();

create trigger employee_form_handoffs_guard
before update or delete on public.employee_form_handoff_sessions
for each row execute function private.guard_employee_form_handoff();

create trigger employee_form_submissions_append_only
before update or delete on public.employee_form_submissions
for each row execute function program_private.reject_mutation();

create or replace function public.assign_employee_form(
  target_employee_id uuid,
  target_location_id uuid,
  target_form_template_version_id uuid,
  target_due_at timestamptz default null,
  target_title text default null,
  target_instructions text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  employee_record public.employees;
  form_record public.safety_program_form_template_versions;
  assignment_id uuid;
  actor_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select employee.* into employee_record
  from public.employees employee
  join public.employee_location_assignments employee_location
    on employee_location.company_id = employee.company_id
   and employee_location.employee_id = employee.id
   and employee_location.location_id = target_location_id
  where employee.id = target_employee_id
    and employee.employment_status = 'active';
  if not found then
    raise exception 'An active employee assigned to this location is required';
  end if;

  actor_role := private.company_role(employee_record.company_id);
  if actor_role is null
     or not (
       private.can_manage_company(employee_record.company_id)
       or (
         actor_role in ('location_manager', 'supervisor')
         and private.can_write_location(employee_record.company_id, target_location_id)
       )
     ) then
    raise exception 'You cannot assign employee forms at this location'
      using errcode = '42501';
  end if;

  select form_version.* into form_record
  from public.safety_program_form_template_versions form_version
  where form_version.company_id = employee_record.company_id
    and form_version.id = target_form_template_version_id
    and form_version.status = 'published';
  if not found then
    raise exception 'A published employee form version is required';
  end if;

  perform program_private.require_current_form_applicability(
    employee_record.company_id,
    form_record.program_version_id,
    target_location_id,
    form_record.id,
    form_record.schema_sha256
  );

  if exists (
    select 1
    from public.safety_program_form_fields field_record
    where field_record.form_template_version_id = form_record.id
      and field_record.field_type = 'file'
  ) then
    raise exception 'Employee tablet forms with file fields are not supported yet';
  end if;

  insert into public.employee_form_assignments (
    company_id,
    location_id,
    employee_id,
    program_version_id,
    form_template_version_id,
    title,
    instructions,
    due_at,
    assigned_by
  ) values (
    employee_record.company_id,
    target_location_id,
    employee_record.id,
    form_record.program_version_id,
    form_record.id,
    coalesce(nullif(trim(target_title), ''), form_record.title),
    coalesce(target_instructions, form_record.instructions_markdown, ''),
    target_due_at,
    auth.uid()
  )
  returning id into assignment_id;

  return assignment_id;
end;
$$;

create or replace function public.begin_employee_form_handoff(
  target_assignment_id uuid
)
returns table (
  handoff_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  assignment_record public.employee_form_assignments;
  employee_record public.employees;
  actor_role text;
  actor_name text;
  raw_token text;
  expiry timestamptz := clock_timestamp() + interval '15 minutes';
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select assignment.* into assignment_record
  from public.employee_form_assignments assignment
  where assignment.id = target_assignment_id
  for update;
  if not found or assignment_record.status not in ('assigned', 'in_progress') then
    raise exception 'An open employee form assignment is required';
  end if;

  select employee.* into employee_record
  from public.employees employee
  where employee.company_id = assignment_record.company_id
    and employee.id = assignment_record.employee_id
    and employee.employment_status = 'active';
  if not found then
    raise exception 'The assigned employee is not active';
  end if;

  actor_role := private.company_role(assignment_record.company_id);
  if actor_role is null
     or not (
       private.can_manage_company(assignment_record.company_id)
       or (
         actor_role in ('location_manager', 'supervisor')
         and private.can_write_location(
           assignment_record.company_id,
           assignment_record.location_id
         )
       )
     ) then
    raise exception 'You cannot facilitate this employee form' using errcode = '42501';
  end if;

  select coalesce(nullif(trim(profile.full_name), ''), auth.uid()::text)
  into actor_name
  from public.profiles profile
  where profile.id = auth.uid();

  update public.employee_form_handoff_sessions session
  set status = case
        when session.expires_at <= clock_timestamp() then 'expired'
        else 'revoked'
      end
  where session.assignment_id = assignment_record.id
    and session.status = 'active';

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.employee_form_handoff_sessions (
    company_id,
    assignment_id,
    token_sha256,
    facilitator_user_id,
    facilitator_name_snapshot,
    facilitator_role_snapshot,
    expires_at
  ) values (
    assignment_record.company_id,
    assignment_record.id,
    encode(extensions.digest(convert_to(raw_token, 'UTF8'), 'sha256'), 'hex'),
    auth.uid(),
    coalesce(actor_name, auth.uid()::text),
    actor_role,
    expiry
  );

  if assignment_record.status = 'assigned' then
    update public.employee_form_assignments
    set status = 'in_progress',
        started_at = clock_timestamp()
    where id = assignment_record.id;
  end if;

  return query select raw_token, expiry;
end;
$$;

create or replace function public.expire_employee_form_handoffs_internal()
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  expired_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role is required' using errcode = '42501';
  end if;

  update public.employee_form_handoff_sessions session
  set status = 'expired'
  where session.status = 'active'
    and session.expires_at <= clock_timestamp();
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

create or replace function public.get_employee_form_handoff(
  target_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  session_record public.employee_form_handoff_sessions;
  assignment_record public.employee_form_assignments;
  session_lookup_id uuid;
  result_record jsonb;
begin
  if target_token is null or target_token !~ '^[0-9a-f]{64}$' then
    raise exception 'The handoff link is invalid' using errcode = '22023';
  end if;

  select session.* into session_record
  from public.employee_form_handoff_sessions session
  where session.token_sha256 = encode(
    extensions.digest(convert_to(target_token, 'UTF8'), 'sha256'),
    'hex'
  );
  if not found then
    raise exception 'The handoff link is expired or already used' using errcode = '42501';
  end if;
  session_lookup_id := session_record.id;

  select assignment.* into assignment_record
  from public.employee_form_assignments assignment
  where assignment.company_id = session_record.company_id
    and assignment.id = session_record.assignment_id
  for update;
  if not found or assignment_record.status <> 'in_progress' then
    raise exception 'The employee form is no longer available' using errcode = '42501';
  end if;

  select session.* into session_record
  from public.employee_form_handoff_sessions session
  where session.id = session_lookup_id
    and session.token_sha256 = encode(
      extensions.digest(convert_to(target_token, 'UTF8'), 'sha256'),
      'hex'
    )
  for update;
  if not found or session_record.status <> 'active'
     or session_record.expires_at <= clock_timestamp() then
    raise exception 'The handoff link is expired or already used' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'handoffVersion', 'safetyops-employee-handoff-v1',
    'assignmentId', assignment_record.id,
    'title', assignment_record.title,
    'instructions', assignment_record.instructions,
    'dueAt', assignment_record.due_at,
    'expiresAt', session_record.expires_at,
    'companyName', company_record.name,
    'locationName', location_record.name,
    'employeeName', employee.full_name,
    'formTemplateVersionId', form_version.id,
    'formVersion', form_version.version,
    'formSchemaSha256', form_version.schema_sha256,
    'programVersionId', form_version.program_version_id,
    'fields', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', field_record.id,
          'key', field_record.field_key,
          'type', field_record.field_type,
          'label', field_record.label,
          'helpText', field_record.help_text,
          'placeholder', field_record.placeholder,
          'required', field_record.required,
          'sortOrder', field_record.sort_order,
          'options', field_record.options,
          'validationRules', field_record.validation_rules,
          'displayLogic', field_record.display_logic,
          'fieldSha256', field_record.field_sha256
        ) order by field_record.sort_order
      )
      from public.safety_program_form_fields field_record
      where field_record.company_id = assignment_record.company_id
        and field_record.form_template_version_id = form_version.id
    ), '[]'::jsonb)
  ) into result_record
  from public.companies company_record
  join public.locations location_record
    on location_record.company_id = company_record.id
   and location_record.id = assignment_record.location_id
  join public.employees employee
    on employee.company_id = company_record.id
   and employee.id = assignment_record.employee_id
  join public.safety_program_form_template_versions form_version
    on form_version.company_id = company_record.id
   and form_version.id = assignment_record.form_template_version_id
   and form_version.status = 'published'
  where company_record.id = assignment_record.company_id;

  if result_record is null then
    raise exception 'The pinned employee form schema is unavailable';
  end if;
  return result_record;
end;
$$;

create or replace function private.employee_form_handoff_value_is_empty(
  target_value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
  if target_value is null or target_value = 'null'::jsonb then
    return true;
  end if;
  if jsonb_typeof(target_value) = 'string' then
    return btrim(target_value #>> '{}') = '';
  end if;
  if jsonb_typeof(target_value) = 'array' then
    return jsonb_array_length(target_value) = 0;
  end if;
  if jsonb_typeof(target_value) = 'object' then
    return target_value = '{}'::jsonb;
  end if;
  return false;
end;
$$;

create or replace function private.employee_form_handoff_display_matches(
  target_rule jsonb,
  target_answers jsonb,
  target_depth integer default 0
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, private, pg_temp
as $$
declare
  rule_key_count integer;
  child_rule jsonb;
  actual_value jsonb;
  expected_value jsonb;
  target_field_key text;
  target_operator text;
  actual_is_empty boolean;
begin
  if target_depth < 0 or target_depth > 16 then
    raise exception 'Employee form display logic exceeds the nesting limit'
      using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(target_rule, 'null'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(target_answers, 'null'::jsonb)) <> 'object' then
    raise exception 'Employee form display logic is malformed'
      using errcode = '23514';
  end if;
  if target_rule = '{}'::jsonb then
    return true;
  end if;

  select count(*) into rule_key_count
  from jsonb_object_keys(target_rule);

  if target_rule ? 'all' then
    if rule_key_count <> 1 or jsonb_typeof(target_rule -> 'all') <> 'array'
       or jsonb_array_length(target_rule -> 'all') = 0 then
      raise exception 'Employee form display logic all must be a non-empty condition array'
        using errcode = '23514';
    end if;
    for child_rule in
      select child.value
      from jsonb_array_elements(target_rule -> 'all') as child(value)
    loop
      if not private.employee_form_handoff_display_matches(
        child_rule,
        target_answers,
        target_depth + 1
      ) then
        return false;
      end if;
    end loop;
    return true;
  elsif target_rule ? 'any' then
    if rule_key_count <> 1 or jsonb_typeof(target_rule -> 'any') <> 'array'
       or jsonb_array_length(target_rule -> 'any') = 0 then
      raise exception 'Employee form display logic any must be a non-empty condition array'
        using errcode = '23514';
    end if;
    for child_rule in
      select child.value
      from jsonb_array_elements(target_rule -> 'any') as child(value)
    loop
      if private.employee_form_handoff_display_matches(
        child_rule,
        target_answers,
        target_depth + 1
      ) then
        return true;
      end if;
    end loop;
    return false;
  elsif target_rule ? 'not' then
    if rule_key_count <> 1 or jsonb_typeof(target_rule -> 'not') <> 'object' then
      raise exception 'Employee form display logic not must contain one condition'
        using errcode = '23514';
    end if;
    return not private.employee_form_handoff_display_matches(
      target_rule -> 'not',
      target_answers,
      target_depth + 1
    );
  end if;

  if exists (
    select 1
    from jsonb_object_keys(target_rule) as rule_keys(rule_key)
    where rule_key not in ('fieldKey', 'operator', 'value')
  ) or not (target_rule ? 'fieldKey')
     or not (target_rule ? 'operator')
     or jsonb_typeof(target_rule -> 'fieldKey') <> 'string'
     or jsonb_typeof(target_rule -> 'operator') <> 'string' then
    raise exception 'Employee form display condition is malformed'
      using errcode = '23514';
  end if;

  target_field_key := target_rule ->> 'fieldKey';
  target_operator := target_rule ->> 'operator';
  if target_field_key !~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$' then
    raise exception 'Employee form display condition has an invalid field key'
      using errcode = '23514';
  end if;
  if target_operator not in (
    'equals', 'notEquals', 'in', 'notIn', 'contains', 'notContains',
    'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'
  ) then
    raise exception 'Unsupported employee form display operator: %', target_operator
      using errcode = '23514';
  end if;
  if target_operator in (
    'equals', 'notEquals', 'in', 'notIn', 'contains', 'notContains'
  ) and not (target_rule ? 'value') then
    raise exception 'Employee form display operator % requires a value', target_operator
      using errcode = '23514';
  elsif target_operator in ('isEmpty', 'isNotEmpty', 'isTrue', 'isFalse')
        and target_rule ? 'value' then
    raise exception 'Employee form display operator % does not accept a value', target_operator
      using errcode = '23514';
  end if;

  actual_value := target_answers -> target_field_key;
  expected_value := target_rule -> 'value';
  actual_is_empty := private.employee_form_handoff_value_is_empty(actual_value);

  if target_operator = 'isEmpty' then
    return actual_is_empty;
  elsif target_operator = 'isNotEmpty' then
    return not actual_is_empty;
  elsif target_operator = 'isTrue' then
    return coalesce(
      jsonb_typeof(actual_value) = 'boolean' and actual_value = 'true'::jsonb,
      false
    );
  elsif target_operator = 'isFalse' then
    return coalesce(
      jsonb_typeof(actual_value) = 'boolean' and actual_value = 'false'::jsonb,
      false
    );
  elsif actual_is_empty then
    return false;
  elsif target_operator = 'equals' then
    return actual_value = expected_value;
  elsif target_operator = 'notEquals' then
    return actual_value is distinct from expected_value;
  elsif target_operator in ('in', 'notIn') then
    if jsonb_typeof(expected_value) <> 'array' then
      raise exception 'Employee form display operator % requires an array value', target_operator
        using errcode = '23514';
    end if;
    if target_operator = 'in' then
      return exists (
        select 1 from jsonb_array_elements(expected_value) as allowed(value)
        where allowed.value = actual_value
      );
    end if;
    return not exists (
      select 1 from jsonb_array_elements(expected_value) as allowed(value)
      where allowed.value = actual_value
    );
  end if;

  if jsonb_typeof(actual_value) <> 'array' then
    raise exception 'Employee form display operator % requires an array response', target_operator
      using errcode = '23514';
  end if;
  if target_operator = 'contains' then
    return exists (
      select 1 from jsonb_array_elements(actual_value) as answer_item(value)
      where answer_item.value = expected_value
    );
  end if;
  return not exists (
    select 1 from jsonb_array_elements(actual_value) as answer_item(value)
    where answer_item.value = expected_value
  );
end;
$$;

create or replace function private.validate_employee_form_handoff_answer(
  target_field_type text,
  target_field_label text,
  target_options jsonb,
  target_validation_rules jsonb,
  target_answer jsonb
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  allowed_keys text[] := array[]::text[];
  rule_key text;
  answer_text text;
  answer_number numeric;
  minimum_value numeric;
  maximum_value numeric;
  exclusive_minimum_value numeric;
  exclusive_maximum_value numeric;
  minimum_count integer;
  maximum_count integer;
  answer_date date;
  minimum_date date;
  maximum_date date;
  answer_time time without time zone;
  minimum_time time without time zone;
  maximum_time time without time zone;
  answer_timestamp timestamp without time zone;
  minimum_timestamp timestamp without time zone;
  maximum_timestamp timestamp without time zone;
  item_count integer;
  distinct_item_count integer;
  numeric_rule numeric;
begin
  if jsonb_typeof(coalesce(target_validation_rules, 'null'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(target_options, 'null'::jsonb)) <> 'array' then
    raise exception 'Pinned validation metadata is malformed for field: %', target_field_label
      using errcode = '23514';
  end if;
  case
    when target_field_type in ('short_text', 'long_text', 'signature') then
      allowed_keys := array['minLength', 'maxLength', 'pattern'];
    when target_field_type = 'number' then
      allowed_keys := array[
        'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'integer'
      ];
    when target_field_type in ('date', 'time', 'datetime') then
      allowed_keys := array['notBefore', 'notAfter'];
    when target_field_type in ('boolean', 'acknowledgement') then
      allowed_keys := array['mustBeTrue'];
    when target_field_type = 'multi_choice' then
      allowed_keys := array['minItems', 'maxItems', 'uniqueItems'];
    else
      allowed_keys := array[]::text[];
  end case;

  for rule_key in
    select rules.rule_key
    from jsonb_object_keys(target_validation_rules) as rules(rule_key)
  loop
    if not (rule_key = any(allowed_keys)) then
      raise exception 'Unsupported validation rule % for field: %', rule_key, target_field_label
        using errcode = '23514';
    end if;
  end loop;

  if target_answer is null or target_answer = 'null'::jsonb then
    return;
  end if;

  if target_field_type in ('short_text', 'long_text', 'signature') then
    if jsonb_typeof(target_answer) <> 'string' then
      raise exception 'A text field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    answer_text := target_answer #>> '{}';
    if target_validation_rules ? 'minLength' then
      if jsonb_typeof(target_validation_rules -> 'minLength') <> 'number' then
        raise exception 'minLength must be a non-negative integer for field: %', target_field_label;
      end if;
      numeric_rule := (target_validation_rules ->> 'minLength')::numeric;
      if numeric_rule <> trunc(numeric_rule) or numeric_rule < 0 or numeric_rule > 1000000 then
        raise exception 'minLength must be a non-negative integer for field: %', target_field_label;
      end if;
      minimum_count := numeric_rule::integer;
    end if;
    if target_validation_rules ? 'maxLength' then
      if jsonb_typeof(target_validation_rules -> 'maxLength') <> 'number' then
        raise exception 'maxLength must be a non-negative integer for field: %', target_field_label;
      end if;
      numeric_rule := (target_validation_rules ->> 'maxLength')::numeric;
      if numeric_rule <> trunc(numeric_rule) or numeric_rule < 0 or numeric_rule > 1000000 then
        raise exception 'maxLength must be a non-negative integer for field: %', target_field_label;
      end if;
      maximum_count := numeric_rule::integer;
    end if;
    if minimum_count is not null and maximum_count is not null
       and minimum_count > maximum_count then
      raise exception 'minLength cannot exceed maxLength for field: %', target_field_label;
    end if;
    if minimum_count is not null and char_length(answer_text) < minimum_count then
      raise exception 'Response is shorter than minLength for field: %', target_field_label
        using errcode = '23514';
    end if;
    if maximum_count is not null and char_length(answer_text) > maximum_count then
      raise exception 'Response is longer than maxLength for field: %', target_field_label
        using errcode = '23514';
    end if;
    if target_validation_rules ? 'pattern' then
      if jsonb_typeof(target_validation_rules -> 'pattern') <> 'string'
         or char_length(target_validation_rules ->> 'pattern') > 512 then
        raise exception 'pattern must be a string of at most 512 characters for field: %',
          target_field_label;
      end if;
      if not (answer_text ~ (target_validation_rules ->> 'pattern')) then
        raise exception 'Response does not match the required pattern for field: %', target_field_label
          using errcode = '23514';
      end if;
    end if;
    return;
  end if;

  if target_field_type = 'number' then
    if jsonb_typeof(target_answer) <> 'number' then
      raise exception 'A numeric field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    answer_number := (target_answer #>> '{}')::numeric;
    foreach rule_key in array array[
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'
    ]
    loop
      if target_validation_rules ? rule_key
         and jsonb_typeof(target_validation_rules -> rule_key) <> 'number' then
        raise exception 'Validation rule % must be numeric for field: %',
          rule_key, target_field_label;
      end if;
    end loop;
    if target_validation_rules ? 'minimum' then
      minimum_value := (target_validation_rules ->> 'minimum')::numeric;
    end if;
    if target_validation_rules ? 'maximum' then
      maximum_value := (target_validation_rules ->> 'maximum')::numeric;
    end if;
    if target_validation_rules ? 'exclusiveMinimum' then
      exclusive_minimum_value := (target_validation_rules ->> 'exclusiveMinimum')::numeric;
    end if;
    if target_validation_rules ? 'exclusiveMaximum' then
      exclusive_maximum_value := (target_validation_rules ->> 'exclusiveMaximum')::numeric;
    end if;
    if minimum_value is not null and maximum_value is not null
       and minimum_value > maximum_value then
      raise exception 'minimum cannot exceed maximum for field: %', target_field_label;
    end if;
    if exclusive_minimum_value is not null and exclusive_maximum_value is not null
       and exclusive_minimum_value >= exclusive_maximum_value then
      raise exception 'exclusiveMinimum must be below exclusiveMaximum for field: %',
        target_field_label;
    end if;
    if minimum_value is not null and answer_number < minimum_value
       or maximum_value is not null and answer_number > maximum_value
       or exclusive_minimum_value is not null and answer_number <= exclusive_minimum_value
       or exclusive_maximum_value is not null and answer_number >= exclusive_maximum_value then
      raise exception 'Numeric response is outside the allowed range for field: %', target_field_label
        using errcode = '23514';
    end if;
    if target_validation_rules ? 'integer' then
      if jsonb_typeof(target_validation_rules -> 'integer') <> 'boolean' then
        raise exception 'integer must be boolean for field: %', target_field_label;
      end if;
      if (target_validation_rules ->> 'integer')::boolean
         and answer_number <> trunc(answer_number) then
        raise exception 'Response must be an integer for field: %', target_field_label
          using errcode = '23514';
      end if;
    end if;
    return;
  end if;

  if target_field_type in ('boolean', 'acknowledgement') then
    if jsonb_typeof(target_answer) <> 'boolean' then
      raise exception 'A confirmation field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    if target_validation_rules ? 'mustBeTrue' then
      if jsonb_typeof(target_validation_rules -> 'mustBeTrue') <> 'boolean' then
        raise exception 'mustBeTrue must be boolean for field: %', target_field_label;
      end if;
      if (target_validation_rules ->> 'mustBeTrue')::boolean
         and target_answer <> 'true'::jsonb then
        raise exception 'Confirmation must be accepted for field: %', target_field_label
          using errcode = '23514';
      end if;
    end if;
    return;
  end if;

  if target_field_type = 'single_choice' then
    if jsonb_typeof(target_answer) <> 'string'
       or not target_options ? (target_answer #>> '{}') then
      raise exception 'A choice field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    return;
  end if;

  if target_field_type = 'multi_choice' then
    if jsonb_typeof(target_answer) <> 'array'
       or exists (
         select 1 from jsonb_array_elements(target_answer) as choices(value)
         where jsonb_typeof(choices.value) <> 'string'
            or not target_options ? (choices.value #>> '{}')
       ) then
      raise exception 'A multiple-choice field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    item_count := jsonb_array_length(target_answer);
    if target_validation_rules ? 'minItems' then
      if jsonb_typeof(target_validation_rules -> 'minItems') <> 'number' then
        raise exception 'minItems must be a non-negative integer for field: %', target_field_label;
      end if;
      numeric_rule := (target_validation_rules ->> 'minItems')::numeric;
      if numeric_rule <> trunc(numeric_rule) or numeric_rule < 0 or numeric_rule > 1000000 then
        raise exception 'minItems must be a non-negative integer for field: %', target_field_label;
      end if;
      minimum_count := numeric_rule::integer;
    end if;
    if target_validation_rules ? 'maxItems' then
      if jsonb_typeof(target_validation_rules -> 'maxItems') <> 'number' then
        raise exception 'maxItems must be a non-negative integer for field: %', target_field_label;
      end if;
      numeric_rule := (target_validation_rules ->> 'maxItems')::numeric;
      if numeric_rule <> trunc(numeric_rule) or numeric_rule < 0 or numeric_rule > 1000000 then
        raise exception 'maxItems must be a non-negative integer for field: %', target_field_label;
      end if;
      maximum_count := numeric_rule::integer;
    end if;
    if minimum_count is not null and maximum_count is not null
       and minimum_count > maximum_count then
      raise exception 'minItems cannot exceed maxItems for field: %', target_field_label;
    end if;
    if minimum_count is not null and item_count < minimum_count
       or maximum_count is not null and item_count > maximum_count then
      raise exception 'Multiple-choice response has an invalid item count for field: %',
        target_field_label using errcode = '23514';
    end if;
    if target_validation_rules ? 'uniqueItems' then
      if jsonb_typeof(target_validation_rules -> 'uniqueItems') <> 'boolean' then
        raise exception 'uniqueItems must be boolean for field: %', target_field_label;
      end if;
      if (target_validation_rules ->> 'uniqueItems')::boolean then
        select count(distinct choices.value #>> '{}') into distinct_item_count
        from jsonb_array_elements(target_answer) as choices(value);
        if distinct_item_count <> item_count then
          raise exception 'Multiple-choice responses must be unique for field: %', target_field_label
            using errcode = '23514';
        end if;
      end if;
    end if;
    return;
  end if;

  if target_field_type in ('employee', 'location') then
    if jsonb_typeof(target_answer) <> 'string' then
      raise exception 'A pinned identity field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    return;
  end if;

  if target_field_type = 'date' then
    if jsonb_typeof(target_answer) <> 'string'
       or (target_answer #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'A date field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    answer_text := target_answer #>> '{}';
    begin
      answer_date := answer_text::date;
    exception when others then
      raise exception 'A date field has an invalid response: %', target_field_label
        using errcode = '23514';
    end;
    if target_validation_rules ? 'notBefore' then
      if jsonb_typeof(target_validation_rules -> 'notBefore') <> 'string'
         or (target_validation_rules ->> 'notBefore') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'notBefore must be an ISO date for field: %', target_field_label;
      end if;
      begin
        minimum_date := (target_validation_rules ->> 'notBefore')::date;
      exception when others then
        raise exception 'notBefore must be an ISO date for field: %', target_field_label;
      end;
    end if;
    if target_validation_rules ? 'notAfter' then
      if jsonb_typeof(target_validation_rules -> 'notAfter') <> 'string'
         or (target_validation_rules ->> 'notAfter') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'notAfter must be an ISO date for field: %', target_field_label;
      end if;
      begin
        maximum_date := (target_validation_rules ->> 'notAfter')::date;
      exception when others then
        raise exception 'notAfter must be an ISO date for field: %', target_field_label;
      end;
    end if;
    if minimum_date is not null and maximum_date is not null
       and minimum_date > maximum_date then
      raise exception 'notBefore cannot exceed notAfter for field: %', target_field_label;
    end if;
    if minimum_date is not null and answer_date < minimum_date
       or maximum_date is not null and answer_date > maximum_date then
      raise exception 'Date response is outside the allowed range for field: %', target_field_label
        using errcode = '23514';
    end if;
    return;
  end if;

  if target_field_type = 'time' then
    if jsonb_typeof(target_answer) <> 'string'
       or (target_answer #>> '{}') !~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?$' then
      raise exception 'A time field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    answer_text := target_answer #>> '{}';
    begin
      answer_time := answer_text::time without time zone;
    exception when others then
      raise exception 'A time field has an invalid response: %', target_field_label
        using errcode = '23514';
    end;
    if target_validation_rules ? 'notBefore' then
      if jsonb_typeof(target_validation_rules -> 'notBefore') <> 'string'
         or (target_validation_rules ->> 'notBefore') !~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?$' then
        raise exception 'notBefore must be an ISO local time for field: %', target_field_label;
      end if;
      begin
        minimum_time := (target_validation_rules ->> 'notBefore')::time without time zone;
      exception when others then
        raise exception 'notBefore must be an ISO local time for field: %', target_field_label;
      end;
    end if;
    if target_validation_rules ? 'notAfter' then
      if jsonb_typeof(target_validation_rules -> 'notAfter') <> 'string'
         or (target_validation_rules ->> 'notAfter') !~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?$' then
        raise exception 'notAfter must be an ISO local time for field: %', target_field_label;
      end if;
      begin
        maximum_time := (target_validation_rules ->> 'notAfter')::time without time zone;
      exception when others then
        raise exception 'notAfter must be an ISO local time for field: %', target_field_label;
      end;
    end if;
    if minimum_time is not null and maximum_time is not null
       and minimum_time > maximum_time then
      raise exception 'notBefore cannot exceed notAfter for field: %', target_field_label;
    end if;
    if minimum_time is not null and answer_time < minimum_time
       or maximum_time is not null and answer_time > maximum_time then
      raise exception 'Time response is outside the allowed range for field: %', target_field_label
        using errcode = '23514';
    end if;
    return;
  end if;

  if target_field_type = 'datetime' then
    if jsonb_typeof(target_answer) <> 'string'
       or (target_answer #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?$' then
      raise exception 'A datetime field has an invalid response: %', target_field_label
        using errcode = '23514';
    end if;
    answer_text := target_answer #>> '{}';
    begin
      answer_timestamp := replace(answer_text, 'T', ' ')::timestamp without time zone;
    exception when others then
      raise exception 'A datetime field has an invalid response: %', target_field_label
        using errcode = '23514';
    end;
    if target_validation_rules ? 'notBefore' then
      if jsonb_typeof(target_validation_rules -> 'notBefore') <> 'string'
         or (target_validation_rules ->> 'notBefore') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?$' then
        raise exception 'notBefore must be an ISO local datetime for field: %', target_field_label;
      end if;
      begin
        minimum_timestamp := replace(
          target_validation_rules ->> 'notBefore', 'T', ' '
        )::timestamp without time zone;
      exception when others then
        raise exception 'notBefore must be an ISO local datetime for field: %', target_field_label;
      end;
    end if;
    if target_validation_rules ? 'notAfter' then
      if jsonb_typeof(target_validation_rules -> 'notAfter') <> 'string'
         or (target_validation_rules ->> 'notAfter') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?$' then
        raise exception 'notAfter must be an ISO local datetime for field: %', target_field_label;
      end if;
      begin
        maximum_timestamp := replace(
          target_validation_rules ->> 'notAfter', 'T', ' '
        )::timestamp without time zone;
      exception when others then
        raise exception 'notAfter must be an ISO local datetime for field: %', target_field_label;
      end;
    end if;
    if minimum_timestamp is not null and maximum_timestamp is not null
       and minimum_timestamp > maximum_timestamp then
      raise exception 'notBefore cannot exceed notAfter for field: %', target_field_label;
    end if;
    if minimum_timestamp is not null and answer_timestamp < minimum_timestamp
       or maximum_timestamp is not null and answer_timestamp > maximum_timestamp then
      raise exception 'Datetime response is outside the allowed range for field: %', target_field_label
        using errcode = '23514';
    end if;
    return;
  end if;

  raise exception 'Unsupported employee form field type: %', target_field_type
    using errcode = '23514';
end;
$$;

create or replace function public.submit_employee_form_handoff(
  target_token text,
  target_answers jsonb,
  target_typed_name text,
  target_consent_confirmed boolean,
  target_employee_attestation boolean
)
returns table (
  submission_id uuid,
  submission_sha256 text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  session_record public.employee_form_handoff_sessions;
  assignment_record public.employee_form_assignments;
  session_lookup_id uuid;
  employee_record public.employees;
  form_record public.safety_program_form_template_versions;
  field_record public.safety_program_form_fields;
  canonical_answers jsonb := '{}'::jsonb;
  field_evidence_value jsonb := '[]'::jsonb;
  answer_value jsonb;
  field_visible boolean;
  answer_is_empty boolean;
  normalized_typed_name text;
  normalized_employee_name text;
  event_time timestamptz := clock_timestamp();
  manifest_value jsonb;
  digest_value text;
  inserted_id uuid;
  attestation_text constant text := 'I confirm these answers are mine and complete.';
begin
  if target_token is null or target_token !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(coalesce(target_answers, 'null'::jsonb)) <> 'object'
     or octet_length(coalesce(target_answers, '{}'::jsonb)::text) > 262144 then
    raise exception 'The employee form payload is invalid' using errcode = '22023';
  end if;
  if target_consent_confirmed is not true or target_employee_attestation is not true then
    raise exception 'Employee consent and attestation are required' using errcode = '23514';
  end if;

  select session.* into session_record
  from public.employee_form_handoff_sessions session
  where session.token_sha256 = encode(
    extensions.digest(convert_to(target_token, 'UTF8'), 'sha256'),
    'hex'
  );
  if not found then
    raise exception 'The handoff link is expired or already used' using errcode = '42501';
  end if;
  session_lookup_id := session_record.id;

  select assignment.* into assignment_record
  from public.employee_form_assignments assignment
  where assignment.company_id = session_record.company_id
    and assignment.id = session_record.assignment_id
  for update;
  if not found or assignment_record.status <> 'in_progress' then
    raise exception 'The employee form is no longer open' using errcode = '42501';
  end if;

  select session.* into session_record
  from public.employee_form_handoff_sessions session
  where session.id = session_lookup_id
    and session.token_sha256 = encode(
      extensions.digest(convert_to(target_token, 'UTF8'), 'sha256'),
      'hex'
    )
  for update;
  if not found or session_record.status <> 'active'
     or session_record.expires_at <= event_time then
    raise exception 'The handoff link is expired or already used' using errcode = '42501';
  end if;

  select employee.* into employee_record
  from public.employees employee
  where employee.company_id = assignment_record.company_id
    and employee.id = assignment_record.employee_id;
  select form_version.* into form_record
  from public.safety_program_form_template_versions form_version
  where form_version.company_id = assignment_record.company_id
    and form_version.id = assignment_record.form_template_version_id
    and form_version.status = 'published';
  if employee_record.id is null or form_record.id is null then
    raise exception 'The pinned employee or form version is unavailable';
  end if;

  normalized_typed_name := lower(regexp_replace(
    trim(coalesce(target_typed_name, '')),
    '[[:space:]]+',
    ' ',
    'g'
  ));
  normalized_employee_name := lower(regexp_replace(
    trim(employee_record.full_name),
    '[[:space:]]+',
    ' ',
    'g'
  ));
  if normalized_typed_name = '' or normalized_typed_name <> normalized_employee_name then
    raise exception 'Typed employee name must match the assigned employee record'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(target_answers) answer_key
    where not exists (
      select 1
      from public.safety_program_form_fields schema_field
      where schema_field.company_id = assignment_record.company_id
        and schema_field.form_template_version_id = form_record.id
        and schema_field.field_key = answer_key
        and schema_field.field_type not in ('instruction', 'employee', 'location', 'signature')
    )
  ) then
    raise exception 'The response contains a field outside the pinned schema'
      using errcode = '23514';
  end if;

  for field_record in
    select field_value.*
    from public.safety_program_form_fields field_value
    where field_value.company_id = assignment_record.company_id
      and field_value.form_template_version_id = form_record.id
    order by field_value.sort_order
  loop
    if field_record.field_type = 'instruction' then
      perform private.employee_form_handoff_display_matches(
        field_record.display_logic,
        canonical_answers,
        0
      );
      perform private.validate_employee_form_handoff_answer(
        field_record.field_type,
        field_record.label,
        field_record.options,
        field_record.validation_rules,
        null
      );
      continue;
    elsif field_record.field_type = 'employee' then
      answer_value := to_jsonb(employee_record.id::text);
    elsif field_record.field_type = 'location' then
      answer_value := to_jsonb(assignment_record.location_id::text);
    elsif field_record.field_type = 'signature' then
      answer_value := to_jsonb(trim(target_typed_name));
    else
      answer_value := target_answers -> field_record.field_key;
    end if;

    field_visible := private.employee_form_handoff_display_matches(
      field_record.display_logic,
      canonical_answers,
      0
    );
    answer_is_empty := private.employee_form_handoff_value_is_empty(answer_value);

    if not field_visible then
      perform private.validate_employee_form_handoff_answer(
        field_record.field_type,
        field_record.label,
        field_record.options,
        field_record.validation_rules,
        null
      );
      if field_record.field_type not in ('employee', 'location', 'signature')
         and not answer_is_empty
         and not (
           field_record.field_type = 'acknowledgement'
           and answer_value = 'false'::jsonb
         ) then
        raise exception 'A hidden employee form field contains a response: %', field_record.label
          using errcode = '23514';
      end if;
      answer_value := null;
    else
      if field_record.required and (
        answer_is_empty
        or (
          field_record.field_type = 'acknowledgement'
          and answer_value = 'false'::jsonb
        )
      ) then
        raise exception 'A required employee form field is missing: %', field_record.label
          using errcode = '23514';
      end if;

      perform private.validate_employee_form_handoff_answer(
        field_record.field_type,
        field_record.label,
        field_record.options,
        field_record.validation_rules,
        answer_value
      );
    end if;

    canonical_answers := canonical_answers || jsonb_build_object(
      field_record.field_key,
      coalesce(answer_value, 'null'::jsonb)
    );
    field_evidence_value := field_evidence_value || jsonb_build_array(
      jsonb_build_object(
        'fieldId', field_record.id,
        'fieldKey', field_record.field_key,
        'fieldType', field_record.field_type,
        'label', field_record.label,
        'required', field_record.required,
        'options', field_record.options,
        'validationRules', field_record.validation_rules,
        'displayLogic', field_record.display_logic,
        'visible', field_visible,
        'fieldSha256', field_record.field_sha256,
        'answer', coalesce(answer_value, 'null'::jsonb)
      )
    );
  end loop;

  manifest_value := jsonb_build_object(
    'manifestVersion', 'safetyops-facilitated-employee-form-v1',
    'assignment', jsonb_build_object(
      'assignmentId', assignment_record.id,
      'companyId', assignment_record.company_id,
      'locationId', assignment_record.location_id,
      'title', assignment_record.title,
      'assignedAtUtc', assignment_record.assigned_at,
      'dueAtUtc', assignment_record.due_at,
      'wasOverdue', assignment_record.due_at is not null and assignment_record.due_at < event_time
    ),
    'employee', jsonb_build_object(
      'employeeId', employee_record.id,
      'employeeNameSnapshot', employee_record.full_name,
      'employeeNumberSnapshot', employee_record.employee_number
    ),
    'facilitator', jsonb_build_object(
      'userId', session_record.facilitator_user_id,
      'nameSnapshot', session_record.facilitator_name_snapshot,
      'roleSnapshot', session_record.facilitator_role_snapshot
    ),
    'form', jsonb_build_object(
      'programVersionId', assignment_record.program_version_id,
      'formTemplateVersionId', form_record.id,
      'formVersion', form_record.version,
      'schemaSha256', form_record.schema_sha256,
      'fieldEvidence', field_evidence_value
    ),
    'signature', jsonb_build_object(
      'method', 'facilitated_in_person_one_time_handoff',
      'identityVerificationMethod', 'in_person_one_time_handoff',
      'typedName', trim(target_typed_name),
      'intent', 'I intend my typed name to be my electronic signature for this completed form.',
      'consentVersion', 'safetyops-employee-form-consent-v1',
      'employeeAttestation', attestation_text
    ),
    'submittedAtUtc', event_time
  );
  digest_value := encode(
    extensions.digest(convert_to(manifest_value::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into public.employee_form_submissions (
    company_id,
    location_id,
    assignment_id,
    employee_id,
    program_version_id,
    form_template_version_id,
    handoff_session_id,
    facilitator_user_id,
    employee_name_snapshot,
    employee_number_snapshot,
    facilitator_name_snapshot,
    facilitator_role_snapshot,
    form_schema_sha256,
    field_evidence,
    answers,
    signature_intent,
    consent_version,
    typed_name_confirmation,
    employee_attestation,
    was_overdue,
    submitted_at,
    submission_manifest,
    submission_sha256
  ) values (
    assignment_record.company_id,
    assignment_record.location_id,
    assignment_record.id,
    assignment_record.employee_id,
    assignment_record.program_version_id,
    assignment_record.form_template_version_id,
    session_record.id,
    session_record.facilitator_user_id,
    employee_record.full_name,
    employee_record.employee_number,
    session_record.facilitator_name_snapshot,
    session_record.facilitator_role_snapshot,
    form_record.schema_sha256,
    field_evidence_value,
    canonical_answers,
    'I intend my typed name to be my electronic signature for this completed form.',
    'safetyops-employee-form-consent-v1',
    trim(target_typed_name),
    attestation_text,
    assignment_record.due_at is not null and assignment_record.due_at < event_time,
    event_time,
    manifest_value,
    digest_value
  ) returning id into inserted_id;

  update public.employee_form_assignments
  set status = 'completed',
      completed_at = event_time
  where id = assignment_record.id;

  update public.employee_form_handoff_sessions
  set status = 'consumed',
      consumed_at = event_time
  where id = session_record.id;

  return query select inserted_id, digest_value, event_time;
end;
$$;

alter table public.employee_form_assignments enable row level security;
alter table public.employee_form_handoff_sessions enable row level security;
alter table public.employee_form_submissions enable row level security;

create policy employee_form_assignments_select
on public.employee_form_assignments
for select to authenticated
using (private.can_view_employee_at_location(company_id, employee_id, location_id));

create policy employee_form_submissions_select
on public.employee_form_submissions
for select to authenticated
using (private.can_view_employee_at_location(company_id, employee_id, location_id));

-- No direct policies exist on ceremony sessions. Their raw token is never
-- stored, and only the narrow SECURITY DEFINER functions can use the hash.
revoke all on table public.employee_form_handoff_sessions
  from public, anon, authenticated;
revoke all on table public.employee_form_assignments
  from public, anon, authenticated;
revoke all on table public.employee_form_submissions
  from public, anon, authenticated;
grant select on table public.employee_form_assignments to authenticated;
grant select on table public.employee_form_submissions to authenticated;

revoke all on function public.assign_employee_form(uuid, uuid, uuid, timestamptz, text, text)
  from public;
revoke all on function public.begin_employee_form_handoff(uuid) from public;
revoke all on function public.expire_employee_form_handoffs_internal() from public;
revoke all on function public.get_employee_form_handoff(text) from public;
revoke all on function public.submit_employee_form_handoff(text, jsonb, text, boolean, boolean)
  from public;
revoke all on function private.employee_form_handoff_value_is_empty(jsonb) from public;
revoke all on function private.employee_form_handoff_display_matches(jsonb, jsonb, integer)
  from public;
revoke all on function private.validate_employee_form_handoff_answer(text, text, jsonb, jsonb, jsonb)
  from public;
grant execute on function public.assign_employee_form(uuid, uuid, uuid, timestamptz, text, text)
  to authenticated;
grant execute on function public.begin_employee_form_handoff(uuid) to authenticated;
grant execute on function public.expire_employee_form_handoffs_internal() to service_role;
grant execute on function public.get_employee_form_handoff(text) to anon, authenticated;
grant execute on function public.submit_employee_form_handoff(text, jsonb, text, boolean, boolean)
  to anon, authenticated;

create trigger lfes_prevent_auditor_write
before insert or update or delete on public.employee_form_assignments
for each row execute function private.prevent_auditor_operational_write();
create trigger lfes_prevent_auditor_write
before insert or update or delete on public.employee_form_submissions
for each row execute function private.prevent_auditor_operational_write();

create trigger safetyops_workflow_employee_form_assignments_audit
after insert or update or delete on public.employee_form_assignments
for each row execute function program_private.capture_audit_event();
create trigger safetyops_workflow_employee_form_handoffs_audit
after insert or update or delete on public.employee_form_handoff_sessions
for each row execute function program_private.capture_audit_event();
create trigger safetyops_workflow_employee_form_submissions_audit
after insert or update or delete on public.employee_form_submissions
for each row execute function program_private.capture_audit_event();

create trigger safetyops_workflow_employee_document_upload_sessions_audit
after insert or update or delete on public.employee_document_upload_sessions
for each row execute function program_private.capture_audit_event();
create trigger safetyops_workflow_employee_document_file_access_audit
after insert or update or delete on public.employee_document_file_access_events
for each row execute function program_private.capture_audit_event();

comment on table public.employee_form_handoff_sessions is
  'Short-lived, one-time capability hashes for isolated employee tablet ceremonies; raw tokens are returned once and never stored.';
comment on table public.employee_form_submissions is
  'Append-only employee form answers, exact field/schema snapshots, facilitator identity, typed signature evidence, and canonical SHA-256 manifest.';

-- Exact-location read boundaries for employees who work at more than one site.
-- A location manager may see only the assignment/completion row for the site
-- they manage, even when the same employee is assigned elsewhere.
drop policy if exists employee_location_assignments_select
  on public.employee_location_assignments;
create policy employee_location_assignments_select
on public.employee_location_assignments
for select to authenticated
using (
  private.employee_for_current_user(company_id) = employee_id
  or private.company_role(company_id) in ('corporate_admin', 'safety_manager', 'auditor')
  or (
    private.company_role(company_id) in ('location_manager', 'supervisor')
    and private.can_write_location(company_id, location_id)
  )
);

drop policy if exists training_requirements_select on public.training_requirements;
create policy training_requirements_select
on public.training_requirements
for select to authenticated
using (private.can_view_employee_at_location(company_id, employee_id, location_id));

drop policy if exists training_assignments_select on public.training_assignments;
create policy training_assignments_select
on public.training_assignments
for select to authenticated
using (private.can_view_employee_at_location(company_id, employee_id, location_id));

drop policy if exists training_completions_select on public.training_completions;
create policy training_completions_select
on public.training_completions
for select to authenticated
using (private.can_view_employee_at_location(company_id, employee_id, location_id));

revoke all on function private.can_view_employee_at_location(uuid, uuid, uuid) from public;
grant execute on function private.can_view_employee_at_location(uuid, uuid, uuid) to authenticated;

create unique index training_assignments_company_id_id_unique
  on public.training_assignments(company_id, id);
alter table public.training_completions
  add constraint training_completions_assignment_fk
  foreign key (company_id, assignment_id)
  references public.training_assignments(company_id, id) on delete restrict;

create or replace function private.guard_training_completion_relationship()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  assignment_record public.training_assignments;
begin
  select assignment.* into assignment_record
  from public.training_assignments assignment
  where assignment.company_id = new.company_id
    and assignment.id = new.assignment_id
  for key share;
  if not found
     or new.location_id is distinct from assignment_record.location_id
     or new.employee_id is distinct from assignment_record.employee_id
     or new.course_id is distinct from assignment_record.course_id
     or new.course_version is distinct from assignment_record.course_version
     or new.requirement_id is distinct from assignment_record.requirement_id then
    raise exception 'Training completion does not match its pinned assignment';
  end if;
  return new;
end;
$$;

create trigger training_completions_relationship_guard
before insert on public.training_completions
for each row execute function private.guard_training_completion_relationship();

-- Terminal assignments may be created only by the server-owned completion
-- RPC. Browser roles have no general update capability on training evidence.
revoke update on table public.training_assignments from authenticated;

create or replace function public.claim_employee_document_upload_internal(
  target_upload_session_id uuid
)
returns table (
  upload_session_id uuid,
  employee_document_id uuid,
  company_id uuid,
  quarantine_path text,
  declared_size_bytes bigint,
  expires_at timestamptz,
  processing_token uuid,
  processing_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  claimed public.employee_document_upload_sessions;
  claim_time timestamptz := clock_timestamp();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  select session.* into claimed
  from public.employee_document_upload_sessions session
  where session.id = target_upload_session_id
  for update;

  if claimed.id is null then
    return;
  end if;

  if claimed.state = 'prepared' and claimed.expires_at <= claim_time then
    update public.employee_document_upload_sessions
    set state = 'expired', rejection_code = 'upload_session_expired'
    where id = claimed.id;
    update public.employee_documents
    set status = 'rejected',
        validation_status = 'rejected',
        malware_scan_status = 'rejected',
        validation_record = jsonb_build_object('rejectionCode', 'upload_session_expired')
    where id = claimed.employee_document_id;
    return;
  end if;

  if claimed.state = 'uploaded'
     and claimed.claimed_at <= claim_time - interval '1 hour' then
    update public.employee_document_upload_sessions
    set state = 'expired', rejection_code = 'processing_window_expired'
    where id = claimed.id;
    update public.employee_documents
    set status = 'rejected',
        validation_status = 'rejected',
        malware_scan_status = 'rejected',
        validation_record = jsonb_build_object('rejectionCode', 'processing_window_expired')
    where id = claimed.employee_document_id;
    return;
  end if;

  if claimed.state = 'prepared' then
    update public.employee_document_upload_sessions session
    set state = 'uploaded',
        claimed_at = claim_time,
        processing_expires_at = claim_time + interval '10 minutes',
        processing_token = gen_random_uuid()
    where session.id = claimed.id
    returning session.* into claimed;
  elsif claimed.state = 'uploaded'
        and claimed.processing_expires_at <= claim_time then
    update public.employee_document_upload_sessions session
    set processing_expires_at = claim_time + interval '10 minutes',
        processing_token = gen_random_uuid()
    where session.id = claimed.id
    returning session.* into claimed;
  elsif claimed.state = 'uploaded' then
    -- A live lease has exactly one worker. Retries may renew only after the
    -- current lease expires, at which point the token is rotated.
    return;
  else
    return;
  end if;

  return query select
    claimed.id,
    claimed.employee_document_id,
    claimed.company_id,
    claimed.quarantine_path,
    claimed.declared_size_bytes,
    claimed.expires_at,
    claimed.processing_token,
    claimed.processing_expires_at;
end;
$$;

revoke all on function public.claim_employee_document_upload_internal(uuid) from public;
grant execute on function public.claim_employee_document_upload_internal(uuid) to service_role;
