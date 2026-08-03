// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

/**
 * Server-to-server JSON contract (all requests require
 * x-safetyops-import-secret; responses always include request_id):
 *
 * prepare
 *   request:  { action:"prepare", company_id, manifest }
 *   response: { manifest_sha256, item_count, total_size_bytes, preparation }
 *   `manifest` is the canonical Drive ZIP snapshot manifest. Its embedded
 *   manifest_sha256 covers canonical JSON with that one digest field removed.
 *
 * signed_upload_urls
 *   request:  { action:"signed_upload_urls", item_ids:[uuid, ...] } (max 50)
 *   response: { uploads:[{item_id,signed_url,upload_token,expires_at,
 *                         mime_type,size_bytes,content_sha256}] }
 *
 * verify_commit
 *   request:  { action:"verify_commit", item_id }
 *   response: { item_id,candidate_id,status,promotion,size_bytes,
 *               content_sha256,mime_type,quarantine_cleanup_pending }
 *
 * status (resume_status is an alias)
 *   request:  { action:"status", run_id }
 *   response: { ingest } where ingest is the service RPC's resumable run/item
 *               snapshot. Source folder names/IDs and ZIP names are omitted.
 */

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey =
  Deno.env.get("SAFETYOPS_SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";
const importSecret = Deno.env.get("SAFETYOPS_DRIVE_IMPORT_SECRET") ?? "";

const bucketId = "safety-program-private";
const maxRequestBytes = 4 * 1024 * 1024;
const maxManifestItems = 1_000;
const maxUploadUrlBatch = 50;
const maxFileBytes = 100 * 1024 * 1024;
const maxAttestationBytes = 64 * 1024;
const signedUploadLifetimeSeconds = 2 * 60 * 60;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const safeCodePattern = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const allowedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "image/x-adobe-dng",
  "image/tiff",
  "image/jpeg",
  "image/png"
]);
const extensionMimeTypes: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  dng: "image/x-adobe-dng",
  tif: "image/tiff",
  tiff: "image/tiff",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png"
};

type JsonObject = Record<string, unknown>;
// Supabase's ungenerated client needs a dynamic Database generic for RPCs.
// deno-lint-ignore no-explicit-any
type ServiceClient = ReturnType<typeof createClient<any>>;

function responseHeaders() {
  return new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders()
  });
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number
): value is string {
  return typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength;
}

function timingSafeStringEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maximumLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 16) throw new Error("json_too_deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_json_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > maxManifestItems) throw new Error("json_array_too_large");
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length > 128) throw new Error("json_object_too_large");
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`
    ).join(",")}}`;
  }
  throw new Error("invalid_json_value");
}

function sameCanonicalJson(left: unknown, right: unknown) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

async function sha256Hex(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digestInput = bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeExtension(value: unknown) {
  if (!isBoundedString(value, 1, 16)) return "";
  return value.trim().toLowerCase().replace(/^\./, "");
}

function extensionMatchesMime(extension: string, mimeType: string) {
  if (extension === "dng") {
    return mimeType === "image/jpeg" || mimeType === "image/x-adobe-dng";
  }
  return extensionMimeTypes[extension] === mimeType;
}

function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validSourceCollection(value: unknown): value is string {
  return isBoundedString(value, 1, 255) &&
    value.trim() === value &&
    !value.includes("\\") &&
    !value.includes("/") &&
    !hasControlCharacters(value);
}

function validFilename(value: unknown): value is string {
  return isBoundedString(value, 1, 255) &&
    !value.includes("\\") &&
    !value.includes("/") &&
    !hasControlCharacters(value) &&
    value !== "." &&
    value !== "..";
}

function validRelativePath(value: unknown, maximumLength: number): value is string {
  if (!isBoundedString(value, 1, maximumLength) || value.startsWith("/") ||
      value.includes("\\") || hasControlCharacters(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validateScanAttestation(value: unknown) {
  if (!isRecord(value) || value.result !== "clean") return false;
  if (!isBoundedString(value.provider, 1, 128) ||
      !isBoundedString(value.engine_version, 1, 128) ||
      !isBoundedString(value.signature_version, 1, 256) ||
      !isBoundedString(value.signature_updated_at, 10, 64) ||
      !isBoundedString(value.recorded_at, 10, 64) ||
      !Number.isSafeInteger(Number(value.scanned_item_count)) ||
      Number(value.scanned_item_count) < 1 ||
      !Array.isArray(value.scanned_snapshot_sha256) ||
      value.scanned_snapshot_sha256.length < 1 ||
      value.scanned_snapshot_sha256.length > 16 ||
      !value.scanned_snapshot_sha256.every((hash) =>
        typeof hash === "string" && sha256Pattern.test(hash)
      ) ||
      new Set(value.scanned_snapshot_sha256).size !== value.scanned_snapshot_sha256.length) {
    return false;
  }
  const signatureUpdatedAt = Date.parse(value.signature_updated_at);
  const recordedAt = Date.parse(value.recorded_at);
  if (!Number.isFinite(signatureUpdatedAt) || !Number.isFinite(recordedAt) ||
      signatureUpdatedAt > Date.now() + 5 * 60 * 1000 ||
      recordedAt > Date.now() + 5 * 60 * 1000 ||
      recordedAt < signatureUpdatedAt) return false;
  try {
    return new TextEncoder().encode(canonicalJson(value)).byteLength <= maxAttestationBytes;
  } catch {
    return false;
  }
}

async function validateManifest(manifest: unknown) {
  if (!isRecord(manifest) || !Array.isArray(manifest.items)) {
    return { valid: false, reason: "invalid_manifest" } as const;
  }
  if (manifest.schema_version !== 1 ||
      !uuidPattern.test(String(manifest.manifest_id ?? "")) ||
      !uuidPattern.test(String(manifest.company_id ?? "")) ||
      !isRecord(manifest.source) ||
      manifest.source.provider !== "google_drive" ||
      manifest.source.identity_kind !== "folder_zip_path_snapshot" ||
      !isRecord(manifest.snapshot) ||
      !validateScanAttestation(manifest.scan_attestation) ||
      !sha256Pattern.test(String(manifest.manifest_sha256 ?? ""))) {
    return { valid: false, reason: "invalid_manifest" } as const;
  }
  if (manifest.items.length < 1 || manifest.items.length > maxManifestItems) {
    return { valid: false, reason: "manifest_item_limit" } as const;
  }

  if (!isBoundedString(manifest.snapshot.kind, 1, 64) ||
      manifest.snapshot.complete !== true ||
      !isBoundedString(manifest.snapshot.captured_at, 10, 64) ||
      !Number.isFinite(Date.parse(manifest.snapshot.captured_at)) ||
      Date.parse(manifest.snapshot.captured_at) > Date.now() + 5 * 60 * 1000) {
    return { valid: false, reason: "invalid_snapshot_lineage" } as const;
  }
  const snapshotsValue = manifest.snapshot.snapshots;
  if (!Array.isArray(snapshotsValue) || snapshotsValue.length !== 2) {
    return { valid: false, reason: "invalid_snapshot_lineage" } as const;
  }
  const snapshotKeys = new Set<string>();
  const snapshotExpected = new Map<string, {
    itemCount: number;
    totalBytes: number;
    sourceCollection: string;
  }>();
  const snapshotActual = new Map<string, { itemCount: number; totalBytes: number }>();
  for (const snapshot of snapshotsValue) {
    if (!isRecord(snapshot) ||
        !isBoundedString(snapshot.snapshot_key, 1, 200) ||
        !isBoundedString(snapshot.folder_id, 1, 255) ||
        !validSourceCollection(snapshot.folder_name) ||
        !validFilename(snapshot.zip_file) ||
        !Number.isSafeInteger(Number(snapshot.zip_bytes)) || Number(snapshot.zip_bytes) < 1 ||
        !sha256Pattern.test(String(snapshot.zip_sha256 ?? "")) ||
        !Number.isSafeInteger(Number(snapshot.item_count)) || Number(snapshot.item_count) < 1 ||
        !Number.isSafeInteger(Number(snapshot.total_bytes)) || Number(snapshot.total_bytes) < 1) {
      return { valid: false, reason: "invalid_snapshot_lineage" } as const;
    }
    if (snapshotKeys.has(snapshot.snapshot_key)) {
      return { valid: false, reason: "duplicate_snapshot_key" } as const;
    }
    snapshotKeys.add(snapshot.snapshot_key);
    snapshotExpected.set(snapshot.snapshot_key, {
      itemCount: Number(snapshot.item_count),
      totalBytes: Number(snapshot.total_bytes),
      sourceCollection: snapshot.folder_name
    });
    snapshotActual.set(snapshot.snapshot_key, { itemCount: 0, totalBytes: 0 });
  }

  const itemKeys = new Set<string>();
  const sourcePathHashes = new Set<string>();
  let calculatedTotalBytes = 0;
  for (const itemValue of manifest.items) {
    if (!isRecord(itemValue)) {
      return { valid: false, reason: "invalid_manifest_item" } as const;
    }
    const itemKey = itemValue.item_key;
    const snapshotKey = itemValue.snapshot_key;
    const sourcePath = itemValue.source_path;
    const sourcePathHash = String(itemValue.source_path_sha256 ?? "");
    const filename = itemValue.filename;
    const extension = normalizeExtension(itemValue.extension);
    const mimeType = String(itemValue.mime_type ?? "");
    const sizeBytes = Number(itemValue.size_bytes);
    const contentSha256 = String(itemValue.content_sha256 ?? "");
    if (typeof itemKey !== "string" || !sha256Pattern.test(itemKey) || itemKeys.has(itemKey) ||
        !isBoundedString(snapshotKey, 1, 200) || !snapshotKeys.has(snapshotKey) ||
        !validRelativePath(sourcePath, 4_096) ||
        !validRelativePath(itemValue.artifact_relative_path, 4_096) ||
        !isBoundedString(itemValue.folder_hint, 1, 512) ||
        hasControlCharacters(itemValue.folder_hint) ||
        !sha256Pattern.test(sourcePathHash) || sourcePathHashes.has(sourcePathHash) ||
        !validFilename(filename) || !extension ||
        !extensionMatchesMime(extension, mimeType) || !allowedMimeTypes.has(mimeType) ||
        !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxFileBytes ||
        !sha256Pattern.test(contentSha256) ||
        !["form_template", "completed_record", "program_document", "training_material",
          "reference", "evidence", "unknown"].includes(String(itemValue.candidate_kind)) ||
        !["internal", "confidential", "restricted"].includes(String(itemValue.classification)) ||
        typeof itemValue.language !== "string" ||
        !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(itemValue.language) ||
        !Array.isArray(itemValue.proposed_location_codes) ||
        itemValue.proposed_location_codes.length > 32 ||
        !itemValue.proposed_location_codes.every((code) =>
          typeof code === "string" && code.length <= 32 && safeCodePattern.test(code)
        ) ||
        new Set(itemValue.proposed_location_codes).size !== itemValue.proposed_location_codes.length ||
        typeof itemValue.render_verified !== "boolean") {
      return { valid: false, reason: "invalid_manifest_item" } as const;
    }
    const filenameExtension = filename.includes(".")
      ? filename.split(".").pop()?.toLowerCase() ?? ""
      : "";
    const sourceSnapshot = snapshotExpected.get(snapshotKey);
    if (!sourceSnapshot ||
        sourcePath.split("/", 1)[0].trim() !== sourceSnapshot.sourceCollection ||
        filenameExtension !== extension || await sha256Hex(sourcePath) !== sourcePathHash) {
      return { valid: false, reason: "manifest_path_mismatch" } as const;
    }
    if (mimeType === "application/pdf" &&
        (!itemValue.render_verified ||
         !Number.isSafeInteger(Number(itemValue.page_count)) ||
         Number(itemValue.page_count) < 1 ||
         Number(itemValue.page_count) > 20_000)) {
      return { valid: false, reason: "pdf_render_attestation_required" } as const;
    }
    if (mimeType !== "application/pdf" &&
        ((itemValue.page_count !== null && itemValue.page_count !== undefined) ||
         itemValue.render_verified !== false)) {
      return { valid: false, reason: "non_pdf_render_attestation_rejected" } as const;
    }
    itemKeys.add(itemKey);
    sourcePathHashes.add(sourcePathHash);
    calculatedTotalBytes += sizeBytes;
    const snapshotTotals = snapshotActual.get(snapshotKey)!;
    snapshotTotals.itemCount += 1;
    snapshotTotals.totalBytes += sizeBytes;
    if (!Number.isSafeInteger(calculatedTotalBytes)) {
      return { valid: false, reason: "manifest_size_overflow" } as const;
    }
  }

  if (Number(manifest.item_count) !== manifest.items.length ||
      Number((manifest.scan_attestation as JsonObject).scanned_item_count) !== manifest.items.length) {
    return { valid: false, reason: "manifest_count_mismatch" } as const;
  }
  if (Number(manifest.total_bytes) !== calculatedTotalBytes) {
    return { valid: false, reason: "manifest_size_mismatch" } as const;
  }
  for (const [snapshotKey, expected] of snapshotExpected) {
    const actual = snapshotActual.get(snapshotKey)!;
    if (actual.itemCount !== expected.itemCount || actual.totalBytes !== expected.totalBytes) {
      return { valid: false, reason: "snapshot_totals_mismatch" } as const;
    }
  }
  const attestedSnapshotHashes = new Set(
    (manifest.scan_attestation as JsonObject).scanned_snapshot_sha256 as string[]
  );
  const snapshotHashes = new Set(
    snapshotsValue.map((snapshot) => String((snapshot as JsonObject).zip_sha256))
  );
  if (attestedSnapshotHashes.size !== snapshotHashes.size ||
      !Array.from(snapshotHashes).every((hash) => attestedSnapshotHashes.has(hash))) {
    return { valid: false, reason: "snapshot_scan_coverage_mismatch" } as const;
  }
  return {
    valid: true,
    itemCount: manifest.items.length,
    totalSizeBytes: calculatedTotalBytes
  } as const;
}

function normalizeRows(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.items)) return value.items.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function readItemIdentifier(value: JsonObject) {
  return String(value.item_id ?? value.id ?? "");
}

function validateUploadItem(value: JsonObject, allowedStatuses: Set<string>) {
  const itemId = readItemIdentifier(value);
  const companyId = String(value.company_id ?? "");
  const storageBucket = String(value.bucket_id ?? "");
  const quarantinePath = String(value.quarantine_object_path ?? "");
  const finalPath = String(value.final_object_path ?? "");
  const expectedSize = Number(value.expected_size_bytes ?? value.size_bytes);
  const expectedSha = String(value.expected_sha256 ?? value.content_sha256 ?? "");
  const expectedMime = String(value.expected_mime_type ?? value.mime_type ?? "");
  const status = String(value.status ?? "");
  const safePrefix = `${companyId}/quarantine/drive/`;
  const expectedFinalPath = `${companyId}/source-archive/sha256/${expectedSha.slice(0, 2)}/${expectedSha}`;
  return uuidPattern.test(itemId) &&
    uuidPattern.test(companyId) &&
    storageBucket === bucketId &&
    quarantinePath.startsWith(safePrefix) &&
    quarantinePath.length <= 1_024 &&
    !quarantinePath.includes("..") &&
    !quarantinePath.includes("\\") &&
    !hasControlCharacters(quarantinePath) &&
    finalPath === expectedFinalPath &&
    Number.isSafeInteger(expectedSize) && expectedSize >= 1 && expectedSize <= maxFileBytes &&
    sha256Pattern.test(expectedSha) &&
    allowedMimeTypes.has(expectedMime) &&
    allowedStatuses.has(status);
}

async function loadUploadItems(
  serviceClient: ServiceClient,
  itemIds: string[],
  allowedStatuses = new Set(["prepared"])
) {
  const lookupResult = await serviceClient.rpc(
    "get_safety_program_drive_ingest_upload_items",
    { target_item_ids: itemIds }
  );
  if (lookupResult.error) return { error: true, rows: [] as JsonObject[] };
  const rows = normalizeRows(lookupResult.data);
  const requestedIds = new Set(itemIds);
  const returnedIds = new Set(rows.map(readItemIdentifier));
  const valid = rows.length === requestedIds.size &&
    returnedIds.size === requestedIds.size &&
    rows.every((row) =>
      requestedIds.has(readItemIdentifier(row)) && validateUploadItem(row, allowedStatuses)
    );
  return { error: !valid, rows: valid ? rows : [] };
}

function hasBytes(bytes: Uint8Array, sequence: number[], offset = 0) {
  if (offset + sequence.length > bytes.length) return false;
  return sequence.every((value, index) => bytes[offset + index] === value);
}

function containsAscii(bytes: Uint8Array, value: string) {
  const needle = new TextEncoder().encode(value);
  if (!needle.length || needle.length > bytes.length) return false;
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function isDng(bytes: Uint8Array) {
  if (bytes.length < 10) return false;
  const littleEndian = hasBytes(bytes, [0x49, 0x49, 0x2a, 0x00]);
  const bigEndian = hasBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
  if (!littleEndian && !bigEndian) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstIfdOffset = view.getUint32(4, littleEndian);
  if (firstIfdOffset > bytes.length - 2) return false;
  const entryCount = view.getUint16(firstIfdOffset, littleEndian);
  if (entryCount > 4_096 || firstIfdOffset + 2 + entryCount * 12 > bytes.length) return false;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = firstIfdOffset + 2 + index * 12;
    // TIFF tag 50706 (0xC612) is DNGVersion and distinguishes DNG from a
    // generic TIFF container that merely has the same endian/magic prefix.
    if (view.getUint16(entryOffset, littleEndian) === 50_706) return true;
  }
  return false;
}

function isTiffContainer(bytes: Uint8Array) {
  if (bytes.length < 10) return false;
  const littleEndian = hasBytes(bytes, [0x49, 0x49, 0x2a, 0x00]);
  const bigEndian = hasBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
  if (!littleEndian && !bigEndian) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstIfdOffset = view.getUint32(4, littleEndian);
  if (firstIfdOffset > bytes.length - 2) return false;
  const entryCount = view.getUint16(firstIfdOffset, littleEndian);
  return entryCount <= 4_096 && firstIfdOffset + 2 + entryCount * 12 <= bytes.length;
}

function detectMimeType(bytes: Uint8Array, declaredMimeType: string) {
  if (declaredMimeType === "application/pdf") {
    const headerSearch = bytes.subarray(0, Math.min(bytes.length, 1_024));
    return containsAscii(headerSearch, "%PDF-") &&
        containsAscii(bytes.subarray(Math.max(0, bytes.length - 4_096)), "%%EOF")
      ? declaredMimeType
      : null;
  }
  if (declaredMimeType === "image/jpeg") {
    return hasBytes(bytes, [0xff, 0xd8, 0xff]) &&
        bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
      ? declaredMimeType
      : null;
  }
  if (declaredMimeType === "image/png") {
    return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? declaredMimeType
      : null;
  }
  if (declaredMimeType === "image/webp") {
    return hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      ? declaredMimeType
      : null;
  }
  if (declaredMimeType === "image/bmp") {
    return hasBytes(bytes, [0x42, 0x4d]) ? declaredMimeType : null;
  }
  if (declaredMimeType === "image/x-adobe-dng") {
    return isDng(bytes) ? declaredMimeType : null;
  }
  if (declaredMimeType === "image/tiff") {
    return isTiffContainer(bytes) && !isDng(bytes) ? declaredMimeType : null;
  }
  if (declaredMimeType === "application/msword") {
    return hasBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
      ? declaredMimeType
      : null;
  }
  if (declaredMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      declaredMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      declaredMimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const isZip = hasBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      hasBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      hasBytes(bytes, [0x50, 0x4b, 0x07, 0x08]);
    const requiredDirectory = declaredMimeType.includes("wordprocessingml")
      ? "word/"
      : declaredMimeType.includes("spreadsheetml")
      ? "xl/"
      : "ppt/";
    return isZip &&
        containsAscii(bytes, "[Content_Types].xml") &&
        containsAscii(bytes, requiredDirectory) &&
        !containsAscii(bytes, "vbaProject.bin")
      ? declaredMimeType
      : null;
  }
  if (declaredMimeType === "application/json") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      JSON.parse(text);
      return declaredMimeType;
    } catch {
      return null;
    }
  }
  if (declaredMimeType === "text/plain") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code === 0 || (code < 32 && ![9, 10, 12, 13].includes(code))) return null;
      }
      return declaredMimeType;
    } catch {
      return null;
    }
  }
  return null;
}

async function downloadVerifiedObject(
  serviceClient: ServiceClient,
  objectPath: string,
  expectedSize: number,
  expectedSha256: string
) {
  const downloadResult = await serviceClient.storage.from(bucketId).download(objectPath);
  if (downloadResult.error || !downloadResult.data) return { found: false, matches: false };
  if (downloadResult.data.size !== expectedSize) return { found: true, matches: false };
  const bytes = new Uint8Array(await downloadResult.data.arrayBuffer());
  return {
    found: true,
    matches: await sha256Hex(bytes) === expectedSha256
  };
}

async function promoteWithoutOverwrite(
  serviceClient: ServiceClient,
  finalPath: string,
  bytes: Uint8Array,
  mimeType: string,
  expectedSha256: string
) {
  const existing = await downloadVerifiedObject(
    serviceClient,
    finalPath,
    bytes.byteLength,
    expectedSha256
  );
  if (existing.found && !existing.matches) return { ok: false, reason: "immutable_collision" };

  if (!existing.found) {
    const uploadResult = await serviceClient.storage.from(bucketId).upload(finalPath, bytes, {
      cacheControl: "31536000",
      contentType: mimeType,
      metadata: { content_sha256: expectedSha256 },
      upsert: false
    });
    if (uploadResult.error) {
      const racedObject = await downloadVerifiedObject(
        serviceClient,
        finalPath,
        bytes.byteLength,
        expectedSha256
      );
      if (!racedObject.found || !racedObject.matches) {
        return { ok: false, reason: "immutable_promotion_failed" };
      }
    }
  }

  const finalVerification = await downloadVerifiedObject(
    serviceClient,
    finalPath,
    bytes.byteLength,
    expectedSha256
  );
  if (!finalVerification.found || !finalVerification.matches) {
    return { ok: false, reason: "immutable_verification_failed" };
  }
  return { ok: true, reason: existing.found ? "deduplicated" : "promoted" };
}

async function handlePrepare(
  serviceClient: ServiceClient,
  body: JsonObject,
  requestId: string
) {
  const companyId = String(body.company_id ?? "");
  const manifest = body.manifest;
  if (!isRecord(manifest)) {
    return jsonResponse(400, { error: "invalid_prepare_request", request_id: requestId });
  }
  const manifestSha256 = String(manifest.manifest_sha256 ?? "");
  const scanAttestation = manifest.scan_attestation;
  if (!uuidPattern.test(companyId) || companyId !== manifest.company_id ||
      !sha256Pattern.test(manifestSha256) ||
      (body.manifest_sha256 !== undefined && body.manifest_sha256 !== manifestSha256) ||
      (body.scan_attestation !== undefined &&
       !sameCanonicalJson(body.scan_attestation, scanAttestation)) ||
      !validateScanAttestation(scanAttestation)) {
    return jsonResponse(400, { error: "invalid_prepare_request", request_id: requestId });
  }
  const validation = await validateManifest(manifest);
  if (!validation.valid) {
    return jsonResponse(400, { error: validation.reason, request_id: requestId });
  }
  let calculatedManifestSha256 = "";
  try {
    const manifestWithoutDigest = { ...manifest };
    delete manifestWithoutDigest.manifest_sha256;
    calculatedManifestSha256 = await sha256Hex(canonicalJson(manifestWithoutDigest));
  } catch {
    return jsonResponse(400, { error: "invalid_manifest", request_id: requestId });
  }
  if (calculatedManifestSha256 !== manifestSha256) {
    return jsonResponse(400, { error: "manifest_hash_mismatch", request_id: requestId });
  }

  const prepareResult = await serviceClient.rpc("prepare_safety_program_drive_ingest", {
    target_company_id: companyId,
    target_manifest_sha256: manifestSha256,
    target_manifest: manifest,
    target_scan_attestation: scanAttestation
  });
  if (prepareResult.error || !prepareResult.data) {
    return jsonResponse(409, { error: "prepare_rejected", request_id: requestId });
  }
  return jsonResponse(200, {
    request_id: requestId,
    manifest_sha256: manifestSha256,
    item_count: validation.itemCount,
    total_size_bytes: validation.totalSizeBytes,
    preparation: prepareResult.data
  });
}

async function handleSignedUploadUrls(
  serviceClient: ServiceClient,
  body: JsonObject,
  requestId: string
) {
  if (!Array.isArray(body.item_ids) || body.item_ids.length < 1 ||
      body.item_ids.length > maxUploadUrlBatch ||
      !body.item_ids.every((value) => typeof value === "string" && uuidPattern.test(value))) {
    return jsonResponse(400, { error: "invalid_item_ids", request_id: requestId });
  }
  const itemIds = Array.from(new Set(body.item_ids as string[]));
  if (itemIds.length !== body.item_ids.length) {
    return jsonResponse(400, { error: "duplicate_item_id", request_id: requestId });
  }
  const lookup = await loadUploadItems(serviceClient, itemIds);
  if (lookup.error) {
    return jsonResponse(403, { error: "upload_batch_denied", request_id: requestId });
  }

  const expiresAt = new Date(Date.now() + signedUploadLifetimeSeconds * 1000).toISOString();
  const uploads: Array<Record<string, unknown>> = [];
  for (const row of lookup.rows) {
    const signedResult = await serviceClient.storage.from(bucketId).createSignedUploadUrl(
      String(row.quarantine_object_path),
      { upsert: false }
    );
    if (signedResult.error || !signedResult.data?.signedUrl || !signedResult.data?.token) {
      return jsonResponse(500, { error: "upload_signing_failed", request_id: requestId });
    }
    uploads.push({
      item_id: readItemIdentifier(row),
      signed_url: signedResult.data.signedUrl,
      upload_token: signedResult.data.token,
      expires_at: expiresAt,
      mime_type: row.expected_mime_type ?? row.mime_type,
      size_bytes: row.expected_size_bytes ?? row.size_bytes,
      content_sha256: row.expected_sha256 ?? row.content_sha256
    });
  }
  return jsonResponse(200, { request_id: requestId, uploads });
}

async function handleStatus(
  serviceClient: ServiceClient,
  body: JsonObject,
  requestId: string
) {
  const runId = String(body.run_id ?? "");
  if (!uuidPattern.test(runId)) {
    return jsonResponse(400, { error: "invalid_run_id", request_id: requestId });
  }
  const statusResult = await serviceClient.rpc("get_safety_program_drive_ingest_status", {
    target_run_id: runId
  });
  if (statusResult.error || !statusResult.data) {
    return jsonResponse(403, { error: "status_denied", request_id: requestId });
  }
  return jsonResponse(200, { request_id: requestId, ingest: statusResult.data });
}

async function handleVerifyCommit(
  serviceClient: ServiceClient,
  body: JsonObject,
  requestId: string
) {
  const itemId = String(body.item_id ?? "");
  if (!uuidPattern.test(itemId)) {
    return jsonResponse(400, { error: "invalid_item_id", request_id: requestId });
  }
  const lookup = await loadUploadItems(
    serviceClient,
    [itemId],
    new Set(["prepared", "committed"])
  );
  if (lookup.error || lookup.rows.length !== 1) {
    return jsonResponse(403, { error: "verification_denied", request_id: requestId });
  }
  const row = lookup.rows[0];
  const companyId = String(row.company_id);
  const quarantinePath = String(row.quarantine_object_path);
  const expectedSize = Number(row.expected_size_bytes ?? row.size_bytes);
  const expectedSha256 = String(row.expected_sha256 ?? row.content_sha256);
  const expectedMimeType = String(row.expected_mime_type ?? row.mime_type);

  if (row.status === "committed") {
    const replayResult = await serviceClient.rpc("commit_safety_program_drive_ingest_item", {
      target_item_id: itemId,
      verified_size_bytes: expectedSize,
      verified_sha256: expectedSha256,
      detected_mime_type: expectedMimeType,
      final_object_path: String(row.final_object_path)
    });
    if (replayResult.error || !replayResult.data) {
      return jsonResponse(409, { error: "commit_replay_rejected", request_id: requestId });
    }
    const replayCleanup = await serviceClient.storage.from(bucketId).remove([quarantinePath]);
    const replayed = normalizeRows(replayResult.data)[0] ?? {};
    return jsonResponse(200, {
      request_id: requestId,
      item_id: itemId,
      candidate_id: replayed.candidate_id ?? replayed.candidateId ?? null,
      status: "committed",
      promotion: "already_committed",
      size_bytes: expectedSize,
      content_sha256: expectedSha256,
      mime_type: expectedMimeType,
      quarantine_cleanup_pending: Boolean(replayCleanup.error)
    });
  }

  const downloadResult = await serviceClient.storage.from(bucketId).download(quarantinePath);
  if (downloadResult.error || !downloadResult.data) {
    return jsonResponse(409, { error: "quarantine_object_missing", request_id: requestId });
  }
  if (downloadResult.data.size !== expectedSize) {
    return jsonResponse(422, { error: "size_verification_failed", request_id: requestId });
  }
  const bytes = new Uint8Array(await downloadResult.data.arrayBuffer());
  if (bytes.byteLength !== expectedSize || await sha256Hex(bytes) !== expectedSha256) {
    return jsonResponse(422, { error: "hash_verification_failed", request_id: requestId });
  }
  const detectedMimeType = detectMimeType(bytes, expectedMimeType);
  if (!detectedMimeType) {
    return jsonResponse(422, { error: "mime_verification_failed", request_id: requestId });
  }

  const finalObjectPath = `${companyId}/source-archive/sha256/${expectedSha256.slice(0, 2)}/${expectedSha256}`;
  const promotion = await promoteWithoutOverwrite(
    serviceClient,
    finalObjectPath,
    bytes,
    detectedMimeType,
    expectedSha256
  );
  if (!promotion.ok) {
    return jsonResponse(409, { error: promotion.reason, request_id: requestId });
  }

  const commitResult = await serviceClient.rpc("commit_safety_program_drive_ingest_item", {
    target_item_id: itemId,
    verified_size_bytes: expectedSize,
    verified_sha256: expectedSha256,
    detected_mime_type: detectedMimeType,
    final_object_path: finalObjectPath
  });
  if (commitResult.error || !commitResult.data) {
    return jsonResponse(409, { error: "commit_rejected", request_id: requestId });
  }
  // Storage and Postgres cannot share one transaction. Delete quarantine only
  // after the transactional commit succeeds; a failed commit remains safely
  // resumable against both the quarantine object and content-addressed copy.
  const quarantineRemoval = await serviceClient.storage.from(bucketId).remove([quarantinePath]);
  const committed = normalizeRows(commitResult.data)[0] ?? {};
  return jsonResponse(200, {
    request_id: requestId,
    item_id: itemId,
    candidate_id: committed.candidate_id ?? committed.candidateId ?? null,
    status: "committed",
    promotion: promotion.reason,
    size_bytes: expectedSize,
    content_sha256: expectedSha256,
    mime_type: detectedMimeType,
    quarantine_cleanup_pending: Boolean(quarantineRemoval.error)
  });
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  if (request.headers.has("origin")) {
    return jsonResponse(403, { error: "browser_requests_not_allowed", request_id: requestId });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed", request_id: requestId });
  }
  if (!supabaseUrl || !serviceKey || importSecret.length < 32) {
    return jsonResponse(503, { error: "service_not_configured", request_id: requestId });
  }
  const suppliedSecret = request.headers.get("x-safetyops-import-secret") ?? "";
  if (suppliedSecret.length > 512 || !timingSafeStringEqual(suppliedSecret, importSecret)) {
    return jsonResponse(401, { error: "authentication_required", request_id: requestId });
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return jsonResponse(415, { error: "content_encoding_not_supported", request_id: requestId });
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonResponse(415, { error: "json_required", request_id: requestId });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
    return jsonResponse(413, { error: "request_too_large", request_id: requestId });
  }

  let body: JsonObject;
  try {
    const requestText = await request.text();
    if (new TextEncoder().encode(requestText).byteLength > maxRequestBytes) {
      return jsonResponse(413, { error: "request_too_large", request_id: requestId });
    }
    const parsed = JSON.parse(requestText);
    if (!isRecord(parsed)) throw new Error("invalid_json");
    body = parsed;
  } catch {
    return jsonResponse(400, { error: "invalid_json", request_id: requestId });
  }

  // deno-lint-ignore no-explicit-any
  const serviceClient = createClient<any>(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  try {
    if (body.action === "prepare") {
      return await handlePrepare(serviceClient, body, requestId);
    }
    if (body.action === "signed_upload_urls") {
      return await handleSignedUploadUrls(serviceClient, body, requestId);
    }
    if (body.action === "verify_commit") {
      return await handleVerifyCommit(serviceClient, body, requestId);
    }
    if (body.action === "status" || body.action === "resume_status") {
      return await handleStatus(serviceClient, body, requestId);
    }
    return jsonResponse(400, { error: "invalid_action", request_id: requestId });
  } catch {
    return jsonResponse(500, { error: "internal_error", request_id: requestId });
  }
});
