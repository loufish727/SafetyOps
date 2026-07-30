# SafetyOps Supabase foundation

Apply these migrations in filename order:

- `migrations/202607300001_initial_safetyops.sql`
- `migrations/202607300002_regulatory_traceability.sql`
- `migrations/202607300003_safety_programs.sql`
- `migrations/202607300004_form_originals.sql`
- `migrations/202607300005_company_onboarding.sql`

Together they establish:

- Supabase Auth-backed profiles
- Companies, five-or-more locations, company roles, and location assignments
- Versioned form templates and immutable submitted inspections
- Incidents and corrective actions
- Training courses, assignments, completions, and credentials
- Controlled documents, immutable versions, acknowledgements, and explicit access
- Private evidence/document storage
- Append-only audit events
- Global, paragraph-versioned regulatory sources and immutable raw-source fingerprints
- Human-reviewed compliance requirements and exact provision citations
- Location jurisdiction profiles, applicability assessments, and approved control mappings
- Evidence links from inspections, training, and document acknowledgements to pinned requirement versions
- Regulatory sync runs, source cursors, corrections, releases, change sets, and impact-review tasks
- A separate private `regulatory-source-snapshots` Storage bucket
- Private, source-pinned Safety Program originals and template renderings
- Service-only upload sessions for signed, scanned, idempotent form imports
- Row Level Security for tenant, role, and location boundaries
- Atomic first-company onboarding with an owner, Main location, and audit event

## Security rules

- GitHub Pages may receive only the Supabase URL and publishable/anon key.
- Never place a service-role key, email-provider secret, signing key, or third-party API secret in browser code.
- Every business table carries `company_id`; location-scoped tables also carry `location_id`.
- UI permissions are convenience only. PostgreSQL RLS and security-definer RPCs are authoritative.
- Published form/document versions and submitted inspection snapshots are immutable.
- Audit records are database-written and read-only to authorized application roles.
- Browser roles cannot ingest or mutate the global regulatory catalogue; only the background service role can write source observations.
- Keep `regulatory_private` out of the Data API's exposed schemas. The ingestion worker should use a server-only pooled PostgreSQL connection or narrowly scoped security-definer RPCs; do not expose the schema to make `supabase-js` writes convenient.
- The release trigger confirms that the manifest object exists and that release-item hashes match immutable rows. The ingestion worker must still hash the manifest's exact bytes before publication; PostgreSQL cannot verify private Storage bytes by object name alone.
- Published requirements, releases, approved mappings, and submission evidence links are immutable.
- A source change creates a change set and impact-review task; it never silently rewrites a published company control.
- Worker self-service transitions are constrained to narrow training and corrective-action RPCs.
- Private Storage objects are readable only after matching database metadata passes RLS.
- Form originals use the service-controlled `safety-program-private` bucket.
  Browser clients receive only short-lived, one-object signed upload/download
  URLs after server-side tenant, role, draft/published-state, classification,
  hash, and malware-scan checks.
- Storage paths begin with the company UUID.

Suggested path shapes:

```text
{company_id}/documents/{document_id}/{version_id}/{filename}
{company_id}/inspections/{inspection_id}/{file_id}/{filename}
{company_id}/incidents/{incident_id}/{file_id}/{filename}
{company_id}/certifications/{certification_id}/{file_id}/{filename}
regulatory/{source_id}/{yyyy}/{sha256}.{extension}
```

The private form-original/template workflow is documented in
`docs/form-originals-and-templates.md`.

## Next database iteration

Before production use:

1. Run the migration in a separate SafetyOps Supabase project.
   - The regulatory migration requires PostgreSQL 15 or newer because it uses `UNIQUE NULLS NOT DISTINCT`.
2. Add seed data through an authenticated corporate-admin account.
3. Add cross-company and cross-location RLS tests.
4. Add Edge Functions for invitations, scheduled reminders, exports, signing workflows, and allowlisted OSHA/state-source synchronization.
5. Add idempotent offline-sync mutation keys and a durable conflict strategy.
6. Add nightly eCFR/Federal Register monitoring, weekly state-source adapters, and annual official GovInfo CFR snapshots.
7. Verify every regulatory applicability and workflow decision with qualified safety/legal counsel; this schema is a software foundation, not a compliance certification.
