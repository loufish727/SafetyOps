# Taylor Safe development handoff

## Responsibilities and current state

The public sanitized development repository is [Taylor-Metal-Products/Taylor-Safe](https://github.com/Taylor-Metal-Products/Taylor-Safe). Wes (`@weserfishley`) has repository administrator access and leads application development. Louie (`@loufish727`) retains all hosted Supabase operations and release-signing authority. This arrangement does not transfer the Supabase organization, grant backend platform access, or require shared logins, paid services, or SSO.

GitHub permission, Supabase platform permission, and Taylor Safe app membership are separate. Wes's requested Taylor Safe app account is **not provisioned by this handoff**; Louie must separately complete and verify the approved Auth invitation and existing-company membership. Do not invoke the first-owner/new-company bootstrap to add someone to the existing company. Auth invitation delivery must be checked against the project's configured email delivery; do not grant platform access just to work around delivery restrictions.

The existing [personal GitHub Pages site](https://loufish727.github.io/SafetyOps/) remains the live frontend. The company repository is the development home, not an automatic live-site cutover. Its planned Pages address is `https://taylor-metal-products.github.io/Taylor-Safe/`; do not distribute that as the live app until verified.

## Ordinary contribution flow

1. Read `AGENTS.md`, work on a branch, and preserve unrelated work.
2. Use `npm ci`, `npm test`, and `npm run build`. Record actual results and explain skipped or blocked checks. The local public-boundary scan needs Louie's private denylist; contributors leave release approval pending rather than requesting private inputs or bypassing it.
3. Open a PR using the template. Link any backend change request and request Louie's review when it affects backend configuration, security, deployment, or release authority.
4. Keep frontend changes compatible with the currently deployed backend until Louie records execution and verification. Use an explicitly reviewed deployment order when compatibility cannot be maintained.
5. Merge only after the appropriate reviews. PR tests/build checks are not a live deployment, backend approval, or release signature.

The repository's CODEOWNERS configuration is intended to request Louie's review on backend and release-control paths. Automatic review requests depend on matching paths in the PR's base branch, valid owner access, and PR state. CODEOWNERS alone does not require approval; branch rules must enforce required review where supported. GitHub/email notification delivery also depends on personal settings. Mention `@loufish727`, confirm that a review request is visible, and obtain explicit acknowledgment for an execution handoff. Do not interpret silence as approval.

## Backend change request

Create `docs/supabase-change-requests/YYYY-MM-DD-subject.md` for each backend-dependent change. Keep it public-safe and include these sections:

### Status, scope, and operator

- Status: **Proposed — not applied**. Name the related PR and intended source revision.
- Operator: `@loufish727`. Explain the user-facing reason and affected database/Auth/Storage/Edge/settings components.
- Identify the intended environment using a non-secret label. Do not assume staging approval authorizes production.

### Preconditions and impact

- List existing migrations/functions/settings expected to be present and read-only checks Louie should run first.
- Describe affected roles, tenant boundaries, data volume, possible locks/downtime, existing-user effects, and any backup/restore prerequisites.
- State which sensitive IDs/values Louie supplies privately. Never put tokens, passwords, service keys, personal data, signed links, or private object paths in the request.

### Exact proposed changes

- Include the exact reviewed SQL or repository migration path and source revision; use explicit runtime placeholders where needed. Explain transaction boundaries, idempotency, and any nontransactional operation.
- For configuration, list each setting, expected current value, proposed value, and validation method. For secrets, list names and provisioning steps only, never values.
- For Edge Functions, identify the exact code revision, function names, authentication requirements, deployment commands, and required settings. Do not silently relax JWT, RLS, grants, origin checks, or signup restrictions.
- For Auth/app access, identify the requested app role and company/location scope without embedding personal data in the public request; keep the actual recipient and identifiers in an approved private channel.

### Louie's execution and rollout order

- Provide numbered, exact operator steps with stop conditions. Separate read-only preflight, mutation, verification, and frontend release.
- State whether backend or frontend must ship first and how the older frontend/backend remains safe during the transition.
- No AI, CI workflow, PR merge, or repository contributor automatically applies these changes. Louie performs the hosted actions and records the result.

### Verification and evidence

- Provide read-back SQL/configuration checks and expected results, plus authorized and denied role/tenant tests where relevant.
- Include a real hosted smoke-test plan; label mocked/local tests separately.
- After execution, record operator, UTC timestamp, source/migration revision, pass/fail outcomes, and a public-safe evidence summary. Redact sensitive runtime values. Unexecuted checks remain pending.

### Rollback or forward recovery

- Give exact reversal steps and their preconditions, including the compatible frontend revision.
- Identify destructive/irreversible changes explicitly. A down migration is not a substitute for restoring lost data; explain the backup/restore or forward-fix path and who validates recovery.
- Define the condition for stopping rollout and who communicates the result.

## Release signing and Pages cutover

Louie retains the private Ed25519 signing key and local tenant denylist outside Git. Contributors must not generate replacement release authority or copy these inputs into repository secrets. Every release-tree change, including documentation and workflow edits, invalidates prior exact-tree approval. Louie builds the final tree, runs `npm run attest:public-boundary` with private inputs, then verifies with `npm run test:public-boundary:ci` before deployment.

The existing deployment workflow runs PR/main verification. PRs do not deploy. The personal `loufish727/SafetyOps` repository remains eligible for its current deployment; company deployment is gated by repository variable `TAYLOR_SAFE_PAGES_ENABLED=true`.

Before enabling that company variable, Louie must approve the exact release and complete the hosted Auth Site URL/redirect allowlist and Edge origin changes for the planned company URL. Verify sign-in, invitation/password setup, recovery, authorized/denied file access, and desktop/mobile loading on the intended hostname. Keep persistent auth disabled on the shared `github.io` origin. Record the prior URL/configuration and rollback plan; retain the current live site until the cutover is verified. Enabling the variable only permits deployment; it does not prove the site has deployed successfully.

Follow `RELEASE_CHECKLIST.md` for remaining readiness gates. Moving development ownership does not complete production, security, compliance, recovery, or app-account provisioning work.
