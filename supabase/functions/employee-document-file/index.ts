// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const publicApiKey =
  Deno.env.get("SAFETYOPS_SUPABASE_PUBLISHABLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ??
  "";
const serviceRoleKey =
  Deno.env.get("SAFETYOPS_SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";
const scannerUrl = Deno.env.get("SAFETYOPS_PDF_SCANNER_URL") ?? "";
const scannerToken = Deno.env.get("SAFETYOPS_PDF_SCANNER_TOKEN") ?? "";
const configuredOrigins = (Deno.env.get("SAFETYOPS_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = new Set(
  configuredOrigins.length
    ? configuredOrigins
    : [
        "https://loufish727.github.io",
        "http://127.0.0.1:4173",
        "http://localhost:4173"
      ]
);
const bucketId = "employee-records-private";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const maxRequestBytes = 32 * 1024;
const maxPdfBytes = 10 * 1024 * 1024;
const blockedPdfTokens = [
  "/JavaScript",
  "/JS",
  "/OpenAction",
  "/AA",
  "/Launch",
  "/RichMedia",
  "/EmbeddedFile",
  "/Encrypt"
];

type MalwareScanOutcome = {
  status: "clean" | "rejected" | "unavailable";
  record?: Record<string, unknown>;
};

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
    headers.set(
      "Access-Control-Allow-Headers",
      "authorization, apikey, content-type, x-client-info"
    );
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

function oneRow<T extends Record<string, unknown>>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return value && typeof value === "object" ? value as T : null;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function safeFilename(value: unknown) {
  const filename = String(value ?? "");
  return filename.length >= 5 &&
    filename.length <= 255 &&
    !/[\\/\u0000-\u001f\u007f]/.test(filename) &&
    filename.toLowerCase().endsWith(".pdf");
}

function inspectPdf(bytes: Uint8Array) {
  if (bytes.byteLength < 8 || bytes.byteLength > maxPdfBytes) {
    return { valid: false, code: "invalid_pdf_size" };
  }
  const prefix = new TextDecoder("ascii").decode(bytes.slice(0, 8));
  if (!prefix.startsWith("%PDF-")) {
    return { valid: false, code: "invalid_pdf_signature" };
  }
  const tail = new TextDecoder("latin1").decode(bytes.slice(Math.max(0, bytes.length - 2048)));
  if (!tail.includes("%%EOF")) {
    return { valid: false, code: "missing_pdf_eof" };
  }
  const content = new TextDecoder("latin1").decode(bytes);
  const blockedToken = blockedPdfTokens.find((token) => content.includes(token));
  if (blockedToken) {
    return {
      valid: false,
      code: blockedToken === "/Encrypt" ? "encrypted_pdf_not_allowed" : "active_pdf_content_not_allowed"
    };
  }
  const pageMatches = content.match(/\/Type\s*\/Page\b/g);
  const pageCount = pageMatches?.length ?? null;
  if (pageCount !== null && (pageCount < 1 || pageCount > 500)) {
    return { valid: false, code: "invalid_pdf_page_count" };
  }
  return {
    valid: true,
    code: "format_verified",
    pageCount,
    checks: {
      pdfMagic: true,
      eofMarker: true,
      encrypted: false,
      blockedActiveTokens: false,
      pageCountHeuristic: pageCount
    }
  };
}

async function scanPdf(
  bytes: Uint8Array,
  contentSha256: string
): Promise<MalwareScanOutcome> {
  if (!scannerUrl || !scannerToken) return { status: "unavailable" };
  let endpoint: URL;
  try {
    endpoint = new URL(scannerUrl);
  } catch {
    return { status: "unavailable" };
  }
  if (endpoint.protocol !== "https:") return { status: "unavailable" };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${scannerToken}`,
        "Content-Type": "application/pdf",
        "X-SafetyOps-Content-SHA256": contentSha256
      },
      body: bytes,
      signal: AbortSignal.timeout(45_000)
    });
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (!response.ok || (declaredLength && declaredLength > 65_536)) {
      return { status: "unavailable" };
    }
    const responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > 65_536) {
      return { status: "unavailable" };
    }
    const value = JSON.parse(responseText) as Record<string, unknown>;
    const status = String(value.status ?? "").toLowerCase();
    const sha256 = String(value.sha256 ?? "").toLowerCase();
    const engine = String(value.engine ?? "").trim();
    const engineVersion = String(value.engine_version ?? "").trim();
    const signatureDatabaseVersion = String(
      value.signature_database_version ?? ""
    ).trim();
    const scanId = String(value.scan_id ?? "").trim();
    const scannedAt = String(value.scanned_at ?? "").trim();
    const scannedTime = Date.parse(scannedAt);
    if (!(["clean", "rejected"] as string[]).includes(status) ||
        sha256 !== contentSha256 ||
        engine.length < 2 || engine.length > 120 ||
        engineVersion.length < 1 || engineVersion.length > 120 ||
        signatureDatabaseVersion.length < 1 || signatureDatabaseVersion.length > 160 ||
        scanId.length < 8 || scanId.length > 240 ||
        !Number.isFinite(scannedTime) ||
        Math.abs(Date.now() - scannedTime) > 24 * 60 * 60 * 1000) {
      return { status: "unavailable" };
    }
    return {
      status: status as "clean" | "rejected",
      record: {
        status,
        sha256,
        engine,
        engineVersion,
        signatureDatabaseVersion,
        scanId,
        scannedAt: new Date(scannedTime).toISOString()
      }
    };
  } catch {
    return { status: "unavailable" };
  }
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

  let body: Record<string, unknown>;
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
      return jsonResponse(origin, 413, { error: "request_too_large" });
    }
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > maxRequestBytes) {
      return jsonResponse(origin, 413, { error: "request_too_large" });
    }
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse(origin, 400, { error: "invalid_json" });
  }

  const action = String(body.action ?? "");
  if (!["prepare", "complete", "scan", "download"].includes(action)) {
    return jsonResponse(origin, 400, { error: "invalid_action" });
  }

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

  if (action === "prepare") {
    const employeeId = String(body.employee_id ?? "");
    const locationId = String(body.location_id ?? "");
    const documentKind = String(body.document_kind ?? "");
    const title = String(body.title ?? "");
    const filename = String(body.filename ?? "");
    const declaredSize = Number(body.size_bytes ?? 0);
    const idempotencyKey = String(body.idempotency_key ?? "");
    if (!uuidPattern.test(employeeId) || !uuidPattern.test(locationId) ||
        !uuidPattern.test(idempotencyKey) || !safeFilename(filename) ||
        !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maxPdfBytes ||
        !["signature_request", "signed_upload"].includes(documentKind) ||
        title.trim().length < 3 || title.trim().length > 220) {
      return jsonResponse(origin, 400, { error: "invalid_upload_request" });
    }

    const prepareResult = await callerClient.rpc("prepare_employee_document_upload", {
      target_employee_id: employeeId,
      target_location_id: locationId,
      target_document_kind: documentKind,
      target_title: title.trim(),
      target_filename: filename,
      target_declared_size_bytes: declaredSize,
      target_document_date: body.document_date ?? null,
      target_signature_due_at: body.signature_due_at ?? null,
      target_signature_intent: body.signature_intent ?? null,
      target_retention_months: body.retention_months ?? null,
      target_retention_basis: body.retention_basis ?? { status: "review_required" },
      target_employee_can_view: body.employee_can_view !== false,
      target_manager_visibility: body.manager_visibility ?? "safety_admin_only",
      target_idempotency_key: idempotencyKey
    });
    const prepared = oneRow<{
      upload_session_id: string;
      employee_document_id: string;
      bucket_id: string;
      quarantine_path: string;
      expires_at: string;
    }>(prepareResult.data);
    if (prepareResult.error || !prepared || prepared.bucket_id !== bucketId) {
      return jsonResponse(origin, 403, { error: "upload_not_authorized" });
    }
    const signedUpload = await serviceClient.storage
      .from(bucketId)
      .createSignedUploadUrl(prepared.quarantine_path, { upsert: false });
    if (signedUpload.error || !signedUpload.data?.token) {
      return jsonResponse(origin, 500, { error: "upload_authority_failed" });
    }
    return jsonResponse(origin, 200, {
      upload_session_id: prepared.upload_session_id,
      employee_document_id: prepared.employee_document_id,
      bucket_id: bucketId,
      object_path: prepared.quarantine_path,
      upload_token: signedUpload.data.token,
      expires_at: prepared.expires_at
    });
  }

  if (action === "complete") {
    const uploadSessionId = String(body.upload_session_id ?? "");
    if (!uuidPattern.test(uploadSessionId)) {
      return jsonResponse(origin, 400, { error: "invalid_upload_session" });
    }
    const rejectOwnedUpload = async (
      processingToken: string,
      rejectionCode: string,
      cleanupPaths: string[] = []
    ) => {
      const rejectionResult = await serviceClient.rpc(
        "reject_employee_document_upload_internal",
        {
          target_upload_session_id: uploadSessionId,
          target_processing_token: processingToken,
          target_rejection_code: rejectionCode
        }
      );
      const rejected = !rejectionResult.error && rejectionResult.data === true;
      if (rejected && cleanupPaths.length) {
        await serviceClient.storage.from(bucketId).remove(cleanupPaths);
      }
      return rejected;
    };
    const authorizeResult = await callerClient.rpc(
      "authorize_employee_document_upload_session",
      { target_upload_session_id: uploadSessionId }
    );
    const authorized = oneRow<{
      upload_session_id: string;
      employee_document_id: string;
      company_id: string;
      quarantine_path: string;
      declared_size_bytes: number;
      expires_at: string;
    }>(authorizeResult.data);
    if (authorizeResult.error || !authorized) {
      return jsonResponse(origin, 403, { error: "upload_not_authorized" });
    }
    const claimResult = await serviceClient.rpc(
      "claim_employee_document_upload_internal",
      { target_upload_session_id: uploadSessionId }
    );
    const claimed = oneRow<{
      upload_session_id: string;
      employee_document_id: string;
      company_id: string;
      quarantine_path: string;
      declared_size_bytes: number;
      expires_at: string;
      processing_token: string;
      processing_expires_at: string;
    }>(claimResult.data);
    if (claimResult.error || !claimed ||
        claimed.employee_document_id !== authorized.employee_document_id ||
        claimed.company_id !== authorized.company_id ||
        claimed.quarantine_path !== authorized.quarantine_path ||
        Number(claimed.declared_size_bytes) !== Number(authorized.declared_size_bytes) ||
        !uuidPattern.test(claimed.processing_token) ||
        !Number.isFinite(Date.parse(claimed.processing_expires_at)) ||
        Date.parse(claimed.processing_expires_at) <= Date.now()) {
      if (claimed && uuidPattern.test(claimed.processing_token)) {
        await rejectOwnedUpload(claimed.processing_token, "claim_metadata_mismatch");
      }
      return jsonResponse(origin, 409, { error: "upload_already_claimed" });
    }
    const downloadResult = await serviceClient.storage
      .from(bucketId)
      .download(claimed.quarantine_path);
    if (downloadResult.error || !downloadResult.data) {
      await rejectOwnedUpload(claimed.processing_token, "uploaded_file_not_found");
      return jsonResponse(origin, 409, { error: "uploaded_file_not_found" });
    }
    const bytes = new Uint8Array(await downloadResult.data.arrayBuffer());
    const inspection = inspectPdf(bytes);
    if (bytes.byteLength !== Number(claimed.declared_size_bytes) || !inspection.valid) {
      const rejectionCode = bytes.byteLength !== Number(claimed.declared_size_bytes)
        ? "size_mismatch"
        : inspection.code;
      await rejectOwnedUpload(
        claimed.processing_token,
        rejectionCode,
        [claimed.quarantine_path]
      );
      return jsonResponse(origin, 422, { error: rejectionCode });
    }
    const contentSha256 = await sha256Hex(bytes);
    if (!sha256Pattern.test(contentSha256)) {
      await rejectOwnedUpload(
        claimed.processing_token,
        "hash_failed",
        [claimed.quarantine_path]
      );
      return jsonResponse(origin, 500, { error: "hash_failed" });
    }
    const formatValidationRecord = {
      validationVersion: "safetyops-employee-pdf-format-v1",
      ...inspection.checks,
      exactBytesPreserved: true
    };
    const malwareScan = await scanPdf(bytes, contentSha256);
    if (malwareScan.status === "rejected") {
      const rejectionAttestation = await serviceClient.rpc(
        "attest_employee_document_malware_rejection_internal",
        {
          target_upload_session_id: uploadSessionId,
          target_processing_token: claimed.processing_token,
          target_observed_size_bytes: bytes.byteLength,
          target_observed_sha256: contentSha256,
          target_validation_record: formatValidationRecord,
          target_scan_record: malwareScan.record
        }
      );
      if (rejectionAttestation.error || rejectionAttestation.data !== true) {
        return jsonResponse(origin, 500, {
          error: "malware_rejection_attestation_failed"
        });
      }
      await serviceClient.storage.from(bucketId).remove([claimed.quarantine_path]);
      return jsonResponse(origin, 422, { error: "malware_scan_rejected" });
    }
    const finalPath = [
      claimed.company_id,
      "employee-documents",
      claimed.employee_document_id,
      `${contentSha256}.pdf`
    ].join("/");
    const copyResult = await serviceClient.storage
      .from(bucketId)
      .copy(claimed.quarantine_path, finalPath);
    if (copyResult.error) {
      const existingCopy = await serviceClient.storage.from(bucketId).download(finalPath);
      const existingBytes = existingCopy.data
        ? new Uint8Array(await existingCopy.data.arrayBuffer())
        : null;
      const existingHash = existingBytes ? await sha256Hex(existingBytes) : "";
      if (existingCopy.error || !existingBytes ||
          existingBytes.byteLength !== bytes.byteLength ||
          existingHash !== contentSha256) {
        await rejectOwnedUpload(
          claimed.processing_token,
          "verified_copy_failed",
          [finalPath, claimed.quarantine_path]
        );
        return jsonResponse(origin, 500, { error: "verified_copy_failed" });
      }
    }
    const commitResult = await serviceClient.rpc(
      "commit_employee_document_upload_internal",
      {
        target_upload_session_id: uploadSessionId,
        target_processing_token: claimed.processing_token,
        target_final_path: finalPath,
        target_observed_size_bytes: bytes.byteLength,
        target_observed_sha256: contentSha256,
        target_validation_record: formatValidationRecord
      }
    );
    let committed = oneRow<{ employee_document_id: string; document_status: string }>(
      commitResult.data
    );
    if (commitResult.error || !committed) {
      const referenceCheck = await serviceClient
        .from("employee_documents")
        .select("id, storage_path, document_sha256, status")
        .eq("id", claimed.employee_document_id)
        .maybeSingle();
      if (referenceCheck.data?.storage_path === finalPath &&
          referenceCheck.data.document_sha256 === contentSha256) {
        committed = {
          employee_document_id: referenceCheck.data.id,
          document_status: referenceCheck.data.status
        };
      } else {
        await rejectOwnedUpload(
          claimed.processing_token,
          "database_commit_failed",
          [finalPath, claimed.quarantine_path]
        );
        return jsonResponse(origin, 500, { error: "database_commit_failed" });
      }
    }
    let finalStatus = committed.document_status;
    let finalScanStatus: "clean" | "unavailable" = "unavailable";
    if (malwareScan.status === "clean" && malwareScan.record) {
      const attestationResult = await serviceClient.rpc(
        "attest_employee_document_malware_scan_internal",
        {
          target_employee_document_id: committed.employee_document_id,
          target_document_sha256: contentSha256,
          target_scan_record: malwareScan.record
        }
      );
      const attested = oneRow<{
        employee_document_id: string;
        document_status: string;
        malware_scan_status: string;
      }>(attestationResult.data);
      if (!attestationResult.error && attested?.malware_scan_status === "clean") {
        finalStatus = attested.document_status;
        finalScanStatus = "clean";
      }
    }
    await serviceClient.storage.from(bucketId).remove([claimed.quarantine_path]);
    return jsonResponse(origin, 200, {
      employee_document_id: committed.employee_document_id,
      status: finalStatus,
      content_sha256: contentSha256,
      size_bytes: bytes.byteLength,
      malware_scan_status: finalScanStatus
    });
  }

  if (action === "scan") {
    const employeeDocumentId = String(body.employee_document_id ?? "");
    if (!uuidPattern.test(employeeDocumentId)) {
      return jsonResponse(origin, 400, { error: "invalid_employee_document_id" });
    }
    if (!scannerUrl || !scannerToken) {
      return jsonResponse(origin, 503, { error: "malware_scanner_unavailable" });
    }
    const authorizationResult = await callerClient.rpc(
      "authorize_employee_document_scan",
      { target_employee_document_id: employeeDocumentId }
    );
    const authorized = oneRow<{
      employee_document_id: string;
      company_id: string;
      expected_size_bytes: number;
      expected_sha256: string;
    }>(authorizationResult.data);
    if (authorizationResult.error || !authorized) {
      return jsonResponse(origin, 403, { error: "scan_not_authorized" });
    }
    const privateRecord = await serviceClient
      .from("employee_documents")
      .select("id, company_id, storage_path, size_bytes, document_sha256, validation_status, malware_scan_status, status")
      .eq("id", employeeDocumentId)
      .single();
    if (privateRecord.error || !privateRecord.data ||
        privateRecord.data.company_id !== authorized.company_id ||
        Number(privateRecord.data.size_bytes) !== Number(authorized.expected_size_bytes) ||
        privateRecord.data.document_sha256 !== authorized.expected_sha256 ||
        privateRecord.data.validation_status !== "format_verified" ||
        privateRecord.data.status !== "upload_pending" ||
        !["not_scanned", "pending", "unavailable"].includes(
          privateRecord.data.malware_scan_status
        ) || !privateRecord.data.storage_path) {
      return jsonResponse(origin, 409, { error: "scan_metadata_mismatch" });
    }
    const downloadResult = await serviceClient.storage
      .from(bucketId)
      .download(privateRecord.data.storage_path);
    if (downloadResult.error || !downloadResult.data) {
      return jsonResponse(origin, 409, { error: "scan_source_unavailable" });
    }
    const bytes = new Uint8Array(await downloadResult.data.arrayBuffer());
    const contentSha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== Number(authorized.expected_size_bytes) ||
        contentSha256 !== authorized.expected_sha256) {
      return jsonResponse(origin, 409, { error: "scan_source_hash_mismatch" });
    }
    const malwareScan = await scanPdf(bytes, contentSha256);
    if (malwareScan.status === "unavailable" || !malwareScan.record) {
      return jsonResponse(origin, 503, { error: "malware_scanner_unavailable" });
    }
    const attestationResult = await serviceClient.rpc(
      "attest_employee_document_malware_scan_internal",
      {
        target_employee_document_id: employeeDocumentId,
        target_document_sha256: contentSha256,
        target_scan_record: malwareScan.record
      }
    );
    const attested = oneRow<{
      employee_document_id: string;
      document_status: string;
      malware_scan_status: string;
    }>(attestationResult.data);
    if (attestationResult.error || !attested) {
      return jsonResponse(origin, 500, { error: "scan_attestation_failed" });
    }
    return jsonResponse(origin, 200, {
      employee_document_id: attested.employee_document_id,
      status: attested.document_status,
      malware_scan_status: attested.malware_scan_status,
      content_sha256: contentSha256
    });
  }

  const employeeDocumentId = String(body.employee_document_id ?? "");
  if (!uuidPattern.test(employeeDocumentId)) {
    return jsonResponse(origin, 400, { error: "invalid_employee_document_id" });
  }
  const requestId = crypto.randomUUID();
  const authorizationResult = await callerClient.rpc(
    "authorize_employee_document_download",
    { target_employee_document_id: employeeDocumentId }
  );
  const safeMetadata = oneRow<{
    employee_document_id: string;
    company_id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    content_sha256: string;
    document_status: string;
  }>(authorizationResult.data);
  if (authorizationResult.error || !safeMetadata) {
    const deniedLookup = await serviceClient
      .from("employee_documents")
      .select("id, company_id")
      .eq("id", employeeDocumentId)
      .maybeSingle();
    if (deniedLookup.data) {
      await serviceClient.from("employee_document_file_access_events").insert({
        company_id: deniedLookup.data.company_id,
        employee_document_id: employeeDocumentId,
        actor_user_id: actorUserId,
        decision: "denied",
        reason_code: "authorization_denied",
        request_id: requestId,
        signed_url_expires_at: null
      });
    }
    return jsonResponse(origin, 403, { error: "file_access_denied", request_id: requestId });
  }
  const privateRecord = await serviceClient
    .from("employee_documents")
    .select("id, company_id, storage_path, original_filename, mime_type, size_bytes, document_sha256, validation_status")
    .eq("id", employeeDocumentId)
    .single();
  if (privateRecord.error || !privateRecord.data ||
      privateRecord.data.company_id !== safeMetadata.company_id ||
      privateRecord.data.original_filename !== safeMetadata.filename ||
      privateRecord.data.mime_type !== safeMetadata.mime_type ||
      Number(privateRecord.data.size_bytes) !== Number(safeMetadata.size_bytes) ||
      privateRecord.data.document_sha256 !== safeMetadata.content_sha256 ||
      privateRecord.data.validation_status !== "format_verified" ||
      !safeFilename(privateRecord.data.original_filename)) {
    return jsonResponse(origin, 500, { error: "file_metadata_mismatch", request_id: requestId });
  }
  const expiresInSeconds = 300;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const signedDownload = await serviceClient.storage
    .from(bucketId)
    .createSignedUrl(privateRecord.data.storage_path, expiresInSeconds, {
      download: privateRecord.data.original_filename
    });
  if (signedDownload.error || !signedDownload.data?.signedUrl) {
    return jsonResponse(origin, 500, { error: "download_authority_failed", request_id: requestId });
  }
  const auditResult = await serviceClient.from("employee_document_file_access_events").insert({
    company_id: privateRecord.data.company_id,
    employee_document_id: employeeDocumentId,
    actor_user_id: actorUserId,
    decision: "allowed",
    reason_code: "authorized_download",
    request_id: requestId,
    signed_url_expires_at: expiresAt
  });
  if (auditResult.error) {
    return jsonResponse(origin, 500, { error: "audit_write_failed", request_id: requestId });
  }
  return jsonResponse(origin, 200, {
    signed_url: signedDownload.data.signedUrl,
    expires_at: expiresAt,
    filename: safeMetadata.filename,
    mime_type: safeMetadata.mime_type,
    size_bytes: safeMetadata.size_bytes,
    content_sha256: safeMetadata.content_sha256,
    request_id: requestId
  });
});
