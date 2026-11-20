begin;

create schema feedback_private;
revoke all on schema feedback_private from public, anon, authenticated, service_role;
grant usage on schema feedback_private to service_role;

-- Rate and retry metadata only. Feedback text, email addresses, views, and
-- provider replies are not stored in the database.
create table feedback_private.feedback_email_attempts (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  attempted_at timestamptz not null,
  primary key (company_id, user_id, request_id)
);

create index feedback_email_attempts_company_time_idx
  on feedback_private.feedback_email_attempts (company_id, attempted_at);
create index feedback_email_attempts_user_idx
  on feedback_private.feedback_email_attempts (user_id);

alter table feedback_private.feedback_email_attempts enable row level security;
revoke all on table feedback_private.feedback_email_attempts from public, anon, authenticated, service_role;

create function feedback_private.reserve_feedback_email(
  target_company_id uuid, target_user_id uuid, target_session_id uuid, target_request_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  attempt_time timestamptz;
  user_attempts bigint;
  company_attempts bigint;
begin
  -- One short database transaction serializes quota decisions for the company.
  -- The provider call happens only after this transaction releases the lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('feedback-email:' || target_company_id::text, 0)
  );

  -- Only the Edge service role can call this function. The Edge handler
  -- authenticates the bearer with Supabase Auth before passing these IDs. Check
  -- current state after waiting for the lock.
  attempt_time := pg_catalog.clock_timestamp();
  perform 1
  from auth.users u
  join auth.sessions s on s.user_id = u.id
  join public.company_memberships m on m.user_id = u.id
  where u.id = target_user_id
    and s.id = target_session_id
    and (s.not_after is null or s.not_after > attempt_time)
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and not coalesce(u.is_anonymous, false)
    and (u.banned_until is null or u.banned_until <= attempt_time)
    and m.company_id = target_company_id
    and m.active
  for share of m;
  if not found or target_request_id is null then
    return 'denied';
  end if;

  delete from feedback_private.feedback_email_attempts a
  where a.company_id = target_company_id
    and a.attempted_at < attempt_time - interval '48 hours';

  -- The mail relay does not deduplicate sends. Keep each retained request ID
  -- reserved even when the Edge Function did not receive a delivery receipt.
  if exists (
    select 1 from feedback_private.feedback_email_attempts a
    where a.company_id = target_company_id and a.user_id = target_user_id
      and a.request_id = target_request_id
  ) then
    return 'already_attempted';
  end if;

  select count(*), count(*) filter (
    where a.user_id = target_user_id and a.attempted_at > attempt_time - interval '1 hour'
  )
  into company_attempts, user_attempts
  from feedback_private.feedback_email_attempts a
  where a.company_id = target_company_id and a.attempted_at > attempt_time - interval '24 hours';

  if user_attempts >= 5 or company_attempts >= 40 then
    return 'limited';
  end if;

  insert into feedback_private.feedback_email_attempts (company_id, user_id, request_id, attempted_at)
  values (target_company_id, target_user_id, target_request_id, attempt_time);
  return 'reserved';
end;
$$;

create function public.reserve_feedback_email(
  target_company_id uuid, target_user_id uuid, target_session_id uuid, target_request_id uuid
)
returns text
language sql
security invoker
set search_path = ''
as $$
  select feedback_private.reserve_feedback_email(
    target_company_id, target_user_id, target_session_id, target_request_id
  );
$$;

revoke execute on function feedback_private.reserve_feedback_email(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.reserve_feedback_email(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function feedback_private.reserve_feedback_email(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.reserve_feedback_email(uuid, uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
