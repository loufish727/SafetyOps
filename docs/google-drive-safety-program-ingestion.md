# Google Drive Safety Programs ingestion

## Outcome

This design imports one explicitly shared, private Google Drive folder tree into immutable Supabase document versions. GitHub Pages reads only authorized document metadata through Supabase Row Level Security; it never receives a Google credential, Supabase service-role key, provider item ID, raw manifest, or unrestricted Storage URL.

The implementation scaffold consists of:

- `scripts/export-google-drive-safety-programs.mjs`: enumerate the source tree, export supported files, hash the bytes, and produce a signed-by-digest manifest.
- `scripts/validate-drive-safety-manifest.mjs`: validate a manifest locally without network access and optionally re-hash all staged artifacts.
- `scripts/ingest-google-drive-safety-manifest.mjs`: default-safe dry run plus a `prepare -> signed upload -> commit` Edge Function protocol.
- `scripts/drive-ingest-core.mjs`: shared MIME policy, deterministic path/object-key functions, canonical JSON hashing, and semantic validation.
- `docs/google-drive-safety-program-manifest.schema.json`: JSON Schema 2020-12 contract.
- `docs/google-drive-safety-program-manifest.example.json`: structurally valid synthetic example. Its hashes are illustrative; no example artifact files are included.

The scaffold does not add a database migration or Edge Function. Production `--apply` intentionally cannot bypass that server-side boundary; implement the protocol below before enabling imports.

## Trust boundary

```text
Private Google Drive root
  -> dedicated read-only ingestion identity
  -> isolated exporter/staging directory
  -> immutable manifest + byte hashes
  -> dedicated Supabase Edge Function
       -> signed uploads to private Storage
       -> transactional metadata/RLS tables
       -> OSHA citation review queue
  -> authenticated GitHub Pages client
       -> RLS-filtered catalog metadata
       -> short-lived authorized download URL
```

Use a dedicated Google service account or dedicated Workspace integration identity. Grant only:

- OAuth scope `https://www.googleapis.com/auth/drive.readonly`.
- Viewer access to the single `Safety Programs` root or its Shared Drive.
- No domain-wide delegation unless a documented business requirement makes it unavoidable.
- No access to unrelated Drives, mail, calendars, or user profiles.

Keep the Google credential in an ingestion runtime secret store. Do not put it in the repository, browser bundle, manifest, Supabase table, or GitHub Pages environment. Prefer short-lived access tokens or workload identity over a long-lived downloaded service-account key. Rotate credentials, log the service identity, and review root-folder sharing periodically.

The importer accepts a one-purpose ingestion token for a dedicated Edge Function. It deliberately does not accept a Supabase service-role key. The Edge Function may hold server credentials, but must validate token subject, allowed company, allowed connection key, manifest digest, object-key prefix, MIME allowlist, and maximum size before performing privileged work.

## File and export policy

| Drive source MIME type | Canonical artifact | Optional editable artifact | Drive API operation |
| --- | --- | --- | --- |
| `application/pdf` | PDF | none | `files.get?alt=media` |
| `application/vnd.google-apps.document` | PDF | DOCX | `files.export` |
| `application/vnd.google-apps.spreadsheet` | PDF | XLSX | `files.export` |
| `application/vnd.google-apps.folder` | metadata only | none | folder traversal |
| Other types and shortcuts | metadata only with skip reason | none | do not follow or ingest |

The PDF is the canonical review and display rendition. DOCX/XLSX is a supporting editable artifact and must not replace the canonical PDF hash. Google native files do not expose a useful downloaded-file MD5; always hash the actual exported bytes with SHA-256. For uploaded PDFs, retain Drive's MD5 only as provider metadata and still calculate SHA-256 locally.

At commit, the manifest's `canonical` object becomes the immutable
`safety_program_source_versions.storage_object_id`. A Google Doc's editable
DOCX maps to `safety_program_source_version_artifacts.artifact_kind =
native_companion`; a Sheet's XLSX maps to `spreadsheet_export`. Record the Drive
API operation, export MIME, provider revision, exporter version, and canonical
hash in derivation/source metadata.

Google's `files.export` endpoint limits exported content size. A failed required export makes the run incomplete and must prevent a `full/complete` manifest from being committed. Large or poorly rendered Sheets require an explicit remediation workflow—split the workbook, approve a different export adapter, or ingest per-sheet representations—rather than silently omitting content.

Shortcuts are not followed because their target can be outside the approved root and can create duplicate or cyclic lineage. Unsupported items remain visible to operators as `metadata-only`; they are not silently discarded.

## Deterministic identity, paths, and versions

Drive names and folders are mutable presentation metadata. Drive file IDs are provider identity. Content hashes are version identity.

### Provider identity

The manifest's logical source item key is:

```text
(company_id, provider="google-drive", connection_key, provider_item_id)
```

At commit, map this to the deployed source identity
`(company_id, provider="google_drive", external_drive_id, external_file_id)` in
`safety_program_source_documents`; retain `connection_key`, root ID, and paths in
the run/source metadata. A rename or move updates current presentation metadata
but does not create a new source identity or rewrite an old source version. A
copied Drive file has a different provider ID and is treated as a separate
logical item even if its bytes match.

### Display and navigation paths

The manifest stores both `pathSegments` and `pathIds`. Each display segment is Unicode NFKC-normalized, stripped of control characters, trimmed, and made separator-safe. `displayPath` joins normalized names for people. `pathKey` joins:

```text
slug(normalized name) + "--" + first 12 hex characters of SHA-256(provider item ID)
```

The ID-derived suffix prevents collisions between same-named siblings. Moves change `pathKey`; provider identity and object storage do not.

### Content and version identity

Each exported artifact receives SHA-256 over its exact bytes. A new SafetyOps document version is created only when the canonical artifact SHA-256 changes. Drive `version`, `modifiedTime`, and MD5 are retained as lineage evidence but never used as the authoritative content-version key.

SafetyOps' sequential `safety_program_versions.version` must be allocated
transactionally on the server when an imported source is promoted into a
controlled program. Do not copy Drive's `version` into this field.

### Storage object key

The object key is derived, never accepted as an arbitrary caller-selected path:

```text
{company_uuid}/imports/google-drive/{connection_key}/
items/{first_32_hex_sha256_of_provider_item_id}/
versions/sha256-{artifact_sha256}/{role}.{extension}
```

Objects are immutable and hash-addressed. Upload with overwrite disabled. A retry that finds the same object key verifies size/hash metadata and reuses it; it never replaces it.

### Manifest integrity

The manifest uses canonical JSON with recursively sorted object keys and preserved array order. `manifestSha256` is SHA-256 of the canonical manifest after removing the `manifestSha256` property. Items are sorted by `pathKey`, then provider ID; artifacts are sorted by role, then MIME type.

A manifest ID and digest pair is immutable. Reusing a manifest ID with different bytes is a hard rejection. Adding a title, location, or OSHA citation requires a new digest and a fresh validation.

## Manifest contract

The JSON Schema is in `google-drive-safety-program-manifest.schema.json`. The custom validator adds constraints that JSON Schema cannot conveniently express:

- Root item matches the declared root folder.
- Provider IDs and derived path/storage keys are unique and consistent.
- Parent chains are complete for a full snapshot.
- PDF, Docs, and Sheets artifacts exactly follow the MIME policy.
- All object and staged paths are traversal-safe.
- Artifact arrays and item arrays have deterministic order.
- Manifest digest matches the canonical content.
- Citation authority, jurisdiction, relation, and review state are valid.

`snapshot.kind="full"` requires `complete=true`. Only a successfully traversed and exported full snapshot may soft-retire source items absent from the new tree. A partial snapshot can add or update items but must never infer deletion.

## Idempotent server flow

Implement one dedicated Edge Function endpoint, for example:

```text
https://{project}.supabase.co/functions/v1/drive-safety-ingest
```

### 1. Prepare

The client posts to `/prepare`:

```json
{
  "protocolVersion": "1.0",
  "manifest": {}
}
```

The server:

1. Authenticates the ingestion identity and checks its company/connection allowlist.
2. Revalidates schema, semantic invariants, digest, complete-snapshot claim, sizes, and MIME types.
3. Inserts or reuses an `ingest_run` keyed by company, manifest ID, and digest.
4. Upserts provider identities by the logical key above without publishing a new document version.
5. Looks up immutable artifact keys and returns signed upload intents only for missing objects.
6. Records expected hashes and byte lengths in a staged state.

Response contract:

```json
{
  "runId": "server-generated-id",
  "commitToken": "single-run-opaque-token",
  "uploads": [
    {
      "storageObjectKey": "<company-uuid>/.../canonical.pdf",
      "putUrl": "https://signed-upload-url",
      "method": "PUT",
      "headers": {},
      "requiredSha256Header": "x-safetyops-sha256"
    }
  ]
}
```

Every requested object key must already exist in the signed manifest. The local importer refuses unexpected keys or non-HTTPS upload URLs.

### 2. Upload

The client verifies each staged file's byte length and SHA-256 before upload. It uploads only the objects requested by `/prepare`. Signed URLs must be short-lived, single-object, write-only, and restricted to the declared MIME and maximum bytes.

### 3. Commit

The client posts to `/commit` with `runId`, `commitToken`, manifest ID, and digest. In one database transaction the server:

1. Verifies every required object exists and matches expected metadata; creates
   `safety_program_storage_objects` as `pending` and completes the configured
   malware/content scan before the object can be treated as clean.
2. Upserts `safety_program_source_documents` metadata and current presentation data.
3. Reuses an existing `safety_program_source_versions` row when canonical SHA-256 already exists.
4. Otherwise inserts the canonical private object and source version, then records optional DOCX/XLSX companions in `safety_program_source_version_artifacts` with derivation metadata.
5. If the import is promoted into a controlled program, creates a draft `safety_program_versions` row and links it through `safety_program_version_sources`; publishing remains a separate reviewed workflow.
6. Applies `safety_program_location_applicability` only after validating company and location ownership.
7. Stages OSHA citation references; it does not auto-approve regulatory mappings.
8. Advances any current source/program pointer only after all required records are durable.
9. For a successful full snapshot, soft-retires missing provider items. It never hard-deletes prior program/source versions, acknowledgements, source artifacts, or lineage.
10. Writes an append-only audit event and marks the run committed.

Storage and Postgres are not one atomic transaction. The prepare/commit protocol makes retries safe: an interrupted upload can resume; an interrupted commit reuses the same run and hashes. A scheduled cleanup may remove uncommitted orphan objects only after a conservative retention window and an audit check.

The safety-program migration already supplies the principal source uniqueness
constraints; the Edge Function must use them rather than inventing a second
identity model:

- `(company_id, provider, external_drive_id, external_file_id)` on `safety_program_source_documents`
- `(source_document_id, provider_revision_id)` and `(source_document_id, content_sha256)` on `safety_program_source_versions`
- `(source_version_id, storage_object_id, artifact_kind)` on `safety_program_source_version_artifacts`
- unique immutable object path on `safety_program_storage_objects`

Add a private ingestion-run table or equivalent durable idempotency record with
`(company_id, manifest_id)` uniqueness and an immutable digest check. Stage raw
citations against the resulting source/program version until they can satisfy
the reviewed `safety_program_regulatory_links` contract.

Use a dedicated, auditable system profile as `created_by`; do not impersonate the safety manager or leave authorship null.

## Supabase private-storage and client boundary

Use the dedicated `safety-program-private` bucket created by the safety-program
migration rather than broadening the existing evidence bucket. Keep it
service-controlled and nonpublic. Enforce an allowlist in bucket configuration
or, at minimum, in the Edge Function:

- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`

The migration currently caps an object at 100 MiB. Reject larger objects before
issuing an upload URL, and use the lower Google export limit where it applies.
Enable no public read policy. Do not permit authenticated browser users to list
the bucket. Keep a new object unavailable until its database metadata records a
successful scan and `verified_at`; quarantine `rejected` or `failed` objects.

The GitHub Pages client should query RLS-protected `safety_programs`,
`safety_program_versions`, and applicability/assignment metadata through a
security-invoker view or narrow RPC that exposes only:

- Safety program ID, code, title, category, current published version, effective/review dates, applicable location labels, assignment state, and source freshness status
- canonical file MIME/size and an authorized “download available” flag
- reviewed OSHA citation labels and official source URLs

Keep provider item IDs, raw Drive names if sensitive, manifest/object paths, staging status, unreviewed citations, and ingestion error detail server-side. A download request should call an authorized Edge Function or narrow RPC that rechecks company membership, role, location access, and document classification before issuing a short-lived signed URL.

The static site may contain the Supabase publishable key; it must never contain the Drive credential, ingestion token, service-role key, or a permanent signed URL.

## Promoting an imported form into the template library

Drive ingestion creates immutable source and artifact records; it does not
silently publish an interactive form. A safety administrator reviews the
imported item, creates a draft `safety_program_form_template_version` with
`origin_kind=drive_import`, and links the canonical PDF as its clean primary
`original` through `safety_program_form_template_files`. A DOCX or XLSX
companion may be linked as `editable_source`.

Field extraction may propose an interactive schema, but a person must verify
labels, required fields, signatures, calculations, and source locators before
publication. The published source manifest then pins the exact source and
object hashes. Downloads use the same short-lived authorization flow described
in `form-originals-and-templates.md`; Drive URLs are never used as permanent
application download links.

## OSHA source-lineage hook

`oshaCitations` is a version-specific staging hook, not a compliance conclusion. Each entry records:

- authority class
- raw citation text
- jurisdiction
- relationship such as `implements`, `training-for`, or `record-required-by`
- official HTTPS source URL
- `unverified` or `reviewed`
- optional immutable `regulatoryUnitVersionId`

On commit, retain these fields against the imported source/program version. A resolver may match citation aliases to `regulatory_unit_versions`, but a qualified reviewer must confirm the exact federal or state-plan unit version and location applicability.

After review, create or update the established compliance model:

```text
safety_program_versions
  -> safety_program_regulatory_links
  -> compliance_requirement_versions and/or regulatory_unit_versions
  -> requirement_citations
  -> immutable regulatory source snapshot
```

Never attach an approved mapping directly to “current OSHA.” Pin the exact regulatory version. When a new Drive document version arrives, prior approved mappings remain with the old version; proposed mappings for the new version begin in draft. When a regulatory source changes, the existing impact workflow can find affected document versions through this chain.

State-plan applicability is location-specific. A federal citation used at a Washington, California, or Oregon location may require a state-plan equivalent or supplement. The resolver must use the selected tenant location's regulatory profile instead of assuming the federal citation is sufficient.

## Commands

Export a complete Drive tree:

```powershell
$env:GOOGLE_DRIVE_ACCESS_TOKEN = "<short-lived-read-only-token>"
node scripts/export-google-drive-safety-programs.mjs `
  --root-folder-id "<folder-id>" `
  --company-id "<company-uuid>" `
  --connection-key "safety-programs" `
  --out "work/drive-import/manifest.json" `
  --artifact-dir "work/drive-import/artifacts"
```

Validate offline:

```powershell
node scripts/validate-drive-safety-manifest.mjs `
  work/drive-import/manifest.json `
  --artifact-root work/drive-import/artifacts `
  --require-complete
```

Preview the import without network:

```powershell
node scripts/ingest-google-drive-safety-manifest.mjs `
  work/drive-import/manifest.json `
  --artifact-root work/drive-import/artifacts `
  --plan-json
```

Apply only after the Edge Function and database contract exist:

```powershell
$env:SAFETYOPS_DRIVE_INGEST_URL = "https://<project>.supabase.co/functions/v1/drive-safety-ingest"
$env:SAFETYOPS_DRIVE_INGEST_TOKEN = "<short-lived-ingestion-token>"
node scripts/ingest-google-drive-safety-manifest.mjs `
  work/drive-import/manifest.json `
  --artifact-root work/drive-import/artifacts `
  --apply `
  --confirm-company "<company-uuid>"
```

Clear token environment variables and remove or encrypt staging artifacts after a successful, independently verified commit according to the company's retention policy.

## Production checklist

- [ ] Dedicated Drive identity has `drive.readonly` and access only to the approved root.
- [ ] Domain-wide delegation is absent or separately approved and documented.
- [ ] Root folder ID, Shared Drive ID, company ID, and connection key are allowlisted server-side.
- [ ] Edge Function revalidates the manifest; client validation is not trusted.
- [ ] Dedicated Storage bucket is private, non-listable, MIME-limited, and size-limited.
- [ ] Signed upload/download URLs are short-lived and single-object.
- [ ] Provider identity, content version, artifact, and manifest uniqueness constraints exist.
- [ ] Complete and partial snapshots have different retirement behavior.
- [ ] New canonical hashes create immutable versions; rename/move-only changes do not.
- [ ] Missing items are soft-retired only after a successful full traversal and commit.
- [ ] Unverified OSHA citations cannot become approved control mappings.
- [ ] Static client metadata and download authorization pass RLS/location/classification checks.
- [ ] Audit events identify the ingestion identity, run, manifest digest, source item, and resulting document version.
- [ ] Retry, interrupted upload, interrupted commit, same-manifest replay, rename, move, deletion, and hash-change cases are tested.
- [ ] Credential rotation, staging cleanup, stale-run alerts, and reconciliation are operationalized.
