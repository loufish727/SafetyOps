# Safety Programs schema

Migration `202607300003_safety_programs.sql` adds the controlled-content and completion-record model for the Safety Programs workspace. It depends on the baseline tenant/location schema and the regulatory traceability migration.

## Record flow

1. A Drive adapter running in a Supabase Edge Function observes a provider file and records a `safety_program_source_document`.
2. Each provider revision is mirrored to the private `safety-program-private` bucket. After upload verification and malware scanning, the Edge Function creates immutable `safety_program_storage_objects` and `safety_program_source_versions` rows. The source version points to the canonical provider bytes; `safety_program_source_version_artifacts` links optional rendered PDFs, extracted text, structured extraction, spreadsheet exports, or thumbnails with derivation-tool provenance. OAuth tokens and provider secrets are never stored in these tables or sent to the GitHub Pages client.
3. A `safety_program` is the stable identity. Each controlled edition is a `safety_program_version` with exact source-version links, versioned sections, forms, training links, and regulatory traces.
4. Each active location receives its own `safety_program_location_applicability` decision. Approval fails until every active location—including the initial five—has a reviewed decision.
5. Form templates and fields are version-pinned to the program edition. Submissions retain the exact schema hash, typed answers, private attachments, and signatures. Submission freezes the payload.
6. Assignments pin the published program, location, worker, and required action. Acknowledgement and form submission RPCs atomically create immutable completion evidence and complete the assignment.

## Originals, templates, and submissions

An original is the exact private source file, a template is the interactive
versioned field schema, and a submission is one user's completion of one
published template version. `safety_program_form_template_files` pins an exact
source revision and exact storage-object hash to a template version. A replaced
PDF or spreadsheet creates new source and template versions; it never rewrites
the file behind an existing template or submission.

Source-backed templates require one clean primary original at publication.
Their server-computed source manifest covers the linked roles, source hashes,
object hashes, and source locators. See
`form-originals-and-templates.md` for the signed upload/download protocol and
the distinction between Safety Program forms and baseline inspection
templates.

## Traceability

Every approved section must identify an immutable source revision and a non-empty source locator. `safety_program_regulatory_links` can attach a whole program, section, form version, or field to:

- an approved `compliance_requirement_version`;
- an exact `regulatory_unit_version` containing the authoritative OSHA/state text; or
- both, plus jurisdiction, location, and applicability-assessment context.

The link stores relationship, coverage, rationale, locator, excerpt hash, review identity/time, and its own trace hash. This preserves the path:

`published program/control → reviewed requirement → exact regulatory paragraph → source snapshot/version`

## Controlled states

- Program editions move `draft → in_review → approved → published → superseded`.
- Approval is a four-eye action: the approver cannot be the preparer.
- Approval also requires source/content manifest hashes, an authoritative source, source-pinned sections, all forms published, all linked courses published, reviewed regulatory traces, and reviewed applicability for every active location.
- Program children lock when the parent is approved. Published and superseded editions cannot be rewritten.
- Provider observations, private object metadata, signatures, acknowledgements, and audit events are append-only.
- Submitted form payloads and answers cannot change; a location manager may only add the later review decision.

## Tenant and storage boundaries

All new public tables have RLS. Company administrators and safety managers curate programs and source records. Workers can see only published editions that apply at a location they can access, plus their own assignments and records. Location managers and supervisors work only inside their authorized locations. Auditors receive read access without write access.

The new Storage bucket is private and has no authenticated `storage.objects` policy. A narrow Edge Function should issue scoped signed upload/download URLs, scan uploaded bytes, and create the immutable metadata row with the service role. Browser clients never receive the service-role key.

Manual upload preparation and scan state live in
`program_private.form_upload_sessions`, not in public storage metadata.
Storage-object metadata is inserted only after the bytes are verified clean.
Non-manager downloads are limited to clean, internal files on published forms
whose program/location the caller may already view. Confidential and restricted
originals remain manager-only.

## Audit and verification

An after-row trigger hashes every insert, update, and delete across the Safety Programs domain. Events are serialized per company and chained with `previous_event_sha256`; direct update/delete of audit rows is rejected. Hash chaining detects ordinary in-database tampering, but it is not a substitute for independent custody. Export signed daily audit manifests to separate WORM storage when legal-grade non-repudiation is required.

Before production rollout, apply all migrations to a disposable Supabase project, run tenant-crossing RLS tests for every role, test concurrent approval/publication, and verify signed-URL expiry and malware-scan failure paths.
