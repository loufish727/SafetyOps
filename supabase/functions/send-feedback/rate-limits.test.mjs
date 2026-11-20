import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("feedback SQL authorizes live company sessions, suppresses duplicate attempts, and enforces rolling quotas", async () => {
  const db = new PGlite();
  const [company, otherCompany, member, session, expiredSession, firstRequest, oldRequest] =
    Array.from({ length: 7 }, () => crypto.randomUUID());
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users (
        id uuid primary key, email text, email_confirmed_at timestamptz,
        deleted_at timestamptz, is_anonymous boolean, banned_until timestamptz
      );
      create table auth.sessions (id uuid primary key, user_id uuid not null, not_after timestamptz);
      create table public.companies (id uuid primary key);
      create table public.company_memberships (company_id uuid not null, user_id uuid not null, active boolean not null);
      insert into public.companies values ('${company}'), ('${otherCompany}');
      insert into auth.users values ('${member}', 'member@example.invalid', now(), null, false, null);
      insert into auth.sessions values ('${session}', '${member}', null),
        ('${expiredSession}', '${member}', now() - interval '1 second');
      insert into public.company_memberships values ('${company}', '${member}', true);
    `);
    const migration = new URL("../../migrations/20261120215037_feedback_email_rate_limits.sql", import.meta.url);
    await db.exec(await readFile(migration, "utf8"));
    const reserve = async (request = crypto.randomUUID(), tenant = company, callerSession = session, role = "service_role") => {
      await db.exec(`set role ${role}`);
      try {
        const { rows } = await db.query(
          "select public.reserve_feedback_email($1, $2, $3, $4) as result",
          [tenant, member, callerSession, request]
        );
        return rows[0].result;
      } finally {
        await db.exec("reset role");
      }
    };

    await assert.rejects(reserve(undefined, company, session, "anon"), /permission denied/);
    await assert.rejects(reserve(undefined, company, session, "authenticated"), /permission denied/);
    assert.equal(await reserve(undefined, otherCompany), "denied");
    assert.equal(await reserve(undefined, company, expiredSession), "denied");
    await db.exec("update public.company_memberships set active = false");
    assert.equal(await reserve(), "denied");
    await db.exec("update public.company_memberships set active = true");
    await db.exec("update auth.users set email_confirmed_at = null");
    assert.equal(await reserve(), "denied");
    await db.exec("update auth.users set email_confirmed_at = now()");

    assert.equal(await reserve(firstRequest), "reserved");
    assert.equal(await reserve(firstRequest), "already_attempted");
    assert.equal(await reserve(firstRequest, otherCompany), "denied");
    assert.equal(await reserve(firstRequest, company, expiredSession), "denied");
    await assert.rejects(
      db.query(
        "insert into feedback_private.feedback_email_attempts values ($1, $2, $3, now())",
        [company, member, firstRequest],
      ),
      /duplicate key/,
    );

    // A repeated request did not use up a new quota slot.
    for (let attempt = 0; attempt < 4; attempt++) assert.equal(await reserve(), "reserved");
    assert.equal(await reserve(), "limited");
    assert.equal(await reserve(firstRequest), "already_attempted");

    await db.exec(`
      update feedback_private.feedback_email_attempts set attempted_at = now() - interval '2 hours';
      insert into feedback_private.feedback_email_attempts
      values ('${company}', '${member}', '${oldRequest}', now() - interval '47 hours 30 minutes');
    `);
    assert.equal(await reserve(oldRequest), "already_attempted");
    assert.equal(await reserve(), "reserved");
    await db.exec(`
      insert into feedback_private.feedback_email_attempts
      select '${company}', '${member}', gen_random_uuid(), now() - interval '2 hours'
      from generate_series(1, 34);
    `);
    assert.equal(await reserve(), "limited");

    await db.exec("update feedback_private.feedback_email_attempts set attempted_at = now() - interval '49 hours'");
    assert.equal(await reserve(oldRequest), "reserved");
    const { rows } = await db.query("select count(*)::int as count from feedback_private.feedback_email_attempts");
    assert.equal(rows[0].count, 1);
    await db.exec("set role service_role");
    await assert.rejects(db.query("select * from feedback_private.feedback_email_attempts"), /permission denied/);
  } finally {
    await db.close();
  }
});
