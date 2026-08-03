# Form originals, templates, and submissions

SafetyOps keeps three records separate:

- **Original:** the exact PDF, DOCX, XLSX, or approved scan received from Drive or uploaded by a safety administrator. It is stored privately, hash-addressed, malware-scanned, immutable, and released only through a scoped signed download.
- **Template:** the interactive, versioned field schema created from an original or authored directly in SafetyOps. Publishing pins its field hash and, for a source-backed template, its original-file manifest hash.
- **Submission:** one worker's completed answers, attachments, and signatures against one published template version. Submissions never replace the template or original.

Use `safety_program_form_templates` and
`safety_program_form_template_versions` for the Safety Programs template
library. The baseline `form_templates` tables remain the inspection/checklist
model. Do not duplicate a Safety Program form into both models.

## Version rules

- A corrected or replaced original creates a new `safety_program_source_version`,
  storage object, template version, and `safety_program_form_template_files`
  link. Never overwrite an existing object or relink a published template.
- `origin_kind=native` means there is no uploaded source file.
- `origin_kind=manual_upload` or `drive_import` requires exactly one clean,
  primary `original` link before publication.
- Additional roles may provide a fillable PDF, printable copy, editable source,
  or preview. Every role pins an exact source revision and exact object hash.
- Published template fields and file links are immutable. Historical
  submissions continue to resolve their original schema and source bytes.

The Templates screen can therefore list the existing program-bound templates
across all Safety Programs. A third, parallel template model is not required.

## Drive-original access review

Drive archive candidates default to **Company access** only when they are
reusable `internal` forms, program documents, training material, or references.
That scope means any active authenticated member of the same company may list
and download the item; it never means anonymous or public-internet access.

A corporate administrator or safety manager can select **Safety/admin private**
on an eligible item and update its review status. Confidential or restricted
material, completed records, evidence, and unknown kinds are always forced
private by both a normalization trigger and a table constraint. Users cannot
update candidate rows directly; managers use the reviewed RPC, and each actual
change creates an append-only, hash-chained review event.

## Source collection and folder hierarchy

Each Drive candidate carries an immutable `source_collection` derived
server-side from its frozen ingest manifest. The label is a single sanitized
folder name; the browser never receives the raw ZIP source path. The exact
`folder_hint`, source-path fingerprint, and candidate ID remain unchanged for
traceability.

The archive library renders the source collection as the top-level headline
and each slash-separated folder segment as a nested, collapsible category.
Counts are computed only from the candidates already authorized for the
current user, so private-only folders and counts do not leak to ordinary
company members. Files retain their exact source node and sort deterministically
by name, source-path fingerprint, and candidate ID.

## Private manual-upload workflow

The browser never receives a service-role key and never writes directly to the
`safety-program-private` bucket.

1. A corporate administrator or safety manager creates or selects a **draft**
   Safety Program form-template version.
2. The client hashes the selected file with SHA-256 and calls a narrow Edge
   Function `prepare-upload` operation with the draft ID, filename, declared
   MIME, classification, byte count, hash, and an idempotency key.
3. The Edge Function rechecks the caller, tenant, role, draft state, extension,
   size, MIME allowlist, and hash format. It creates a service-only
   `program_private.form_upload_sessions` row and derives a quarantine path
   below `{company_uuid}/quarantine/forms/`.
4. The function returns a short-lived, write-only URL for that exact object.
   The URL cannot list the bucket, select another path, or overwrite an object.
5. On `complete-upload`, the server verifies the stored byte count and SHA-256,
   identifies content from its bytes rather than trusting the extension, checks
   archive-expansion limits, and performs malware scanning.
6. Rejected bytes remain unavailable and the session is marked `rejected`.
   Clean bytes are copied to an immutable hash-derived final key with overwrite
   disabled.
7. In one database transaction, the server inserts:
   - a clean `safety_program_storage_objects` row with
     `purpose=form_original`;
   - a `manual_upload` source document whose external ID is the server upload
     identity;
   - an immutable source version whose provider revision is derived from the
     content hash; and
   - the exact `safety_program_form_template_files` link.
8. The transaction marks the upload session `committed`. Retries with the same
   company, user, and idempotency key return the same result.

Manual uploads are limited to 25 MiB and PDF, DOCX, XLSX, JPEG, or PNG. Reject
macro-enabled Office files, legacy binary Office formats, MIME/extension
mismatches, encrypted archives, and archive bombs. The bucket's broader
allowlist also permits controlled Drive-derived text, JSON, thumbnails, and BMP
source images.

Storage metadata is append-only, so the upload session carries the
`prepared/uploaded/scanning` states. Insert the public storage-object row only
after the scan succeeds, with `malware_scan_status=clean` and `verified_at`
populated.

## Private download workflow

The static client passes only a `form_file_id` to a download Edge Function.
That function invokes `get_safety_program_form_file_metadata` under the
caller's JWT. A result exists only when:

- the object is clean and verified;
- the caller is a company safety administrator; or
- the template and parent program are published and visible to the caller, the
  source classification is `internal`, and any object location is accessible
  to the caller.

`confidential` and `restricted` originals remain manager-only until explicit
document grants are modeled. The metadata RPC intentionally returns no bucket
or object path. After authorization, the Edge Function uses its service client
to fetch the exact path by ID and issues a single-object signed URL lasting no
more than five minutes. Prefer `attachment` disposition for DOCX/XLSX and allow
inline display only for reviewed PDF/image types.

Never store signed URLs, bucket paths, provider credentials, service-role
keys, or originals in GitHub, local storage, template JSON, or public audit
payloads.

## Trace and operations

The committed form-file link is covered by the Safety Programs audit chain.
The Edge Function must also log prepare, scan rejection, commit, and download
decisions with company, actor, upload/link ID, result, and request correlation
ID—never with credentials or signed URLs. Retain or purge rejected quarantine
objects on a documented schedule. Published and otherwise referenced originals
must not be hard-deleted; apply the company's retention and legal-hold policy.
