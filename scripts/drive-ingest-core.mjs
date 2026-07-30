import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_SCHEMA_VERSION = "1.0.0";
export const GOOGLE_DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const PDF_MIME = "application/pdf";
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const DEFAULT_MIME_MAPPINGS = Object.freeze({
  [PDF_MIME]: Object.freeze([
    Object.freeze({
      role: "canonical",
      mimeType: PDF_MIME,
      extension: "pdf",
      exportMethod: "download",
    }),
  ]),
  [GOOGLE_DOC_MIME]: Object.freeze([
    Object.freeze({
      role: "canonical",
      mimeType: PDF_MIME,
      extension: "pdf",
      exportMethod: "google-export",
    }),
    Object.freeze({
      role: "editable",
      mimeType: DOCX_MIME,
      extension: "docx",
      exportMethod: "google-export",
    }),
  ]),
  [GOOGLE_SHEET_MIME]: Object.freeze([
    Object.freeze({
      role: "canonical",
      mimeType: PDF_MIME,
      extension: "pdf",
      exportMethod: "google-export",
    }),
    Object.freeze({
      role: "editable",
      mimeType: XLSX_MIME,
      extension: "xlsx",
      exportMethod: "google-export",
    }),
  ]),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LOCATION_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), "utf8"));
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

export function canonicalJson(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForCanonicalJson(value[key])]),
    );
  }

  return value;
}

export function manifestSha256(manifest) {
  const { manifestSha256: _ignored, ...unsignedManifest } = manifest;
  return sha256Text(canonicalJson(unsignedManifest));
}

export function normalizeDisplaySegment(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || "_unnamed";
}

export function pathKeySegment(name, providerItemId) {
  const slug =
    normalizeDisplaySegment(name)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item";

  return `${slug}--${sha256Text(providerItemId).slice(0, 12)}`;
}

export function derivePathFields(pathSegments, pathIds) {
  if (!Array.isArray(pathSegments) || !Array.isArray(pathIds)) {
    throw new TypeError("pathSegments and pathIds must be arrays");
  }
  if (pathSegments.length === 0 || pathSegments.length !== pathIds.length) {
    throw new Error("pathSegments and pathIds must be nonempty and equal length");
  }

  const normalizedSegments = pathSegments.map(normalizeDisplaySegment);
  return {
    pathSegments: normalizedSegments,
    displayPath: normalizedSegments.join("/"),
    pathKey: normalizedSegments
      .map((segment, index) => pathKeySegment(segment, pathIds[index]))
      .join("/"),
  };
}

export function providerItemStorageKey(providerItemId) {
  return sha256Text(providerItemId).slice(0, 32);
}

export function deriveStorageObjectKey({
  companyId,
  connectionKey,
  providerItemId,
  sha256,
  role,
  extension,
}) {
  return [
    String(companyId).toLowerCase(),
    "imports",
    "google-drive",
    connectionKey,
    "items",
    providerItemStorageKey(providerItemId),
    "versions",
    `sha256-${sha256}`,
    `${role}.${extension}`,
  ].join("/");
}

export function expectedMimeArtifacts(sourceMimeType, includeEditableExports = true) {
  const mapping = DEFAULT_MIME_MAPPINGS[sourceMimeType];
  if (!mapping) return [];
  return mapping.filter(
    (entry) => includeEditableExports || entry.role !== "editable",
  );
}

export function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function isIsoDateTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isIsoDate(value) {
  if (value === null || value === undefined) return true;
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareManifestItems(a, b) {
  return (
    String(a?.pathKey ?? "").localeCompare(String(b?.pathKey ?? ""), "en") ||
    String(a?.providerItemId ?? "").localeCompare(
      String(b?.providerItemId ?? ""),
      "en",
    )
  );
}

function artifactSortKey(artifact) {
  return `${artifact?.role ?? ""}\u0000${artifact?.mimeType ?? ""}`;
}

export function validateDriveManifest(
  manifest,
  { requireDigest = true, requireCompleteSnapshot = false } = {},
) {
  const errors = [];
  const warnings = [];
  const error = (jsonPath, message) => errors.push({ path: jsonPath, message });
  const warning = (jsonPath, message) =>
    warnings.push({ path: jsonPath, message });
  const checkAllowedKeys = (value, allowedKeys, jsonPath) => {
    if (!isObject(value)) return;
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        error(`${jsonPath}.${key}`, "property is not allowed by manifest schema");
      }
    }
  };
  const checkRequiredKeys = (value, requiredKeys, jsonPath) => {
    if (!isObject(value)) return;
    for (const key of requiredKeys) {
      if (!Object.hasOwn(value, key)) {
        error(`${jsonPath}.${key}`, "required property is missing");
      }
    }
  };

  if (!isObject(manifest)) {
    return {
      valid: false,
      errors: [{ path: "$", message: "manifest must be a JSON object" }],
      warnings,
      computedManifestSha256: null,
      stats: { items: 0, files: 0, folders: 0, artifacts: 0, citations: 0 },
    };
  }

  checkAllowedKeys(
    manifest,
    [
      "schemaVersion",
      "manifestId",
      "manifestSha256",
      "generatedAt",
      "tenant",
      "source",
      "snapshot",
      "exportPolicy",
      "items",
    ],
    "$",
  );
  checkRequiredKeys(
    manifest,
    [
      "schemaVersion",
      "manifestId",
      "manifestSha256",
      "generatedAt",
      "tenant",
      "source",
      "snapshot",
      "exportPolicy",
      "items",
    ],
    "$",
  );
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    error(
      "$.schemaVersion",
      `must equal ${MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (!UUID_RE.test(manifest.manifestId ?? "")) {
    error("$.manifestId", "must be a UUID");
  }
  if (!isIsoDateTime(manifest.generatedAt)) {
    error("$.generatedAt", "must be an ISO 8601 date-time with a timezone");
  }
  if (!isObject(manifest.tenant) || !UUID_RE.test(manifest.tenant.companyId ?? "")) {
    error("$.tenant.companyId", "must be a UUID");
  } else {
    checkAllowedKeys(manifest.tenant, ["companyId"], "$.tenant");
    checkRequiredKeys(manifest.tenant, ["companyId"], "$.tenant");
  }

  if (!isObject(manifest.source)) {
    error("$.source", "must be an object");
  } else {
    checkAllowedKeys(
      manifest.source,
      [
        "provider",
        "connectionKey",
        "rootFolderId",
        "rootName",
        "driveId",
        "oauthScope",
      ],
      "$.source",
    );
    checkRequiredKeys(
      manifest.source,
      [
        "provider",
        "connectionKey",
        "rootFolderId",
        "rootName",
        "driveId",
        "oauthScope",
      ],
      "$.source",
    );
    if (manifest.source.provider !== "google-drive") {
      error("$.source.provider", 'must equal "google-drive"');
    }
    if (!KEY_RE.test(manifest.source.connectionKey ?? "")) {
      error(
        "$.source.connectionKey",
        "must be a lowercase kebab-case key of at most 64 characters",
      );
    }
    if (
      typeof manifest.source.rootFolderId !== "string" ||
      manifest.source.rootFolderId.length < 3
    ) {
      error("$.source.rootFolderId", "must be a nonempty Google Drive folder ID");
    }
    if (
      typeof manifest.source.rootName !== "string" ||
      normalizeDisplaySegment(manifest.source.rootName) !==
        manifest.source.rootName
    ) {
      error("$.source.rootName", "must be a normalized display segment");
    }
    if (
      manifest.source.driveId !== null &&
      manifest.source.driveId !== undefined &&
      typeof manifest.source.driveId !== "string"
    ) {
      error("$.source.driveId", "must be a string or null");
    }
    if (manifest.source.oauthScope !== GOOGLE_DRIVE_READONLY_SCOPE) {
      error(
        "$.source.oauthScope",
        `must equal ${GOOGLE_DRIVE_READONLY_SCOPE}`,
      );
    }
  }

  if (!isObject(manifest.snapshot)) {
    error("$.snapshot", "must be an object");
  } else {
    checkAllowedKeys(manifest.snapshot, ["kind", "complete"], "$.snapshot");
    checkRequiredKeys(manifest.snapshot, ["kind", "complete"], "$.snapshot");
    if (!["full", "partial"].includes(manifest.snapshot.kind)) {
      error("$.snapshot.kind", 'must be "full" or "partial"');
    }
    if (typeof manifest.snapshot.complete !== "boolean") {
      error("$.snapshot.complete", "must be boolean");
    }
    if (
      manifest.snapshot.kind === "full" &&
      manifest.snapshot.complete !== true
    ) {
      error("$.snapshot.complete", "must be true for a full snapshot");
    }
    if (
      manifest.snapshot.kind === "partial" &&
      manifest.snapshot.complete !== false
    ) {
      error("$.snapshot.complete", "must be false for a partial snapshot");
    }
    if (requireCompleteSnapshot && manifest.snapshot.complete !== true) {
      error("$.snapshot.complete", "a complete snapshot is required");
    }
  }

  const includeEditableExports =
    manifest.exportPolicy?.includeEditableExports === true;
  if (!isObject(manifest.exportPolicy)) {
    error("$.exportPolicy", "must be an object");
  } else {
    checkAllowedKeys(
      manifest.exportPolicy,
      ["canonicalMimeType", "includeEditableExports", "mimeMappings"],
      "$.exportPolicy",
    );
    checkRequiredKeys(
      manifest.exportPolicy,
      ["canonicalMimeType", "includeEditableExports", "mimeMappings"],
      "$.exportPolicy",
    );
    if (manifest.exportPolicy.canonicalMimeType !== PDF_MIME) {
      error("$.exportPolicy.canonicalMimeType", `must equal ${PDF_MIME}`);
    }
    if (typeof manifest.exportPolicy.includeEditableExports !== "boolean") {
      error("$.exportPolicy.includeEditableExports", "must be boolean");
    }
    if (!isObject(manifest.exportPolicy.mimeMappings)) {
      error("$.exportPolicy.mimeMappings", "must be an object");
    } else {
      const mappingKeys = Object.keys(DEFAULT_MIME_MAPPINGS);
      checkAllowedKeys(
        manifest.exportPolicy.mimeMappings,
        mappingKeys,
        "$.exportPolicy.mimeMappings",
      );
      for (const sourceMimeType of mappingKeys) {
        const declaredPlans =
          manifest.exportPolicy.mimeMappings[sourceMimeType];
        const requiredPlans = DEFAULT_MIME_MAPPINGS[sourceMimeType];
        if (!Array.isArray(declaredPlans)) {
          error(
            `$.exportPolicy.mimeMappings.${sourceMimeType}`,
            "must be an array",
          );
          continue;
        }
        if (declaredPlans.length !== requiredPlans.length) {
          error(
            `$.exportPolicy.mimeMappings.${sourceMimeType}`,
            `must contain exactly ${requiredPlans.length} plans`,
          );
        }
        declaredPlans.forEach((plan, planIndex) => {
          const planPath = `$.exportPolicy.mimeMappings.${sourceMimeType}[${planIndex}]`;
          if (!isObject(plan)) {
            error(planPath, "must be an object");
            return;
          }
          checkAllowedKeys(
            plan,
            ["role", "mimeType", "extension", "exportMethod"],
            planPath,
          );
          checkRequiredKeys(
            plan,
            ["role", "mimeType", "extension", "exportMethod"],
            planPath,
          );
          const required = requiredPlans[planIndex];
          if (
            !required ||
            plan.role !== required.role ||
            plan.mimeType !== required.mimeType ||
            plan.extension !== required.extension ||
            plan.exportMethod !== required.exportMethod
          ) {
            error(
              planPath,
              "must match the fixed SafetyOps MIME export policy",
            );
          }
        });
      }
    }
  }

  if (!Array.isArray(manifest.items)) {
    error("$.items", "must be an array");
  }

  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const itemIds = new Set();
  const pathKeys = new Set();
  const storageKeys = new Set();
  const itemById = new Map();
  let files = 0;
  let folders = 0;
  let artifacts = 0;
  let citations = 0;

  const sortedItems = [...items].sort(compareManifestItems);
  if (
    items.some(
      (item, index) =>
        item?.providerItemId !== sortedItems[index]?.providerItemId,
    )
  ) {
    error(
      "$.items",
      "must be deterministically sorted by pathKey and providerItemId",
    );
  }

  items.forEach((item, index) => {
    const base = `$.items[${index}]`;
    if (!isObject(item)) {
      error(base, "must be an object");
      return;
    }
    checkAllowedKeys(
      item,
      [
        "providerItemId",
        "parentProviderItemId",
        "pathIds",
        "pathSegments",
        "displayPath",
        "pathKey",
        "name",
        "kind",
        "sourceMimeType",
        "modifiedTime",
        "providerVersion",
        "providerMd5Checksum",
        "sourceSizeBytes",
        "ingestDisposition",
        "skipReason",
        "artifacts",
        "document",
        "oshaCitations",
      ],
      base,
    );
    checkRequiredKeys(
      item,
      [
        "providerItemId",
        "parentProviderItemId",
        "pathIds",
        "pathSegments",
        "displayPath",
        "pathKey",
        "name",
        "kind",
        "sourceMimeType",
        "modifiedTime",
        "providerVersion",
        "providerMd5Checksum",
        "sourceSizeBytes",
        "ingestDisposition",
        "skipReason",
        "artifacts",
        "document",
        "oshaCitations",
      ],
      base,
    );

    if (
      typeof item.providerItemId !== "string" ||
      item.providerItemId.length < 3
    ) {
      error(`${base}.providerItemId`, "must be a nonempty provider ID");
    } else if (itemIds.has(item.providerItemId)) {
      error(`${base}.providerItemId`, "must be unique in the manifest");
    } else {
      itemIds.add(item.providerItemId);
      itemById.set(item.providerItemId, item);
    }

    if (
      item.parentProviderItemId !== null &&
      typeof item.parentProviderItemId !== "string"
    ) {
      error(`${base}.parentProviderItemId`, "must be a string or null");
    }
    if (!["folder", "file"].includes(item.kind)) {
      error(`${base}.kind`, 'must be "folder" or "file"');
    }
    if (
      typeof item.name !== "string" ||
      normalizeDisplaySegment(item.name) !== item.name
    ) {
      error(`${base}.name`, "must be a normalized display segment");
    }
    if (!Array.isArray(item.pathIds) || item.pathIds.length === 0) {
      error(`${base}.pathIds`, "must be a nonempty array");
    }
    if (!Array.isArray(item.pathSegments) || item.pathSegments.length === 0) {
      error(`${base}.pathSegments`, "must be a nonempty array");
    }

    if (
      Array.isArray(item.pathIds) &&
      Array.isArray(item.pathSegments) &&
      item.pathIds.length === item.pathSegments.length &&
      item.pathIds.length > 0
    ) {
      try {
        const derived = derivePathFields(item.pathSegments, item.pathIds);
        if (
          item.pathSegments.some(
            (segment, segmentIndex) =>
              segment !== derived.pathSegments[segmentIndex],
          )
        ) {
          error(`${base}.pathSegments`, "contains an unnormalized segment");
        }
        if (item.displayPath !== derived.displayPath) {
          error(
            `${base}.displayPath`,
            `must equal derived display path ${derived.displayPath}`,
          );
        }
        if (item.pathKey !== derived.pathKey) {
          error(`${base}.pathKey`, `must equal derived path key ${derived.pathKey}`);
        }
        if (item.pathIds.at(-1) !== item.providerItemId) {
          error(
            `${base}.pathIds`,
            "last path ID must equal providerItemId",
          );
        }
        if (item.pathSegments.at(-1) !== item.name) {
          error(`${base}.pathSegments`, "last segment must equal name");
        }
      } catch (caught) {
        error(`${base}.pathKey`, caught.message);
      }
    } else if (
      Array.isArray(item.pathIds) &&
      Array.isArray(item.pathSegments)
    ) {
      error(`${base}.pathSegments`, "must have the same length as pathIds");
    }

    if (typeof item.pathKey === "string") {
      if (pathKeys.has(item.pathKey)) {
        error(`${base}.pathKey`, "must be unique in the manifest");
      }
      pathKeys.add(item.pathKey);
    }

    if (!isIsoDateTime(item.modifiedTime)) {
      error(`${base}.modifiedTime`, "must be an ISO 8601 date-time");
    }
    if (
      item.providerVersion !== null &&
      item.providerVersion !== undefined &&
      typeof item.providerVersion !== "string"
    ) {
      error(`${base}.providerVersion`, "must be a string or null");
    }
    if (
      item.providerMd5Checksum !== null &&
      item.providerMd5Checksum !== undefined &&
      !/^[0-9a-f]{32}$/.test(item.providerMd5Checksum)
    ) {
      error(
        `${base}.providerMd5Checksum`,
        "must be a lowercase MD5 hex string or null",
      );
    }
    if (
      item.sourceSizeBytes !== null &&
      item.sourceSizeBytes !== undefined &&
      (!Number.isSafeInteger(item.sourceSizeBytes) || item.sourceSizeBytes < 0)
    ) {
      error(`${base}.sourceSizeBytes`, "must be a nonnegative integer or null");
    }

    if (!["ingest", "metadata-only"].includes(item.ingestDisposition)) {
      error(
        `${base}.ingestDisposition`,
        'must be "ingest" or "metadata-only"',
      );
    }
    if (
      item.ingestDisposition === "metadata-only" &&
      (typeof item.skipReason !== "string" || item.skipReason.length === 0)
    ) {
      error(
        `${base}.skipReason`,
        "is required for a metadata-only item",
      );
    }
    if (
      item.ingestDisposition === "ingest" &&
      item.skipReason !== null &&
      item.skipReason !== undefined
    ) {
      error(`${base}.skipReason`, "must be null for an ingested item");
    }

    const itemArtifacts = Array.isArray(item.artifacts) ? item.artifacts : [];
    if (!Array.isArray(item.artifacts)) {
      error(`${base}.artifacts`, "must be an array");
    }

    if (item.kind === "folder") {
      folders += 1;
      if (item.sourceMimeType !== GOOGLE_FOLDER_MIME) {
        error(`${base}.sourceMimeType`, `must equal ${GOOGLE_FOLDER_MIME}`);
      }
      if (item.ingestDisposition !== "metadata-only") {
        error(
          `${base}.ingestDisposition`,
          "folders must be metadata-only",
        );
      }
      if (itemArtifacts.length !== 0) {
        error(`${base}.artifacts`, "folders cannot contain artifacts");
      }
    } else if (item.kind === "file") {
      files += 1;
      const expected = expectedMimeArtifacts(
        item.sourceMimeType,
        includeEditableExports,
      );
      if (expected.length > 0 && item.ingestDisposition !== "ingest") {
        error(
          `${base}.ingestDisposition`,
          "supported PDF, Google Doc, and Google Sheet files must be ingested",
        );
      }
      if (expected.length === 0 && item.ingestDisposition === "ingest") {
        error(
          `${base}.sourceMimeType`,
          "cannot be ingested by the declared MIME policy",
        );
      }
      if (
        item.ingestDisposition === "metadata-only" &&
        itemArtifacts.length !== 0
      ) {
        error(
          `${base}.artifacts`,
          "metadata-only items cannot contain artifacts",
        );
      }

      const seenArtifactKeys = new Set();
      itemArtifacts.forEach((artifact, artifactIndex) => {
        const artifactBase = `${base}.artifacts[${artifactIndex}]`;
        artifacts += 1;
        if (!isObject(artifact)) {
          error(artifactBase, "must be an object");
          return;
        }
        checkAllowedKeys(
          artifact,
          [
            "role",
            "mimeType",
            "extension",
            "exportMethod",
            "byteLength",
            "sha256",
            "stagedFile",
            "storageObjectKey",
          ],
          artifactBase,
        );
        checkRequiredKeys(
          artifact,
          [
            "role",
            "mimeType",
            "extension",
            "exportMethod",
            "byteLength",
            "sha256",
            "stagedFile",
            "storageObjectKey",
          ],
          artifactBase,
        );
        if (!["canonical", "editable"].includes(artifact.role)) {
          error(
            `${artifactBase}.role`,
            'must be "canonical" or "editable"',
          );
        }
        if (typeof artifact.mimeType !== "string" || !artifact.mimeType) {
          error(`${artifactBase}.mimeType`, "must be a MIME type");
        }
        if (!/^[a-z0-9]{1,10}$/.test(artifact.extension ?? "")) {
          error(
            `${artifactBase}.extension`,
            "must be a lowercase file extension",
          );
        }
        if (!["download", "google-export"].includes(artifact.exportMethod)) {
          error(
            `${artifactBase}.exportMethod`,
            'must be "download" or "google-export"',
          );
        }
        if (
          !Number.isSafeInteger(artifact.byteLength) ||
          artifact.byteLength <= 0
        ) {
          error(`${artifactBase}.byteLength`, "must be a positive integer");
        }
        if (!SHA256_RE.test(artifact.sha256 ?? "")) {
          error(
            `${artifactBase}.sha256`,
            "must be a lowercase SHA-256 hex string",
          );
        }
        if (!isSafeRelativePath(artifact.stagedFile)) {
          error(
            `${artifactBase}.stagedFile`,
            "must be a normalized relative POSIX path without traversal",
          );
        }

        if (
          UUID_RE.test(manifest.tenant?.companyId ?? "") &&
          KEY_RE.test(manifest.source?.connectionKey ?? "") &&
          typeof item.providerItemId === "string" &&
          SHA256_RE.test(artifact.sha256 ?? "") &&
          ["canonical", "editable"].includes(artifact.role) &&
          /^[a-z0-9]{1,10}$/.test(artifact.extension ?? "")
        ) {
          const expectedStorageKey = deriveStorageObjectKey({
            companyId: manifest.tenant.companyId,
            connectionKey: manifest.source.connectionKey,
            providerItemId: item.providerItemId,
            sha256: artifact.sha256,
            role: artifact.role,
            extension: artifact.extension,
          });
          if (artifact.storageObjectKey !== expectedStorageKey) {
            error(
              `${artifactBase}.storageObjectKey`,
              `must equal ${expectedStorageKey}`,
            );
          }
        }

        if (storageKeys.has(artifact.storageObjectKey)) {
          error(
            `${artifactBase}.storageObjectKey`,
            "must be unique in the manifest",
          );
        }
        storageKeys.add(artifact.storageObjectKey);

        const artifactKey = artifactSortKey(artifact);
        if (seenArtifactKeys.has(artifactKey)) {
          error(
            artifactBase,
            "artifact role and MIME type must be unique for an item",
          );
        }
        seenArtifactKeys.add(artifactKey);
      });

      const sortedArtifacts = [...itemArtifacts].sort((a, b) =>
        artifactSortKey(a).localeCompare(artifactSortKey(b), "en"),
      );
      if (
        itemArtifacts.some(
          (artifact, artifactIndex) =>
            artifactSortKey(artifact) !==
            artifactSortKey(sortedArtifacts[artifactIndex]),
        )
      ) {
        error(
          `${base}.artifacts`,
          "must be deterministically sorted by role and MIME type",
        );
      }

      for (const expectedArtifact of expected) {
        const match = itemArtifacts.find(
          (artifact) =>
            artifact.role === expectedArtifact.role &&
            artifact.mimeType === expectedArtifact.mimeType &&
            artifact.extension === expectedArtifact.extension &&
            artifact.exportMethod === expectedArtifact.exportMethod,
        );
        if (!match) {
          error(
            `${base}.artifacts`,
            `missing ${expectedArtifact.role} ${expectedArtifact.mimeType} artifact`,
          );
        }
      }
      if (
        item.ingestDisposition === "ingest" &&
        itemArtifacts.length !== expected.length
      ) {
        error(
          `${base}.artifacts`,
          `must contain exactly ${expected.length} artifacts for ${item.sourceMimeType}`,
        );
      }
      for (const artifact of itemArtifacts) {
        const allowed = expected.some(
          (expectedArtifact) =>
            artifact.role === expectedArtifact.role &&
            artifact.mimeType === expectedArtifact.mimeType &&
            artifact.extension === expectedArtifact.extension &&
            artifact.exportMethod === expectedArtifact.exportMethod,
        );
        if (!allowed) {
          error(
            `${base}.artifacts`,
            `contains an artifact outside the declared MIME policy: ${artifact.role} ${artifact.mimeType}`,
          );
        }
      }
    }

    if (!isObject(item.document)) {
      error(`${base}.document`, "must be an object");
    } else {
      checkAllowedKeys(
        item.document,
        [
          "title",
          "documentType",
          "visibility",
          "acknowledgementRequired",
          "effectiveAt",
          "reviewAt",
          "locationKeys",
        ],
        `${base}.document`,
      );
      checkRequiredKeys(
        item.document,
        [
          "title",
          "documentType",
          "visibility",
          "acknowledgementRequired",
          "effectiveAt",
          "reviewAt",
          "locationKeys",
        ],
        `${base}.document`,
      );
      if (
        typeof item.document.title !== "string" ||
        item.document.title.length < 2 ||
        item.document.title.length > 220
      ) {
        error(`${base}.document.title`, "must contain 2 to 220 characters");
      }
      if (
        typeof item.document.documentType !== "string" ||
        item.document.documentType.length < 2 ||
        item.document.documentType.length > 80
      ) {
        error(
          `${base}.document.documentType`,
          "must contain 2 to 80 characters",
        );
      }
      if (!["company", "location", "restricted"].includes(item.document.visibility)) {
        error(
          `${base}.document.visibility`,
          'must be "company", "location", or "restricted"',
        );
      }
      if (typeof item.document.acknowledgementRequired !== "boolean") {
        error(
          `${base}.document.acknowledgementRequired`,
          "must be boolean",
        );
      }
      if (!isIsoDate(item.document.effectiveAt)) {
        error(`${base}.document.effectiveAt`, "must be YYYY-MM-DD or null");
      }
      if (!isIsoDate(item.document.reviewAt)) {
        error(`${base}.document.reviewAt`, "must be YYYY-MM-DD or null");
      }
      if (!Array.isArray(item.document.locationKeys)) {
        error(`${base}.document.locationKeys`, "must be an array");
      } else {
        const uniqueLocations = new Set();
        for (const locationKey of item.document.locationKeys) {
          if (!LOCATION_KEY_RE.test(locationKey)) {
            error(
              `${base}.document.locationKeys`,
              `invalid location key ${locationKey}`,
            );
          }
          if (uniqueLocations.has(locationKey)) {
            error(
              `${base}.document.locationKeys`,
              `duplicate location key ${locationKey}`,
            );
          }
          uniqueLocations.add(locationKey);
        }
        if (
          item.document.visibility === "location" &&
          item.document.locationKeys.length === 0
        ) {
          error(
            `${base}.document.locationKeys`,
            "location visibility requires at least one location key",
          );
        }
      }
    }

    if (!Array.isArray(item.oshaCitations)) {
      error(`${base}.oshaCitations`, "must be an array");
    } else {
      citations += item.oshaCitations.length;
      item.oshaCitations.forEach((citation, citationIndex) => {
        const citationBase = `${base}.oshaCitations[${citationIndex}]`;
        if (!isObject(citation)) {
          error(citationBase, "must be an object");
          return;
        }
        checkAllowedKeys(
          citation,
          [
            "authority",
            "citation",
            "jurisdiction",
            "relation",
            "sourceUrl",
            "reviewStatus",
            "regulatoryUnitVersionId",
            "notes",
          ],
          citationBase,
        );
        checkRequiredKeys(
          citation,
          [
            "authority",
            "citation",
            "jurisdiction",
            "relation",
            "sourceUrl",
            "reviewStatus",
            "regulatoryUnitVersionId",
            "notes",
          ],
          citationBase,
        );
        if (
          ![
            "federal-regulation",
            "state-regulation",
            "statute",
            "interpretation",
            "directive",
            "guidance",
          ].includes(citation.authority)
        ) {
          error(`${citationBase}.authority`, "has an unsupported authority");
        }
        if (
          typeof citation.citation !== "string" ||
          citation.citation.length < 3
        ) {
          error(`${citationBase}.citation`, "must be a citation string");
        }
        if (
          typeof citation.jurisdiction !== "string" ||
          !/^[A-Z0-9-]{2,40}$/.test(citation.jurisdiction)
        ) {
          error(
            `${citationBase}.jurisdiction`,
            "must be an uppercase jurisdiction code",
          );
        }
        if (
          ![
            "implements",
            "references",
            "training-for",
            "record-required-by",
            "supports",
          ].includes(citation.relation)
        ) {
          error(`${citationBase}.relation`, "has an unsupported relation");
        }
        if (!["unverified", "reviewed"].includes(citation.reviewStatus)) {
          error(
            `${citationBase}.reviewStatus`,
            'must be "unverified" or "reviewed"',
          );
        }
        if (
          citation.regulatoryUnitVersionId !== null &&
          citation.regulatoryUnitVersionId !== undefined &&
          !UUID_RE.test(citation.regulatoryUnitVersionId)
        ) {
          error(
            `${citationBase}.regulatoryUnitVersionId`,
            "must be a UUID or null",
          );
        }
        if (
          citation.sourceUrl !== null &&
          citation.sourceUrl !== undefined
        ) {
          try {
            const sourceUrl = new URL(citation.sourceUrl);
            if (sourceUrl.protocol !== "https:") {
              throw new Error("not HTTPS");
            }
          } catch {
            error(
              `${citationBase}.sourceUrl`,
              "must be an HTTPS URL or null",
            );
          }
        }
        if (
          citation.reviewStatus === "unverified" &&
          citation.regulatoryUnitVersionId
        ) {
          warning(
            citationBase,
            "an unverified citation should not be promoted to an approved control mapping",
          );
        }
        if (
          citation.notes !== null &&
          citation.notes !== undefined &&
          (typeof citation.notes !== "string" ||
            citation.notes.length > 2000)
        ) {
          error(
            `${citationBase}.notes`,
            "must be a string of at most 2000 characters or null",
          );
        }
      });
    }
  });

  const rootItems = items.filter(
    (item) => item?.providerItemId === manifest.source?.rootFolderId,
  );
  if (rootItems.length !== 1) {
    error(
      "$.items",
      "must contain exactly one root item matching source.rootFolderId",
    );
  } else {
    const root = rootItems[0];
    if (root.kind !== "folder") {
      error("$.items", "root item must be a folder");
    }
    if (root.parentProviderItemId !== null) {
      error("$.items", "root item parentProviderItemId must be null");
    }
    if (root.name !== manifest.source?.rootName) {
      error("$.items", "root item name must equal source.rootName");
    }
    if (root.pathIds?.length !== 1) {
      error("$.items", "root item pathIds must contain only the root ID");
    }
  }

  items.forEach((item, index) => {
    if (!isObject(item) || item.providerItemId === manifest.source?.rootFolderId) {
      return;
    }
    const base = `$.items[${index}]`;
    const expectedParent = Array.isArray(item.pathIds)
      ? item.pathIds.at(-2)
      : undefined;
    if (item.parentProviderItemId !== expectedParent) {
      error(
        `${base}.parentProviderItemId`,
        "must equal the penultimate path ID",
      );
    }
    if (!itemById.has(item.parentProviderItemId)) {
      if (manifest.snapshot?.complete) {
        error(
          `${base}.parentProviderItemId`,
          "parent must be present in a complete snapshot",
        );
      } else {
        warning(
          `${base}.parentProviderItemId`,
          "parent is absent from this partial snapshot",
        );
      }
    }
  });

  let computedManifestSha256 = null;
  try {
    computedManifestSha256 = manifestSha256(manifest);
    if (!SHA256_RE.test(manifest.manifestSha256 ?? "")) {
      if (requireDigest) {
        error(
          "$.manifestSha256",
          "must be a lowercase SHA-256 hex string",
        );
      } else {
        warning("$.manifestSha256", "manifest digest is absent");
      }
    } else if (manifest.manifestSha256 !== computedManifestSha256) {
      error(
        "$.manifestSha256",
        `digest mismatch; expected ${computedManifestSha256}`,
      );
    }
  } catch (caught) {
    error("$.manifestSha256", `could not compute digest: ${caught.message}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    computedManifestSha256,
    stats: {
      items: items.length,
      files,
      folders,
      artifacts,
      citations,
    },
  };
}
