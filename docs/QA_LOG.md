# SafetyOps QA Log

LFES rule: record what ran, what it proved, and what remains outside the proof
boundary.

## Current 2026-08-03 evidence

| Check | Result | What it proves | What it does not prove |
|---|---:|---|---|
| Full `npm test` Playwright run, desktop and Pixel 7 projects | PASS: 97 passed, 7 skipped, 0 failed | In addition to the prior auth, tenant, responsive, inspection, incident, program, and regulatory-guide coverage, the harness passes the task-first Today setup path, Quick start, Safety inbox, Safety Monitor, committee minutes/action ownership/finalization, training assignment/completion/retention and regulatory-basis evidence, anonymous one-time tablet forms with pending-to-complete dashboard state and replay denial, scanned-clean facilitated PDF signing, fail-closed PDF quarantine, company/private Drive-original access, manager review controls, and source-collection/folder hierarchy on desktop/mobile. | Real authenticated workflow persistence, scanner behavior, hosted callback exchange and email delivery, real devices, accessibility, or weak networks. |
| Targeted program-form submission test, desktop and mobile | PASS | The browser sends only pinned signature entity IDs and completes the expected mocked submission contract in both projects. | Migration `010` trigger execution, server-derived signature fields/hashes, persistence, or hostile direct-write rejection. |
| Skip review | ACCEPTED FOR THIS LAYER | Four skip instances are two tests requiring ignored private fixture/original PDFs in both projects; three are desktop skips of mobile-only overflow mirrors. They are conditional/project skips, not failures. | The unavailable private fixture/original PDF paths. |
| Signed public-release verification | PASS | Ed25519 attestation v2 binds exact hashes/sizes for all 12 deployable `dist` files and all 80 sanitized release-tree files. Local boundary and signature verification passed; GitHub Actions must reproduce the exact lists before Pages deployment. | Tenant database behavior, production secrets, runtime authorization, or hosted tenant workflows. |
| Public regulatory source evaluation | PASS | Public tenant/program collections are empty; tenant control links are absent; the federal artifact has 1,547 structural records current through 2026-07-29; the state artifact has 30 curated records (10 OR, 10 WA, 10 CA). | Complete state coverage, state source-byte hashes, legal applicability, or current official text after the artifact date. |
| Hosted migration `016` deployment | PASS FOR NAMED EVIDENCE | The final source passed a hosted `BEGIN`/`ROLLBACK` compile, was applied, and was recorded in the migration ledger with its SHA-256. Live checks found the expected employee form/document tables and RPCs, RLS on the five named sensitive tables, zero anonymous table grants, exactly two anonymous capability-bound handoff RPC grants, one company, five active locations, and one employee. | Exact identity for older migrations, hostile authenticated role requests, full trigger/policy behavior, backup/restore, scanner integration, or complete live workflows. |
| Hosted migration `017` deployment | PASS FOR NAMED EVIDENCE | The reviewed source passed hosted rollback compilation, was applied with SHA-256 `4a98c3c684e8ef7ac4e9bb78a6cd57385e1846e4e5a39c2eaedd32b2d8597516`, and produced 112 company-access plus 11 safety/admin-private candidates with zero invalid company scopes. Live checks confirmed candidate/review-event RLS, scoped table/RPC grants, no anonymous grants, and no direct authenticated candidate updates. | Hostile authenticated requests across disposable companies and roles, complete UI persistence, backup/restore, or recovery. |
| Hosted migration `018` deployment | PASS FOR NAMED EVIDENCE | The reviewed source passed hosted rollback compilation, was applied with SHA-256 `173b97ac95fe8ff0548ac39e7e5f548d03eb53801d7380cf2ce4020e4db82aee`, and gave all 123 candidates immutable sanitized collection labels: 120 Forms & Appendices and 3 Spanish Translations. Live checks confirmed zero invalid labels, RLS, read-only authenticated table access, enabled derivation/guard triggers, and no callable derivation grants. | Hostile authenticated requests across disposable companies and roles, complete UI persistence, backup/restore, or recovery. |
| Employee document Edge Function | PASS FOR DEPLOYMENT INVENTORY | `employee-document-file` deployed successfully; hosted inventory reports it active with `verify_jwt=true`. Deno type-checking passed. Security review closed stale-worker storage deletion and exact-hash malware-rejection evidence races. | A configured real scanner, authorized upload/download on hosted Storage, timeout/retry under load, or operational recovery. |
| Hosted Auth configuration | PASS FOR CONFIGURATION | Exact GitHub Pages Site URL/redirect, invite-only email Auth, disabled public/anonymous signup, the 8-character hosted minimum, no extra hosted character preset, leaked-password protection, secure password change, refresh-token rotation, and publishable/secret keys were read back from the hosted project. Legacy anon/service-role keys were disabled. SafetyOps separately enforces a capital and special character in its password-creation/reset UI. | Direct Auth API character-class enforcement, production SMTP, external-recipient delivery, invite acceptance, recovery delivery, MFA, or session behavior on real devices. |
| Hosted owner and initial-tenant bootstrap | PASS FOR PROVISIONING | The invited owner record, one active corporate-administrator membership, five location memberships, five persisted locations, the intended default location, five draft regulatory profiles, five `requires_review` assignments, and six NULL-actor system-provisioning audit events were read back after the atomic service-only call. | Invite acceptance, password setup, authenticated workspace reload, ordinary workflows, or role isolation. |
| Hosted catalog and anonymous boundary baseline | PASS FOR NAMED ASSERTIONS | Every public table reports RLS enabled; no reviewed security-definer function is missing a pinned `search_path`; both historical self-onboarding overloads are absent; only `service_role` can execute first-owner bootstrap; all three Storage buckets are nonpublic; public signup returned 422; anonymous Data API and privileged-RPC requests returned 401; anonymous private-bucket listing returned zero objects. | Full policy/grant/owner/trigger assertions, authenticated role behavior, cross-company/cross-location denial, or authorized Storage download. |
| Hosted Pages deployment and signed-out smoke | PASS | GitHub Actions passed browser tests, build, exact-tree attestation verification, and Pages deployment. A cache-busted live desktop load rendered the connected invite-only sign-in shell instead of the configuration-required state. | Mobile live smoke, invite callback acceptance, authenticated tenant reload, accessibility, weak-network behavior, or rollback. |
| Migrations and Edge source inspection | PARTIAL | Eighteen ordered migrations and three Edge Function sources describe the intended LFES controls; migrations `016` through `018` are SHA-bound in the hosted ledger, the hardened Drive-ingest function is active at version 2, and the final `010`–`012` compatibility sequence compiled/applied. | Legacy applied-file checksum identity, complete catalog/grant assertions, authenticated role denials, or authorized Storage behavior. |

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

- clean local Docker/PostgreSQL replay of migrations `001` through `012`;
- complete policy/grant, function-owner, and trigger-installation assertions;
- hosted two-company, cross-location, and all authenticated-role denial tests;
- hosted inspection `review_required` degradation and verified evidence-link
  emission;
- authenticated private Storage and signed-file allow/deny tests;
- hosted authorized employee-PDF upload/download and access-ledger verification;
- configured-scanner clean/rejected/timeout/retry/stale-lease recovery tests;
- real-device, accessibility, weak-network, reconnect, and persistent-session
  tests;
- live mobile, invite-acceptance, password-setup, and authenticated-tenant smoke;
- backup/restore, migration recovery, and qualified regulatory review.

## Current QA decision

The browser suite, hosted migrations `016` through `018`, employee-document function
deployment, Auth configuration, initial tenant provisioning, named
catalog/anonymous assertions, and signed live-shell layers pass. Broad
production tenant operation remains **BLOCKED** because the authenticated RLS
role matrix, authorized Storage/scanner behavior, external recovery delivery,
backup/restore, and regulatory-review layers are unproven.
