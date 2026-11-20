import { deepStrictEqual, equal } from "node:assert/strict";
import { createFeedbackHandler } from "./handler.ts";

const testOrigin = "https://app.example.invalid";
const testProject = "https://project.example.invalid";
const testScript = "https://script.google.com/macros/s/fixture-deployment/exec";
const testEcho = "https://script.googleusercontent.com/macros/echo?fixture=one-time-response";
const userId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-000000000000";
const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const claims = btoa(JSON.stringify({ sub: userId, role: "authenticated", session_id: sessionId }))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const token = `header.${claims}.signature`;
const config = {
  allowedOrigins: [testOrigin],
  companyId,
  recipient: "owner@example.invalid",
  scriptUrl: testScript,
  scriptSecret: "fixture-relay-secret",
  supabaseUrl: testProject,
  publicKey: "fixture-public-key",
  serviceKey: "sb_secret_fixture",
};

function request(body: unknown = { message: "  The calendar looks great!  ", view: "calendar", requestId }) {
  return new Request(`${testProject}/functions/v1/send-feedback`, {
    method: "POST",
    headers: { Origin: testOrigin, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function fakeServices({
  reservation = "reserved",
  delivery = () => Response.json({ ok: true, privateProviderDetail: "do not expose" }),
  echo = () => Response.json({ ok: true }),
} = {}) {
  const calls: { url: string; init?: RequestInit; headers: Headers; body: unknown }[] = [];
  const transport: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url === `${testProject}/auth/v1/user`) {
      return Promise.resolve(Response.json({ id: userId, email: "member@example.invalid", email_confirmed_at: "confirmed" }));
    }
    if (url === `${testProject}/rest/v1/rpc/reserve_feedback_email`) {
      return Promise.resolve(Response.json(reservation));
    }
    if (url === testEcho) return Promise.resolve(echo());
    equal(url, testScript);
    return Promise.resolve(delivery());
  };
  return { handler: createFeedbackHandler(config, transport), calls, transport };
}

Deno.test("feedback emails one configured recipient with verified sender context and bounded view label", async () => {
  const { handler, calls } = fakeServices();
  const result = await handler(request());
  equal(result.status, 200);
  equal(result.headers.get("Access-Control-Allow-Origin"), testOrigin);
  deepStrictEqual(await result.json(), { sent: true });
  deepStrictEqual(calls[1].body, {
    target_company_id: companyId,
    target_user_id: userId,
    target_session_id: sessionId,
    target_request_id: requestId,
  });
  equal(calls[0].headers.get("authorization"), `Bearer ${token}`);
  equal(calls[1].headers.get("apikey"), config.serviceKey);
  equal(calls[1].headers.get("authorization"), null);
  deepStrictEqual(calls[2].body, {
    secret: config.scriptSecret,
    to: config.recipient,
    subject: "Taylor Safe feedback",
    text: "From: member@example.invalid\nScreen: Calendar\n\nThe calendar looks great!",
  });

  equal(calls[2].url, testScript);
  equal(calls[2].init?.method, "POST");
  equal(calls[2].init?.redirect, "manual");
  equal(calls[2].headers.get("authorization"), null);
  equal(calls[2].headers.get("apikey"), null);
});

Deno.test("fetches the one-time Apps Script response without forwarding credentials or allowing more redirects", async () => {
  for (const status of [302, 303]) {
    const { handler, calls } = fakeServices({
      delivery: () => new Response(null, { status, headers: { location: testEcho } }),
    });
    const result = await handler(request());
    equal(result.status, 200);
    deepStrictEqual(await result.json(), { sent: true });
    equal(calls.length, 4);
    equal(calls[3].url, testEcho);
    equal(calls[3].init?.method, "GET");
    equal(calls[3].init?.redirect, "error");
    equal(calls[3].init?.signal, calls[2].init?.signal);
    equal(calls[3].body, undefined);
    deepStrictEqual([...calls[3].headers], []);
  }
  const { handler, calls } = fakeServices({
    delivery: () => new Response(null, { status: 302, headers: { location: testEcho } }),
    echo: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.invalid" } }),
  });
  equal((await handler(request())).status, 409);
  equal(calls.length, 4);
});

Deno.test("rejects unapproved script URLs before making any external call", async () => {
  const { calls, transport } = fakeServices();
  for (const scriptUrl of [
    "https://elsewhere.example.invalid/macros/s/fixture/exec",
    "http://script.google.com/macros/s/fixture/exec",
    "https://script.google.com@elsewhere.example.invalid/macros/s/fixture/exec",
    "https://script.google.com/macros/s/fixture/dev",
    "https://script.google.com/macros/s/fixture/exec?extra=1",
  ]) {
    const handler = createFeedbackHandler({ ...config, scriptUrl }, transport);
    equal((await handler(request())).status, 503);
  }
  equal(calls.length, 0);
});

Deno.test("blocks cross-origin, credentialed, non-echo, and body-preserving relay redirects", async () => {
  for (const [status, location] of [
    [302, "https://elsewhere.example.invalid/macros/echo"],
    [302, "http://script.googleusercontent.com/macros/echo"],
    [302, "https://user:pass@script.googleusercontent.com/macros/echo"],
    [302, "https://script.googleusercontent.com/macros/not-echo"],
    [302, "/macros/echo"],
    [307, testEcho],
    [308, testEcho],
  ] as const) {
    const { handler, calls } = fakeServices({
      delivery: () => new Response(null, { status, headers: { location } }),
    });
    const result = await handler(request());
    equal(result.status, 409);
    deepStrictEqual(await result.json(), { error: "feedback_delivery_unknown" });
    equal(calls.length, 3);
  }
});

Deno.test("rejects other origins and grants preflight only to the exact allowed origin", async () => {
  const { handler, calls } = fakeServices();
  const rejected = request();
  rejected.headers.set("origin", "https://other.example.invalid");
  const denial = await handler(rejected);
  equal(denial.status, 403);
  equal(denial.headers.get("access-control-allow-origin"), null);
  const noOrigin = request();
  noOrigin.headers.delete("origin");
  equal((await handler(noOrigin)).status, 403);
  const preflight = await handler(new Request(`${testProject}/functions/v1/send-feedback`, {
    method: "OPTIONS",
    headers: { Origin: testOrigin },
  }));
  equal(preflight.status, 204);
  equal(preflight.headers.get("access-control-allow-origin"), testOrigin);
  equal(calls.length, 0);
});

Deno.test("rejects empty and oversized feedback, unsolicited fields, and invalid context", async () => {
  const { handler, calls } = fakeServices();
  const valid = { message: "Test", view: "actions", requestId };
  for (const body of [
    { ...valid, message: " " }, { ...valid, message: "x".repeat(2001) },
    { ...valid, message: "x".repeat(17000) }, { ...valid, view: "/personal/path" },
    { ...valid, requestId: "invalid" }, { ...valid, to: "other@example.invalid" },
  ]) {
    equal((await handler(request(body))).status, 400);
  }
  equal(calls.length, 0);
});

Deno.test("requires a valid user JWT rather than an API key", async () => {
  const { handler, calls } = fakeServices();
  const unsigned = request();
  unsigned.headers.set("authorization", "Bearer sb_publishable_example");
  equal((await handler(unsigned)).status, 401);
  equal(calls.length, 0);

  const rejectedBearer = createFeedbackHandler(config, () => Promise.resolve(new Response(null, { status: 401 })));
  equal((await rejectedBearer(request())).status, 401);
  const unverifiedEmail = createFeedbackHandler(config, () =>
    Promise.resolve(Response.json({ id: userId, email: "member@example.invalid" }))
  );
  equal((await unverifiedEmail(request())).status, 403);
});

Deno.test("denials, quota limits and previously attempted requests never call the relay", async () => {
  const cases = [
    { reservation: "denied", status: 403, calls: 2 },
    { reservation: "limited", status: 429, calls: 2 },
    { reservation: "already_attempted", status: 409, calls: 2 },
    { reservation: "unexpected", status: 503, calls: 2 },
  ];
  for (const scenario of cases) {
    const { handler, calls } = fakeServices({ reservation: scenario.reservation });
    const result = await handler(request());
    equal(result.status, scenario.status);
    equal(calls.length, scenario.calls);
    const body = await result.json();
    deepStrictEqual(Object.keys(body), ["error"]);
    if (scenario.reservation === "already_attempted") {
      deepStrictEqual(body, { error: "feedback_delivery_unknown" });
    }
  }
});

Deno.test("a reserved send requires an explicit relay success response", async () => {
  for (const delivery of [
    () => Response.json({ ok: false, privateProviderDetail: "do not expose" }),
    () => Response.json({ ok: "true" }),
    () => new Response("invalid JSON"),
    () => Response.json({ ok: true }, { status: 502 }),
    () => {
      throw new DOMException("mock relay timeout", "TimeoutError");
    },
  ]) {
    const { handler, calls } = fakeServices({ delivery });
    const result = await handler(request());
    equal(result.status, 409);
    deepStrictEqual(await result.json(), { error: "feedback_delivery_unknown" });
    equal(calls.length, 3);
  }
});
