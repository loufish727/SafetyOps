# SafetyOps Architecture

## Current system boundary

SafetyOps is a static browser application intended for GitHub Pages. GitHub
serves the shell and regulatory reference artifacts; authenticated tenant data
is intended to come from Supabase after RLS authorizes the user.

```mermaid
flowchart LR
  A["GitHub Pages: public shell and reference catalogs"] --> B["Browser app"]
  B --> C["Supabase Auth"]
  B --> D["Data API and RPCs"]
  B --> E["Edge Function: sign-form-file"]
  D --> F["PostgreSQL with RLS"]
  E --> F
  E --> G["Private Supabase Storage"]
  H["Future source ingestion and monitoring"] -. "not deployed" .-> F
  H -. "not deployed" .-> G
```

This is the target architecture represented by source. The public shell has an
exact signed release process. The hosted migration ledger is aligned through
`012`, and `010` through `012` compiled and applied in the final compatibility
sequence on 2026-07-31. That ledger does not prove historical file checksums.
Catalog, cross-role, tenant-isolation, Storage, Edge Function, and full workflow
behavior remain separately unproven.

## Public layer

- `index.html`, `styles.css`, and `app.js` form the static application.
- `supabase-config.js` is public by design and contains only the dedicated
  project URL and its publishable key.
- Persistent Supabase sessions remain disabled on the shared account-level
  `github.io` origin. Enabling them requires a dedicated custom domain and
  corresponding Auth/Edge origin allowlists.
- `data.js` and the public safety-program files contain null company/user values
  and empty tenant collections.
- `tenant-bootstrap.js` can load ignored private fixtures only on localhost and
  only when explicit development flags are enabled.
- `osha-reference.js` contains the full 1,547-record structural index for eCFR
  29 CFR Chapter XVII with `currentThrough: 2026-07-29`.
- `state-osha-reference.js` contains 10 curated records each for Oregon,
  Washington, and California. Its official links were checked 2026-07-30, but
  it explicitly claims no source-content hash or complete legal coverage.
- `scripts/build-static.js` creates the allowlisted `dist` artifact.
- `scripts/verify-public-build.mjs` checks empty tenant seeds, tenant-free
  regulatory mappings, the exact 12-file `dist` allowlist, and the complete
  sanitized release tree for known tenant markers, Drive identities,
  credentials, private directories, and symbolic links. Git-tracked
  private/generated directories, environment files, debug logs, and local
  Supabase configuration are hard failures rather than scanner exclusions.
- Local release approval requires the ignored private tenant denylist and
  Ed25519 private key. Attestation schema v2 signs exact hashes and byte sizes
  for both the deployable artifact and every sanitized release-tree file. The
  attestation JSON/signature alone are excluded to avoid circular hashing.
  CI verifies the strict schema, public-key signature, both aggregates, and
  both exact file lists.

The working source repository contains prior private material in history, so
only the sanitized single-root release repository may be published.

## Browser and data layer

`app.js` initializes Supabase only when public connection values are present.
Otherwise it renders a configuration-required state. After authentication:

1. the app resolves one active `company_memberships` row;
2. it loads company, location, profile, regulatory, inspection, incident,
   action, training, document, member, audit, safety-program, form, assignment,
   submission, lineage, and file-link records scoped by `company_id`;
3. it maps authorized records into browser state; and
4. it renders empty states when a tenant has no operational records.

Inspection submission uses
`submit_inspection_with_regulatory_evidence`, while company/location onboarding
and terminal safety-program submission use narrow RPCs. Incident, training,
corrective-action, and draft-form writes use RLS-filtered Data API paths. These
browser paths depend on database-side authorization; hidden controls are not
treated as the security boundary (LFES-SEC-002).

Workspace reads now have explicit collection caps, generally 30 to 1,000 rows.
They are bounded first loads, not pagination: deterministic cursors/ranges,
truncation indicators, and detail-on-demand remain required before scale.

## Database layer

Migrations must be applied in filename order:

1. `202607300001_initial_safetyops.sql`: tenant, locations, roles, operational
   forms, inspections, incidents, actions, training, documents, evidence, audit,
   RLS, and narrow worker RPCs.
2. `202607300002_regulatory_traceability.sql`: source/version lineage,
   requirements, releases, changes, location profiles, applicability, mappings,
   and regulatory evidence.
3. `202607300003_safety_programs.sql`: versioned programs, form schemas,
   assignments, submissions, answers, signatures, acknowledgements, sources,
   private object metadata, audit, and RLS.
4. `202607300004_form_originals.sql`: immutable original/template file links,
   service-controlled upload sessions, metadata authorization, and file RLS.
5. `202607300005_company_onboarding.sql`: historical atomic company onboarding
   revision retained in migration history and retired by migration `011`.
6. `202607300006_state_jurisdiction_onboarding.sql`: OR/WA/CA seeds and the
   historical four-argument company onboarding revision, retired by migration
   `011`.
7. `202607300007_form_file_access_ledger.sql`: service-only allow/deny events
   for signed form-file access.
8. `202607300008_company_location_onboarding.sql`: authorized additional
   location creation with a draft, review-required jurisdiction assignment.
9. `202607300009_inspection_regulatory_trace.sql`: exact published-template
   inspection RPC, idempotency, immutable regulatory contexts, typed evidence
   links, and acknowledgement audit coverage. Draft/review-required profiles
   are captured as `review_required` without emitting compliance evidence.
10. `202607300010_lfes_role_and_form_integrity.sql`: database-side read-only
    auditor enforcement, scoped personnel visibility, immutable inspection
    tenant/location/template identity, active access revalidation, current
    program/profile applicability, canonical form contexts, server-derived
    signature/final evidence hashes, and answer/attachment freezing after
    signature. A browser
    signature insert supplies only pinned submission, template, field, signer,
    and optional artifact IDs. PostgreSQL derives the signer name from
    profile/JWT context, company role, method from the pinned field type, intent
    from its label, timestamp, unsigned-payload digest, canonical signature
    record, and signature hash.
11. `202607310011_auth_and_tenant_integrity.sql`: service-only invite-owner
    bootstrap with system provenance; retirement of both browser onboarding
    overloads; one-active-company, attributable membership audit, and
    last-administrator invariants; state-aware location enforcement; corrected
     profile supersession; database-derived jurisdiction review; and
     resolved-jurisdiction profile/program gating.
12. `202607310012_pgcrypto_schema_compatibility.sql`: hosted-Supabase pgcrypto
    namespace compatibility and original-search-path-preserving repair for
    hash-dependent functions installed by migrations `002` through `009`.

The critical intended boundaries are `private.is_company_member`,
`private.can_manage_company`, `private.can_access_location`, RLS policies,
foreign keys that repeat `company_id`, and pinned `search_path` values on
security-definer functions. Hosted version-ledger alignment and the final
`010`–`012` compatibility application are proven; exact legacy file identity
and the complete runtime role and tenant-denial matrix are not.

## Private file boundary

The intended original-form download path is:

1. authenticated browser requests RLS-filtered metadata through
   `get_safety_program_form_file_metadata`;
2. the browser invokes `sign-form-file`;
3. the function revalidates user access and immutable object metadata;
4. only clean, verified bytes receive a five-minute signed URL; and
5. the service writes an allow/deny access event.

The function exists in source but is not proven deployed. There is no live
prepare, quarantine, malware-scan, or immutable upload/attachment commit
pipeline. Production controls therefore keep upload actions disabled; optional
localhost staging is device-local development state, not company evidence.

## Regulatory traceability

Location onboarding never makes a legal determination. A state selection
creates a draft profile and `requires_review` assignment. Migration `009` is
designed to allow the operational inspection while capturing that incomplete
context immutably as `review_required`; it emits zero compliance-evidence links
until the profile, jurisdiction, applicability assessment, exact mapping,
requirement, and release are reviewed, approved, published, and effective.

The federal artifact is a full structural/link index as of 2026-07-29. The
state artifact is deliberately a 30-record curated high-use catalog, not a
complete state corpus, and claims no state source-byte hash. Qualified review
and controlled source snapshots remain required. Nothing in the reference
layer is an LFES or regulatory compliance certification.

## Open architecture boundaries

- no clean local PostgreSQL replay, applied-file checksum proof for legacy
  versions, or hosted catalog assertion suite;
- no hosted cross-company, cross-location, or role denial tests;
- no deployed Edge Function, source ingestion, malware scanner, scheduler, or
  change-monitoring worker;
- bounded query caps without user-visible pagination or truncation handling;
- no offline mutation/conflict design;
- no database backup, rollback, or forward-correction runbook;
- no live prepare/quarantine/malware/commit upload service;
- possible legacy IndexedDB staging blobs on devices used by earlier builds;
- concentrated browser responsibilities in `app.js`.

These boundaries are release gates in `RELEASE_CHECKLIST.md`.
