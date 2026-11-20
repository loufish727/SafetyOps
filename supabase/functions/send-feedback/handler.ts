type FeedbackConfig = {
  allowedOrigins: readonly string[];
  companyId: string;
  recipient: string;
  scriptUrl: string;
  scriptSecret: string;
  supabaseUrl: string;
  publicKey: string;
  serviceKey: string;
};

const views = new Map([
  ["dashboard", "Today"],
  ["calendar", "Calendar"],
  ["my-work", "Safety monitor"],
  ["inspections", "Inspections"],
  ["committee", "Safety committee"],
  ["training", "Training"],
  ["incidents", "Incidents & near misses"],
  ["actions", "Action items"],
  ["programs", "Company forms & programs"],
  ["documents", "Policies & controlled documents"],
  ["standards", "OSHA manufacturing guide"],
  ["people", "Employees & credentials"],
  ["locations", "Locations"],
  ["settings", "Workspace settings"],
  ["search", "Search results"],
]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const bearerPattern = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i;
const scriptUrlPattern = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const bodyLimit = 16 * 1024;

function validAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && emailPattern.test(value);
}

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return headers;
}

async function readFeedback(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const length = request.headers.get("content-length");
  if (contentType !== "application/json" || (length && Number(length) > bodyLimit) || !request.body) {
    throw new Error("Invalid request");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let payload = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > bodyLimit) throw new Error("Request too large");
      payload += decoder.decode(chunk.value, { stream: true });
    }
    payload += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(payload);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 3 ||
      typeof body.message !== "string" || typeof body.view !== "string" || typeof body.requestId !== "string") {
    throw new Error("Invalid feedback");
  }
  const message = body.message.trim();
  const view = views.get(body.view);
  if (!message || message.length > 2000 || !view || !uuidPattern.test(body.requestId)) {
    throw new Error("Invalid feedback");
  }
  return { message, view, requestId: body.requestId.toLowerCase() };
}

// Only called after Supabase Auth verifies this exact bearer. The service RPC
// verifies that the session still exists and belongs to the verified user.
function verifiedSessionId(token: string, userId: string): string | null {
  try {
    const encoded = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const claims = JSON.parse(atob(encoded));
    return claims.sub === userId && claims.role === "authenticated" &&
        typeof claims.session_id === "string" && uuidPattern.test(claims.session_id)
      ? claims.session_id
      : null;
  } catch {
    return null;
  }
}

async function sendThroughRelay(config: FeedbackConfig, text: string, fetcher: typeof fetch) {
  const signal = AbortSignal.timeout(15000);
  let delivery = await fetcher(config.scriptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: config.scriptSecret,
      to: config.recipient,
      subject: "Taylor Safe feedback",
      text,
    }),
    redirect: "manual",
    signal,
  });
  if (delivery.status === 302 || delivery.status === 303) {
    // Apps Script Content Service uses a one-time URL for its response. Only
    // retrieve the body from that endpoint. The relay secret stays in the POST.
    const redirect = new URL(delivery.headers.get("location") ?? "");
    if (redirect.origin !== "https://script.googleusercontent.com" ||
        redirect.pathname !== "/macros/echo" || redirect.username || redirect.password || redirect.hash) {
      return false;
    }
    delivery = await fetcher(redirect, { method: "GET", redirect: "error", signal });
  }
  if (!delivery.ok) return false;
  const body = await delivery.json();
  return body?.ok === true;
}

export function createFeedbackHandler(config: FeedbackConfig, fetcher: typeof fetch = fetch) {
  const allowedOrigins = new Set(config.allowedOrigins);
  const configured = uuidPattern.test(config.companyId) && validAddress(config.recipient) &&
    scriptUrlPattern.test(config.scriptUrl) &&
    Boolean(config.scriptSecret && config.supabaseUrl && config.publicKey && config.serviceKey);
  return async (request: Request): Promise<Response> => {
    const incomingOrigin = request.headers.get("origin");
    const origin = incomingOrigin && allowedOrigins.has(incomingOrigin) ? incomingOrigin : null;
    const headers = corsHeaders(origin);
    const json = (status: number, body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), { status, headers });
    const unavailable = () => json(503, { error: "feedback_unavailable" });
    const unknownDelivery = () => json(409, { error: "feedback_delivery_unknown" });

    if (!origin) return json(403, { error: "feedback_forbidden" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!configured) return unavailable();

    const authorization = request.headers.get("authorization") ?? "";
    const token = bearerPattern.exec(authorization)?.[1];
    if (!token || token.length > 8192) return json(401, { error: "sign_in_required" });

    let feedback;
    try {
      feedback = await readFeedback(request);
    } catch {
      return json(400, { error: "invalid_feedback" });
    }

    let user: { id?: unknown; email?: unknown; email_confirmed_at?: unknown; is_anonymous?: unknown };
    let sessionId: string | null;
    try {
      const auth = await fetcher(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: config.publicKey, Authorization: authorization },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if ([400, 401, 403, 404].includes(auth.status)) return json(401, { error: "sign_in_required" });
      if (!auth.ok) return unavailable();
      user = await auth.json();
      if (!user || typeof user.id !== "string" || !uuidPattern.test(user.id) ||
          !validAddress(user.email) || !user.email_confirmed_at || user.is_anonymous) {
        return json(403, { error: "feedback_forbidden" });
      }
      sessionId = verifiedSessionId(token, user.id);
      if (!sessionId) return json(401, { error: "sign_in_required" });

      const serviceHeaders = new Headers({
        apikey: config.serviceKey,
        "Content-Type": "application/json",
      });
      if (!config.serviceKey.startsWith("sb_secret_")) {
        serviceHeaders.set("Authorization", `Bearer ${config.serviceKey}`);
      }
      const quota = await fetcher(`${config.supabaseUrl}/rest/v1/rpc/reserve_feedback_email`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({
          target_company_id: config.companyId,
          target_user_id: user.id,
          target_session_id: sessionId,
          target_request_id: feedback.requestId,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!quota.ok) return unavailable();
      const reservation = await quota.json();
      if (reservation === "denied") return json(403, { error: "feedback_forbidden" });
      if (reservation === "limited") return json(429, { error: "feedback_rate_limit" });
      if (reservation === "already_attempted") return unknownDelivery();
      if (reservation !== "reserved") return unavailable();
    } catch {
      return unavailable();
    }

    try {
      const text = `From: ${user.email}\nScreen: ${feedback.view}\n\n${feedback.message}`;
      if (await sendThroughRelay(config, text, fetcher)) {
        return json(200, { sent: true });
      }
    } catch {
      // Suppress provider request/response details and caller feedback text.
    }
    return unknownDelivery();
  };
}
