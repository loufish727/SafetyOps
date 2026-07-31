# SafetyOps

SafetyOps is a multi-tenant application foundation for workplace safety operations across multiple locations. Its engineering baseline is the LFES Full Private Packet generated 2026-06-10 and the inherited Gold, Core, Security, Database, Reliability, Reviewability, and Deployment standards. This is an internal engineering standard, not an LFES certification or a compliance certification.

The public application starts empty. It does not ship a fictional company, locations, workers, incidents, inspections, training records, documents, or tenant control mappings. GitHub Pages hosts the application shell and public regulatory reference metadata; authorized company records and private files belong in Supabase.

The browser implementation, ten ordered migrations, and one controlled-download Edge Function exist in source. The database controls and Edge behavior remain **DESIGNED/UNPROVEN** until migrations `001` through `010` are applied and tested in a dedicated SafetyOps Supabase project. A hosted release may therefore be an honest connection-required shell without being ready for production tenant operation.

## Current source implementation

- Supabase email/password authentication and company membership bootstrap
- Atomic first-company onboarding with a named first location
- Tenant-safe creation of additional locations
- Company- and location-scoped operational views
- Safety-program and source-derived digital-form data models
- Form drafts, typed answers, electronic signatures, and pinned source/schema lineage
- Inspection, incident, training-assignment, corrective-action, and document-acknowledgement workflows
- Controlled form-original downloads through short-lived, one-object signed URLs
- Full structural eCFR index for 29 CFR Chapter XVII, current through 2026-07-29
- Curated high-use Oregon OSHA, Washington DOSH, and Cal/OSHA starter references
- Location regulatory profiles, jurisdiction assignments, applicability assessments, approved control mappings, and evidence lineage
- Idempotent database-side inspection submission with immutable regulatory context; draft or review-required profiles degrade to `review_required` with zero compliance-evidence links
- Database-authoritative auditor, personnel-visibility, inspection-identity, active-membership, current-applicability, signature, and final form-evidence controls in migration `010`; the browser supplies only pinned signature entity IDs while PostgreSQL derives signer identity/role, method, intent, timestamp, unsigned-payload digest, signature record, and signature hash
- Row Level Security, immutable version records, append-only audit records, and private Storage design
- Bounded browser queries, with explicit server pagination still required before large-scale use
- Responsive desktop/mobile interface; the latest full local Playwright run completed with 39 passed, 7 conditional/project skips, and 0 failures
- GitHub Pages build and deployment workflow

Some administrative workflows remain intentionally unavailable until their server-side services are deployed. In particular, SafetyOps does **not** yet provide a production form-original upload service. The checked-in `sign-form-file` Edge Function authorizes downloads of already committed, verified files; it is not an upload, quarantine, malware-scan, or commit service. Development-only local upload staging is disabled by default and is never the production system of record.

## LFES location and jurisdiction model

Each company owns its locations, memberships, programs, forms, and operational records. A user sees only the company and locations authorized by Supabase RLS.

Company and location onboarding currently accepts Oregon, Washington, or California. That state selection creates a draft location regulatory profile and a `requires_review` state-plan assignment:

- Oregon locations are candidates for Oregon OSHA coverage.
- Washington locations are candidates for Washington DOSH coverage.
- California locations are candidates for Cal/OSHA coverage.
- Federal OSHA remains a baseline reference and may retain jurisdiction for particular employers, activities, or locations.

State, ZIP code, or address alone does not determine legal applicability. Employer type, industry, work activity, federal enclaves, maritime activity, tribal or trust lands, and other coverage facts require human review. SafetyOps must not emit compliance evidence until the applicable profile, jurisdiction assignments, requirement assessment, control mapping, and regulatory release have all been reviewed and approved.

## Public/private boundary

The public build contains:

- Static HTML, CSS, and application JavaScript
- The locally vendored, version-pinned Supabase browser client at `vendor/supabase.js`
- Empty tenant seed collections
- Public federal and state regulatory reference metadata

It does not contain tenant source files, Drive identities, employee data, private storage paths, signed URLs, service-role credentials, or company control mappings. Files under the ignored `private/` directory are local development inputs and are disabled unless an explicit localhost-only flag is enabled.

The public GitHub repository must be published from the sanitized clean-history release tree. Do not push the internal development repository or its history. Before every release, build the exact source state and run `npm run attest:public-boundary` with the ignored local tenant denylist and private signing key. The v2 Ed25519 attestation records hashes and byte sizes for both the exact 12-file deployable `dist` artifact and every file in the sanitized release tree; only the attestation JSON and signature are excluded from release-tree hashing to avoid circular input. CI verifies the strict schema, signature, both aggregate hashes, and both exact file lists before deployment. The verifier also fails closed if Git tracks a private/generated directory, environment file, debug log, or local Supabase configuration. Private tenant markers and the signing key are never committed.

## Local development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`.

The browser loads `vendor/supabase.js` from the same origin; it does not execute the Supabase client from a third-party CDN. The build and public-boundary checks also pin its reviewed SHA-256 digest. Keep the vendored file, the pinned `@supabase/supabase-js` dependency, the lockfile version, and the expected digest aligned when upgrading the client.

Authentication persistence is disabled by default because all repositories under an account-level GitHub Pages host share one browser origin. Leave `SAFETYOPS_ENABLE_PERSISTENT_AUTH_SESSION` false on `loufish727.github.io`. Before enabling persistent sessions for production, give SafetyOps a dedicated trusted origin, such as its own custom domain, and update the Auth redirect and Edge Function origin allowlists.

## Validation

```bash
npm run build
npm run test
npm run test:public-boundary
npm run generate:public-attestation-key # one-time release-authority setup
npm run attest:public-boundary
npm run test:public-boundary:ci
npm run sync:osha
```

`test:public-boundary` evaluates the built public seed, requires empty tenant and company-control collections, enforces the explicit `dist` allowlist, scans the sanitized release tree, rejects tracked sensitive/excluded paths, and rejects known tenant markers, credentials, private directories, and embedded Drive identities. `attest:public-boundary` additionally requires the ignored local denylist and private signing key and writes the v2 dual-manifest signature. CI uses `test:public-boundary:ci` and fails unless the rebuilt `dist` artifact and checkout both match that approval exactly. Keep the private key backed up securely; key rotation requires a separately reviewed public-key change.

`sync:osha` retrieves official eCFR metadata and the complete Chapter XVII structure, refuses to publish during an in-progress import, fingerprints that structure, and regenerates `osha-reference.js` and `docs/osha-corpus-manifest.json`. The current federal artifact contains 1,547 structural records and is current through 2026-07-29. It is a structural/link index, not a private raw-text snapshot store.

## Supabase deployment order

Use a separate Supabase project for SafetyOps:

1. Apply every SQL file in `supabase/migrations/` in filename order, currently `202607300001` through `202607300010`. Until a clean apply and hosted role tests are recorded, treat every database behavior in this repository as design evidence only.
2. Deploy the controlled-download function:

   ```bash
   npx supabase functions deploy sign-form-file --project-ref <project-ref>
   npx supabase secrets set \
     SAFETYOPS_ALLOWED_ORIGINS=https://<production-origin> \
     --project-ref <project-ref>
   ```

3. Confirm the function receives the Supabase URL, anon key, and service-role key as server-side function secrets. Never copy the service-role key into browser code or GitHub Pages configuration.
4. Add only the project URL and publishable/anon key to `supabase-config.js`.
5. Configure the Supabase Auth Site URL and redirect allowlist for the production GitHub Pages URL and approved local development origins.
6. Review the Storage buckets, RLS policies, function origin allowlist, and migration results before loading company data.
7. Create or import real company records through authorized workflows. Do not seed production from ignored local fixtures.

See `supabase/README.md` for the migration-by-migration capabilities and security requirements.

## Private form files

Committed form originals are represented by immutable database metadata and private Storage objects. `sign-form-file`:

- Validates the caller's Supabase JWT
- Re-runs tenant, role, publication-state, classification, and location authorization
- Requires matching database metadata plus a clean malware-scan status
- Issues a five-minute signed URL for one object
- Records authorized issuance and post-authorization integrity denials in the service-only access ledger
- Never returns a service credential; the metadata RPC and audit ledger omit the raw object path

Production upload remains a separate required service. No live prepare, quarantine, malware-scan, or immutable commit pipeline exists yet. It must prepare a short-lived upload session, quarantine the bytes, validate MIME and size, calculate and compare SHA-256, scan for malware, commit immutable metadata, and write an audit event. Until that service exists, production upload controls remain disabled.

## Regulatory and safety notice

SafetyOps is designed to preserve source versions, review decisions, and evidence lineage; it does not independently determine regulatory applicability or certify compliance. The 30 state records are deliberately curated high-use references, not a complete state corpus. Public summaries are starting points, not substitutes for current official rule text, applicable exceptions, qualified safety professionals, or legal advice.

The eCFR is continuously updated and is not the official legal edition of the CFR. Oregon, Washington, California, and federal sources must be monitored and re-reviewed when they change. A source update creates review work; it must never silently rewrite an approved company control or historical record.

## Reference documents

- `docs/competitive-research.md`
- `docs/form-originals-and-templates.md`
- `docs/google-drive-safety-program-ingestion.md`
- `docs/safety-programs-schema.md`
- `docs/osha-reference-architecture.md`
- `docs/osha-corpus-manifest.json`
- `docs/product-blueprint.md`
- `docs/supabase-architecture.md`
- `supabase/README.md`
- `docs/LFES/README.md`
- `docs/LFES/CONTROL_MATRIX.md`
- `docs/LFES/PROOF_MODEL.md`
- `docs/QA_LOG.md`
- `docs/KNOWN_RISKS.md`
- `docs/RELEASE_CHECKLIST.md`
