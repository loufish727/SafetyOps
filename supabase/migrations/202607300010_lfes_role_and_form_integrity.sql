-- SafetyOps LFES role, privacy, and form-evidence integrity hardening
--
-- This migration makes the auditor role database-authoritatively read-only,
-- narrows personnel visibility to the caller's company/location authority,
-- revalidates program applicability on final form submission, and derives all
-- signature/submission evidence digests from server-owned records.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Personnel visibility without recursive RLS evaluation
-- ---------------------------------------------------------------------------

create or replace function private.can_view_company_person(
  target_company_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.company_memberships actor_membership
    join public.company_memberships target_membership
      on target_membership.company_id = actor_membership.company_id
     and target_membership.user_id = target_user_id
    where actor_membership.company_id = target_company_id
      and actor_membership.user_id = auth.uid()
      and actor_membership.active
      and (
        target_user_id = auth.uid()
        or actor_membership.role in (
          'corporate_admin',
          'safety_manager',
          'auditor'
        )
        or (
          actor_membership.role in ('location_manager', 'supervisor')
          and exists (
            select 1
            from public.location_memberships actor_location
            join public.location_memberships target_location
              on target_location.company_id = actor_location.company_id
             and target_location.location_id = actor_location.location_id
             and target_location.user_id = target_user_id
            where actor_location.company_id = target_company_id
              and actor_location.user_id = auth.uid()
          )
        )
      )
  );
$$;

create or replace function private.can_view_profile(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select
    target_user_id = auth.uid()
    or exists (
      select 1
      from public.company_memberships target_membership
      where target_membership.user_id = target_user_id
        and private.can_view_company_person(
          target_membership.company_id,
          target_user_id
        )
    );
$$;

create or replace function private.can_view_safety_program_version(
  target_program_version_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_program_versions program_version
    where program_version.id = target_program_version_id
      and (
        private.can_manage_company(program_version.company_id)
        or (
          program_version.status in ('published', 'superseded')
          and private.is_company_member(program_version.company_id)
          and (
            private.company_role(program_version.company_id) = 'auditor'
            or exists (
              select 1
              from public.safety_program_assignments assignment
              where assignment.program_version_id = program_version.id
                and assignment.assignee_user_id = auth.uid()
            )
            or exists (
              select 1
              from public.safety_program_form_submissions submission
              where submission.program_version_id = program_version.id
                and (
                  submission.submitted_by = auth.uid()
                  or private.can_write_location(
                    submission.company_id,
                    submission.location_id
                  )
                )
            )
            or (
              program_version.status = 'published'
              and exists (
                select 1
                from public.safety_program_location_applicability applicability
                join public.locations location_record
                  on location_record.company_id = applicability.company_id
                 and location_record.id = applicability.location_id
                 and location_record.active
                join public.location_regulatory_profiles profile_record
                  on profile_record.company_id = applicability.company_id
                 and profile_record.location_id = applicability.location_id
                 and profile_record.id = applicability.regulatory_profile_id
                where applicability.program_version_id = program_version.id
                  and applicability.review_status = 'reviewed'
                  and applicability.applicability_status in ('applies', 'conditional')
                  and (
                    program_version.effective_from is null
                    or program_version.effective_from <=
                      timezone(
                        location_record.timezone,
                        statement_timestamp()
                      )::date
                  )
                  and (
                    program_version.effective_to is null
                    or program_version.effective_to >=
                      timezone(
                        location_record.timezone,
                        statement_timestamp()
                      )::date
                  )
                  and (
                    applicability.effective_from is null
                    or applicability.effective_from <=
                      timezone(
                        location_record.timezone,
                        statement_timestamp()
                      )::date
                  )
                  and (
                    applicability.effective_to is null
                    or applicability.effective_to >=
                      timezone(
                        location_record.timezone,
                        statement_timestamp()
                      )::date
                  )
                  and profile_record.status = 'approved'
                  and profile_record.reviewed_by is not null
                  and profile_record.reviewed_at is not null
                  and (
                    profile_record.effective_from is null
                    or profile_record.effective_from <=
                      timezone(
                        location_record.timezone,
                        statement_timestamp()
                      )::date
                  )
                  and (
                    profile_record.effective_to is null
                    or profile_record.effective_to >=
                      timezone(
                        location_record.timezone,
                        statement_timestamp()
                      )::date
                  )
                  and private.can_access_location(
                    applicability.company_id,
                    applicability.location_id
                  )
              )
            )
          )
        )
      )
  );
$$;

revoke all on function private.can_view_company_person(uuid, uuid)
  from public, anon;
revoke all on function private.can_view_profile(uuid)
  from public, anon;
revoke all on function private.can_view_safety_program_version(uuid)
  from public, anon;
grant execute on function private.can_view_company_person(uuid, uuid)
  to authenticated;
grant execute on function private.can_view_profile(uuid)
  to authenticated;
grant execute on function private.can_view_safety_program_version(uuid)
  to authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select
on public.profiles
for select to authenticated
using (private.can_view_profile(id));

drop policy if exists company_memberships_select on public.company_memberships;
create policy company_memberships_select
on public.company_memberships
for select to authenticated
using (private.can_view_company_person(company_id, user_id));

drop policy if exists location_memberships_select on public.location_memberships;
create policy location_memberships_select
on public.location_memberships
for select to authenticated
using (
  private.can_view_company_person(company_id, user_id)
  and (
    user_id = auth.uid()
    or private.can_manage_company(company_id)
    or (
      private.company_role(company_id) = 'auditor'
      and private.can_access_location(company_id, location_id)
    )
    or private.can_write_location(company_id, location_id)
  )
);

drop policy if exists safety_program_assignments_select
  on public.safety_program_assignments;
create policy safety_program_assignments_select
on public.safety_program_assignments
for select to authenticated
using (
  assignee_user_id = auth.uid()
  or private.can_manage_company(company_id)
  or private.can_write_location(company_id, location_id)
  or (
    private.company_role(company_id) = 'auditor'
    and private.can_access_location(company_id, location_id)
  )
);

-- Auditors need the evidence necessary to audit, but never mutation authority.
drop policy if exists corrective_actions_select on public.corrective_actions;
create policy corrective_actions_select
on public.corrective_actions
for select to authenticated
using (
  private.can_access_location(company_id, location_id)
  and (
    assigned_to = auth.uid()
    or private.can_write_location(company_id, location_id)
    or private.can_manage_company(company_id)
    or private.company_role(company_id) = 'auditor'
  )
);

drop policy if exists training_assignments_select on public.training_assignments;
create policy training_assignments_select
on public.training_assignments
for select to authenticated
using (
  private.is_company_member(company_id)
  and (
    worker_profile_id = auth.uid()
    or private.can_manage_company(company_id)
    or (
      location_id is not null
      and private.can_write_location(company_id, location_id)
    )
    or (
      private.company_role(company_id) = 'auditor'
      and (
        location_id is null
        or private.can_access_location(company_id, location_id)
      )
    )
  )
);

drop policy if exists certifications_select on public.certifications;
create policy certifications_select
on public.certifications
for select to authenticated
using (
  worker_profile_id = auth.uid()
  or private.can_manage_company(company_id)
  or (
    location_id is not null
    and private.can_write_location(company_id, location_id)
  )
  or (
    private.company_role(company_id) = 'auditor'
    and (
      location_id is null
      or private.can_access_location(company_id, location_id)
    )
  )
);

drop policy if exists document_acknowledgements_select
  on public.document_acknowledgements;
create policy document_acknowledgements_select
on public.document_acknowledgements
for select to authenticated
using (
  user_id = auth.uid()
  or private.can_manage_company(company_id)
  or private.company_role(company_id) = 'auditor'
);

-- ---------------------------------------------------------------------------
-- Database-authoritative read-only auditor boundary
-- ---------------------------------------------------------------------------

create or replace function private.prevent_auditor_operational_write()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  row_value jsonb;
  target_company_id uuid;
begin
  if auth.uid() is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  row_value := case
    when tg_op = 'DELETE' then to_jsonb(old)
    else to_jsonb(new)
  end;
  target_company_id := nullif(row_value ->> 'company_id', '')::uuid;

  if target_company_id is not null
     and private.company_role(target_company_id) = 'auditor' then
    raise exception 'auditor role is read-only for %', tg_table_name
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_auditor_operational_write()
  from public, anon, authenticated;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'inspections',
    'incidents',
    'corrective_actions',
    'training_assignments',
    'certifications',
    'document_acknowledgements',
    'evidence_files',
    'compliance_evidence_links',
    'inspection_regulatory_contexts',
    'regulatory_change_impacts',
    'safety_program_storage_objects',
    'safety_program_assignments',
    'safety_program_form_submissions',
    'safety_program_form_answers',
    'safety_program_answer_files',
    'safety_program_form_signatures',
    'safety_program_acknowledgements'
  ]
  loop
    execute format(
      'drop trigger if exists lfes_prevent_auditor_write on public.%I',
      target_table
    );
    execute format(
      'create trigger lfes_prevent_auditor_write
       before insert or update or delete on public.%I
       for each row execute function private.prevent_auditor_operational_write()',
      target_table
    );
  end loop;
end;
$$;

-- Keep worker reporting available while removing can_access_location's auditor
-- implication from the two baseline insert policies.
drop policy if exists inspections_insert on public.inspections;
create policy inspections_insert
on public.inspections
for insert to authenticated
with check (
  private.company_role(company_id) <> 'auditor'
  and private.can_access_location(company_id, location_id)
  and created_by = auth.uid()
);

create or replace function private.enforce_inspection_update_boundary()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.id <> old.id
     or new.company_id <> old.company_id
     or new.location_id <> old.location_id
     or new.template_id <> old.template_id
     or new.template_version_id <> old.template_version_id
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at
     or new.client_submission_key is distinct from old.client_submission_key then
    raise exception 'inspection identity, tenant, location, and pinned template are immutable'
      using errcode = '55000';
  end if;

  if auth.uid() is not null
     and not private.can_access_location(new.company_id, new.location_id) then
    raise exception 'inspection location access denied'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_inspection_update_boundary()
  from public, anon, authenticated;

drop trigger if exists inspections_identity_and_access
  on public.inspections;
create trigger inspections_identity_and_access
before update on public.inspections
for each row execute function private.enforce_inspection_update_boundary();

drop policy if exists inspections_update on public.inspections;
create policy inspections_update
on public.inspections
for update to authenticated
using (
  private.company_role(company_id) <> 'auditor'
  and private.can_access_location(company_id, location_id)
  and (
    private.can_write_location(company_id, location_id)
    or (
      created_by = auth.uid()
      and status in ('draft', 'in_progress')
    )
  )
)
with check (
  private.company_role(company_id) <> 'auditor'
  and private.can_access_location(company_id, location_id)
  and (
    private.can_write_location(company_id, location_id)
    or created_by = auth.uid()
  )
);

drop policy if exists inspections_delete_drafts on public.inspections;
create policy inspections_delete_drafts
on public.inspections
for delete to authenticated
using (
  status = 'draft'
  and private.company_role(company_id) <> 'auditor'
  and private.can_access_location(company_id, location_id)
  and (
    private.can_write_location(company_id, location_id)
    or created_by = auth.uid()
  )
);

drop policy if exists incidents_insert on public.incidents;
create policy incidents_insert
on public.incidents
for insert to authenticated
with check (
  private.company_role(company_id) <> 'auditor'
  and private.can_access_location(company_id, location_id)
  and reported_by = auth.uid()
);

drop policy if exists document_acknowledgements_insert
  on public.document_acknowledgements;
create policy document_acknowledgements_insert
on public.document_acknowledgements
for insert to authenticated
with check (
  private.company_role(company_id) <> 'auditor'
  and user_id = auth.uid()
  and private.can_access_document(document_id)
);

drop policy if exists evidence_files_insert on public.evidence_files;
create policy evidence_files_insert
on public.evidence_files
for insert to authenticated
with check (
  private.company_role(company_id) <> 'auditor'
  and uploaded_by = auth.uid()
  and (
    (location_id is null and private.is_company_member(company_id))
    or (
      location_id is not null
      and private.can_access_location(company_id, location_id)
    )
  )
);

drop policy if exists safety_program_submissions_insert
  on public.safety_program_form_submissions;
create policy safety_program_submissions_insert
on public.safety_program_form_submissions
for insert to authenticated
with check (
  private.company_role(company_id) <> 'auditor'
  and submitted_by = auth.uid()
  and private.can_access_location(company_id, location_id)
  and private.can_view_safety_program_version(program_version_id)
);

create or replace function private.can_edit_safety_program_submission(
  target_submission_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from public.safety_program_form_submissions submission
    where submission.id = target_submission_id
      and submission.status = 'draft'
      and private.is_company_member(submission.company_id)
      and private.can_access_location(
        submission.company_id,
        submission.location_id
      )
      and private.company_role(submission.company_id) <> 'auditor'
      and (
        submission.submitted_by = auth.uid()
        or private.can_write_location(
          submission.company_id,
          submission.location_id
        )
      )
  );
$$;

revoke all on function private.can_edit_safety_program_submission(uuid)
  from public, anon;
grant execute on function private.can_edit_safety_program_submission(uuid)
  to authenticated;

drop policy if exists safety_program_submissions_owner_update
  on public.safety_program_form_submissions;
drop policy if exists safety_program_submissions_manager_update
  on public.safety_program_form_submissions;
drop policy if exists safety_program_submissions_update
  on public.safety_program_form_submissions;
create policy safety_program_submissions_update
on public.safety_program_form_submissions
for update to authenticated
using (private.can_edit_safety_program_submission(id))
with check (
  private.is_company_member(company_id)
  and private.can_access_location(company_id, location_id)
  and private.company_role(company_id) <> 'auditor'
  and (
    submitted_by = auth.uid()
    or private.can_write_location(company_id, location_id)
  )
);

drop policy if exists safety_program_submissions_delete
  on public.safety_program_form_submissions;
create policy safety_program_submissions_delete
on public.safety_program_form_submissions
for delete to authenticated
using (private.can_edit_safety_program_submission(id));

-- Prevent authenticated auditors from writing bytes into the shared evidence
-- bucket even when they know a valid tenant path.
drop policy if exists safetyops_storage_insert on storage.objects;
create policy safetyops_storage_insert
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'safetyops-private'
  and private.company_role((storage.foldername(name))[1]::uuid) <> 'auditor'
  and private.is_company_member((storage.foldername(name))[1]::uuid)
);

drop policy if exists safetyops_storage_update on storage.objects;
create policy safetyops_storage_update
on storage.objects
for update to authenticated
using (
  bucket_id = 'safetyops-private'
  and private.company_role((storage.foldername(name))[1]::uuid) <> 'auditor'
  and owner_id = auth.uid()::text
)
with check (
  bucket_id = 'safetyops-private'
  and private.company_role((storage.foldername(name))[1]::uuid) <> 'auditor'
  and owner_id = auth.uid()::text
);

drop policy if exists safetyops_storage_delete on storage.objects;
create policy safetyops_storage_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'safetyops-private'
  and private.company_role((storage.foldername(name))[1]::uuid) <> 'auditor'
  and (
    owner_id = auth.uid()::text
    or private.can_manage_company((storage.foldername(name))[1]::uuid)
  )
);

-- ---------------------------------------------------------------------------
-- Current published/effective program applicability
-- ---------------------------------------------------------------------------

create or replace function program_private.require_current_program_applicability(
  target_company_id uuid,
  target_program_version_id uuid,
  target_location_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, program_private, pg_temp
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
      and (
        program_version.effective_from is null
        or program_version.effective_from <= location_date
      )
      and (
        program_version.effective_to is null
        or program_version.effective_to >= location_date
      )
      and applicability.review_status = 'reviewed'
      and applicability.applicability_status in ('applies', 'conditional')
      and (
        applicability.effective_from is null
        or applicability.effective_from <= location_date
      )
      and (
        applicability.effective_to is null
        or applicability.effective_to >= location_date
      )
      and profile_record.status = 'approved'
      and profile_record.reviewed_by is not null
      and profile_record.reviewed_at is not null
      and (
        profile_record.effective_from is null
        or profile_record.effective_from <= location_date
      )
      and (
        profile_record.effective_to is null
        or profile_record.effective_to >= location_date
      )
  ) then
    raise exception
      'program applicability and regulatory profile are not reviewed and effective at this location'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function program_private.enforce_current_program_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if new.status not in ('waived', 'cancelled') then
    perform program_private.require_current_program_applicability(
      new.company_id,
      new.program_version_id,
      new.location_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists safety_program_assignments_current_applicability
  on public.safety_program_assignments;
create trigger safety_program_assignments_current_applicability
before insert or update on public.safety_program_assignments
for each row execute function
  program_private.enforce_current_program_assignment();

create or replace function program_private.require_current_form_applicability(
  target_company_id uuid,
  target_program_version_id uuid,
  target_location_id uuid,
  target_form_template_version_id uuid,
  target_form_schema_sha256 text
)
returns void
language plpgsql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  location_date date;
begin
  perform program_private.require_current_program_applicability(
    target_company_id,
    target_program_version_id,
    target_location_id
  );

  select timezone(location_record.timezone, statement_timestamp())::date
  into location_date
  from public.locations location_record
  where location_record.id = target_location_id
    and location_record.company_id = target_company_id
    and location_record.active;

  if location_date is null then
    raise exception 'an active tenant location is required for this form'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.safety_program_versions program_version
    join public.safety_program_form_template_versions form_version
      on form_version.program_version_id = program_version.id
     and form_version.company_id = program_version.company_id
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
      and (
        program_version.effective_from is null
        or program_version.effective_from <= location_date
      )
      and (
        program_version.effective_to is null
        or program_version.effective_to >= location_date
      )
      and form_version.id = target_form_template_version_id
      and form_version.status = 'published'
      and form_version.schema_sha256 = target_form_schema_sha256
      and applicability.review_status = 'reviewed'
      and applicability.applicability_status in ('applies', 'conditional')
      and (
        applicability.effective_from is null
        or applicability.effective_from <= location_date
      )
      and (
        applicability.effective_to is null
        or applicability.effective_to >= location_date
      )
      and profile_record.status = 'approved'
      and profile_record.reviewed_by is not null
      and profile_record.reviewed_at is not null
      and (
        profile_record.effective_from is null
        or profile_record.effective_from <= location_date
      )
      and (
        profile_record.effective_to is null
        or profile_record.effective_to >= location_date
      )
  ) then
    raise exception
      'form program/applicability is not published, reviewed, and effective at this location'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function program_private.enforce_current_form_applicability()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if tg_op = 'INSERT'
     or (
       tg_op = 'UPDATE'
       and old.status = 'draft'
       and new.status = 'submitted'
     ) then
    perform program_private.require_current_form_applicability(
      new.company_id,
      new.program_version_id,
      new.location_id,
      new.form_template_version_id,
      new.form_schema_sha256
    );
  end if;

  return new;
end;
$$;

drop trigger if exists safety_program_submissions_current_applicability
  on public.safety_program_form_submissions;
create trigger safety_program_submissions_current_applicability
before insert or update on public.safety_program_form_submissions
for each row execute function
  program_private.enforce_current_form_applicability();

-- The browser may provide workflow input, but it cannot author the regulatory
-- evidence context. Pin that context from the exact published database rows.
create or replace function program_private.derive_submission_context()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.submission_context is distinct from old.submission_context then
      raise exception 'server-derived submission context is immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;

  new.started_at := clock_timestamp();

  select jsonb_build_object(
    'contextVersion', 'safetyops-form-submission-context-v1',
    'capturedAtUtc', to_char(
      new.started_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'companyId', new.company_id,
    'location', jsonb_build_object(
      'locationId', location_record.id,
      'timezone', location_record.timezone
    ),
    'programVersion', jsonb_build_object(
      'programVersionId', program_version.id,
      'programId', program_version.program_id,
      'version', program_version.version,
      'status', program_version.status,
      'effectiveFrom', program_version.effective_from,
      'effectiveTo', program_version.effective_to,
      'sourceManifestSha256', program_version.source_manifest_sha256,
      'contentManifestSha256', program_version.content_manifest_sha256
    ),
    'formTemplateVersion', jsonb_build_object(
      'formTemplateVersionId', form_version.id,
      'templateId', form_version.template_id,
      'version', form_version.version,
      'status', form_version.status,
      'schemaSha256', form_version.schema_sha256,
      'completionPolicy', form_version.completion_policy,
      'signaturePolicy', form_version.signature_policy
    ),
    'locationApplicability', jsonb_build_object(
      'applicabilityId', applicability.id,
      'applicabilityStatus', applicability.applicability_status,
      'reviewStatus', applicability.review_status,
      'regulatoryProfileId', applicability.regulatory_profile_id,
      'effectiveFrom', applicability.effective_from,
      'effectiveTo', applicability.effective_to,
      'applicabilitySha256', applicability.applicability_sha256,
      'reviewedBy', applicability.reviewed_by,
      'reviewedAtUtc', case
        when applicability.reviewed_at is null then null
        else to_char(
          applicability.reviewed_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      end
    ),
    'regulatoryProfile', case
      when profile_record.id is null then 'null'::jsonb
      else jsonb_build_object(
        'profileId', profile_record.id,
        'version', profile_record.version,
        'stateCode', profile_record.state_code,
        'status', profile_record.status,
        'effectiveFrom', profile_record.effective_from,
        'effectiveTo', profile_record.effective_to,
        'reviewedBy', profile_record.reviewed_by,
        'reviewedAtUtc', case
          when profile_record.reviewed_at is null then null
          else to_char(
            profile_record.reviewed_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        end
      )
    end
  )
  into new.submission_context
  from public.safety_program_versions program_version
  join public.safety_program_form_template_versions form_version
    on form_version.company_id = program_version.company_id
   and form_version.program_version_id = program_version.id
  join public.safety_program_location_applicability applicability
    on applicability.company_id = program_version.company_id
   and applicability.program_version_id = program_version.id
   and applicability.location_id = new.location_id
  join public.locations location_record
    on location_record.company_id = program_version.company_id
   and location_record.id = new.location_id
  left join public.location_regulatory_profiles profile_record
    on profile_record.company_id = applicability.company_id
   and profile_record.location_id = applicability.location_id
   and profile_record.id = applicability.regulatory_profile_id
  where program_version.company_id = new.company_id
    and program_version.id = new.program_version_id
    and form_version.id = new.form_template_version_id
    and form_version.schema_sha256 = new.form_schema_sha256;

  if new.submission_context is null then
    raise exception 'server-derived submission context is unavailable'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists safety_program_submissions_canonical_context
  on public.safety_program_form_submissions;
create trigger safety_program_submissions_canonical_context
before insert or update on public.safety_program_form_submissions
for each row execute function
  program_private.derive_submission_context();

-- ---------------------------------------------------------------------------
-- Canonical server-owned form evidence manifests and hashes
-- ---------------------------------------------------------------------------

create or replace function program_private.form_unsigned_evidence_manifest(
  target_submission_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
  select jsonb_build_object(
    'manifestVersion', 'safetyops-form-unsigned-v1',
    'submission', jsonb_build_object(
      'submissionId', submission.id,
      'companyId', submission.company_id,
      'programVersionId', submission.program_version_id,
      'locationId', submission.location_id,
      'formTemplateVersionId', submission.form_template_version_id,
      'assignmentId', submission.assignment_id,
      'submittedBy', submission.submitted_by,
      'clientSubmissionKey', submission.client_submission_key,
      'formSchemaSha256', submission.form_schema_sha256,
      'submissionContext', submission.submission_context
    ),
    'answers', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'fieldId', answer.field_id,
            'answerSha256', answer.answer_sha256,
            'attachments', coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'storageObjectId', object_record.id,
                    'attachmentKind', answer_file.attachment_kind,
                    'contentSha256', object_record.content_sha256
                  )
                  order by object_record.id, answer_file.attachment_kind
                )
                from public.safety_program_answer_files answer_file
                join public.safety_program_storage_objects object_record
                  on object_record.id = answer_file.storage_object_id
                 and object_record.company_id = answer_file.company_id
                where answer_file.answer_id = answer.id
              ),
              '[]'::jsonb
            )
          )
          order by answer.field_id
        )
        from public.safety_program_form_answers answer
        where answer.submission_id = submission.id
      ),
      '[]'::jsonb
    )
  )
  from public.safety_program_form_submissions submission
  where submission.id = target_submission_id;
$$;

create or replace function program_private.form_unsigned_evidence_sha256(
  target_submission_id uuid
)
returns text
language sql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
  select encode(
    digest(
      convert_to(
        program_private.form_unsigned_evidence_manifest(
          target_submission_id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function program_private.form_final_evidence_manifest(
  target_submission_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, program_private, pg_temp
as $$
  select
    program_private.form_unsigned_evidence_manifest(target_submission_id)
    || jsonb_build_object(
      'manifestVersion', 'safetyops-form-final-v1',
      'signatures', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'fieldId', signature_record.field_id,
              'signerUserId', signature_record.signer_user_id,
              'signerNameSnapshot', signature_record.signer_name_snapshot,
              'signerRoleSnapshot', signature_record.signer_role_snapshot,
              'signatureMethod', signature_record.signature_method,
              'signatureIntent', signature_record.signature_intent,
              'signatureStorageObjectId',
                signature_record.signature_storage_object_id,
              'signatureArtifactSha256', object_record.content_sha256,
              'signedPayloadSha256',
                signature_record.signed_payload_sha256,
              'signatureSha256', signature_record.signature_sha256,
              'signatureRecord', signature_record.signature_record,
              'signedAtUtc', to_char(
                signature_record.signed_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            )
            order by
              coalesce(
                signature_record.field_id,
                '00000000-0000-0000-0000-000000000000'::uuid
              ),
              signature_record.signer_user_id,
              signature_record.signature_sha256
          )
          from public.safety_program_form_signatures signature_record
          left join public.safety_program_storage_objects object_record
            on object_record.id =
              signature_record.signature_storage_object_id
           and object_record.company_id = signature_record.company_id
          where signature_record.submission_id = target_submission_id
        ),
        '[]'::jsonb
      ),
      'submissionFinalState', (
        select jsonb_build_object(
          'status', final_submission.status,
          'submittedAtUtc', case
            when final_submission.submitted_at is null then null
            else to_char(
              final_submission.submitted_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
          end
        )
        from public.safety_program_form_submissions final_submission
        where final_submission.id = target_submission_id
      )
    );
$$;

create or replace function program_private.guard_signature()
returns trigger
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  submission_record public.safety_program_form_submissions%rowtype;
  field_type_value text;
  field_label_value text;
  object_record public.safety_program_storage_objects%rowtype;
  signer_role_value text;
  signer_name_value text;
  unsigned_payload_sha256 text;
  signature_time timestamptz := clock_timestamp();
begin
  if tg_op <> 'INSERT' then
    raise exception 'signature records are append-only'
      using errcode = '55000';
  end if;

  select submission.*
  into submission_record
  from public.safety_program_form_submissions submission
  where submission.id = new.submission_id
  for update;

  if submission_record.id is null then
    raise exception 'submission not found'
      using errcode = '23503';
  end if;
  if submission_record.status <> 'draft' then
    raise exception 'signatures cannot be added after submission'
      using errcode = '55000';
  end if;
  if submission_record.company_id <> new.company_id
     or submission_record.form_template_version_id <>
       new.form_template_version_id then
    raise exception 'signature does not match the pinned form version'
      using errcode = '23514';
  end if;
  if auth.uid() is not null and new.signer_user_id <> auth.uid() then
    raise exception 'a user may only create their own signature'
      using errcode = '42501';
  end if;

  select
    membership.role::text,
    profile_record.full_name
  into
    signer_role_value,
    signer_name_value
  from public.company_memberships membership
  join public.profiles profile_record
    on profile_record.id = membership.user_id
  where membership.company_id = new.company_id
    and membership.user_id = new.signer_user_id
    and membership.active;

  if signer_role_value is null then
    raise exception 'signer is not an active company member'
      using errcode = '23514';
  end if;

  if new.field_id is not null then
    select
      field_record.field_type,
      field_record.label
    into
      field_type_value,
      field_label_value
    from public.safety_program_form_fields field_record
    where field_record.id = new.field_id
      and field_record.form_template_version_id =
        new.form_template_version_id;

    if field_type_value not in ('signature', 'acknowledgement') then
      raise exception 'field is not a signature or acknowledgement field'
        using errcode = '23514';
    end if;
  else
    field_type_value := 'signature';
    field_label_value := 'Form signature';
  end if;

  if new.signature_storage_object_id is not null then
    select object_value.*
    into object_record
    from public.safety_program_storage_objects object_value
    where object_value.id = new.signature_storage_object_id
      and object_value.company_id = new.company_id;

    if object_record.id is null
       or object_record.purpose <> 'signature_artifact'
       or object_record.malware_scan_status <> 'clean' then
      raise exception 'signature artifact must be a clean private object'
        using errcode = '23514';
    end if;
  end if;

  unsigned_payload_sha256 :=
    program_private.form_unsigned_evidence_sha256(new.submission_id);
  if unsigned_payload_sha256 is null then
    raise exception 'the pinned form evidence manifest is unavailable'
      using errcode = '23514';
  end if;

  new.signer_name_snapshot := coalesce(
    nullif(btrim(signer_name_value), ''),
    case
      when new.signer_user_id = auth.uid()
      then nullif(auth.jwt() ->> 'email', '')
      else null
    end,
    new.signer_user_id::text
  );
  new.signer_role_snapshot := signer_role_value;
  new.signature_method := case
    when field_type_value = 'acknowledgement' then 'electronic_ack'
    else 'typed'
  end;
  new.signature_intent := coalesce(
    nullif(btrim(field_label_value), ''),
    'I acknowledge and sign this record'
  );
  new.signed_payload_sha256 := unsigned_payload_sha256;
  new.signed_at := signature_time;
  new.created_at := signature_time;
  new.signature_record := jsonb_build_object(
    'recordVersion', 'safetyops-signature-v1',
    'submissionId', new.submission_id,
    'formTemplateVersionId', new.form_template_version_id,
    'fieldId', new.field_id,
    'signerUserId', new.signer_user_id,
    'signerNameSnapshot', new.signer_name_snapshot,
    'signerRoleSnapshot', new.signer_role_snapshot,
    'signatureMethod', new.signature_method,
    'signatureIntent', new.signature_intent,
    'signatureStorageObjectId', new.signature_storage_object_id,
    'signatureArtifactSha256', object_record.content_sha256,
    'signedPayloadSha256', new.signed_payload_sha256,
    'signedAtUtc', to_char(
      new.signed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
  new.signature_sha256 := encode(
    digest(convert_to(new.signature_record::text, 'UTF8'), 'sha256'),
    'hex'
  );

  return new;
end;
$$;

-- Once any signature has been captured, its answer/attachment manifest is
-- frozen. This prevents a valid signature digest from being paired with later
-- answer changes.
create or replace function program_private.prevent_signed_answer_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  target_submission_id uuid;
begin
  target_submission_id := case
    when tg_op = 'DELETE' then old.submission_id
    else new.submission_id
  end;

  if exists (
    select 1
    from public.safety_program_form_signatures signature_record
    where signature_record.submission_id = target_submission_id
  ) then
    raise exception 'answers are frozen after the first signature'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function program_private.prevent_signed_attachment_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  target_answer_id uuid;
  target_submission_id uuid;
begin
  target_answer_id := case
    when tg_op = 'DELETE' then old.answer_id
    else new.answer_id
  end;

  select answer.submission_id
  into target_submission_id
  from public.safety_program_form_answers answer
  where answer.id = target_answer_id;

  if exists (
    select 1
    from public.safety_program_form_signatures signature_record
    where signature_record.submission_id = target_submission_id
  ) then
    raise exception 'answer attachments are frozen after the first signature'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists safety_program_answers_signature_freeze
  on public.safety_program_form_answers;
create trigger safety_program_answers_signature_freeze
before insert or update or delete on public.safety_program_form_answers
for each row execute function
  program_private.prevent_signed_answer_mutation();

drop trigger if exists safety_program_answer_files_signature_freeze
  on public.safety_program_answer_files;
create trigger safety_program_answer_files_signature_freeze
before insert or update or delete on public.safety_program_answer_files
for each row execute function
  program_private.prevent_signed_attachment_mutation();

create or replace function program_private.derive_final_submission_hash()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  unsigned_payload_sha256 text;
  final_manifest jsonb;
begin
  if tg_op = 'UPDATE'
     and old.status = 'draft'
     and new.status = 'submitted' then
    if auth.uid() is not null and new.submitted_by <> auth.uid() then
      raise exception 'only the form owner may submit this payload'
        using errcode = '42501';
    end if;

    unsigned_payload_sha256 :=
      program_private.form_unsigned_evidence_sha256(new.id);

    if unsigned_payload_sha256 is null then
      raise exception 'the pinned form evidence manifest is unavailable'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.safety_program_form_signatures signature_record
      where signature_record.submission_id = new.id
        and signature_record.signed_payload_sha256 <>
          unsigned_payload_sha256
    ) then
      raise exception 'a signature does not match the current answer manifest'
        using errcode = '23514';
    end if;

    final_manifest :=
      program_private.form_final_evidence_manifest(new.id);
    new.submitted_payload_sha256 := encode(
      digest(convert_to(final_manifest::text, 'UTF8'), 'sha256'),
      'hex'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists safety_program_submissions_derive_payload
  on public.safety_program_form_submissions;
create trigger safety_program_submissions_derive_payload
before update on public.safety_program_form_submissions
for each row execute function
  program_private.derive_final_submission_hash();

-- The baseline guard assigns submitted_at after the preliminary hash trigger.
-- Recompute last so the retained digest is reproducible from the committed
-- final-state manifest, including the server-owned submission timestamp.
create or replace function program_private.finalize_submission_hash()
returns trigger
language plpgsql
security definer
set search_path = public, program_private, pg_temp
as $$
declare
  final_manifest jsonb;
begin
  if tg_op = 'UPDATE'
     and old.status = 'draft'
     and new.status = 'submitted' then
    if new.submitted_at is null then
      raise exception 'server submission time is required'
        using errcode = '23514';
    end if;

    final_manifest :=
      program_private.form_final_evidence_manifest(new.id)
      || jsonb_build_object(
        'submissionFinalState', jsonb_build_object(
          'status', new.status,
          'submittedAtUtc', to_char(
            new.submitted_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        )
      );
    new.submitted_payload_sha256 := encode(
      digest(convert_to(final_manifest::text, 'UTF8'), 'sha256'),
      'hex'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists safety_program_submissions_z_finalize_payload
  on public.safety_program_form_submissions;
create trigger safety_program_submissions_z_finalize_payload
before update on public.safety_program_form_submissions
for each row execute function
  program_private.finalize_submission_hash();

revoke all on function
  program_private.require_current_program_applicability(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function
  program_private.enforce_current_program_assignment()
  from public, anon, authenticated;
revoke all on function
  program_private.require_current_form_applicability(
    uuid, uuid, uuid, uuid, text
  )
  from public, anon, authenticated;
revoke all on function
  program_private.enforce_current_form_applicability()
  from public, anon, authenticated;
revoke all on function
  program_private.form_unsigned_evidence_manifest(uuid)
  from public, anon, authenticated;
revoke all on function
  program_private.form_unsigned_evidence_sha256(uuid)
  from public, anon, authenticated;
revoke all on function
  program_private.form_final_evidence_manifest(uuid)
  from public, anon, authenticated;
revoke all on function
  program_private.prevent_signed_answer_mutation()
  from public, anon, authenticated;
revoke all on function
  program_private.prevent_signed_attachment_mutation()
  from public, anon, authenticated;
revoke all on function
  program_private.derive_final_submission_hash()
  from public, anon, authenticated;
revoke all on function
  program_private.derive_submission_context()
  from public, anon, authenticated;
revoke all on function
  program_private.finalize_submission_hash()
  from public, anon, authenticated;

grant execute on function
  program_private.require_current_program_applicability(uuid, uuid, uuid)
  to service_role;
grant execute on function
  program_private.require_current_form_applicability(
    uuid, uuid, uuid, uuid, text
  )
  to service_role;
grant execute on function
  program_private.form_unsigned_evidence_manifest(uuid)
  to service_role;
grant execute on function
  program_private.form_unsigned_evidence_sha256(uuid)
  to service_role;
grant execute on function
  program_private.form_final_evidence_manifest(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Final form submission RPC: no caller-supplied evidence digest
-- ---------------------------------------------------------------------------

drop function if exists public.submit_safety_program_form(uuid, text);

create or replace function public.submit_safety_program_form(
  target_submission_id uuid
)
returns public.safety_program_form_submissions
language plpgsql
security definer
set search_path = public, private, program_private, pg_temp
as $$
declare
  submission_record public.safety_program_form_submissions%rowtype;
  actor_role public.safetyops_role;
begin
  if auth.uid() is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  select submission.*
  into submission_record
  from public.safety_program_form_submissions submission
  where submission.id = target_submission_id
  for update;

  if submission_record.id is null then
    raise exception 'submission not found'
      using errcode = 'P0002';
  end if;
  actor_role := private.company_role(submission_record.company_id);
  if actor_role is null
     or not private.is_company_member(submission_record.company_id)
     or not private.can_access_location(
       submission_record.company_id,
       submission_record.location_id
     ) then
    raise exception 'active company and location access is required'
      using errcode = '42501';
  end if;
  if actor_role = 'auditor' then
    raise exception 'auditor role is read-only'
      using errcode = '42501';
  end if;
  if submission_record.submitted_by <> auth.uid() then
    raise exception 'only the form owner may submit this payload'
      using errcode = '42501';
  end if;
  if submission_record.status <> 'draft' then
    raise exception 'submission is not editable'
      using errcode = '55000';
  end if;

  -- Applicability and all required evidence are revalidated by BEFORE
  -- triggers. The final payload hash is also derived there from stored rows.
  update public.safety_program_form_submissions
  set status = 'submitted',
      updated_at = clock_timestamp()
  where id = target_submission_id
  returning * into submission_record;

  if submission_record.assignment_id is not null then
    update public.safety_program_assignments
    set status = 'completed',
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = submission_record.assignment_id
      and status in ('assigned', 'in_progress');
  end if;

  return submission_record;
end;
$$;

revoke all on function public.submit_safety_program_form(uuid)
  from public, anon;
grant execute on function public.submit_safety_program_form(uuid)
  to authenticated;

comment on function public.submit_safety_program_form(uuid) is
  'Atomically submits an owned draft after server-side applicability/evidence validation and derives the final SHA-256 manifest from pinned records.';

comment on function private.can_view_company_person(uuid, uuid) is
  'RLS-safe personnel visibility: self; company administrators/auditors; or location managers/supervisors sharing a location with the target.';
