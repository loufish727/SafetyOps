## Change and scope

What changed, why, and what is intentionally out of scope?

## Verification

- [ ] `npm ci`
- [ ] `npm test` (include results and explain skips/failures)
- [ ] `npm run build`
- [ ] Relevant browser/manual checks completed; evidence contains no private data

Public-boundary release approval: pending / verified by Louie (include actual result).
Do not request the private denylist or signing key for ordinary PR validation.

## Backend impact — required

- [ ] No hosted Supabase dependency or change
- [ ] Backend change required; request linked below and `@loufish727` review requested

Choose the applicable option above. Request path: `docs/supabase-change-requests/YYYY-MM-DD-subject.md`.

For a backend change, include exact proposed SQL/configuration, prerequisites, execution order, validation and expected results, frontend compatibility/rollout timing, and rollback or forward recovery. Mark proposals **not applied**. Louie alone performs all hosted Supabase operations; this PR does not authorize automatic application.

## Release and safety

- [ ] No credentials, private inputs, tenant/employee data, signed URLs, or internal history included
- [ ] Existing live Pages URL and company deployment gate remain unchanged, or an explicit Louie-approved cutover plan is linked
- [ ] Release-signing impact identified; Louie will approve and attest the exact release tree when deployment is requested

CODEOWNERS can request review, but does not guarantee delivery or approval. Confirm Louie's review when backend or release-authority files change. Green PR checks do not establish hosted behavior, provision an app account, or replace signed release approval.
