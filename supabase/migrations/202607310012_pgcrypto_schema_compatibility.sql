-- Hosted Supabase installs pgcrypto in the extensions schema. Earlier
-- migrations now qualify extensions.digest directly for clean deployments.
-- This upgrade also repairs the fixed search_path of functions that may have
-- been installed from the earlier unqualified definitions before that change.

alter function regulatory_private.protect_requirement_version()
  set search_path = public, regulatory_private, extensions, pg_temp;
alter function regulatory_private.protect_requirement_citation()
  set search_path = public, regulatory_private, extensions, pg_temp;
alter function regulatory_private.protect_applicability_assessment()
  set search_path = public, regulatory_private, extensions, pg_temp;
alter function regulatory_private.protect_control_mapping()
  set search_path = public, regulatory_private, extensions, pg_temp;
alter function regulatory_private.write_regulatory_audit_event()
  set search_path = public, regulatory_private, extensions, pg_temp;

alter function program_private.guard_answer()
  set search_path = public, extensions, pg_temp;
alter function program_private.capture_audit_event()
  set search_path = public, extensions, pg_temp;
alter function program_private.guard_form_template_sources()
  set search_path = public, private, program_private, extensions, pg_temp;

alter function regulatory_private.validate_inspection_evidence_trace()
  set search_path = public, private, regulatory_private, extensions, pg_temp;
alter function public.submit_inspection_with_regulatory_evidence(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text,
  text
)
  set search_path = public, private, regulatory_private, extensions, pg_temp;
