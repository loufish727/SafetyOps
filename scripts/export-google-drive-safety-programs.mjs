#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_MIME_MAPPINGS,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GOOGLE_FOLDER_MIME,
  MANIFEST_SCHEMA_VERSION,
  PDF_MIME,
  derivePathFields,
  deriveStorageObjectKey,
  expectedMimeArtifacts,
  manifestSha256,
  normalizeDisplaySegment,
  providerItemStorageKey,
  sha256Bytes,
  validateDriveManifest,
} from "./drive-ingest-core.mjs";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "parents",
  "modifiedTime",
  "version",
  "md5Checksum",
  "size",
  "driveId",
  "shortcutDetails(targetId,targetMimeType)",
].join(",");

function usage() {
  return `Usage:
  GOOGLE_DRIVE_ACCESS_TOKEN=... node scripts/export-google-drive-safety-programs.mjs \\
    --root-folder-id <drive-folder-id> \\
    --company-id <uuid> \\
    --connection-key safety-programs \\
    --out <manifest.json> \\
    --artifact-dir <directory> [options]

Options:
  --drive-id <shared-drive-id>  Scope listing to a Shared Drive.
  --canonical-only              Export only canonical PDFs, not DOCX/XLSX copies.
  --help                        Show this help.

The access token must have only the Drive read-only scope, and the source root
should be the only Drive tree shared with the ingestion identity.`;
}

function parseArguments(argv) {
  const options = {
    rootFolderId: null,
    companyId: null,
    connectionKey: null,
    out: null,
    artifactDir: null,
    driveId: null,
    includeEditableExports: true,
    help: false,
  };

  const valueOptions = new Map([
    ["--root-folder-id", "rootFolderId"],
    ["--company-id", "companyId"],
    ["--connection-key", "connectionKey"],
    ["--out", "out"],
    ["--artifact-dir", "artifactDir"],
    ["--drive-id", "driveId"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valueOptions.has(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options[valueOptions.get(argument)] = value;
    } else if (argument === "--canonical-only") {
      options.includeEditableExports = false;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }

  return options;
}

function requireOptions(options) {
  for (const key of [
    "rootFolderId",
    "companyId",
    "connectionKey",
    "out",
    "artifactDir",
  ]) {
    if (!options[key]) {
      throw new Error(`missing required option for ${key}`);
    }
  }
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function readErrorBody(response) {
  const text = await response.text();
  return text.slice(0, 1500).replace(/\s+/g, " ").trim();
}

async function driveFetch(url, token) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, application/pdf, application/octet-stream",
    },
  });

  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(
      `Google Drive API ${response.status} ${response.statusText}: ${details}`,
    );
  }
  return response;
}

function addSharedDriveParameters(searchParams, options) {
  searchParams.set("supportsAllDrives", "true");
  if (options.driveId) {
    searchParams.set("includeItemsFromAllDrives", "true");
    searchParams.set("corpora", "drive");
    searchParams.set("driveId", options.driveId);
  }
}

async function getDriveFile(fileId, token, options) {
  const searchParams = new URLSearchParams({ fields: DRIVE_FIELDS });
  addSharedDriveParameters(searchParams, options);
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${searchParams}`;
  return (await driveFetch(url, token)).json();
}

async function listDriveChildren(folderId, token, options) {
  const files = [];
  let pageToken = null;

  do {
    const searchParams = new URLSearchParams({
      q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
      fields: `nextPageToken,files(${DRIVE_FIELDS})`,
      pageSize: "1000",
      orderBy: "folder,name_natural",
    });
    addSharedDriveParameters(searchParams, options);
    if (pageToken) searchParams.set("pageToken", pageToken);

    const response = await driveFetch(
      `${DRIVE_API}/files?${searchParams}`,
      token,
    );
    const page = await response.json();
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);

  return files;
}

async function enumerateDriveTree(root, token, options) {
  if (root.mimeType !== GOOGLE_FOLDER_MIME) {
    throw new Error("--root-folder-id does not identify a Google Drive folder");
  }

  const nodes = [
    {
      file: root,
      parentProviderItemId: null,
      pathIds: [root.id],
      pathSegments: [normalizeDisplaySegment(root.name)],
    },
  ];
  const queue = [nodes[0]];
  const seen = new Set([root.id]);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parent = queue[cursor];
    const children = await listDriveChildren(parent.file.id, token, options);
    for (const child of children) {
      if (seen.has(child.id)) {
        throw new Error(
          `Drive item ${child.id} appeared more than once below the source root`,
        );
      }
      seen.add(child.id);

      const node = {
        file: child,
        parentProviderItemId: parent.file.id,
        pathIds: [...parent.pathIds, child.id],
        pathSegments: [
          ...parent.pathSegments,
          normalizeDisplaySegment(child.name),
        ],
      };
      nodes.push(node);
      if (child.mimeType === GOOGLE_FOLDER_MIME) queue.push(node);
    }
  }

  return nodes;
}

async function downloadArtifact(file, artifactPlan, token) {
  let url;
  if (artifactPlan.exportMethod === "download") {
    const searchParams = new URLSearchParams({
      alt: "media",
      supportsAllDrives: "true",
    });
    url = `${DRIVE_API}/files/${encodeURIComponent(file.id)}?${searchParams}`;
  } else {
    const searchParams = new URLSearchParams({
      mimeType: artifactPlan.mimeType,
    });
    url = `${DRIVE_API}/files/${encodeURIComponent(file.id)}/export?${searchParams}`;
  }

  try {
    const response = await driveFetch(url, token);
    return Buffer.from(await response.arrayBuffer());
  } catch (caught) {
    if (artifactPlan.exportMethod === "google-export") {
      throw new Error(
        `could not export ${file.name} (${file.id}) as ${artifactPlan.mimeType}; ` +
          `Google native-file exports are subject to the Drive API export-size limit: ${caught.message}`,
      );
    }
    throw caught;
  }
}

function makeDocumentMetadata(name) {
  return {
    title: normalizeDisplaySegment(name),
    documentType: "Safety Program",
    visibility: "company",
    acknowledgementRequired: false,
    effectiveAt: null,
    reviewAt: null,
    locationKeys: [],
  };
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function buildManifestItem(node, options, token, artifactRoot) {
  const { file } = node;
  const derivedPath = derivePathFields(node.pathSegments, node.pathIds);
  const isFolder = file.mimeType === GOOGLE_FOLDER_MIME;
  const artifactPlans = isFolder
    ? []
    : expectedMimeArtifacts(
        file.mimeType,
        options.includeEditableExports,
      );
  const supported = artifactPlans.length > 0;
  const item = {
    providerItemId: file.id,
    parentProviderItemId: node.parentProviderItemId,
    pathIds: node.pathIds,
    pathSegments: derivedPath.pathSegments,
    displayPath: derivedPath.displayPath,
    pathKey: derivedPath.pathKey,
    name: normalizeDisplaySegment(file.name),
    kind: isFolder ? "folder" : "file",
    sourceMimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    providerVersion:
      file.version === undefined || file.version === null
        ? null
        : String(file.version),
    providerMd5Checksum: file.md5Checksum ?? null,
    sourceSizeBytes: numericOrNull(file.size),
    ingestDisposition: supported ? "ingest" : "metadata-only",
    skipReason: isFolder
      ? "Folder metadata only"
      : supported
        ? null
        : file.shortcutDetails
          ? "Google Drive shortcuts are not followed"
          : `Unsupported source MIME type: ${file.mimeType}`,
    artifacts: [],
    document: makeDocumentMetadata(file.name),
    oshaCitations: [],
  };

  for (const artifactPlan of artifactPlans) {
    const bytes = await downloadArtifact(file, artifactPlan, token);
    const sha256 = sha256Bytes(bytes);
    const stagedFile = [
      providerItemStorageKey(file.id),
      sha256,
      `${artifactPlan.role}.${artifactPlan.extension}`,
    ].join("/");
    const absoluteStagedFile = path.resolve(
      artifactRoot,
      ...stagedFile.split("/"),
    );
    await mkdir(path.dirname(absoluteStagedFile), { recursive: true });
    await writeFile(absoluteStagedFile, bytes, { flag: "wx" }).catch(
      async (caught) => {
        if (caught.code !== "EEXIST") throw caught;
        const existing = await readFile(absoluteStagedFile);
        if (sha256Bytes(existing) !== sha256) {
          throw new Error(
            `existing staged artifact has a different hash: ${stagedFile}`,
          );
        }
      },
    );

    item.artifacts.push({
      role: artifactPlan.role,
      mimeType: artifactPlan.mimeType,
      extension: artifactPlan.extension,
      exportMethod: artifactPlan.exportMethod,
      byteLength: bytes.length,
      sha256,
      stagedFile,
      storageObjectKey: deriveStorageObjectKey({
        companyId: options.companyId,
        connectionKey: options.connectionKey,
        providerItemId: file.id,
        sha256,
        role: artifactPlan.role,
        extension: artifactPlan.extension,
      }),
    });
  }

  item.artifacts.sort((left, right) =>
    `${left.role}\u0000${left.mimeType}`.localeCompare(
      `${right.role}\u0000${right.mimeType}`,
      "en",
    ),
  );
  return item;
}

function cloneMimeMappings() {
  return Object.fromEntries(
    Object.entries(DEFAULT_MIME_MAPPINGS).map(([sourceMime, plans]) => [
      sourceMime,
      plans.map((plan) => ({ ...plan })),
    ]),
  );
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    requireOptions(options);
  } catch (caught) {
    console.error(caught.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const token = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  if (!token) {
    console.error("GOOGLE_DRIVE_ACCESS_TOKEN is required");
    process.exitCode = 2;
    return;
  }

  const absoluteArtifactRoot = path.resolve(options.artifactDir);
  const absoluteManifestPath = path.resolve(options.out);
  await mkdir(absoluteArtifactRoot, { recursive: true });
  await mkdir(path.dirname(absoluteManifestPath), { recursive: true });

  const root = await getDriveFile(options.rootFolderId, token, options);
  const nodes = await enumerateDriveTree(root, token, options);
  const items = [];
  for (const node of nodes) {
    items.push(
      await buildManifestItem(node, options, token, absoluteArtifactRoot),
    );
  }
  items.sort(
    (left, right) =>
      left.pathKey.localeCompare(right.pathKey, "en") ||
      left.providerItemId.localeCompare(right.providerItemId, "en"),
  );

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestId: randomUUID(),
    manifestSha256: "",
    generatedAt: new Date().toISOString(),
    tenant: {
      companyId: options.companyId.toLowerCase(),
    },
    source: {
      provider: "google-drive",
      connectionKey: options.connectionKey,
      rootFolderId: root.id,
      rootName: normalizeDisplaySegment(root.name),
      driveId: options.driveId ?? root.driveId ?? null,
      oauthScope: GOOGLE_DRIVE_READONLY_SCOPE,
    },
    snapshot: {
      kind: "full",
      complete: true,
    },
    exportPolicy: {
      canonicalMimeType: PDF_MIME,
      includeEditableExports: options.includeEditableExports,
      mimeMappings: cloneMimeMappings(),
    },
    items,
  };
  manifest.manifestSha256 = manifestSha256(manifest);

  const validation = validateDriveManifest(manifest, {
    requireDigest: true,
    requireCompleteSnapshot: true,
  });
  if (!validation.valid) {
    throw new Error(
      `generated manifest failed validation:\n${validation.errors
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("\n")}`,
    );
  }

  await writeFile(
    absoluteManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(`manifest=${absoluteManifestPath}`);
  console.log(`artifactRoot=${absoluteArtifactRoot}`);
  console.log(`manifestSha256=${manifest.manifestSha256}`);
  console.log(
    `items=${validation.stats.items} files=${validation.stats.files} folders=${validation.stats.folders} artifacts=${validation.stats.artifacts}`,
  );
}

await main().catch((caught) => {
  console.error(caught.stack ?? caught.message);
  process.exitCode = 1;
});
