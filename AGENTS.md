# Taylor Safe development rules

These instructions apply to this entire repository and to every AI assistant working on it.

## Ownership and authority

- The development home is `Taylor-Metal-Products/Taylor-Safe`.
- Wes (`@weserfishley`) develops the application and administers the GitHub repository.
- Louie (`@loufish727`) is the sole operator for **all hosted Supabase changes**: database data/schema and migrations, Auth users/invitations/settings, Storage, Edge Functions/secrets, project configuration, and access control.
- GitHub access is not Supabase platform access or Taylor Safe app membership. Wes's requested app account has not been provisioned by this handoff.
- Do not create a Supabase organization, grant backend access, introduce paid services/SSO, or share an account as part of ordinary development.

## Backend changes: propose, never auto-apply

You may inspect repository code, develop frontend changes, and prepare reviewed SQL, migrations, Edge Function code, and configuration proposals. Do not run commands, APIs, dashboard actions, or workflows that change hosted Supabase resources. Do not send Auth invitations or create application memberships. Louie performs those operations.

For every backend dependency, add `docs/supabase-change-requests/YYYY-MM-DD-subject.md` using the requirements in `docs/DEVELOPMENT_HANDOFF.md`. Include exact proposed SQL/configuration, prerequisites, ordered execution steps, verification queries and expected outcomes, compatibility/rollout sequence, and a safe rollback or forward-recovery plan. Mark it **proposed; not applied**. Use placeholders for sensitive runtime values and identify where Louie supplies them privately.

Request Louie's review on the pull request and mention `@loufish727` in its backend-change summary. CODEOWNERS review requests depend on GitHub configuration, permissions, and PR state; they do not guarantee notification delivery or enforce approval by themselves. Obtain explicit review and execution evidence. A merge or green CI is not permission to apply backend changes.

## Public repository boundary

- This is the sanitized, clean-history public source. Never import the internal development repository, its history, or ignored local inputs.
- Never commit credentials, service-role/secret keys, private signing keys, tenant denylist contents, personal/employee data, private source documents, raw storage paths, or signed URLs. Do not include them in issues, PRs, logs, or screenshots either.
- Keep `.env*`, `private/`, local Supabase configuration, generated build/test files, and other ignored sensitive paths untracked. Do not weaken the public-boundary verifier or exclusions to make a release pass.
- Public Supabase project URL/publishable browser configuration is not an administrator credential. Changes to it still require Louie's review.

## Development, verification, and release

Use `npm ci`, `npm test`, and `npm run build` for normal contributor validation. The local public-boundary scan requires Louie's private denylist and belongs to the release approval step, not an unsigned contributor PR. Document failures and skipped checks accurately; do not claim hosted proof from mocks or local tests. Consult `docs/RELEASE_CHECKLIST.md` before claiming production readiness.

Louie retains the private release-signing key and tenant denylist. Do not generate a replacement key, move those inputs into CI, or bypass signature verification. Any change to the sanitized release tree requires fresh release approval. Louie runs `npm run attest:public-boundary` with private inputs, then `npm run test:public-boundary:ci` on the exact release tree. Contributors do not need those inputs to develop or open PRs.

The existing `loufish727/SafetyOps` GitHub Pages site remains live during handoff. Company-repository deployment stays disabled until Louie completes and verifies the Auth redirect/Edge origin cutover. Only then may the approved release use repository variable `TAYLOR_SAFE_PAGES_ENABLED=true`. Do not enable it, change live URLs, or assume the company site is already serving production as part of ordinary code work.
