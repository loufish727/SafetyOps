// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

/**
 * Authenticated request contract (exactly one selector):
 *   { form_file_id: uuid }       existing published-form authorization path
 *   { candidate_id: uuid }       access-scoped import-candidate path
 * Success returns { signed_url, expires_at, filename, mime_type, size_bytes,
 * content_sha256, page_count, render_verified, request_id }. Completeness
 * fields are null on the legacy form-file path. Raw bucket/object paths and
 * service credentials are never returned. Candidate decisions use their own
 * append-only ledger.
 */

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const publicApiKey =
  Deno.env.get("SAFETYOPS_SUPABASE_PUBLISHABLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ??
  "";
const serviceRoleKey =
  Deno.env.get("SAFETYOPS_SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";
const configuredOrigins = (Deno.env.get("SAFETYOPS_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = new Set(
  configuredOrigins.length
    ? configuredOrigins
    : [
        "http://127.0.0.1:4173",
        "http://localhost:4173"
      ]
);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxRequestBytes = 8 * 1024;

function responseHeaders(origin: string | null) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff"
  });
  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return headers;
}

function jsonResponse(
  origin: string | null,
  status: number,
  body: Record<string, unknown>
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(origin)
  });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) {
    return jsonResponse(null, 403, { error: "origin_not_allowed" });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(origin) });
  }
  if (request.method !== "POST") {
    return jsonResponse(origin, 405, { error: "method_not_allowed" });
  }
  if (!supabaseUrl || !publicApiKey || !serviceRoleKey) {
    return jsonResponse(origin, 503, { error: "service_not_configured" });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return jsonResponse(origin, 401, { error: "authentication_required" });
  }

  let formFileId = "";
  let candidateId = "";
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
      return jsonResponse(origin, 413, { error: "request_too_large" });
    }
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > maxRequestBytes) {
      return jsonResponse(origin, 413, { error: "request_too_large" });
    }
    const body = JSON.parse(bodyText);
    formFileId = String(body?.form_file_id ?? "");
    candidateId = String(body?.candidate_id ?? "");
  } catch {
    return jsonResponse(origin, 400, { error: "invalid_json" });
  }
  if (Boolean(formFileId) === Boolean(candidateId)) {
    return jsonResponse(origin, 400, { error: "invalid_file_request" });
  }
  if (formFileId && !uuidPattern.test(formFileId)) {
    return jsonResponse(origin, 400, { error: "invalid_form_file_id" });
  }
  if (candidateId && !uuidPattern.test(candidateId)) {
    return jsonResponse(origin, 400, { error: "invalid_candidate_id" });
  }

  const requestId = crypto.randomUUID();
  const isCandidate = Boolean(candidateId);
  const callerClient = createClient(supabaseUrl, publicApiKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const userResult = await callerClient.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    return jsonResponse(origin, 401, { error: "authentication_required" });
  }
  const actorUserId = userResult.data.user.id;

  // Both RPCs make the authorization decision under the caller's JWT and omit
  // bucket/object paths. PostgreSQL authorizes company-visible candidates for
  // active tenant members and safety/admin-private candidates for managers.
  const metadataResult = isCandidate
    ? await callerClient.rpc("get_safety_program_import_candidate_file_metadata", {
        target_candidate_id: candidateId
      })
    : await callerClient.rpc("get_safety_program_form_file_metadata", {
        target_form_file_id: formFileId
      });
  const authorizedMetadata = Array.isArray(metadataResult.data)
    ? metadataResult.data[0]
    : metadataResult.data;
  if (metadataResult.error || !authorizedMetadata) {
    if (isCandidate) {
      const deniedLocatorResult = await serviceClient.rpc(
        "get_safety_program_import_candidate_storage_locator",
        { target_candidate_id: candidateId }
      );
      const deniedLocator = Array.isArray(deniedLocatorResult.data)
        ? deniedLocatorResult.data[0]
        : deniedLocatorResult.data;
      if (!deniedLocatorResult.error && deniedLocator) {
        await serviceClient.from("safety_program_candidate_file_access_events").insert({
          company_id: deniedLocator.company_id,
          candidate_id: candidateId,
          storage_object_id: deniedLocator.storage_object_id,
          actor_user_id: actorUserId,
          decision: "denied",
          reason_code: "authorization_denied",
          request_id: requestId,
          signed_url_expires_at: null,
          request_context: {
            function: "sign-form-file",
            resource_kind: "import_candidate",
            origin: origin ?? "non_browser"
          }
        });
      }
    }
    return jsonResponse(origin, 403, { error: "file_access_denied", request_id: requestId });
  }

  let companyId = "";
  let storageObjectId = "";
  let locator: Record<string, unknown> | null = null;
  if (isCandidate) {
    const locatorResult = await serviceClient.rpc(
      "get_safety_program_import_candidate_storage_locator",
      { target_candidate_id: candidateId }
    );
    locator = (Array.isArray(locatorResult.data)
      ? locatorResult.data[0]
      : locatorResult.data) as Record<string, unknown> | null;
    if (locatorResult.error || !locator) {
      return jsonResponse(origin, 500, { error: "file_lookup_failed", request_id: requestId });
    }
    companyId = String(locator.company_id ?? "");
    storageObjectId = String(locator.storage_object_id ?? "");
  } else {
    const linkResult = await serviceClient
      .from("safety_program_form_template_files")
      .select("id, company_id, storage_object_id")
      .eq("id", formFileId)
      .maybeSingle();
    if (linkResult.error) {
      return jsonResponse(origin, 500, { error: "file_lookup_failed", request_id: requestId });
    }
    if (!linkResult.data) {
      return jsonResponse(origin, 404, { error: "file_not_found", request_id: requestId });
    }
    companyId = linkResult.data.company_id;
    storageObjectId = linkResult.data.storage_object_id;
  }

  if (!uuidPattern.test(companyId) || !uuidPattern.test(storageObjectId)) {
    return jsonResponse(origin, 500, { error: "file_lookup_failed", request_id: requestId });
  }
  const objectResult = await serviceClient
    .from("safety_program_storage_objects")
    .select("id, company_id, location_id, bucket_id, object_path, original_filename, mime_type, size_bytes, content_sha256, malware_scan_status, verified_at")
    .eq("id", storageObjectId)
    .eq("company_id", companyId)
    .single();
  if (objectResult.error || !objectResult.data) {
    return jsonResponse(origin, 500, { error: "storage_record_missing", request_id: requestId });
  }

  const ledger = isCandidate
    ? "safety_program_candidate_file_access_events"
    : "safety_program_file_access_events";
  const auditBase = {
    company_id: companyId,
    ...(isCandidate
      ? { candidate_id: candidateId }
      : {
          location_id: objectResult.data.location_id,
          form_file_id: formFileId
        }),
    storage_object_id: objectResult.data.id,
    actor_user_id: actorUserId,
    request_id: requestId,
    request_context: {
      function: "sign-form-file",
      resource_kind: isCandidate ? "import_candidate" : "form_file",
      origin: origin ?? "non_browser",
      mime_type: objectResult.data.mime_type
    }
  };

  const expectedIdentifier = isCandidate ? candidateId : formFileId;
  const metadataIdentifier = isCandidate
    ? authorizedMetadata?.candidate_id
    : authorizedMetadata?.form_file_id;
  const authorizedFilename = String(
    isCandidate ? authorizedMetadata?.filename ?? "" : objectResult.data.original_filename
  );
  const filenameIsSafe = authorizedFilename.length >= 1 &&
    authorizedFilename.length <= 255 &&
    !/[\\/\u0000-\u001f\u007f]/.test(authorizedFilename);
  const objectIsVerified =
    objectResult.data.malware_scan_status === "clean" &&
    Boolean(objectResult.data.verified_at);
  const completenessMatches = !isCandidate || (
    objectResult.data.mime_type === "application/pdf"
      ? Number.isSafeInteger(Number(authorizedMetadata?.page_count)) &&
        Number(authorizedMetadata?.page_count) > 0 &&
        authorizedMetadata?.render_verified === true
      : (authorizedMetadata?.page_count === null || authorizedMetadata?.page_count === undefined) &&
        authorizedMetadata?.render_verified === false
  );
  const metadataMatches =
    metadataIdentifier === expectedIdentifier &&
    filenameIsSafe &&
    (isCandidate
      ? locator?.filename === authorizedFilename
      : authorizedMetadata?.filename === objectResult.data.original_filename) &&
    authorizedMetadata?.content_sha256 === objectResult.data.content_sha256 &&
    authorizedMetadata?.mime_type === objectResult.data.mime_type &&
    Number(authorizedMetadata?.size_bytes) === Number(objectResult.data.size_bytes) &&
    (!locator || (
      locator.candidate_id === candidateId &&
      locator.storage_object_id === objectResult.data.id &&
      locator.bucket_id === objectResult.data.bucket_id &&
      locator.object_path === objectResult.data.object_path &&
      locator.content_sha256 === objectResult.data.content_sha256 &&
      locator.mime_type === objectResult.data.mime_type &&
      Number(locator.size_bytes) === Number(objectResult.data.size_bytes)
    )) &&
    completenessMatches;

  if (!objectIsVerified || !metadataMatches) {
    await serviceClient.from(ledger).insert({
      ...auditBase,
      decision: "denied",
      reason_code: !objectIsVerified ? "object_not_verified" : "metadata_mismatch",
      signed_url_expires_at: null
    });
    return jsonResponse(origin, 403, { error: "file_access_denied", request_id: requestId });
  }

  const expiresInSeconds = 300;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const signedResult = await serviceClient.storage
    .from(objectResult.data.bucket_id)
    .createSignedUrl(objectResult.data.object_path, expiresInSeconds);
  if (signedResult.error || !signedResult.data?.signedUrl) {
    return jsonResponse(origin, 500, { error: "signing_failed", request_id: requestId });
  }
  let purposeBoundSignedUrl = "";
  try {
    const parsedSignedUrl = new URL(signedResult.data.signedUrl);
    parsedSignedUrl.searchParams.set("download", authorizedFilename);
    purposeBoundSignedUrl = parsedSignedUrl.toString();
  } catch {
    return jsonResponse(origin, 500, { error: "signing_failed", request_id: requestId });
  }

  const auditResult = await serviceClient.from(ledger).insert({
    ...auditBase,
    decision: "allowed",
    reason_code: "authorized_download",
    signed_url_expires_at: expiresAt
  });
  if (auditResult.error) {
    return jsonResponse(origin, 500, { error: "audit_write_failed", request_id: requestId });
  }

  // Deliberately omit bucket IDs, raw object paths, and all credentials other
  // than the purpose-bound, five-minute Storage URL.
  return jsonResponse(origin, 200, {
    signed_url: purposeBoundSignedUrl,
    expires_at: expiresAt,
    filename: authorizedFilename,
    mime_type: authorizedMetadata.mime_type,
    size_bytes: authorizedMetadata.size_bytes,
    content_sha256: authorizedMetadata.content_sha256,
    page_count: isCandidate ? authorizedMetadata.page_count : null,
    render_verified: isCandidate ? authorizedMetadata.render_verified : null,
    request_id: requestId
  });
});
