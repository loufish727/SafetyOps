#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  isSafeRelativePath,
  sha256File,
  validateDriveManifest,
} from "./drive-ingest-core.mjs";

function usage() {
  return `Usage:
  node scripts/validate-drive-safety-manifest.mjs <manifest.json> [options]

Options:
  --artifact-root <dir>  Verify staged files, byte lengths, and SHA-256 hashes.
  --require-complete     Reject partial snapshots.
  --json                 Print a machine-readable result.
  --help                 Show this help.

The validator performs no network requests.`;
}

function parseArguments(argv) {
  const options = {
    manifestPath: null,
    artifactRoot: null,
    requireComplete: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifact-root") {
      options.artifactRoot = argv[++index];
      if (!options.artifactRoot) {
        throw new Error("--artifact-root requires a directory");
      }
    } else if (argument === "--require-complete") {
      options.requireComplete = true;
    } else if (argument === "--json") {
      options.json = true;
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

async function verifyStagedArtifacts(manifest, artifactRoot) {
  const errors = [];
  const warnings = [];
  let verifiedArtifacts = 0;
  const absoluteRoot = path.resolve(artifactRoot);

  for (let itemIndex = 0; itemIndex < manifest.items.length; itemIndex += 1) {
    const item = manifest.items[itemIndex];
    for (
      let artifactIndex = 0;
      artifactIndex < item.artifacts.length;
      artifactIndex += 1
    ) {
      const artifact = item.artifacts[artifactIndex];
      const jsonPath = `$.items[${itemIndex}].artifacts[${artifactIndex}]`;
      if (!isSafeRelativePath(artifact.stagedFile)) {
        continue;
      }

      const absoluteFile = path.resolve(
        absoluteRoot,
        ...artifact.stagedFile.split("/"),
      );
      const relativeToRoot = path.relative(absoluteRoot, absoluteFile);
      if (
        relativeToRoot === ".." ||
        relativeToRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRoot)
      ) {
        errors.push({
          path: `${jsonPath}.stagedFile`,
          message: "resolves outside --artifact-root",
        });
        continue;
      }

      let fileStats;
      try {
        fileStats = await stat(absoluteFile);
      } catch (caught) {
        errors.push({
          path: `${jsonPath}.stagedFile`,
          message: `cannot read ${artifact.stagedFile}: ${caught.message}`,
        });
        continue;
      }

      if (!fileStats.isFile()) {
        errors.push({
          path: `${jsonPath}.stagedFile`,
          message: "does not resolve to a regular file",
        });
        continue;
      }
      if (fileStats.size !== artifact.byteLength) {
        errors.push({
          path: `${jsonPath}.byteLength`,
          message: `expected ${artifact.byteLength}, found ${fileStats.size}`,
        });
      }

      const actualSha256 = await sha256File(absoluteFile);
      if (actualSha256 !== artifact.sha256) {
        errors.push({
          path: `${jsonPath}.sha256`,
          message: `expected ${artifact.sha256}, found ${actualSha256}`,
        });
      }

      if (
        fileStats.size === artifact.byteLength &&
        actualSha256 === artifact.sha256
      ) {
        verifiedArtifacts += 1;
      }
    }
  }

  if (verifiedArtifacts === 0) {
    warnings.push({
      path: "$.items",
      message: "no staged artifacts were verified",
    });
  }

  return { errors, warnings, verifiedArtifacts };
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
  if (!options.manifestPath) {
    console.error("a manifest path is required");
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  } catch (caught) {
    console.error(`could not read manifest: ${caught.message}`);
    process.exitCode = 2;
    return;
  }

  const result = validateDriveManifest(manifest, {
    requireDigest: true,
    requireCompleteSnapshot: options.requireComplete,
  });

  let verifiedArtifacts = null;
  if (options.artifactRoot && Array.isArray(manifest.items)) {
    const fileResult = await verifyStagedArtifacts(
      manifest,
      options.artifactRoot,
    );
    result.errors.push(...fileResult.errors);
    result.warnings.push(...fileResult.warnings);
    result.valid = result.errors.length === 0;
    verifiedArtifacts = fileResult.verifiedArtifacts;
  }

  const output = {
    manifest: path.resolve(options.manifestPath),
    valid: result.valid,
    manifestSha256: result.computedManifestSha256,
    stats: result.stats,
    verifiedArtifacts,
    errors: result.errors,
    warnings: result.warnings,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(
      `${result.valid ? "VALID" : "INVALID"} ${options.manifestPath}`,
    );
    console.log(
      `items=${result.stats.items} files=${result.stats.files} folders=${result.stats.folders} artifacts=${result.stats.artifacts} citations=${result.stats.citations}`,
    );
    console.log(`manifestSha256=${result.computedManifestSha256 ?? "unavailable"}`);
    if (verifiedArtifacts !== null) {
      console.log(`verifiedArtifacts=${verifiedArtifacts}`);
    }
    for (const warning of result.warnings) {
      console.warn(`warning ${warning.path}: ${warning.message}`);
    }
    for (const error of result.errors) {
      console.error(`error ${error.path}: ${error.message}`);
    }
  }

  if (!result.valid) {
    process.exitCode = 1;
  }
}

await main();

