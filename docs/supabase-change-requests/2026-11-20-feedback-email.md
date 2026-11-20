# Email feedback from the current screen

## Status and operator

**Proposed, not applied.** @loufish727 operates hosted changes. Review the feedback-email PR and record its exact approved commit before running this procedure. The target is the existing SafetyOps project used by the live Taylor Safe frontend.

Signed-in members of one explicitly configured company can email app feedback to Louie's approved company mailbox from the current screen. `send-feedback` uses the existing MaintainOps Google Apps Script email relay to send the text, signed-in email address, and a predefined screen label. The script's confirmed response indicates acceptance. Confirm inbox receipt during rollout.

The pending setup covers the SafetyOps project only. MaintainOps already uses the relay. Its function, configuration, script deployment, and sender account stay in use as configured. This setup is independent of Auth emails and the Team Access migration.

## Preconditions and impact

- Verify the intended project and live frontend origin. Confirm the exact company UUID privately from the existing company's row. Keep `feedback_private` off the Data API exposed-schema list.
- Use the existing MaintainOps Apps Script web app URL and shared secret supplied by Louie. MaintainOps exposes the secret names `GOOGLE_SCRIPT_WEBHOOK_URL` and `GOOGLE_SCRIPT_WEBHOOK_SECRET` in its Edge Function dashboard. Retrieve the full URL from **Deploy → Manage deployments** in the existing Apps Script project or the private deployment record. Retrieve the original secret from the owner's private setup record or existing script configuration. The Supabase secrets list shows digests and cannot recover the original strings. Verify access to both before deploying. The apps share the executing Google account's mail quota and the existing relay credential.
- Confirm the existing Auth tables contain `users.id`, `email`, `email_confirmed_at`, `deleted_at`, `is_anonymous`, `banned_until`, and `sessions.id`, `user_id`, `not_after`. Confirm `public.companies` and `public.company_memberships` with `company_id`, `user_id`, and `active` exist. Check the project recovery point and current deployment revision.
- The database stores bounded attempt metadata only: company, user, request identifiers, and reservation time. After 48 hours old metadata is cleared on subsequent authorized use for that tenant. Idle tenants may retain those rows until the next approved use or owner cleanup. No email address, text, screen label, or provider response is stored by the database. Google Apps Script and the recipient mailbox process the message under the existing company email setup.
- The per-company quota lock is held only during SQL validation and reservation, with a two-second lock timeout. The provider is called after the transaction. Five attempts per verified account per rolling hour and 40 per configured company per rolling day include provider failures and retries. This bounds load and email volume.

## Exact changes

- Apply only [`20261120215037_feedback_email_rate_limits.sql`](../../supabase/migrations/20261120215037_feedback_email_rate_limits.sql) from the approved commit. It is an additive transaction. It creates a private schema and rate table, a pinned-search-path definer inside that schema, and an invoker wrapper `public.reserve_feedback_email(uuid, uuid, uuid, uuid)`. Both routines are executable by `service_role` only. API roles, including `service_role`, have no direct table grants. The migration is applied once and should not be rerun if its objects are already present.
- Deploy only [`send-feedback`](../../supabase/functions/send-feedback/index.ts) from that commit with gateway `verify_jwt = true`. The function also validates the exact bearer using Supabase Auth, and the service-only reservation checks the current session and active membership for the configured company. Request origin must exactly match the configured list. The owner mailbox and sending address are read only from secrets. The approved message limit is 2,000 characters.
- The Apps Script relay accepts a JSON POST containing its shared secret, the configured To address, a fixed subject, and plain text. The Edge Function sends only to the approved Google web app URL. It fetches Google's one-time Content Service result with a separate GET that carries no POST body. Success requires the script to return JSON `ok: true`.
- The database reserves each company/user/request ID once during the 48-hour retention window. A repeated ID cannot trigger another relay send. If the relay response does not confirm sending, the app preserves the message and asks the user to check with the app owner before resubmitting. Editing, closing, or waiting past the retention window can start a new submission, so an uncertain result is a reason to check the owner's inbox first.

Add these Edge secrets in the selected Supabase project's dashboard. Enter values privately.

| Secret name | Value to supply privately |
| --- | --- |
| `SAFETYOPS_FEEDBACK_ALLOWED_ORIGINS` | One or more exact approved origins separated by commas, with scheme and hostname and without URL paths or trailing slash. Enable only the verified live origin for production. |
| `SAFETYOPS_FEEDBACK_COMPANY_ID` | UUID of the one approved company in this project. |
| `SAFETYOPS_FEEDBACK_TO` | Louie's approved company mailbox. |
| `SAFETYOPS_FEEDBACK_GOOGLE_SCRIPT_URL` | Existing MaintainOps Google Apps Script web app URL ending in `/exec`, as configured in `GOOGLE_SCRIPT_WEBHOOK_URL`. |
| `SAFETYOPS_FEEDBACK_GOOGLE_SCRIPT_SECRET` | Original MaintainOps Apps Script shared secret, as configured in `GOOGLE_SCRIPT_WEBHOOK_SECRET`. |

The function also uses the existing `SUPABASE_URL` and platform API keys. It follows the existing `SAFETYOPS_SUPABASE_PUBLISHABLE_KEY` and `SAFETYOPS_SUPABASE_SECRET_KEY` overrides first, then uses the platform's injected default keys, then its legacy keys for compatible local stacks. Review key availability without displaying values. Store relay credentials only in the Edge Function secrets and the owner's private credential storage.

## Owner execution and rollout

1. Verify the target SafetyOps project, company, expected inbox, live frontend origin, and availability of the original relay URL and secret. Read the migration source and review history in Supabase. Stop if an earlier feedback migration or an unexpected version of the feedback schema is already present.
2. Open that project's SQL Editor and run only the approved migration file. Do not run `db push` or apply pending Team Access or other unrelated SQL. Confirm the transaction succeeded, verify the privilege query below, and record precisely this migration as applied through the project's existing workflow. If using CLI migration history repair after verifying the SQL, use `npx --yes supabase@3.2.0 migration repair 20261120215037 --status applied --remote=<project-ref>` and confirm the intended target. The command records history, it does not execute the file.
3. Add the five named values in **SafetyOps → Edge Functions → Secrets**. For the two relay values, use the original private values from the existing sender, not the digests visible in the MaintainOps project.
4. From the exact approved commit, deploy `npx --yes supabase@3.2.0 functions deploy send-feedback --remote=<project-ref> --use-api`. Confirm the intended target and just this function. Preserve gateway JWT verification. CLI v3 requires a hosted confirmation and generally uses `--remote` to target the project. Keep the deployment out of CI.
5. Complete the schema and Edge deployment readbacks below. When they pass, authorize, attest, and publish the exact frontend release using the existing procedure. The previous frontend works alongside the backend. The newer frontend retains drafts and displays an error if email delivery is unavailable.
6. On the released build, run the owner-only synthetic inbox test below before inviting coworkers to use Feedback. Follow rollback if a required check fails. Record operator, UTC time, approved revision, applied migration, function version, and redacted check results privately.

## Verification and evidence

Privately check the schema, wrapper, and grants in SQL Editor:

```sql
select
  to_regclass('feedback_private.feedback_email_attempts') is not null as rate_table_exists,
  has_schema_privilege('authenticated', 'feedback_private', 'usage') as browser_schema_access,
  has_table_privilege('service_role', 'feedback_private.feedback_email_attempts', 'select') as service_direct_table_read,
  has_function_privilege('anon', 'public.reserve_feedback_email(uuid,uuid,uuid,uuid)', 'execute') as anonymous_reserve,
  has_function_privilege('authenticated', 'public.reserve_feedback_email(uuid,uuid,uuid,uuid)', 'execute') as browser_reserve,
  has_function_privilege('service_role', 'public.reserve_feedback_email(uuid,uuid,uuid,uuid)', 'execute') as service_reserve;
```

Expect `true, false, false, false, false, true` in order. Check Edge Functions for the deployed version and gateway JWT verification. Run the project's security advisors and review new findings. Local CLI advisor and migration inventory require a running local Supabase stack.

- Verify a signed-in member of the configured company can send one synthetic feedback message. The screen remains in place. Confirm the success indicator and receive one email with subject **Taylor Safe feedback**, the existing relay's sender, the user's email, the view label, and the text. The shared script can use MaintainOps as its sender display name.
- Using an approved test environment, check that an unauthenticated caller, a different origin, a user in another company, an inactive user, and an expired session cannot send. Confirm quotas and an unavailable relay return feedback errors. Test identical retries with the same ID and confirm they yield at most one relay call within the documented retention window. If the live test returns an uncertain result, check the inbox and the relay's execution history before trying another send.
- Local checks use a mocked provider and scratch Postgres, with `npx --yes deno@2.9.6 test --no-lock supabase/functions/send-feedback/handler_test.ts` and `node --test supabase/functions/send-feedback/rate-limits.test.mjs`. Hosted mail delivery, gateway behavior, and verification results are pending owner execution.

## Rollback or forward recovery

If verification fails, stop frontend rollout. Remove `SAFETYOPS_FEEDBACK_GOOGLE_SCRIPT_SECRET` from SafetyOps and verify sends fail closed. If necessary, disable the endpoint by confirming `npx --yes supabase@3.2.0 functions delete send-feedback --remote=<project-ref>`. Restore the previous approved frontend with the existing release process if the client already went live. Leave the additive quota schema and migration record in place unless a separate reviewed cleanup is required. Emails already accepted for delivery or received are outside database rollback. The relay credential is shared, so coordinate with the MaintainOps owner before any credential rotation.

## References

- [Supabase Edge Function authorization headers](https://supabase.com/docs/guides/functions/auth-headers)
- [Supabase Edge Function environment variables](https://supabase.com/docs/guides/functions/secrets)
- [Supabase CLI v3 targeting and confirmations](https://supabase.com/changelog/supabase-cli-v3)
- [Google Apps Script web app deployments](https://developers.google.com/apps-script/guides/web)
- [Google Apps Script Content Service redirects](https://developers.google.com/apps-script/guides/content#redirects)
- [Google Apps Script MailApp](https://developers.google.com/apps-script/reference/mail/mail-app)
