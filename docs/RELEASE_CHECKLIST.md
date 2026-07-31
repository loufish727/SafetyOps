# SafetyOps Release Checklist

Current status: **BLOCKED for production tenant operation**. The last sanitized
public shell has signed artifact proof, but database, Edge, hosted workflow,
recovery, and compliance gates remain open. Check a box only with evidence from
the exact release revision and environment.

## Public release artifact — LFES-SEC-003, LFES-DEP-001, LFES-DEP-005

- [x] The signed release used an Ed25519 v2 attestation and passed strict CI
  verification of the schema, signature, both aggregate hashes, and both exact
  file lists.
- [x] The attestation bound hashes and byte sizes for all 12 deployable `dist`
  files and every file in the sanitized release tree. Only
  `public-build-attestation.json` and its `.sig` were omitted from tree hashing
  to avoid circular input. Untracked local private/generated inputs were
  excluded; matching Git-tracked paths are hard failures.
- [x] The Supabase browser client in the signed release was locally vendored
  and digest-pinned.
- [x] Build `dist` from this exact release candidate and create a new
  local-denylist signature; prior approval did not carry forward.
- [x] Confirm `supabase-config.js` contains only the intended project URL and
  publishable/anon key.
- [ ] Publish only from the sanitized clean-history release repository; never
  push the working source repository or its prior history.
- [ ] Record release-key and private-denylist custody, backup, rotation, and
  recovery ownership.

## Code and browser QA — LFES-REL-001, LFES-VER-001

- [x] The current Playwright run passed 67, skipped 7, and failed 0 across
  desktop and mobile projects.
- [x] The seven conditional skips were reviewed: four require private fixture
  or original-PDF evidence, and three are desktop-only mirrors of mobile
  overflow checks. They are not failures.
- [x] The targeted program-form submission test passed on desktop and mobile.
- [x] Pass static checks and the complete browser suite again for the exact
  release revision.
- [ ] Verify configuration-required, signed-out, onboarding, empty, loading,
  error, and retry states against the intended hosted configuration.
- [ ] Verify prior IndexedDB staging blobs can be explicitly cleared.
- [ ] Complete keyboard, focus, accessibility, real-device, and weak-network
  review.

## Supabase staging — LFES-SEC-001, LFES-DB-002, LFES-DB-006

- [x] Create a dedicated non-production SafetyOps project.
- [x] Align hosted migration history through `012` with no pending version and
  retain output. Migration `012` records the pgcrypto compatibility repair;
  exact checksum identity for previously applied legacy files is not asserted.
- [ ] Keep public Auth signup disabled; prove invitation, password setup,
  non-enumerating recovery, one-active-company, and last-admin controls.
- [x] Verify anonymous signup is disabled; email confirmation is enabled; the
  Site URL and redirect allowlist are exact; hosted minimum password length is
  12; strongest available character/leaked-password controls are on; refresh
  rotation is enabled; and the legacy API keys are disabled.
- [ ] Configure production SMTP before invitation or recovery mail to external,
  non-organization recipients. The initial owner is an organization-team
  address and can use Supabase's restricted default sender for this bootstrap.
- [ ] Prove both historical browser company-creation RPC overloads are absent,
  the owner bootstrap is service-only, and system provisioning is not falsely
  attributed to the invited owner.
- [ ] Prove jurisdiction reviewer identity/time are database-derived and a
  manager cannot spoof review fields through direct Data API writes.
- [ ] Verify functions compile, RLS is enabled, policies/grants exist, and each
  security-definer function has the intended owner and pinned `search_path`.
- [ ] Verify private buckets are nonpublic and paths are company-prefixed.
- [ ] Run two-company and cross-location read/write denial tests for every role
  through direct Data API, RPC, Storage, and UI paths.
- [ ] Verify migration `009` records `review_required` with zero regulatory
  evidence links when profile/jurisdiction context is unresolved, and records
  pinned evidence only when context is verified.
- [ ] Verify migration `010` enforces auditor read-only behavior, personnel
  privacy, current program/profile/applicability checks, and immutable terminal
  records.
- [ ] Verify form signature inserts accept only pinned entity IDs and that the
  database derives signer identity, company role, signature method, intent,
  timestamp, unsigned-payload digest, signature record, and signature hash.
- [ ] Verify signing freezes answers/attachments and final submission produces
  the database-owned final evidence manifest/hash.

## Private files — LFES-SEC-002, LFES-OBS-001

- [ ] Deploy and test `sign-form-file` with JWT verification, explicit allowed
  origins, private buckets, and server-only service-role secrets.
- [ ] Build and deploy the prepare/quarantine/malware-scan/commit upload
  pipeline; no such live pipeline exists today.
- [ ] Verify MIME, extension, size, clean-scan, SHA-256, and metadata checks.
- [ ] Prove allowed download produces one short-lived URL and forbidden
  company/location or unverified-byte requests disclose no object existence.
- [ ] Verify allow/deny ledger events contain no credential, object path, or
  signed URL.

## Functional hosted proof — LFES-TRACE-001

- [ ] Create a company with five named locations and assign the correct
  OR/WA/CA jurisdiction context to each.
- [ ] Confirm onboarding creates review-required context rather than silently
  asserting approved applicability.
- [ ] Create and reload an inspection, incident, corrective action, training
  assignment, program assignment, acknowledgement, and signed program form.
- [ ] Confirm template/program/schema/regulatory snapshots remain pinned and
  traceable.
- [ ] Verify authorized and denied original-form download behavior.
- [ ] Test partial-failure recovery for multi-step program submissions.
- [ ] Verify bounded query caps communicate truncation; add pagination before
  a tenant can exceed those caps.

## Regulatory review — LFES-TRACE-001, LFES-OBS-001

- [ ] Record the federal eCFR structural-index generation/current-through date
  (`2026-07-29`) and source fingerprint.
- [ ] Treat the OR/WA/CA catalog as curated high-use guidance, not a complete
  state corpus; retain source URL, authority, dates, and review state.
- [ ] Record immutable state source snapshots before claiming source-content
  hash trace.
- [ ] Have a qualified reviewer determine each location's state-plan, retained
  federal, industry, task, exposure, and exception applicability.
- [ ] Approve or reject each control crosswalk with reviewer/time/source
  evidence and keep pending/legal-review notices visible.

## Deployment and recovery — LFES-DEP-004, LFES-DEP-005

- [ ] Use a controlled custom domain and complete auth/session/origin/cache
  testing before enabling persistent Supabase auth; keep persistence off on the
  shared `github.io` origin.
- [ ] Record release revision, database migration state, Edge Function
  revision, and v2 attestation identity.
- [ ] Make the exact-revision GitHub Actions verification/deploy workflow green
  and smoke the hosted URL with a cache-bust query on desktop and mobile.
- [ ] Verify a real authorized QA tenant without adding production PII.
- [ ] Confirm logs and audit events are observable and contain no secrets.
- [ ] Document and rehearse frontend rollback plus database backup/restore or
  forward-correction.
- [ ] Obtain engineering, security, product owner, and safety/compliance
  sign-off with residual risks listed.

This checklist records LFES-aligned engineering evidence; it is not an LFES
certification or a substitute for legal or qualified safety review.
