-- SafetyOps controlled form-file access ledger.
--
-- Private file URLs are issued only by the sign-form-file Edge Function.
-- This service-only table records the authorization decision without storing
-- a bucket path, signed URL, bearer token, or other credential.

create table public.safety_program_file_access_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  location_id uuid,
  form_file_id uuid not null,
  storage_object_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('allowed', 'denied')),
  reason_code text not null
    check (reason_code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  request_id uuid not null,
  signed_url_expires_at timestamptz,
  request_context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  unique (request_id),
  foreign key (company_id, location_id)
    references public.locations(company_id, id) on delete restrict,
  foreign key (company_id, form_file_id)
    references public.safety_program_form_template_files(company_id, id)
    on delete restrict,
  foreign key (company_id, storage_object_id)
    references public.safety_program_storage_objects(company_id, id)
    on delete restrict,
  check (jsonb_typeof(request_context) = 'object'),
  check (
    (decision = 'allowed' and signed_url_expires_at is not null)
    or (decision = 'denied' and signed_url_expires_at is null)
  )
);

create index safety_program_file_access_events_company_time_idx
  on public.safety_program_file_access_events(company_id, occurred_at desc);

create index safety_program_file_access_events_actor_time_idx
  on public.safety_program_file_access_events(actor_user_id, occurred_at desc);

alter table public.safety_program_file_access_events enable row level security;

revoke all on table public.safety_program_file_access_events
  from public, anon, authenticated;
grant select, insert on table public.safety_program_file_access_events
  to service_role;

comment on table public.safety_program_file_access_events is
  'Service-only allow/deny ledger for controlled form-file download decisions; never stores object paths, signed URLs, or credentials.';
