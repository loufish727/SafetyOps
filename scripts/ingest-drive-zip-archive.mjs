#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const SIGNED_URL_BATCH_SIZE = 50;

const MIME_BY_EXTENSION = Object.freeze({
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".dng": "image/x-adobe-dng",
});

function usage() {
  return `Usage:
  node scripts/ingest-drive-zip-archive.mjs <manifest.json> \\
    --artifact-root <snapshot-key>=<directory> [--artifact-root ...] [--plan-json]

Apply the verified archive through the dedicated server-side ingest function:
  SAFETYOPS_DRIVE_INGEST_URL=https://<project-ref>.supabase.co/functions/v1/drive-safety-ingest \\
  SAFETYOPS_DRIVE_IMPORT_SECRET=... \\
  SAFETYOPS_SUPABASE_PUBLISHABLE_KEY=... \\
  node scripts/ingest-drive-zip-archive.mjs <manifest.json> \\
    --artifact-root forms-appendices=<directory> \\
    --artifact-root spanish-translations=<directory> \\
    --apply --confirm-company <company-uuid>

Options:
  --artifact-root <key>=<dir>  Required once for every manifest snapshot.
  --plan-json                  Print the verified dry-run plan as JSON.
  --apply                      Prepare, upload, independently verify, and commit.
  --confirm-company <uuid>     Required with --apply; must match the manifest.
  --concurrency <1-8>          Concurrent item pipelines (default: 4).
  --help                       Show this help.

Dry-run is the default. Secrets are accepted only through environment variables.
This client never accepts or uses a Supabase service-role or secret API key.`;
}

function parseArguments(argv) {
  const options = {
    manifestPath: null,
    artifactRoots: new Map(),
    planJson: false,
    apply: false,
    confirmCompany: null,
    concurrency: DEFAULT_CONCURRENCY,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact-root") {
      const mapping = argv[++index];
      const separator = mapping?.indexOf("=") ?? -1;
      if (separator < 1 || separator === mapping.length - 1) {
        throw new Error("--artifact-root requires <snapshot-key>=<directory>");
      }
      const snapshotKey = mapping.slice(0, separator);
      const root = mapping.slice(separator + 1);
      if (options.artifactRoots.has(snapshotKey)) {
        throw new Error(`duplicate artifact root for snapshot ${snapshotKey}`);
      }
      options.artifactRoots.set(snapshotKey, root);
    } else if (argument === "--confirm-company") {
      options.confirmCompany = argv[++index];
      if (!options.confirmCompany) {
        throw new Error("--confirm-company requires a UUID");
      }
    } else if (argument === "--concurrency") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 8) {
        throw new Error("--concurrency must be an integer from 1 through 8");
      }
      options.concurrency = value;
    } else if (argument === "--plan-json") {
      options.planJson = true;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    } else if (options.manifestPath) {
      throw new Error("only one manifest path may be provided");
    } else {
      options.manifestPath = argument;
    }
  }
  return options;
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForCanonicalJson(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), "utf8"));
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validSourceCollection(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    value.trim() === value &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !hasControlCharacters(value);
}

function safeArtifactPath(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length < 1 ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error("manifest contains an unsafe staged artifact path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("manifest contains an unsafe staged artifact path");
  }
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(absoluteRoot, ...segments);
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("staged artifact resolves outside its snapshot root");
  }
  return absoluteFile;
}

function hasPrefix(bytes, expected) {
  return expected.every((value, index) => bytes[index] === value);
}

function containsAscii(bytes, value) {
  return bytes.indexOf(Buffer.from(value, "ascii")) >= 0;
}

function isDng(bytes) {
  if (bytes.length < 10) return false;
  const littleEndian = hasPrefix(bytes, [0x49, 0x49, 0x2a, 0x00]);
  const bigEndian = hasPrefix(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
  if (!littleEndian && !bigEndian) return false;
  const read16 = (offset) =>
    littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const read32 = (offset) =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const firstIfd = read32(4);
  if (firstIfd < 8 || firstIfd + 2 > bytes.length) return false;
  const entryCount = read16(firstIfd);
  if (entryCount > 8192 || firstIfd + 2 + entryCount * 12 > bytes.length) return false;
  for (let index = 0; index < entryCount; index += 1) {
    const tag = read16(firstIfd + 2 + index * 12);
    if (tag === 0xc612 || tag === 0xc613) return true;
  }
  return false;
}

function verifyMagic(bytes, mimeType) {
  if (mimeType === "application/pdf") {
    return (
      bytes.subarray(0, Math.min(bytes.length, 1024)).includes(Buffer.from("%PDF-")) &&
      bytes.subarray(Math.max(0, bytes.length - 4096)).includes(Buffer.from("%%EOF"))
    );
  }
  if (mimeType === "application/msword") {
    return hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    const zipMagic =
      hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08]);
    const requiredMember = mimeType.includes("wordprocessingml")
      ? "word/document.xml"
      : mimeType.includes("spreadsheetml")
        ? "xl/workbook.xml"
        : "ppt/presentation.xml";
    return (
      zipMagic &&
      containsAscii(bytes, "[Content_Types].xml") &&
      containsAscii(bytes, requiredMember) &&
      !containsAscii(bytes, "vbaProject.bin")
    );
  }
  if (mimeType === "image/jpeg") {
    return (
      hasPrefix(bytes, [0xff, 0xd8, 0xff]) &&
      bytes.length >= 4 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9
    );
  }
  if (mimeType === "image/png") {
    return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mimeType === "image/x-adobe-dng") return isDng(bytes);
  return false;
}

function validateManifestStructure(manifest, artifactRoots) {
  if (!isRecord(manifest) || manifest.schema_version !== 1) {
    throw new Error("unsupported archive manifest schema");
  }
  if (!UUID_RE.test(String(manifest.manifest_id ?? ""))) {
    throw new Error("manifest_id must be a UUID");
  }
  if (!UUID_RE.test(String(manifest.company_id ?? ""))) {
    throw new Error("company_id must be a UUID");
  }
  if (!SHA256_RE.test(String(manifest.manifest_sha256 ?? ""))) {
    throw new Error("manifest_sha256 must be a lowercase SHA-256 digest");
  }
  const unsignedManifest = { ...manifest };
  delete unsignedManifest.manifest_sha256;
  const computedManifestSha256 = sha256Text(canonicalJson(unsignedManifest));
  if (computedManifestSha256 !== manifest.manifest_sha256) {
    throw new Error("manifest canonical SHA-256 does not match its frozen assertion");
  }
  if (
    manifest.source?.provider !== "google_drive" ||
    manifest.source?.identity_kind !== "folder_zip_path_snapshot" ||
    manifest.snapshot?.complete !== true ||
    !Array.isArray(manifest.snapshot?.snapshots) ||
    !Array.isArray(manifest.items)
  ) {
    throw new Error("manifest is not a complete Google Drive ZIP snapshot");
  }
  const snapshotKeys = new Set();
  const sourceCollections = new Map();
  for (const snapshot of manifest.snapshot.snapshots) {
    if (
      !isRecord(snapshot) ||
      typeof snapshot.snapshot_key !== "string" ||
      snapshotKeys.has(snapshot.snapshot_key) ||
      !validSourceCollection(snapshot.folder_name) ||
      !SHA256_RE.test(String(snapshot.zip_sha256 ?? ""))
    ) {
      throw new Error("manifest has invalid or duplicate snapshot lineage");
    }
    snapshotKeys.add(snapshot.snapshot_key);
    sourceCollections.set(snapshot.snapshot_key, snapshot.folder_name);
    if (!artifactRoots.has(snapshot.snapshot_key)) {
      throw new Error(`missing --artifact-root for snapshot ${snapshot.snapshot_key}`);
    }
  }
  for (const suppliedKey of artifactRoots.keys()) {
    if (!snapshotKeys.has(suppliedKey)) {
      throw new Error(`artifact root does not match a manifest snapshot: ${suppliedKey}`);
    }
  }
  if (
    manifest.scan_attestation?.result !== "clean" ||
    Number(manifest.scan_attestation?.scanned_item_count) !== manifest.items.length
  ) {
    throw new Error("a clean scan attestation covering every item is required");
  }
  if (Number(manifest.item_count) !== manifest.items.length) {
    throw new Error("manifest item_count does not match its items");
  }
  return { snapshotKeys, sourceCollections, computedManifestSha256 };
}

async function verifyArtifacts(manifest, artifactRoots) {
  const { sourceCollections } = validateManifestStructure(manifest, artifactRoots);
  const itemKeys = new Set();
  const sourcePathHashes = new Set();
  const verifiedByItemKey = new Map();
  let totalBytes = 0;
  let pdfCount = 0;
  let pdfPages = 0;

  for (let index = 0; index < manifest.items.length; index += 1) {
    const item = manifest.items[index];
    if (!isRecord(item) || !SHA256_RE.test(String(item.item_key ?? ""))) {
      throw new Error(`manifest item ${index + 1} has an invalid item key`);
    }
    if (itemKeys.has(item.item_key)) {
      throw new Error(`manifest item ${index + 1} duplicates an item key`);
    }
    itemKeys.add(item.item_key);
    if (
      typeof item.source_path !== "string" ||
      sha256Text(item.source_path) !== item.source_path_sha256 ||
      sourcePathHashes.has(item.source_path_sha256)
    ) {
      throw new Error(`manifest item ${index + 1} has an invalid source-path fingerprint`);
    }
    sourcePathHashes.add(item.source_path_sha256);
    const sourceCollection = sourceCollections.get(item.snapshot_key);
    if (
      !sourceCollection ||
      item.source_path.split("/", 1)[0].trim() !== sourceCollection
    ) {
      throw new Error(`manifest item ${index + 1} source path does not match its snapshot folder`);
    }
    const allowedMimes = item.extension === ".dng"
      ? new Set(["image/x-adobe-dng", "image/jpeg"])
      : new Set([MIME_BY_EXTENSION[item.extension]]);
    if (!allowedMimes.has(item.mime_type)) {
      throw new Error(`manifest item ${index + 1} has an unsupported extension/MIME pair`);
    }
    if (
      !Number.isSafeInteger(Number(item.size_bytes)) ||
      Number(item.size_bytes) < 1 ||
      Number(item.size_bytes) > MAX_FILE_BYTES ||
      !SHA256_RE.test(String(item.content_sha256 ?? ""))
    ) {
      throw new Error(`manifest item ${index + 1} has invalid byte/hash assertions`);
    }
    if (item.mime_type === "application/pdf") {
      if (!item.render_verified || !Number.isInteger(item.page_count) || item.page_count < 1) {
        throw new Error(`PDF item ${index + 1} lacks full-document render verification`);
      }
      pdfCount += 1;
      pdfPages += item.page_count;
    } else if (item.page_count !== null || item.render_verified !== false) {
      throw new Error(`non-PDF item ${index + 1} contains invalid PDF verification fields`);
    }

    const root = artifactRoots.get(item.snapshot_key);
    if (!root) throw new Error(`item ${index + 1} references an unknown snapshot`);
    const absoluteFile = safeArtifactPath(root, item.artifact_relative_path);
    const fileStats = await stat(absoluteFile);
    if (!fileStats.isFile() || fileStats.size !== item.size_bytes) {
      throw new Error(`staged item ${index + 1} does not match its byte assertion`);
    }
    const actualSha256 = await sha256File(absoluteFile);
    if (actualSha256 !== item.content_sha256) {
      throw new Error(`staged item ${index + 1} does not match its SHA-256 assertion`);
    }
    const bytes = await readFile(absoluteFile);
    if (!verifyMagic(bytes, item.mime_type)) {
      throw new Error(`staged item ${index + 1} failed file-signature verification`);
    }
    verifiedByItemKey.set(item.item_key, { item, absoluteFile });
    totalBytes += item.size_bytes;
    if ((index + 1) % 50 === 0 || index + 1 === manifest.items.length) {
      console.error(`Verified source bytes ${index + 1}/${manifest.items.length}`);
    }
  }

  if (totalBytes !== Number(manifest.total_bytes)) {
    throw new Error("verified source byte total does not match the manifest");
  }
  return { verifiedByItemKey, totalBytes, pdfCount, pdfPages };
}

function buildPlan(manifest, verification) {
  const kindCounts = Object.fromEntries(
    [...new Set(manifest.items.map((item) => item.candidate_kind))]
      .sort()
      .map((kind) => [
        kind,
        manifest.items.filter((item) => item.candidate_kind === kind).length,
      ]),
  );
  return {
    mode: "dry-run",
    protocolVersion: "1.0",
    manifestId: manifest.manifest_id,
    manifestSha256: manifest.manifest_sha256,
    companyId: manifest.company_id,
    snapshotCount: manifest.snapshot.snapshots.length,
    counts: {
      items: manifest.items.length,
      bytes: verification.totalBytes,
      pdfs: verification.pdfCount,
      pdfPages: verification.pdfPages,
      uniqueContentHashes: new Set(manifest.items.map((item) => item.content_sha256)).size,
      candidateKinds: kindCounts,
    },
    assertions: [
      "every staged file byte count and SHA-256 matches the frozen manifest",
      "every staged file signature matches its declared MIME type",
      "every PDF has a positive full-document page count and render attestation",
      "the clean malware-scan attestation covers every snapshot and item",
      "server commit remains pending until quarantine bytes are re-downloaded and verified",
    ],
  };
}

async function requestJson(endpoint, secret, body, timeoutMs = 120_000) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-safetyops-import-secret": secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { error: "invalid_json_response" };
  }
  if (!response.ok) {
    throw new Error(
      `ingestion service rejected ${body.action}: HTTP ${response.status} ${
        responseBody.error || "request_failed"
      }`,
    );
  }
  return responseBody;
}

function validateEndpoint(value) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(".supabase.co") ||
    !endpoint.pathname.endsWith("/functions/v1/drive-safety-ingest") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("SAFETYOPS_DRIVE_INGEST_URL is not an approved Supabase function URL");
  }
  return endpoint;
}

function normalizePreparation(response, manifest) {
  const preparation = response?.preparation;
  if (
    !isRecord(preparation) ||
    !UUID_RE.test(String(preparation.runId ?? "")) ||
    preparation.companyId !== manifest.company_id ||
    preparation.manifestId !== manifest.manifest_id ||
    preparation.manifestSha256 !== manifest.manifest_sha256 ||
    Number(preparation.itemCount) !== manifest.items.length ||
    Number(preparation.totalSizeBytes) !== Number(manifest.total_bytes) ||
    !Array.isArray(preparation.items)
  ) {
    throw new Error("prepare response does not match the frozen manifest");
  }
  const itemIds = new Set();
  const itemKeys = new Set();
  for (const item of preparation.items) {
    if (
      !isRecord(item) ||
      !UUID_RE.test(String(item.itemId ?? "")) ||
      !SHA256_RE.test(String(item.itemKey ?? "")) ||
      !["prepared", "committed"].includes(item.status) ||
      itemIds.has(item.itemId) ||
      itemKeys.has(item.itemKey)
    ) {
      throw new Error("prepare response contains an invalid or duplicate item");
    }
    itemIds.add(item.itemId);
    itemKeys.add(item.itemKey);
  }
  if (itemKeys.size !== manifest.items.length) {
    throw new Error("prepare response omitted manifest items");
  }
  return preparation;
}

function validateSignedUpload(upload, preparedItem, endpoint) {
  if (
    !isRecord(upload) ||
    upload.item_id !== preparedItem.itemId ||
    upload.content_sha256 !== preparedItem.contentSha256 ||
    Number(upload.size_bytes) !== Number(preparedItem.sizeBytes) ||
    upload.mime_type !== preparedItem.mimeType
  ) {
    throw new Error("signed upload intent does not match the prepared item");
  }
  const signedUrl = new URL(upload.signed_url);
  if (
    signedUrl.protocol !== "https:" ||
    signedUrl.hostname !== endpoint.hostname ||
    !signedUrl.pathname.startsWith("/storage/v1/object/upload/sign/safety-program-private/") ||
    !signedUrl.searchParams.get("token") ||
    signedUrl.username ||
    signedUrl.password ||
    signedUrl.hash
  ) {
    throw new Error("ingestion service returned an invalid signed upload URL");
  }
  return signedUrl;
}

async function uploadSignedObject(signedUrl, verifiedItem, publishableKey) {
  const bytes = await readFile(verifiedItem.absoluteFile);
  const response = await fetch(signedUrl, {
    method: "PUT",
    headers: {
      "cache-control": "max-age=0",
      "content-type": verifiedItem.item.mime_type,
      "x-upsert": "false",
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
    },
    body: bytes,
    signal: AbortSignal.timeout(300_000),
  });
  if (response.ok) return { uploaded: true, status: response.status };
  // A replay may already have the exact immutable bytes in quarantine. The
  // server-side verify step below decides whether that existing object is safe.
  if ([400, 409].includes(response.status)) {
    return { uploaded: false, status: response.status };
  }
  throw new Error(`signed upload failed with HTTP ${response.status}`);
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(workers);
}

async function applyArchive(manifest, verification, options) {
  const endpointValue = process.env.SAFETYOPS_DRIVE_INGEST_URL;
  const secret = process.env.SAFETYOPS_DRIVE_IMPORT_SECRET;
  const publishableKey = process.env.SAFETYOPS_SUPABASE_PUBLISHABLE_KEY;
  if (
    !endpointValue ||
    !secret ||
    secret.length < 32 ||
    !publishableKey ||
    !publishableKey.startsWith("sb_publishable_")
  ) {
    throw new Error(
      "ingest URL, a 32+ character import secret, and a non-secret Supabase publishable key are required",
    );
  }
  const endpoint = validateEndpoint(endpointValue);
  const prepareResponse = await requestJson(endpoint.href, secret, {
    action: "prepare",
    company_id: manifest.company_id,
    manifest_sha256: manifest.manifest_sha256,
    manifest,
    scan_attestation: manifest.scan_attestation,
  });
  const preparation = normalizePreparation(prepareResponse, manifest);
  const preparedItems = preparation.items.filter((item) => item.status === "prepared");
  const resumedCommittedItems = preparation.items.filter((item) => item.status === "committed");
  const alreadyCommitted = resumedCommittedItems.length;
  console.error(
    `Prepared run ${preparation.runId}: ${preparedItems.length} pending, ${alreadyCommitted} already committed`,
  );

  // A prior request can commit Postgres and time out before deleting its
  // quarantine copy. Replaying committed items is cheap and retries that
  // cleanup without rewriting the immutable final object or database record.
  if (resumedCommittedItems.length) {
    let cleaned = 0;
    await runWithConcurrency(
      resumedCommittedItems,
      options.concurrency,
      async (committedItem) => {
        const replayed = await requestJson(
          endpoint.href,
          secret,
          { action: "verify_commit", item_id: committedItem.itemId },
          300_000,
        );
        if (
          replayed.status !== "committed" ||
          replayed.item_id !== committedItem.itemId ||
          replayed.content_sha256 !== committedItem.contentSha256 ||
          Number(replayed.size_bytes) !== Number(committedItem.sizeBytes) ||
          replayed.mime_type !== committedItem.mimeType ||
          replayed.quarantine_cleanup_pending === true
        ) {
          throw new Error("committed-item replay or quarantine cleanup did not verify");
        }
        cleaned += 1;
        if (cleaned % 25 === 0 || cleaned === resumedCommittedItems.length) {
          console.error(`Verified committed originals ${cleaned}/${resumedCommittedItems.length}`);
        }
      },
    );
  }

  let completedThisRun = 0;
  for (let offset = 0; offset < preparedItems.length; offset += SIGNED_URL_BATCH_SIZE) {
    const batch = preparedItems.slice(offset, offset + SIGNED_URL_BATCH_SIZE);
    const signedResponse = await requestJson(endpoint.href, secret, {
      action: "signed_upload_urls",
      item_ids: batch.map((item) => item.itemId),
    });
    if (!Array.isArray(signedResponse.uploads) || signedResponse.uploads.length !== batch.length) {
      throw new Error("signed upload response omitted prepared items");
    }
    const uploadByItemId = new Map(
      signedResponse.uploads.map((upload) => [upload.item_id, upload]),
    );

    await runWithConcurrency(batch, options.concurrency, async (preparedItem) => {
      const verifiedItem = verification.verifiedByItemKey.get(preparedItem.itemKey);
      const upload = uploadByItemId.get(preparedItem.itemId);
      if (!verifiedItem || !upload) {
        throw new Error("prepared item cannot be matched to locally verified bytes");
      }
      const signedUrl = validateSignedUpload(upload, preparedItem, endpoint);
      const uploadResult = await uploadSignedObject(signedUrl, verifiedItem, publishableKey);
      try {
        const committed = await requestJson(
          endpoint.href,
          secret,
          { action: "verify_commit", item_id: preparedItem.itemId },
          300_000,
        );
        if (
          committed.status !== "committed" ||
          committed.item_id !== preparedItem.itemId ||
          committed.content_sha256 !== preparedItem.contentSha256 ||
          Number(committed.size_bytes) !== Number(preparedItem.sizeBytes) ||
          committed.mime_type !== preparedItem.mimeType ||
          committed.quarantine_cleanup_pending === true
        ) {
          throw new Error("commit response does not match the prepared item");
        }
      } catch (error) {
        if (!uploadResult.uploaded) {
          throw new Error(
            `existing quarantine object failed server verification after upload HTTP ${uploadResult.status}: ${error.message}`,
          );
        }
        throw error;
      }
      completedThisRun += 1;
      const completedTotal = alreadyCommitted + completedThisRun;
      if (completedThisRun % 10 === 0 || completedThisRun === preparedItems.length) {
        console.error(`Committed originals ${completedTotal}/${preparation.items.length}`);
      }
    });
  }

  const replayResponse = await requestJson(endpoint.href, secret, {
    action: "prepare",
    company_id: manifest.company_id,
    manifest_sha256: manifest.manifest_sha256,
    manifest,
    scan_attestation: manifest.scan_attestation,
  });
  const finalPreparation = normalizePreparation(replayResponse, manifest);
  if (
    finalPreparation.status !== "committed" ||
    finalPreparation.items.some((item) => item.status !== "committed")
  ) {
    throw new Error("archive run did not reach a fully committed state");
  }
  return {
    runId: finalPreparation.runId,
    status: finalPreparation.status,
    committedItems: finalPreparation.items.length,
    committedThisRun: completedThisRun,
    resumedItems: alreadyCommitted,
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.manifestPath || options.artifactRoots.size < 1) {
    console.error("manifest path and at least one --artifact-root are required");
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  const verification = await verifyArtifacts(manifest, options.artifactRoots);
  const plan = buildPlan(manifest, verification);
  if (!options.apply) {
    if (options.planJson) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`DRY RUN manifest=${plan.manifestId}`);
      console.log(`company=${plan.companyId}`);
      console.log(`manifestSha256=${plan.manifestSha256}`);
      console.log(
        `items=${plan.counts.items} bytes=${plan.counts.bytes} pdfs=${plan.counts.pdfs} pdfPages=${plan.counts.pdfPages}`,
      );
      for (const assertion of plan.assertions) console.log(`- ${assertion}`);
    }
    return;
  }

  if (
    !options.confirmCompany ||
    options.confirmCompany.toLowerCase() !== manifest.company_id.toLowerCase()
  ) {
    throw new Error("--confirm-company must exactly match the manifest company ID");
  }
  const result = await applyArchive(manifest, verification, options);
  console.log(`COMMITTED run=${result.runId}`);
  console.log(
    `items=${result.committedItems} committedThisRun=${result.committedThisRun} resumed=${result.resumedItems}`,
  );
}

await main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
