import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const publicBuildRoot = path.resolve(projectRoot, "dist");

const privateDenylistPath = path.resolve(projectRoot, "private", "public-boundary-denylist.json");
let tenantMarkers = [];
let knownTenantDriveIds = [];
let tenantLocationNames = [];

async function loadPrivateDenylist() {
  try {
    const parsed = JSON.parse(await readFile(privateDenylistPath, "utf8"));
    tenantMarkers = Array.isArray(parsed.tenantMarkers) ? parsed.tenantMarkers : [];
    knownTenantDriveIds = Array.isArray(parsed.driveIds) ? parsed.driveIds : [];
    tenantLocationNames = Array.isArray(parsed.locationNames) ? parsed.locationNames : [];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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

function displayPath(absolutePath) {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
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

function inspectText(file, text, violations) {
  for (const marker of tenantMarkers) {
    if (text.toLowerCase().includes(marker.toLowerCase())) {
      violations.push({
        file: displayPath(file),
        reason: `known tenant marker: ${marker}`
      });
    }
  }

  for (const driveId of knownTenantDriveIds) {
    if (text.includes(driveId)) {
      violations.push({
        file: displayPath(file),
        reason: `known tenant Drive ID ending in ${driveId.slice(-6)}`
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

  const matchedLocations = tenantLocationNames.filter((name) =>
    new RegExp(`\\b${name}\\b`, "i").test(text)
  );
  if (matchedLocations.length >= 3) {
    violations.push({
      file: displayPath(file),
      reason: `tenant location set: ${matchedLocations.join(", ")}`
    });
  }
}

async function main() {
  await loadPrivateDenylist();
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

  const violations = [];
  const files = await collectFiles(publicBuildRoot, violations);
  let scannedBytes = 0;

  for (const file of files) {
    const content = await readFile(file);
    scannedBytes += content.byteLength;
    inspectText(file, content.toString("utf8"), violations);
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

  console.log(
    `Public boundary verified: ${files.length} files (${scannedBytes.toLocaleString()} bytes) contain no known tenant markers, Drive identities, or private directories.`
  );
}

await main();
