const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const output = path.resolve(root, "dist");
const expectedSupabaseVendorSha256 =
  "7e94b62086deecef8c0ba3b38f514e2a1944ff6c81d92fb3ff967828c406c38f";

if (!output.startsWith(`${root}${path.sep}`)) {
  throw new Error("Refusing to write outside the SafetyOps project.");
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const supabaseVendorPath = path.join(root, "vendor", "supabase.js");
const supabaseVendorSha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(supabaseVendorPath))
  .digest("hex");
if (supabaseVendorSha256 !== expectedSupabaseVendorSha256) {
  throw new Error(
    "vendor/supabase.js does not match the reviewed @supabase/supabase-js 2.57.4 artifact. Review the upgrade and update the expected digest."
  );
}

const files = [
  "index.html",
  "styles.css",
  "app.js",
  "data.js",
  "osha-reference.js",
  "state-osha-reference.js",
  "safety-programs.js",
  "safety-source-lineage.js",
  "safety-program-extracts.js",
  "tenant-bootstrap.js",
  "supabase-config.js",
  "vendor/supabase.js"
];

for (const file of files) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}

console.log(`Built ${files.length} static files in ${output}`);
