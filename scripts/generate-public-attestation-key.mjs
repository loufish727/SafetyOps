import {
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const privateDirectory = path.resolve(projectRoot, "private");
const privateKeyPath = path.resolve(
  privateDirectory,
  "public-build-attestation-private-key.pem"
);
const publicKeyPath = path.resolve(
  projectRoot,
  "public-build-attestation-public-key.pem"
);

if (!privateKeyPath.startsWith(`${privateDirectory}${path.sep}`)) {
  throw new Error("Refusing to write an attestation key outside private/.");
}
if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
  throw new Error(
    "Attestation key material already exists. Refusing to overwrite the release authority."
  );
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(privateDirectory, { recursive: true });
writeFileSync(
  privateKeyPath,
  privateKey.export({ format: "pem", type: "pkcs8" }),
  { encoding: "utf8", mode: 0o600 }
);
writeFileSync(
  publicKeyPath,
  publicKey.export({ format: "pem", type: "spki" }),
  { encoding: "utf8", mode: 0o644 }
);

console.log(
  "Created a local-only attestation signing key and its public verification key."
);
