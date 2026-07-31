# LFES for SafetyOps

SafetyOps uses LFES as its engineering standard. The LFES control IDs keep
their established meanings; this directory records how those controls apply to
SafetyOps and where proof exists. This use of LFES is not a certification.

## Source baseline

This application was reviewed against the internal **LFES Full Private Packet**
generated 2026-06-10 from the MaintainOps LFES corpus. The primary inherited
references are `CORE_STANDARD.md`, `GOLD_STANDARD.md`, and the LFES Security,
Database, Reliability, Reviewability, and Deployment standards. The private
packet is engineering-source material and is not copied into the public
SafetyOps repository.

SafetyOps-specific documents may strengthen an LFES control, but they must not
silently redefine or weaken its established meaning. Where the product differs
from MaintainOps, the adaptation and its proof boundary belong in the control
matrix, decision log, QA log, or known-risk register.

## Evidence labels

- **PROVEN**: the named check ran successfully against the named artifact.
- **PARTIAL**: code or mocked-browser evidence exists, but the production
  boundary was not exercised.
- **DESIGNED**: the control exists in source or SQL but has not run in a
  database or hosted environment.
- **UNPROVEN**: no adequate evidence exists.
- **BLOCKED**: a known failure prevents release.

Mocked Supabase browser tests never prove PostgreSQL RLS, Storage policy,
security-definer RPC, Edge Function, or cross-company behavior.

## Current posture

SafetyOps is a configured public application shell with static regulatory
reference artifacts and a Supabase-backed implementation. The repository
contains twelve ordered migrations and one Edge Function. Hosted migration
history is aligned through `012`, and `010`–`012` compiled/applied in the final
compatibility sequence; exact legacy applied-file checksums are not asserted.
The latest full local
Playwright run passed 67 tests, skipped 7 conditional/project instances, and
failed 0. The public-release process uses an Ed25519-signed v2 manifest over the
exact 12-file deployment artifact and exact sanitized release tree, verified
in CI; only the attestation JSON/signature are omitted from tree hashing to
avoid circular input.

Those results prove hosted version-ledger alignment and final compatibility
application, but do not prove historical applied-file identity or
the PostgreSQL hostile-role matrix, Storage, the Edge Function, or complete
tenant workflows. The Edge Function has not been shown deployed. Production
tenant operation remains **BLOCKED** even when the
hosted public shell is a valid connection-required release. See:

1. `../ARCHITECTURE.md`
2. `CONTROL_MATRIX.md`
3. `PROOF_MODEL.md`
4. `../QA_LOG.md`
5. `../KNOWN_RISKS.md`
6. `../RELEASE_CHECKLIST.md`

## LFES release rule

Do not promote SafetyOps for real company use until the public build, database,
RLS role matrix, private file service, hosted application, and rollback path
have their own recorded evidence. Passing a lower proof layer cannot be used as
evidence that a higher layer passed, and applying LFES terminology does not
certify this application.
