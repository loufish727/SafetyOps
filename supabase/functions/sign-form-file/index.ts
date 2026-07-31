import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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

function responseHeaders(origin: string | null) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin"
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
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(origin, 503, { error: "service_not_configured" });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return jsonResponse(origin, 401, { error: "authentication_required" });
  }

  let formFileId = "";
  try {
    const body = await request.json();
    formFileId = String(body?.form_file_id ?? "");
  } catch {
    return jsonResponse(origin, 400, { error: "invalid_json" });
  }
  if (!uuidPattern.test(formFileId)) {
    return jsonResponse(origin, 400, { error: "invalid_form_file_id" });
  }

  const requestId = crypto.randomUUID();
  const callerClient = createClient(supabaseUrl, anonKey, {
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

  const metadataResult = await callerClient.rpc(
    "get_safety_program_form_file_metadata",
    { target_form_file_id: formFileId }
  );
  const authorizedMetadata = Array.isArray(metadataResult.data)
    ? metadataResult.data[0]
    : metadataResult.data;
  if (metadataResult.error || !authorizedMetadata) {
    return jsonResponse(origin, 403, { error: "file_access_denied", request_id: requestId });
  }

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

  const objectResult = await serviceClient
    .from("safety_program_storage_objects")
    .select("id, company_id, location_id, bucket_id, object_path, original_filename, mime_type, size_bytes, content_sha256, malware_scan_status, verified_at")
    .eq("id", linkResult.data.storage_object_id)
    .eq("company_id", linkResult.data.company_id)
    .single();
  if (objectResult.error || !objectResult.data) {
    return jsonResponse(origin, 500, { error: "storage_record_missing", request_id: requestId });
  }

  const auditBase = {
    company_id: linkResult.data.company_id,
    location_id: objectResult.data.location_id,
    form_file_id: formFileId,
    storage_object_id: objectResult.data.id,
    actor_user_id: actorUserId,
    request_id: requestId,
    request_context: {
      function: "sign-form-file",
      origin: origin ?? "non_browser",
      mime_type: objectResult.data.mime_type
    }
  };

  const objectIsVerified =
    objectResult.data.malware_scan_status === "clean" &&
    Boolean(objectResult.data.verified_at);
  const metadataMatches =
    authorizedMetadata?.form_file_id === formFileId &&
    authorizedMetadata?.content_sha256 === objectResult.data.content_sha256 &&
    Number(authorizedMetadata?.size_bytes) === Number(objectResult.data.size_bytes);

  if (!objectIsVerified || !metadataMatches) {
    await serviceClient.from("safety_program_file_access_events").insert({
      ...auditBase,
      decision: "denied",
      reason_code: !objectIsVerified
        ? "object_not_verified"
        : "metadata_mismatch",
      signed_url_expires_at: null
    });
    return jsonResponse(origin, 403, { error: "file_access_denied", request_id: requestId });
  }

  const expiresInSeconds = 300;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const signedResult = await serviceClient.storage
    .from(objectResult.data.bucket_id)
    .createSignedUrl(objectResult.data.object_path, expiresInSeconds, {
      download: objectResult.data.original_filename
    });
  if (signedResult.error || !signedResult.data?.signedUrl) {
    return jsonResponse(origin, 500, { error: "signing_failed", request_id: requestId });
  }

  const auditResult = await serviceClient
    .from("safety_program_file_access_events")
    .insert({
      ...auditBase,
      decision: "allowed",
      reason_code: "authorized_download",
      signed_url_expires_at: expiresAt
    });
  if (auditResult.error) {
    return jsonResponse(origin, 500, { error: "audit_write_failed", request_id: requestId });
  }

  return jsonResponse(origin, 200, {
    signed_url: signedResult.data.signedUrl,
    expires_at: expiresAt,
    filename: authorizedMetadata.filename,
    mime_type: authorizedMetadata.mime_type,
    size_bytes: authorizedMetadata.size_bytes,
    content_sha256: authorizedMetadata.content_sha256,
    request_id: requestId
  });
});
