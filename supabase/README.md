# SafetyOps Supabase foundation

SafetyOps uses Supabase Auth, PostgreSQL, Row Level Security, private Storage, security-definer RPCs, and Edge Functions as the authority for LFES company data. GitHub Pages is only the public browser client.

The last recorded hosted SafetyOps migration evidence in this document is aligned through `012`; migrations `013` through `016` exist in source and require their own deployment evidence. Migrations `010` through `012` compiled and applied in the final pgcrypto compatibility sequence. Supabase's ledger is version-based and does not prove checksum identity for previously applied legacy files. RLS, role, Storage, Edge, and workflow behavior remain **PARTIAL/UNPROVEN** until the staging proof in this document is complete.

## Migration order

Apply every migration in filename order. Later migrations depend on objects and security helpers created earlier:

1. `202607300001_initial_safetyops.sql` — Core companies, profiles, memberships, locations, forms, inspections, incidents, corrective actions, training, credentials, documents, acknowledgements, evidence, audit events, RLS, and private Storage.
2. `202607300002_regulatory_traceability.sql` — Versioned regulatory sources, immutable source observations, requirements, releases, location profiles, jurisdiction assignments, applicability assessments, approved control mappings, evidence links, change detection, and impact review.
3. `202607300003_safety_programs.sql` — Private source-pinned safety programs, versions, sections, location applicability, digital forms, assignments, submissions, typed answers, signatures, acknowledgements, and audit records.
4. `202607300004_form_originals.sql` — Immutable original/template file links, service-only upload sessions, file authorization helpers, and controlled metadata RPCs.
5. `202607300005_company_onboarding.sql` — Historical authenticated company-owner onboarding revision, retired by migration `011`.
6. `202607300006_state_jurisdiction_onboarding.sql` — Oregon, Washington, and California jurisdiction seeds plus the historical four-argument first-location onboarding revision, retired by migration `011`.
7. `202607300007_form_file_access_ledger.sql` — Service-only allow/deny ledger for controlled form-file download decisions.
8. `202607300008_company_location_onboarding.sql` — Tenant-safe creation of additional locations with draft OR/WA/CA regulatory profiles.
9. `202607300009_inspection_regulatory_trace.sql` — Idempotent inspection submission pinned to the exact published question schema and an immutable server-derived regulatory context. A draft/missing profile or unresolved jurisdiction is recorded as `review_required`; the inspection remains operational, but the database emits zero compliance-evidence links until the profile, jurisdiction, applicability, mapping, requirement, and release chain is reviewed, approved, and effective.
10. `202607300010_lfes_role_and_form_integrity.sql` — Database-authoritative read-only auditor enforcement, location-scoped personnel privacy, immutable inspection tenant/location/template identity, active membership/location revalidation on terminal form submission, current/effective program applicability, server-derived submission context and signature evidence, answer/attachment freezing after signature, and final form-evidence hashes. Signature inserts provide only pinned entity IDs; the database derives signer name from profile/JWT context, company role, method from field type, intent from field label, timestamp, unsigned-payload digest, canonical signature record, and signature hash.
11. `202607310011_auth_and_tenant_integrity.sql` — Retires both browser self-onboarding overloads, enforces one active company per user, protects and audit-traces corporate-administrator membership, fixes regulatory-profile supersession, derives jurisdiction reviewer identity/time in PostgreSQL, requires resolved review before profile/program/form use, blocks direct location inserts, and adds a service-role-only atomic bootstrap with truthful system provenance for an invited first owner and initial locations.
12. `202607310012_pgcrypto_schema_compatibility.sql` — Preserves the existing security-definer function paths while adding the hosted `extensions` schema required for explicit pgcrypto digest resolution.
13. `202607310013_drive_form_archive.sql` — Adds two-phase private Drive-export archive ingestion with immutable source/candidate provenance, quarantine metadata, review state, and service access ledgers.
14. `202607310014_candidate_download_review_guard.sql` — Prevents rejected, duplicate, and superseded import candidates from receiving signed downloads.
15. `202607310015_drive_ingest_invalidation_ledger.sql` — Adds append-only ingest-run invalidation while retaining the frozen original evidence.
16. `202608030016_employee_safety_workflows.sql` — Adds employees independent from Auth, exact-location assignments, safety-committee minutes, action/training ownership, employee PDF evidence, and isolated 15-minute one-time tablet forms with append-only completion hashes.

Migration `002` requires PostgreSQL 15 or newer because it uses `UNIQUE NULLS NOT DISTINCT`.

## Deployment order

1. Create a dedicated SafetyOps Supabase project.
2. Link the local project or supply the target project reference to the CLI.
3. Apply migrations `001` through `016` in order and verify that each transaction completed.
4. Deploy the controlled-download Edge Function:

   ```bash
   npx supabase functions deploy sign-form-file --project-ref <project-ref>
   npx supabase functions deploy employee-document-file --project-ref <project-ref>
   ```

5. Set the exact browser origins allowed to call the function:

   ```bash
   npx supabase secrets set \
     SAFETYOPS_ALLOWED_ORIGINS=https://<production-origin> \
     --project-ref <project-ref>
   ```

   To release employee PDFs, also configure a reviewed trusted HTTPS scanner
   endpoint and its server-only bearer token as
   `SAFETYOPS_PDF_SCANNER_URL` and `SAFETYOPS_PDF_SCANNER_TOKEN`. The scanner
   response contract is documented below. Leave both unset to fail closed in
   quarantine.

6. Confirm that `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are available only in the Edge Function environment. The service-role key must never be added to `supabase-config.js`, GitHub Pages, or any browser bundle.
7. Put only the Supabase project URL and publishable/anon key in `supabase-config.js`.
8. Push and verify `supabase/config.toml`: the exact production Site URL and redirect, global public signup disabled, anonymous sign-in disabled, the email/password provider enabled, email confirmation enabled, and secure password change enabled. Do not add broad wildcard or production-localhost redirects.
9. In hosted Auth settings, enforce the 8-character minimum and keep leaked-password screening enabled. SafetyOps enforces a capital letter and a special character in its password-creation and reset UI. Hosted Auth's supported `password_requirements` presets cannot express that exact pair without also requiring a lowercase letter and digit, so direct Auth API password changes are outside that app-level character-class proof. Configure production SMTP before using invitation or recovery email; the default Supabase sender refuses non-team addresses and is best-effort only.
10. Exercise invitation/password setup, invalid and expired callbacks, non-enumerating recovery, administrator provisioning, company/location isolation, one-active-company and last-admin protection, authoritative jurisdiction review, inspection truthful degradation, signed downloads, auditor denial, personnel privacy, form-signature integrity, and cross-tenant denial tests before importing real data.

`supabase/config.toml` keeps JWT verification enabled for authenticated file
services. The employee tablet RPC is anonymous by design but accepts only a
short-lived one-time capability; it does not grant table access or expose the
facilitator's Auth session.

## Employee tablet and PDF boundaries

The authenticated safety user assigns a published form and calls
`begin_employee_form_handoff`. PostgreSQL stores only the capability hash and
returns the raw token once with a 15-minute expiry. The separate employee tab
calls only the handoff read/submit RPCs. Submission validates the exact pinned
schema, consumes the token, completes the assignment, and writes an immutable
manifest SHA-256. File fields are rejected from this flow.

`employee-document-file` is a separate PDF upload/download boundary. It uses a
token-bound processing lease, allowing an interrupted worker to resume while
preventing a stale worker from committing or rejecting a newer attempt.
Format, size, and SHA-256 verification do not count as malware scanning. Until
a configured scanner attests the exact bytes, the document remains
non-releasable as `upload_pending` with malware status `unavailable`; signing
and download RPCs require `clean`. A safety manager can retry the scan without
re-uploading the exact stored object.

The scanner must accept the PDF bytes at the configured HTTPS endpoint and
return JSON containing `status` (`clean` or `rejected`), the exact `sha256`,
`engine`, `engine_version`, `signature_database_version`, `scan_id`, and an ISO
`scanned_at` timestamp. The Edge Function validates and normalizes that record;
only a service-role RPC can apply it to the exact committed SHA-256. Treat the
scanner as an approved employee-record subprocessor.

Account-level GitHub Pages repositories share one browser origin. SafetyOps therefore keeps persistent browser sessions disabled by default. Use a dedicated custom domain or otherwise isolated trusted origin before setting `SAFETYOPS_ENABLE_PERSISTENT_AUTH_SESSION` to true; CORS cannot isolate two applications by URL path on the same origin.

## What `sign-form-file` does

The function authorizes downloads of already committed form originals:

- Validates the caller's JWT
- Runs the caller-scoped metadata RPC
- Rechecks the exact company, object, content hash, byte size, location, publication state, classification, and malware-scan result
- Creates a five-minute signed URL for one private object
- Records authorized issuance and post-authorization integrity denials in `safety_program_file_access_events`
- Omits bucket paths, signed URLs, bearer tokens, and credentials from the audit ledger

`sign-form-file` is not a production upload service for source form originals.
That separate workflow still needs prepare, quarantine, malware scanning, and
immutable commit before form-original upload can be enabled. The employee-PDF
workflow described above is narrower and must not be reused as a general source
document ingestion path. Optional localhost staging is development-only,
device-local, and never authoritative.

## Tenant and location security rules

- Every business record carries `company_id`; location-scoped records also carry `location_id`.
- PostgreSQL RLS and narrow security-definer RPCs are authoritative. UI visibility is not an authorization boundary.
- Company onboarding and additional-location creation execute as database transactions and validate the caller's management authority.
- Worker self-service transitions are constrained to narrow training, corrective-action, form, acknowledgement, and submission policies or RPCs.
- Migration `009` validates the exact published inspection schema and records a server-owned context even when review is incomplete; only fully resolved mappings create typed evidence links.
- Migration `010` adds database-side auditor write denial, prevents draft inspection retargeting, rejects inactive/former members at terminal form submission, revalidates current program/profile/applicability state, and prevents the browser from authoring signature evidence fields.
- Published program, form, document, requirement, release, mapping, and historical submission records are immutable or tightly transition-controlled.
- Database-written audit and access-ledger records are append-only and cannot be fabricated by a browser role.
- Private Storage paths begin with the company UUID and are not public catalogue data.
- Browser clients receive only short-lived, one-object signed URLs after server-side authorization.
- Global regulatory ingestion is service-only. Keep `regulatory_private` out of the Data API's exposed schemas.
- An ingestion worker should use a server-only PostgreSQL connection or narrowly scoped security-definer RPCs; do not expose private schemas to make browser writes convenient.
- A regulatory source change creates a change set and impact-review task. It never silently rewrites a published company control.

Suggested private object paths:

```text
{company_id}/documents/{document_id}/{version_id}/{filename}
{company_id}/inspections/{inspection_id}/{file_id}/{filename}
{company_id}/incidents/{incident_id}/{file_id}/{filename}
{company_id}/certifications/{certification_id}/{file_id}/{filename}
regulatory/{source_id}/{yyyy}/{sha256}.{extension}
```

## OR/WA/CA review requirements

A submitted state code is only an onboarding fact:

- `OR` creates a candidate Oregon OSHA assignment.
- `WA` creates a candidate Washington DOSH assignment.
- `CA` creates a candidate Cal/OSHA assignment.

Each location begins with a draft `location_regulatory_profile` and a `requires_review` jurisdiction assignment. That review state does not block an authorized worker from submitting an operational inspection. Migration `009` pins the latest available profile and jurisdiction facts into an immutable context, labels the trace `review_required`, and emits zero compliance-evidence links. Verified links appear only after an authorized reviewer approves the profile, resolves every jurisdiction assignment, approves the requirement applicability assessment and exact control mapping, and publishes the pinned regulatory requirement release.

Migration `009` enforces that chain inside the database. Browser-provided citation strings are not accepted as evidence. Missing, excluded, or unresolved mappings are preserved honestly in the immutable inspection context instead of being represented as verified compliance evidence.

Federal OSHA remains a baseline and retained-jurisdiction reference. State or address alone cannot decide coverage; employer type, industry, activity, federal enclave, maritime, tribal/trust-land, and other facts may change the controlling authority.

## Regulatory ingestion safeguards

- Browser roles cannot ingest or mutate the global regulatory catalogue.
- Raw source observations and published requirement versions retain exact hashes and lineage.
- The release trigger confirms that the manifest object exists and that release-item hashes match immutable rows.
- The ingestion worker must still hash the manifest's exact bytes before publication; PostgreSQL cannot verify private Storage bytes by object name alone.
- Published requirements, releases, approved mappings, and submission evidence links are immutable.
- Nightly federal and scheduled state-source monitoring should create review work rather than automatically changing approved controls.

## Production-readiness checks

Before loading LFES production information:

1. Apply and record all migrations in a separate SafetyOps project.
2. Verify anon access is revoked from business tables and privileged functions.
3. Run cross-company, cross-location, role, last-admin, and object-path security tests.
4. Deploy and test `sign-form-file` with the exact origin allowlist.
5. Build the production upload quarantine, malware scan, hash verification, immutable commit, and audit workflow.
6. Add invitation, reminder, export, signing, and source-monitoring services as required.
7. Define backup, retention, recovery, incident-response, and secret-rotation procedures.
8. Review every jurisdiction, applicability, and workflow decision with qualified safety and legal personnel.

This schema is a software and evidence-lineage foundation. It does not determine legal applicability by itself and does not certify OSHA or state-plan compliance.

The browser currently applies explicit caps to workspace queries (generally 30 to 1,000 rows by collection). Those caps prevent unbounded first loads but are not pagination. Add deterministic ordering, cursors/ranges, truncation indicators, and detail-on-demand before a tenant can exceed the caps.

The form-original workflow is documented in `docs/form-originals-and-templates.md`.
