# SafetyOps LFES Proof Model

Each layer must be reported separately. A lower layer cannot imply that a
higher layer passed.

| Layer | What it can prove | Current result |
|---|---|---:|
| Source/static | JavaScript parses; public seed files are empty; sixteen ordered migrations and three Edge Function sources exist. | PARTIAL: source/type/build checks pass; full hosted execution does not |
| Mocked browser | UI, responsive layouts, role presentation, invite/recovery edge cases, hosted password-class contract, stale-session rejection, provisioning pending, Pacific/Boise location-timezone handling, inspection/form RPC contracts, committee/training/employee-tablet/PDF workflows, and selected failures behave against the fake Supabase client. | PASS: 91 passed, 7 conditional/project skips, 0 failed |
| Signed public release | The exact 12-file `dist` artifact and exact sanitized release tree match the local private-denylist approval. | PROVEN for the signed release: strict Ed25519 v2 schema, signature, both aggregates, and both exact file lists verified in CI |
| Clean local PostgreSQL | Migrations compile in order; functions, constraints, triggers, RLS, and grants exist in the catalog. | NOT RUN (`001`–`012`); local Docker is unavailable |
| Hosted versioned application/upgrade | Migration versions are recorded, reviewed migrations compile/apply, and named catalog/grant assertions match. | PASS for `016`: hosted rollback compile, application, SHA-bound ledger entry, RLS/anonymous-grant checks, and active JWT-protected employee file function. Legacy identity and hostile-role runtime tests remain open |
| Hosted anonymous | Anonymous Data API, privileged RPC, signup, and private-bucket listing disclose no tenant material. | PARTIAL: Data API and privileged RPC returned 401, signup returned 422, and private-bucket listing returned zero objects; broader endpoint coverage remains open |
| Hosted authenticated roles | Two-company and cross-location allow/deny behavior works for each SafetyOps role. | NOT RUN |
| Hosted functional | Onboarding, inspections, incidents, actions, training, programs, signatures, and private files persist correctly. | PARTIAL: invited-owner and five-location bootstrap persisted with draft/review-required context and system audit provenance; invite acceptance and ordinary workflows remain untested |
| Regulatory review | Location jurisdiction and company controls are reviewed against current official sources by qualified reviewers. | NOT RUN |
| LFES engineering review | Architecture, security, reliability, deployment, rollback, and residual risk are reviewed together against the 2026-06-10 private-packet baseline. | IN PROGRESS; not an LFES certification |

## Minimum hosted role matrix

Use disposable QA tenants and users. At minimum test:

- corporate admin, safety manager, location manager, supervisor, worker, and
  auditor;
- allowed company and forbidden company;
- assigned location and unassigned location;
- allowed read/write and denied read/write for operational, program, document,
  evidence, regulatory-assessment, and private-file records;
- direct table attempts as well as normal UI and RPC paths.

Record test user role and fixture IDs, but never record passwords, access tokens,
signed URLs, service-role credentials, or real employee data.

## Release interpretation

SafetyOps is not production-ready while the database, hosted role, Edge
Function, upload, and recovery layers remain unproven. A valid signed
connection-required GitHub Pages shell is not evidence of production tenant
operation.

The seven Playwright skips are expected test-instance skips, not failures:
two tests require the ignored private fixture/original PDFs and are skipped in
both projects (four instances), while three mobile-only overflow checks are
skipped in the desktop project. They provide no proof for the unavailable
private-fixture paths.
