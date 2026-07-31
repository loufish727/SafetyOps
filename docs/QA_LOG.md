# SafetyOps QA Log

LFES rule: record what ran, what it proved, and what remains outside the proof
boundary.

## Current 2026-07-31 evidence

| Check | Result | What it proves | What it does not prove |
|---|---:|---|---|
| Full `npm test` Playwright run, desktop and Pixel 7 projects | PASS: 67 passed, 7 skipped, 0 failed | The empty/configuration shell, invite-only sign-in presentation, app password-policy presentation/enforcement, verified invite/password setup, invalid/expired callback handling, non-enumerating recovery success/error paths, auth-event deduplication, sign-out/reload, stale A-to-signout and A-to-B tenant-load rejection, provisioning-pending state, mocked authenticated workspace, responsive views, role presentation, Pacific/Boise location-timezone handling, inspection/program-form RPC contracts, incident flow, and reference-guide behavior passed the current browser harness. | PostgreSQL role behavior, hosted callback exchange and email delivery, Storage, Edge Functions, real workflow persistence, real devices, accessibility, or weak networks. |
| Targeted program-form submission test, desktop and mobile | PASS | The browser sends only pinned signature entity IDs and completes the expected mocked submission contract in both projects. | Migration `010` trigger execution, server-derived signature fields/hashes, persistence, or hostile direct-write rejection. |
| Skip review | ACCEPTED FOR THIS LAYER | Four skip instances are two tests requiring ignored private fixture/original PDFs in both projects; three are desktop skips of mobile-only overflow mirrors. They are conditional/project skips, not failures. | The unavailable private fixture/original PDF paths. |
| Signed public-release verification | PASS | Ed25519 attestation v2 binds exact hashes/sizes for all 12 deployable `dist` files and all 67 sanitized release-tree files. A clean-checkout reproduction and GitHub Actions verified the strict schema, signature, both aggregate hashes, and both exact file lists. | Tenant database behavior, production secrets, runtime authorization, or hosted tenant workflows. |
| Public regulatory source evaluation | PASS | Public tenant/program collections are empty; tenant control links are absent; the federal artifact has 1,547 structural records current through 2026-07-29; the state artifact has 30 curated records (10 OR, 10 WA, 10 CA). | Complete state coverage, state source-byte hashes, legal applicability, or current official text after the artifact date. |
| Hosted migration deployment | PASS FOR VERSIONED APPLICATION | The dedicated project's migration ledger is aligned through `012` with no pending version. A live compile failure in migration `010` exposed hosted pgcrypto namespace resolution; the source was corrected, migration `012` added an upgrade repair, and `010` through `012` then compiled and applied successfully. | Exact checksum identity between previously applied legacy versions and current source, catalog assertions, hostile role requests, concurrency behavior, Storage, Edge Function deployment, backup/restore, or full workflows. |
| Hosted Auth configuration | PASS FOR CONFIGURATION | Exact GitHub Pages Site URL/redirect, invite-only email Auth, disabled public/anonymous signup, the 8-character hosted minimum, no extra hosted character preset, leaked-password protection, secure password change, refresh-token rotation, and publishable/secret keys were read back from the hosted project. Legacy anon/service-role keys were disabled. SafetyOps separately enforces a capital and special character in its password-creation/reset UI. | Direct Auth API character-class enforcement, production SMTP, external-recipient delivery, invite acceptance, recovery delivery, MFA, or session behavior on real devices. |
| Hosted owner and initial-tenant bootstrap | PASS FOR PROVISIONING | The invited owner record, one active corporate-administrator membership, five location memberships, five persisted locations, the intended default location, five draft regulatory profiles, five `requires_review` assignments, and six NULL-actor system-provisioning audit events were read back after the atomic service-only call. | Invite acceptance, password setup, authenticated workspace reload, ordinary workflows, or role isolation. |
| Hosted catalog and anonymous boundary baseline | PASS FOR NAMED ASSERTIONS | Every public table reports RLS enabled; no reviewed security-definer function is missing a pinned `search_path`; both historical self-onboarding overloads are absent; only `service_role` can execute first-owner bootstrap; all three Storage buckets are nonpublic; public signup returned 422; anonymous Data API and privileged-RPC requests returned 401; anonymous private-bucket listing returned zero objects. | Full policy/grant/owner/trigger assertions, authenticated role behavior, cross-company/cross-location denial, or authorized Storage download. |
| Hosted Pages deployment and signed-out smoke | PASS | GitHub Actions passed browser tests, build, exact-tree attestation verification, and Pages deployment. A cache-busted live desktop load rendered the connected invite-only sign-in shell instead of the configuration-required state. | Mobile live smoke, invite callback acceptance, authenticated tenant reload, accessibility, weak-network behavior, or rollback. |
| Migrations and Edge source inspection | PARTIAL | Twelve ordered migrations and the `sign-form-file` Edge source describe the intended LFES controls; hosted history is aligned and the final `010`–`012` compatibility sequence compiled/applied. | Legacy applied-file checksum identity, complete catalog/grant assertions, authenticated role denials, authorized Storage behavior, or function deployment. |

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
- Edge Function deployment and access-ledger verification;
- live prepare/quarantine/malware-scan/immutable-commit upload tests;
- real-device, accessibility, weak-network, reconnect, and persistent-session
  tests;
- live mobile, invite-acceptance, password-setup, and authenticated-tenant smoke;
- backup/restore, migration recovery, and qualified regulatory review.

## Current QA decision

The browser suite, hosted versioned application, Auth configuration, initial
tenant provisioning, named catalog/anonymous assertions, and signed live-shell
layers pass. Broad production tenant operation remains **BLOCKED** because the
authenticated RLS role matrix, authorized Storage, Edge, upload, external
recovery delivery, and regulatory-review layers are unproven.
