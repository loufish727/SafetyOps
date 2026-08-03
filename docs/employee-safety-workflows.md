# Employee safety workflows

This document describes the employee-facing workflow represented by migration
`202608030016_employee_safety_workflows.sql` and the browser application. It is
an engineering contract, not a claim that electronic signatures, retention
periods, or regulatory applicability have received legal approval.

## Facilitated tablet form

Employees are company records and do not need a SafetyOps Auth account. A
safety user performs the authenticated work and hands the device to the
employee:

1. The safety user assigns one published, location-applicable form version to
   an active employee at an authorized location. The dashboard shows the
   assignment as pending (`assigned` or `in_progress`).
2. The safety user selects **Start tablet form**. SafetyOps creates a 15-minute,
   one-time handoff and opens a separate no-opener tab. That tab receives no
   facilitator Auth session and operates only with the public Supabase key and
   the one-time capability.
3. The raw 256-bit token is returned once. PostgreSQL stores only its SHA-256
   digest; the browser does not put the raw token in local or session storage.
   Starting another handoff revokes any prior active handoff for the assignment.
4. The employee completes the pinned form, confirms consent and the employee
   attestation, and types the name held on the assigned employee record. The
   database validates every answer against the exact published field schema and
   pins employee, location, facilitator, form-version, and signature evidence.
5. Submission atomically creates an append-only evidence record, marks the
   assignment `completed`, and consumes the handoff. Expired, revoked,
   completed, or replayed handoffs are rejected.
6. The safety user's dashboard refreshes the assignment to completed. The
   employee record shows pending/completed work and the completion evidence
   digest.

The submission manifest includes the assignment and location, employee and
facilitator snapshots, exact schema and field hashes, canonical answers,
consent and attestation text, signature intent, timestamp, and overdue state.
Its SHA-256 digest is immutable evidence that the stored manifest has not
changed; the digest alone does not establish identity, legal validity, or
regulatory compliance.

Tablet handoff deliberately rejects a form containing a `file` field. Photos,
attachments, and other file-upload questions require a later isolated upload
design; they must not be added to the one-time employee ceremony by bypassing
the assignment RPC.

## Access and regulatory trace

Employee, assignment, training, completion, form, and document reads are
company-scoped and location-specific. A location manager or supervisor may act
only at an authorized location; an employee assigned to multiple locations
does not make their other-location records visible.

Regulatory or policy citations attached to a training requirement or workflow
remain trace inputs, not verified compliance evidence. New citation records
retain a `review_required` trace status until a qualified reviewer resolves the
applicable Oregon OSHA, Washington DOSH, Cal/OSHA, federal OSHA, or other source
for that exact location and pins the reviewed source/version lineage. A typed
citation, location state, or dashboard label must never be promoted to
`verified` automatically.

## Employee PDF boundary

Employee PDFs use a separate service-controlled upload path. The service checks
authorization, PDF format, size, and SHA-256 metadata, and uses a renewable,
token-bound processing lease so a crashed worker can resume without allowing a
stale worker to commit or reject a later attempt. Format verification is not
malware scanning. When `SAFETYOPS_PDF_SCANNER_URL` and its server-only token are
not configured, committed bytes remain logically quarantined and non-releasable
as `upload_pending` with `malware_scan_status = unavailable`. A configured,
trusted HTTPS scanner must return a constrained attestation bound to the exact
SHA-256, engine/version, signature-database version, scan ID, result, and scan
time. Only the service role can apply that attestation. Download and
electronic-signature RPCs require `clean`, so an unavailable scanner cannot
silently release a PDF. The scanner is a trusted subprocessor for employee
records and must be approved before its endpoint is configured.

## Production follow-ups

The following are release gates rather than optional polish:

- Integrate and prove a malware scanner or approved sanitization service for
  the exact uploaded PDF bytes, including clean, rejected, timeout, retry, and
  audit paths.
- Pin the originating PDF template/source version and its immutable lineage in
  the employee-document evidence manifest before allowing production signing.
- Add explicit, auditable retention-review and legal-hold decision records with
  owner, basis, scope, effective time, review date, and release decision.
- Add a server-owned recurring-training renewal scheduler and idempotent
  assignment generation; a cadence value by itself does not create renewals.
- Replace direct corrective-action closeout with a narrow server-owned
  transition that verifies completion evidence, authority, timestamp, and
  audit provenance before closure.
