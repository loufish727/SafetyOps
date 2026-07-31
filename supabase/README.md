# SafetyOps Supabase foundation

SafetyOps uses Supabase Auth, PostgreSQL, Row Level Security, private Storage, security-definer RPCs, and Edge Functions as the authority for LFES company data. GitHub Pages is only the public browser client.

All database and Edge controls described here are **DESIGNED/UNPROVEN**. They are present in source but have not been shown applied, compiled, and exercised in a dedicated SafetyOps Supabase project. Do not load real company data until the staging proof in this document is complete.

## Migration order

Apply every migration in filename order. Later migrations depend on objects and security helpers created earlier:

1. `202607300001_initial_safetyops.sql` — Core companies, profiles, memberships, locations, forms, inspections, incidents, corrective actions, training, credentials, documents, acknowledgements, evidence, audit events, RLS, and private Storage.
2. `202607300002_regulatory_traceability.sql` — Versioned regulatory sources, immutable source observations, requirements, releases, location profiles, jurisdiction assignments, applicability assessments, approved control mappings, evidence links, change detection, and impact review.
3. `202607300003_safety_programs.sql` — Private source-pinned safety programs, versions, sections, location applicability, digital forms, assignments, submissions, typed answers, signatures, acknowledgements, and audit records.
4. `202607300004_form_originals.sql` — Immutable original/template file links, service-only upload sessions, file authorization helpers, and controlled metadata RPCs.
5. `202607300005_company_onboarding.sql` — Atomic authenticated company-owner onboarding.
6. `202607300006_state_jurisdiction_onboarding.sql` — Oregon, Washington, and California jurisdiction seeds plus first-location onboarding with a draft profile and review-required assignment.
7. `202607300007_form_file_access_ledger.sql` — Service-only allow/deny ledger for controlled form-file download decisions.
8. `202607300008_company_location_onboarding.sql` — Tenant-safe creation of additional locations with draft OR/WA/CA regulatory profiles.
9. `202607300009_inspection_regulatory_trace.sql` — Idempotent inspection submission pinned to the exact published question schema and an immutable server-derived regulatory context. A draft/missing profile or unresolved jurisdiction is recorded as `review_required`; the inspection remains operational, but the database emits zero compliance-evidence links until the profile, jurisdiction, applicability, mapping, requirement, and release chain is reviewed, approved, and effective.
10. `202607300010_lfes_role_and_form_integrity.sql` — Database-authoritative read-only auditor enforcement, location-scoped personnel privacy, immutable inspection tenant/location/template identity, active membership/location revalidation on terminal form submission, current/effective program applicability, server-derived submission context and signature evidence, answer/attachment freezing after signature, and final form-evidence hashes. Signature inserts provide only pinned entity IDs; the database derives signer name from profile/JWT context, company role, method from field type, intent from field label, timestamp, unsigned-payload digest, canonical signature record, and signature hash.

Migration `002` requires PostgreSQL 15 or newer because it uses `UNIQUE NULLS NOT DISTINCT`.

## Deployment order

1. Create a dedicated SafetyOps Supabase project.
2. Link the local project or supply the target project reference to the CLI.
3. Apply migrations `001` through `010` in order and verify that each transaction completed.
4. Deploy the controlled-download Edge Function:

   ```bash
   npx supabase functions deploy sign-form-file --project-ref <project-ref>
   ```

5. Set the exact browser origins allowed to call the function:

   ```bash
   npx supabase secrets set \
     SAFETYOPS_ALLOWED_ORIGINS=https://<production-origin> \
     --project-ref <project-ref>
   ```

6. Confirm that `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are available only in the Edge Function environment. The service-role key must never be added to `supabase-config.js`, GitHub Pages, or any browser bundle.
7. Put only the Supabase project URL and publishable/anon key in `supabase-config.js`.
8. Configure the Auth Site URL and redirect allowlist for the production URL and approved local origins.
9. Exercise onboarding, company/location isolation, inspection truthful degradation, signed downloads, auditor denial, personnel privacy, form-signature integrity, and cross-tenant denial tests before importing real data.

`supabase/config.toml` keeps JWT verification enabled for `sign-form-file`.

Account-level GitHub Pages repositories share one browser origin. SafetyOps therefore keeps persistent browser sessions disabled by default. Use a dedicated custom domain or otherwise isolated trusted origin before setting `SAFETYOPS_ENABLE_PERSISTENT_AUTH_SESSION` to true; CORS cannot isolate two applications by URL path on the same origin.

## What `sign-form-file` does

The function authorizes downloads of already committed form originals:

- Validates the caller's JWT
- Runs the caller-scoped metadata RPC
- Rechecks the exact company, object, content hash, byte size, location, publication state, classification, and malware-scan result
- Creates a five-minute signed URL for one private object
- Records authorized issuance and post-authorization integrity denials in `safety_program_file_access_events`
- Omits bucket paths, signed URLs, bearer tokens, and credentials from the audit ledger

It is not a production upload service. No live prepare, quarantine, malware-scan, or immutable commit pipeline exists. Production upload still requires a separate workflow that consumes the service-only upload-session model from migration `004`. Until that service is implemented and deployed, the public application keeps production upload disabled. Optional localhost staging is development-only, device-local, and never authoritative.

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
