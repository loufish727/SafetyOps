#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  isSafeRelativePath,
  sha256Bytes,
  validateDriveManifest,
} from "./drive-ingest-core.mjs";

function usage() {
  return `Usage:
  node scripts/ingest-google-drive-safety-manifest.mjs <manifest.json> \\
    --artifact-root <directory> [--plan-json]

Apply through the dedicated Supabase Edge Function:
  SAFETYOPS_DRIVE_INGEST_URL=https://<project>.supabase.co/functions/v1/drive-safety-ingest \\
  SAFETYOPS_DRIVE_INGEST_TOKEN=... \\
  node scripts/ingest-google-drive-safety-manifest.mjs <manifest.json> \\
    --artifact-root <directory> --apply --confirm-company <company-uuid>

Options:
  --artifact-root <dir>      Required staging root for manifest artifacts.
  --plan-json                Print the dry-run plan as JSON.
  --apply                    Prepare, upload missing immutable objects, and commit.
  --confirm-company <uuid>   Required with --apply; must equal manifest company ID.
  --help                     Show this help.

Dry-run is the default. This client never accepts a Supabase service-role key.`;
}

function parseArguments(argv) {
  const options = {
    manifestPath: null,
    artifactRoot: null,
    planJson: false,
    apply: false,
    confirmCompany: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact-root") {
      options.artifactRoot = argv[++index];
      if (!options.artifactRoot) {
        throw new Error("--artifact-root requires a directory");
      }
    } else if (argument === "--confirm-company") {
      options.confirmCompany = argv[++index];
      if (!options.confirmCompany) {
        throw new Error("--confirm-company requires a UUID");
      }
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

function safeArtifactPath(artifactRoot, stagedFile) {
  if (!isSafeRelativePath(stagedFile)) {
    throw new Error(`unsafe staged file path: ${stagedFile}`);
  }
  const absoluteRoot = path.resolve(artifactRoot);
  const absoluteFile = path.resolve(
    absoluteRoot,
    ...stagedFile.split("/"),
  );
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`staged file resolves outside artifact root: ${stagedFile}`);
  }
  return absoluteFile;
}

async function verifyArtifacts(manifest, artifactRoot) {
  const artifactsByStorageKey = new Map();
  let totalBytes = 0;

  for (const item of manifest.items) {
    for (const artifact of item.artifacts) {
      const absoluteFile = safeArtifactPath(
        artifactRoot,
        artifact.stagedFile,
      );
      const fileStats = await stat(absoluteFile);
      if (!fileStats.isFile()) {
        throw new Error(`${artifact.stagedFile} is not a regular file`);
      }
      if (fileStats.size !== artifact.byteLength) {
        throw new Error(
          `${artifact.stagedFile} byte length mismatch: expected ${artifact.byteLength}, found ${fileStats.size}`,
        );
      }
      const bytes = await readFile(absoluteFile);
      const actualSha256 = sha256Bytes(bytes);
      if (actualSha256 !== artifact.sha256) {
        throw new Error(
          `${artifact.stagedFile} SHA-256 mismatch: expected ${artifact.sha256}, found ${actualSha256}`,
        );
      }
      artifactsByStorageKey.set(artifact.storageObjectKey, {
        ...artifact,
        providerItemId: item.providerItemId,
        absoluteFile,
      });
      totalBytes += artifact.byteLength;
    }
  }

  return { artifactsByStorageKey, totalBytes };
}

function buildPlan(manifest, totalBytes) {
  const ingestItems = manifest.items.filter(
    (item) => item.ingestDisposition === "ingest",
  );
  const metadataOnlyItems = manifest.items.filter(
    (item) => item.ingestDisposition === "metadata-only",
  );
  const artifactCount = manifest.items.reduce(
    (total, item) => total + item.artifacts.length,
    0,
  );
  const citations = manifest.items.flatMap((item) => item.oshaCitations);

  return {
    mode: "dry-run",
    protocolVersion: "1.0",
    manifestId: manifest.manifestId,
    manifestSha256: manifest.manifestSha256,
    companyId: manifest.tenant.companyId,
    source: {
      provider: manifest.source.provider,
      connectionKey: manifest.source.connectionKey,
      rootFolderId: manifest.source.rootFolderId,
    },
    snapshot: manifest.snapshot,
    counts: {
      items: manifest.items.length,
      ingestItems: ingestItems.length,
      metadataOnlyItems: metadataOnlyItems.length,
      artifacts: artifactCount,
      bytes: totalBytes,
      citations: citations.length,
      unverifiedCitations: citations.filter(
        (citation) => citation.reviewStatus === "unverified",
      ).length,
    },
    effects: [
      "upsert provider identities by company, provider, connection, and provider item ID",
      "upload only missing immutable hash-addressed artifacts",
      "create a source version only for a new canonical content hash",
      "link editable exports as immutable source-version companion artifacts",
      "update display path metadata without rewriting historical versions",
      "stage OSHA citation links for review; do not auto-approve control mappings",
      manifest.snapshot.complete
        ? "soft-retire previously seen provider items absent from this successful full snapshot"
        : "do not retire absent items because this is a partial snapshot",
    ],
  };
}

async function edgeRequest(url, token, body, timeoutMs = 60_000) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { message: responseText.slice(0, 1500) };
  }
  if (!response.ok) {
    throw new Error(
      `ingestion service ${response.status} ${response.statusText}: ${
        responseBody.message ?? JSON.stringify(responseBody)
      }`,
    );
  }
  return responseBody;
}

function validatePrepareResponse(prepared, artifactsByStorageKey) {
  if (
    typeof prepared.runId !== "string" ||
    typeof prepared.commitToken !== "string" ||
    !Array.isArray(prepared.uploads)
  ) {
    throw new Error("prepare response is missing runId, commitToken, or uploads");
  }
  const seen = new Set();
  for (const upload of prepared.uploads) {
    if (
      typeof upload.storageObjectKey !== "string" ||
      typeof upload.putUrl !== "string"
    ) {
      throw new Error("prepare response contains an invalid upload intent");
    }
    if (!artifactsByStorageKey.has(upload.storageObjectKey)) {
      throw new Error(
        `prepare requested an object absent from the signed manifest: ${upload.storageObjectKey}`,
      );
    }
    if (seen.has(upload.storageObjectKey)) {
      throw new Error(
        `prepare returned a duplicate upload intent: ${upload.storageObjectKey}`,
      );
    }
    seen.add(upload.storageObjectKey);
    const putUrl = new URL(upload.putUrl);
    if (putUrl.protocol !== "https:") {
      throw new Error("signed upload URLs must use HTTPS");
    }
  }
}

async function uploadPreparedArtifacts(prepared, artifactsByStorageKey) {
  let uploaded = 0;
  for (const upload of prepared.uploads) {
    const artifact = artifactsByStorageKey.get(upload.storageObjectKey);
    const bytes = await readFile(artifact.absoluteFile);
    const headers = new Headers(upload.headers ?? {});
    if (!headers.has("content-type")) {
      headers.set("content-type", artifact.mimeType);
    }
    if (upload.requiredSha256Header) {
      headers.set(upload.requiredSha256Header, artifact.sha256);
    }

    const response = await fetch(upload.putUrl, {
      method: upload.method ?? "PUT",
      headers,
      body: bytes,
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 1500);
      throw new Error(
        `upload failed for ${upload.storageObjectKey}: ${response.status} ${response.statusText} ${details}`,
      );
    }
    uploaded += 1;
  }
  return uploaded;
}

async function applyManifest(manifest, artifactsByStorageKey) {
  const endpoint = process.env.SAFETYOPS_DRIVE_INGEST_URL?.replace(/\/+$/, "");
  const token = process.env.SAFETYOPS_DRIVE_INGEST_TOKEN;
  if (!endpoint || !token) {
    throw new Error(
      "SAFETYOPS_DRIVE_INGEST_URL and SAFETYOPS_DRIVE_INGEST_TOKEN are required for --apply",
    );
  }
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:") {
    throw new Error("SAFETYOPS_DRIVE_INGEST_URL must use HTTPS");
  }

  const prepared = await edgeRequest(`${endpoint}/prepare`, token, {
    protocolVersion: "1.0",
    manifest,
  });
  validatePrepareResponse(prepared, artifactsByStorageKey);
  const uploaded = await uploadPreparedArtifacts(
    prepared,
    artifactsByStorageKey,
  );
  const committed = await edgeRequest(
    `${endpoint}/commit`,
    token,
    {
      protocolVersion: "1.0",
      runId: prepared.runId,
      commitToken: prepared.commitToken,
      manifestId: manifest.manifestId,
      manifestSha256: manifest.manifestSha256,
    },
    120_000,
  );

  return {
    runId: prepared.runId,
    uploaded,
    skippedExisting:
      artifactsByStorageKey.size - prepared.uploads.length,
    commit: committed,
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (caught) {
    console.error(caught.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.manifestPath || !options.artifactRoot) {
    console.error("manifest path and --artifact-root are required");
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  const validation = validateDriveManifest(manifest, {
    requireDigest: true,
    requireCompleteSnapshot: options.apply,
  });
  if (!validation.valid) {
    for (const entry of validation.errors) {
      console.error(`error ${entry.path}: ${entry.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const { artifactsByStorageKey, totalBytes } = await verifyArtifacts(
    manifest,
    options.artifactRoot,
  );
  const plan = buildPlan(manifest, totalBytes);

  if (!options.apply) {
    if (options.planJson) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`DRY RUN manifest=${manifest.manifestId}`);
      console.log(`company=${manifest.tenant.companyId}`);
      console.log(`manifestSha256=${manifest.manifestSha256}`);
      console.log(
        `items=${plan.counts.items} ingestItems=${plan.counts.ingestItems} artifacts=${plan.counts.artifacts} bytes=${plan.counts.bytes} citations=${plan.counts.citations}`,
      );
      for (const effect of plan.effects) console.log(`- ${effect}`);
    }
    return;
  }

  if (
    !options.confirmCompany ||
    options.confirmCompany.toLowerCase() !==
      manifest.tenant.companyId.toLowerCase()
  ) {
    throw new Error(
      "--confirm-company must exactly match the manifest company ID",
    );
  }

  const result = await applyManifest(manifest, artifactsByStorageKey);
  console.log(`COMMITTED run=${result.runId}`);
  console.log(
    `uploaded=${result.uploaded} skippedExisting=${result.skippedExisting}`,
  );
  console.log(JSON.stringify(result.commit, null, 2));
}

await main().catch((caught) => {
  console.error(caught.stack ?? caught.message);
  process.exitCode = 1;
});
