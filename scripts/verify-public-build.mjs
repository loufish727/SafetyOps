import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, sign, verify } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const publicBuildRoot = path.resolve(projectRoot, "dist");
const allowedPublicFiles = new Set([
  "app.js",
  "data.js",
  "index.html",
  "osha-reference.js",
  "safety-program-extracts.js",
  "safety-programs.js",
  "safety-source-lineage.js",
  "state-osha-reference.js",
  "styles.css",
  "supabase-config.js",
  "tenant-bootstrap.js",
  "vendor/supabase.js"
]);

const privateDenylistPath = path.resolve(projectRoot, "private", "public-boundary-denylist.json");
const privateAttestationKeyPath = path.resolve(
  projectRoot,
  "private",
  "public-build-attestation-private-key.pem"
);
const publicAttestationPath = path.resolve(projectRoot, "public-build-attestation.json");
const publicAttestationSignaturePath = path.resolve(
  projectRoot,
  "public-build-attestation.sig"
);
const publicAttestationKeyPath = path.resolve(
  projectRoot,
  "public-build-attestation-public-key.pem"
);
const attestationPurpose =
  "Exact deployable artifact and sanitized release tree approved after the local private-tenant boundary scan; contains public file hashes only.";
const expectedSupabaseVendorSha256 =
  "7e94b62086deecef8c0ba3b38f514e2a1944ff6c81d92fb3ff967828c406c38f";
const shouldWriteAttestation = process.argv.includes("--write-attestation");
const shouldVerifyAttestation = process.argv.includes("--verify-attestation");
let tenantMarkers = [];
let knownTenantDriveIds = [];
let tenantLocationNames = [];
let privateDenylistLoaded = false;
const excludedReleaseScanDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "playwright-report",
  "private",
  "test-results"
]);
const excludedReleaseAttestationFiles = new Set([
  "public-build-attestation.json",
  "public-build-attestation.sig"
]);
const excludedLocalReleaseFiles = new Set([
  "debug.log",
  "supabase-config.local.js"
]);

function trackedSensitivePathLabel(relativePath) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  const filename = segments.at(-1) || "";
  const excludedDirectory = segments
    .slice(0, -1)
    .find((segment) => excludedReleaseScanDirectories.has(segment.toLowerCase()));
  if (excludedDirectory) {
    return `${excludedDirectory}/[tracked-excluded-file]`;
  }
  if (
    filename === ".env"
    || (
      filename.startsWith(".env.")
      && !filename.endsWith(".example")
    )
  ) {
    return "[tracked-environment-file]";
  }
  if (filename === "debug.log") return "[tracked-debug-log]";
  if (filename === "supabase-config.local.js") {
    return "[tracked-local-config]";
  }
  return null;
}

async function inspectTrackedSensitivePaths(violations) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      }
    ));
  } catch {
    throw new Error(
      "Public-boundary verification requires a Git checkout so tracked sensitive paths can be rejected."
    );
  }

  for (const trackedPath of stdout.split("\0").filter(Boolean)) {
    const safeLabel = trackedSensitivePathLabel(trackedPath);
    if (safeLabel) {
      violations.push({
        file: safeLabel,
        reason:
          "tracked sensitive or excluded paths are forbidden in the public repository"
      });
    }
  }
}

function applyDenylist(parsed) {
  tenantMarkers = Array.isArray(parsed.tenantMarkers) ? parsed.tenantMarkers : [];
  knownTenantDriveIds = Array.isArray(parsed.driveIds) ? parsed.driveIds : [];
  tenantLocationNames = Array.isArray(parsed.locationNames) ? parsed.locationNames : [];
  privateDenylistLoaded = true;
}

async function loadPrivateDenylist() {
  const secretDenylist = process.env.SAFETYOPS_PUBLIC_BOUNDARY_DENYLIST_JSON;
  if (secretDenylist) {
    applyDenylist(JSON.parse(secretDenylist));
    return;
  }
  try {
    applyDenylist(JSON.parse(await readFile(privateDenylistPath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (
    privateDenylistLoaded
    && !tenantMarkers.length
    && !knownTenantDriveIds.length
    && !tenantLocationNames.length
  ) {
    throw new Error("The private tenant denylist is empty.");
  }
  if (shouldWriteAttestation && !privateDenylistLoaded) {
    throw new Error(
      "Writing a public-build attestation requires the local private tenant denylist."
    );
  }
}

const driveIdentityPatterns = [
  {
    label: "Google Drive file identity",
    expression:
      /https:\/\/drive\.google\.com\/(?:file\/d\/|drive\/folders\/|open\?id=)[A-Za-z0-9_-]{20,}/
  },
  {
    label: "Google document identity",
    expression:
      /https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/[A-Za-z0-9_-]{20,}/
  },
  {
    label: "Google Drive lineage identity",
    expression: /google-drive:[A-Za-z0-9_-]{20,}/
  }
];
const sensitiveCredentialPatterns = [
  {
    label: "private key material",
    expression: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/
  },
  {
    label: "GitHub access token",
    expression: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/
  },
  {
    label: "AWS access key",
    expression: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    label: "OpenAI API key",
    expression: /\bsk-[A-Za-z0-9_-]{20,}\b/
  }
];

function displayPath(absolutePath) {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

async function createFileEntries(files, root) {
  const entries = [];
  for (const file of files) {
    const content = await readFile(file);
    entries.push({
      path: path.relative(root, file).split(path.sep).join("/"),
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex")
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function aggregateFileEntries(entries) {
  const aggregateInput = entries
    .map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`)
    .join("");
  return createHash("sha256").update(aggregateInput).digest("hex");
}

async function createAttestation(deployableFiles, releaseTreeFiles) {
  const files = await createFileEntries(deployableFiles, publicBuildRoot);
  const releaseFiles = await createFileEntries(releaseTreeFiles, projectRoot);
  return {
    schemaVersion: 2,
    purpose: attestationPurpose,
    files,
    aggregateSha256: aggregateFileEntries(files),
    releaseFiles,
    releaseAggregateSha256: aggregateFileEntries(releaseFiles)
  };
}

function hasExactKeys(value, expectedKeys) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...expectedKeys].sort())
  );
}

function isStrictAttestation(value) {
  return (
    hasExactKeys(value, [
      "schemaVersion",
      "purpose",
      "files",
      "aggregateSha256",
      "releaseFiles",
      "releaseAggregateSha256"
    ])
    && value.schemaVersion === 2
    && value.purpose === attestationPurpose
    && typeof value.aggregateSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.aggregateSha256)
    && typeof value.releaseAggregateSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.releaseAggregateSha256)
    && Array.isArray(value.files)
    && Array.isArray(value.releaseFiles)
    && [...value.files, ...value.releaseFiles].every((entry) => (
      hasExactKeys(entry, ["path", "bytes", "sha256"])
      && typeof entry.path === "string"
      && Number.isSafeInteger(entry.bytes)
      && entry.bytes >= 0
      && typeof entry.sha256 === "string"
      && /^[0-9a-f]{64}$/.test(entry.sha256)
    ))
  );
}

async function compareAttestation(actual, violations) {
  let expectedRaw;
  let expected;
  try {
    expectedRaw = await readFile(publicAttestationPath, "utf8");
    expected = JSON.parse(expectedRaw);
  } catch (error) {
    violations.push({
      file: "public-build-attestation.json",
      reason:
        error?.code === "ENOENT"
          ? "required public-build attestation is missing"
          : `public-build attestation could not be read: ${error.message}`
    });
    return;
  }
  if (!isStrictAttestation(expected)) {
    violations.push({
      file: "public-build-attestation.json",
      reason: "public-build attestation does not match the strict schema"
    });
    return;
  }
  try {
    const [publicKey, signatureBase64] = await Promise.all([
      readFile(publicAttestationKeyPath, "utf8"),
      readFile(publicAttestationSignaturePath, "utf8")
    ]);
    const signature = Buffer.from(signatureBase64.trim(), "base64");
    if (
      signature.length === 0
      || !verify(null, Buffer.from(expectedRaw, "utf8"), publicKey, signature)
    ) {
      violations.push({
        file: "public-build-attestation.sig",
        reason: "public-build attestation signature is invalid"
      });
    }
  } catch (error) {
    violations.push({
      file: "public-build-attestation.sig",
      reason:
        error?.code === "ENOENT"
          ? "public-build attestation key or signature is missing"
          : `public-build attestation signature could not be verified: ${error.message}`
    });
  }
  if (
    expected?.schemaVersion !== actual.schemaVersion
    || expected?.purpose !== actual.purpose
    || expected?.aggregateSha256 !== actual.aggregateSha256
    || expected?.releaseAggregateSha256 !== actual.releaseAggregateSha256
    || JSON.stringify(expected?.files) !== JSON.stringify(actual.files)
    || JSON.stringify(expected?.releaseFiles) !== JSON.stringify(actual.releaseFiles)
  ) {
    violations.push({
      file: "public-build-attestation.json",
      reason:
        "public build differs from the artifact approved by the local private-tenant boundary scan"
    });
  }
}

async function collectFiles(directory, violations) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      violations.push({
        file: displayPath(absolutePath),
        reason: "symbolic links are not allowed in the public build"
      });
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === "private") {
        violations.push({
          file: displayPath(absolutePath),
          reason: "private directory is present in the public build"
        });
        continue;
      }
      files.push(...(await collectFiles(absolutePath, violations)));
      continue;
    }

    if (entry.isFile()) files.push(absolutePath);
  }

  return files;
}

async function collectReleaseTreeFiles(directory, violations) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      violations.push({
        file: displayPath(absolutePath),
        reason: "symbolic links are not allowed in the release tree"
      });
      continue;
    }
    if (entry.isDirectory()) {
      if (excludedReleaseScanDirectories.has(entry.name.toLowerCase())) {
        continue;
      }
      files.push(...(await collectReleaseTreeFiles(absolutePath, violations)));
      continue;
    }
    if (entry.isFile()) {
      const relativePath = displayPath(absolutePath);
      const isLocalEnvironmentFile = (
        entry.name === ".env"
        || (
          entry.name.startsWith(".env.")
          && !entry.name.endsWith(".example")
        )
      );
      if (
        excludedLocalReleaseFiles.has(relativePath)
        || isLocalEnvironmentFile
      ) {
        continue;
      }
      files.push(absolutePath);
    }
  }
  return files;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inspectText(file, text, violations) {
  for (const marker of tenantMarkers) {
    if (text.toLowerCase().includes(marker.toLowerCase())) {
      violations.push({
        file: displayPath(file),
        reason: "known private tenant marker"
      });
    }
  }

  for (const driveId of knownTenantDriveIds) {
    if (text.includes(driveId)) {
      violations.push({
        file: displayPath(file),
        reason: "known private tenant Drive identity"
      });
    }
  }

  for (const pattern of driveIdentityPatterns) {
    if (pattern.expression.test(text)) {
      violations.push({
        file: displayPath(file),
        reason: pattern.label
      });
    }
  }

  const containsKnownLocation = tenantLocationNames
    .filter((name) => typeof name === "string" && name.trim())
    .some((name) => (
      new RegExp(`\\b${escapeRegularExpression(name.trim())}\\b`, "i").test(text)
    ));
  if (containsKnownLocation) {
    violations.push({
      file: displayPath(file),
      reason: "known private tenant location marker"
    });
  }

  for (const pattern of sensitiveCredentialPatterns) {
    if (pattern.expression.test(text)) {
      violations.push({
        file: displayPath(file),
        reason: pattern.label
      });
    }
  }
}

function containsTenantMappingKey(value) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsTenantMappingKey(entry));
  }
  if (!value || typeof value !== "object") return false;

  const forbiddenKeys = new Set([
    "assignedlocations",
    "assignments",
    "companies",
    "company",
    "companyid",
    "company_id",
    "locationid",
    "locationids",
    "location_id",
    "location_ids",
    "locations",
    "mappings",
    "siteid",
    "siteids",
    "site_id",
    "site_ids",
    "sites",
    "tenant",
    "tenantid",
    "tenant_id"
  ]);
  return Object.entries(value).some(([key, nestedValue]) => (
    forbiddenKeys.has(key.toLowerCase())
    || containsTenantMappingKey(nestedValue)
  ));
}

async function inspectPublicSeedData(violations) {
  const context = vm.createContext({ window: {} });
  const seedFiles = [
    "data.js",
    "safety-programs.js",
    "safety-source-lineage.js",
    "safety-program-extracts.js",
    "osha-reference.js",
    "state-osha-reference.js"
  ];
  for (const filename of seedFiles) {
    const source = await readFile(path.join(publicBuildRoot, filename), "utf8");
    try {
      vm.runInContext(source, context, {
        filename,
        timeout: 2_000
      });
    } catch (error) {
      violations.push({
        file: `dist/${filename}`,
        reason: `public seed could not be evaluated: ${error.message}`
      });
    }
  }

  const tenant = context.window.SafetyOpsData;
  if (!tenant || tenant.company !== null || tenant.currentUser !== null) {
    violations.push({
      file: "dist/data.js",
      reason: "public tenant seed must have null company and currentUser"
    });
  }
  for (const key of [
    "locations",
    "tasks",
    "inspectionTemplates",
    "inspections",
    "courses",
    "people",
    "incidents",
    "actions",
    "documents",
    "activity",
    "programAssignments",
    "programSubmissions"
  ]) {
    if (!Array.isArray(tenant?.[key]) || tenant[key].length !== 0) {
      violations.push({
        file: "dist/data.js",
        reason: `public tenant collection ${key} must be an empty array`
      });
    }
  }

  const programs = context.window.SafetyOpsProgramLibrary;
  for (const key of ["programs", "forms", "folders", "looseResources"]) {
    if (!Array.isArray(programs?.[key]) || programs[key].length !== 0) {
      violations.push({
        file: "dist/safety-programs.js",
        reason: `public safety-program collection ${key} must be an empty array`
      });
    }
  }

  const regulatory = context.window.SafetyOpsRegulatoryData;
  if (!Array.isArray(regulatory?.regulatoryLinks) || regulatory.regulatoryLinks.length !== 0) {
    violations.push({
      file: "dist/osha-reference.js",
      reason: "public regulatory catalogue must not contain tenant control links"
    });
  }
  const mappedPlan = (regulatory?.statePlans || []).find((plan) =>
    Array.isArray(plan.locationIds) && plan.locationIds.length > 0
  );
  if (mappedPlan) {
    violations.push({
      file: "dist/osha-reference.js",
      reason: `public state plan ${mappedPlan.id || "unknown"} contains tenant location IDs`
    });
  }

  const stateRegulatory = context.window.SafetyOpsStateRegulatoryData;
  if (
    !stateRegulatory
    || !Array.isArray(stateRegulatory.jurisdictions)
    || !Array.isArray(stateRegulatory.standards)
    || !Array.isArray(stateRegulatory.resources)
  ) {
    violations.push({
      file: "dist/state-osha-reference.js",
      reason: "public state reference catalogue has an invalid structure"
    });
  }
  if (containsTenantMappingKey(stateRegulatory)) {
    violations.push({
      file: "dist/state-osha-reference.js",
      reason: "public state reference catalogue contains tenant-mapping fields"
    });
  }
}

async function main() {
  await loadPrivateDenylist();
  const violations = [];
  await inspectTrackedSensitivePaths(violations);
  let buildStats;
  try {
    buildStats = await stat(publicBuildRoot);
  } catch {
    throw new Error(
      `Public build is missing at ${publicBuildRoot}. Run npm run build first.`
    );
  }

  if (!buildStats.isDirectory()) {
    throw new Error(`Public build path is not a directory: ${publicBuildRoot}`);
  }

  const files = await collectFiles(publicBuildRoot, violations);
  const releaseTreeFiles = (await collectReleaseTreeFiles(projectRoot, violations))
    .filter((file) => !excludedReleaseAttestationFiles.has(displayPath(file)));
  let scannedBytes = 0;

  for (const file of files) {
    const relativeBuildPath = path
      .relative(publicBuildRoot, file)
      .split(path.sep)
      .join("/");
    if (!allowedPublicFiles.has(relativeBuildPath)) {
      violations.push({
        file: displayPath(file),
        reason: "file is not in the explicit public-build allowlist"
      });
    }
    const content = await readFile(file);
    scannedBytes += content.byteLength;
    inspectText(file, content.toString("utf8"), violations);
  }
  for (const file of releaseTreeFiles) {
    const content = await readFile(file);
    inspectText(file, content.toString("utf8"), violations);
  }
  for (const expectedFile of allowedPublicFiles) {
    if (!files.some((file) => (
      path.relative(publicBuildRoot, file).split(path.sep).join("/") === expectedFile
    ))) {
      violations.push({
        file: `dist/${expectedFile}`,
        reason: "required public-build file is missing"
      });
    }
  }
  await inspectPublicSeedData(violations);
  const publicSupabaseVendor = await readFile(
    path.join(publicBuildRoot, "vendor", "supabase.js")
  );
  const publicSupabaseVendorSha256 = createHash("sha256")
    .update(publicSupabaseVendor)
    .digest("hex");
  if (publicSupabaseVendorSha256 !== expectedSupabaseVendorSha256) {
    violations.push({
      file: "dist/vendor/supabase.js",
      reason: "vendored Supabase client does not match the reviewed digest"
    });
  }
  const attestation = await createAttestation(files, releaseTreeFiles);
  if (shouldVerifyAttestation) {
    await compareAttestation(attestation, violations);
  }

  if (violations.length) {
    console.error(
      `Public-boundary verification failed with ${violations.length} violation${violations.length === 1 ? "" : "s"}:`
    );
    for (const violation of violations) {
      console.error(`- ${violation.file}: ${violation.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  if (shouldWriteAttestation) {
    const attestationText = `${JSON.stringify(attestation, null, 2)}\n`;
    const [privateKey, publicKey] = await Promise.all([
      readFile(privateAttestationKeyPath, "utf8"),
      readFile(publicAttestationKeyPath, "utf8")
    ]);
    const attestationSignature = sign(
      null,
      Buffer.from(attestationText, "utf8"),
      privateKey
    );
    if (
      !verify(
        null,
        Buffer.from(attestationText, "utf8"),
        publicKey,
        attestationSignature
      )
    ) {
      throw new Error(
        "The local attestation private key does not match the committed public key."
      );
    }
    await writeFile(
      publicAttestationPath,
      attestationText,
      "utf8"
    );
    await writeFile(
      publicAttestationSignaturePath,
      `${attestationSignature.toString("base64")}\n`,
      "utf8"
    );
  }

  console.log(
    `Public boundary verified: ${files.length} deployable files (${scannedBytes.toLocaleString()} bytes) and ${releaseTreeFiles.length} release-tree files contain no known tenant markers, Drive identities, credentials, or private directories.${shouldWriteAttestation ? " Signed public hash attestation written." : ""}${shouldVerifyAttestation ? " Signed public hash attestation matched." : ""}`
  );
}

await main();
