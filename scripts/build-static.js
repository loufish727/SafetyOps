const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.resolve(root, "dist");

if (!output.startsWith(`${root}${path.sep}`)) {
  throw new Error("Refusing to write outside the SafetyOps project.");
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const files = [
  "index.html",
  "styles.css",
  "app.js",
  "data.js",
  "osha-reference.js",
  "safety-programs.js",
  "safety-source-lineage.js",
  "safety-program-extracts.js",
  "tenant-bootstrap.js",
  "supabase-config.js"
];

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}

console.log(`Built ${files.length} static files in ${output}`);
