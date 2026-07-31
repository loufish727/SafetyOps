# SafetyOps QA Log

LFES rule: record what ran, what it proved, and what remains outside the proof
boundary.

## Current 2026-07-30 evidence

| Check | Result | What it proves | What it does not prove |
|---|---:|---|---|
| Full `npm test` Playwright run, desktop and Pixel 7 projects | PASS: 39 passed, 7 skipped, 0 failed | The empty/configuration shell, mocked authenticated workspace, responsive views, role presentation, onboarding, inspection/program-form RPC contracts, incident flow, and reference-guide behavior passed the current browser harness. | PostgreSQL, RLS, Storage, Edge Functions, real persistence, real devices, accessibility, weak networks, or hosted behavior. |
| Targeted program-form submission test, desktop and mobile | PASS | The browser sends only pinned signature entity IDs and completes the expected mocked submission contract in both projects. | Migration `010` trigger execution, server-derived signature fields/hashes, persistence, or hostile direct-write rejection. |
| Skip review | ACCEPTED FOR THIS LAYER | Four skip instances are two tests requiring ignored private fixture/original PDFs in both projects; three are desktop skips of mobile-only overflow mirrors. They are conditional/project skips, not failures. | The unavailable private fixture/original PDF paths. |
| Signed public-release verification | PASS | Ed25519 attestation v2 binds exact hashes/sizes for all 12 deployable `dist` files and every sanitized release-tree file. CI verifies the strict schema, signature, both aggregate hashes, and both exact file lists. | Tenant database behavior, production secrets, runtime authorization, or hosted tenant workflows. |
| Public regulatory source evaluation | PASS | Public tenant/program collections are empty; tenant control links are absent; the federal artifact has 1,547 structural records current through 2026-07-29; the state artifact has 30 curated records (10 OR, 10 WA, 10 CA). | Complete state coverage, state source-byte hashes, legal applicability, or current official text after the artifact date. |
| Migrations and Edge source inspection | PARTIAL | Ten ordered migrations and the `sign-form-file` Edge source describe the intended LFES controls. | SQL compilation/application, catalog state, grants, role denials, Storage behavior, or function deployment. |

## Prior and intermediate failures retained as history

- An earlier desktop-only run reported **11 passed, 6 skipped, 1 failed**
  because the Safety Programs upload test still looked for stale button text.
  The selector was corrected; the current full run has no failures.
- An earlier public-boundary run found stale tenant-derived mappings and source/
  `dist` hash differences. The sanitized release and signed exact-tree process
  replaced that stale artifact.
- During active post-release source changes, CI-mode verification correctly
  rejected a build that differed from its prior attestation. Every new release
  must rebuild and produce a new local-denylist signature before CI deploys it.

## Not run

- clean PostgreSQL apply of migrations `001` through `010`;
- catalog checks for RLS, grants, function ownership, trigger installation,
  and pinned `search_path`;
- hosted anonymous, two-company, cross-location, and all-role denial tests;
- hosted inspection `review_required` degradation and verified evidence-link
  emission;
- private Storage and signed-file allow/deny tests;
- Edge Function deployment and access-ledger verification;
- live prepare/quarantine/malware-scan/immutable-commit upload tests;
- real-device, accessibility, weak-network, reconnect, and persistent-session
  tests;
- cache-busted hosted tenant smoke;
- backup/restore, migration recovery, and qualified regulatory review.

## Current QA decision

The browser suite and signed public-shell release layers pass. Production tenant
operation remains **BLOCKED** because the database, RLS role matrix, Storage,
Edge, upload, recovery, and regulatory-review layers are unproven. A hosted
connection-required shell is an honest release state, not production readiness.
