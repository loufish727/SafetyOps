# SafetyOps product blueprint

## Product promise

SafetyOps gives a company one reliable safety record across all locations without making frontline workers behave like database administrators.

## Primary users

- **Worker/employee:** completes assigned forms and training on a facilitated tablet, reports hazards/incidents, and signs or acknowledges approved documents. The initial employee model does not require an individual SafetyOps login.
- **Supervisor:** reviews shift/site work, assigns corrective actions, verifies practical training, and monitors local readiness.
- **Location manager:** owns local compliance, investigations, overdue work, and worker readiness.
- **Safety manager:** standardizes company programs, templates, training, documents, and reporting across locations.
- **Corporate administrator:** manages identity, roles, locations, integrations, retention, and platform configuration.
- **Auditor:** receives time-bound, read-only access to approved records.

## Navigation model

```text
Today
├── Today
└── Safety monitor

Run safety
├── Forms
├── Committee
├── Training
├── Incidents
└── Action items

Library & compliance
├── Forms & programs
├── Documents
└── OSHA guide

Company
├── Employees
├── Locations
└── Settings
```

The shell is organized by the safety coordinator's intent rather than by the
underlying tables. **Today** is a prioritized work inbox: setup blockers,
overdue work, work due today, employee handoffs, and recently completed
evidence appear before aggregate health measures. **Safety monitor** separates
open work from completed records and is the review surface across locations.

Operational content and imported source evidence remain distinct. **Forms &
programs** contains approved, ready-to-use interactive templates and controlled
company programs. **Documents** contains readable or signable resources. The
Drive-derived folder tree is an administrator source archive used for
classification, provenance, privacy review, and conversion; it is not the
default worker or coordinator menu.

## Core workflow loops

### Inspection loop

```text
Template version
→ Location assignment/schedule
→ Worker draft
→ Signed immutable submission
→ Finding
→ Corrective action
→ Evidence
→ Manager review
→ Closed audit event
```

### Training loop

```text
Course version
→ Role/location assignment
→ Worker lesson and quiz
→ Practical verification when required
→ Completion record
→ Credential/readiness update
→ Expiry or refresher assignment
```

### Facilitated employee-form loop

```text
Published location-applicable form version
→ Safety user assigns employee
→ Dashboard shows pending
→ Safety user starts isolated 15-minute tablet handoff
→ Employee answers, consents, attests, and types their name
→ Append-only manifest and SHA-256 evidence
→ Handoff consumed and replay blocked
→ Dashboard shows completed
```

### Incident loop

```text
Fast initial report
→ Severity/notification rule
→ Investigation assignment
→ Evidence and root cause
→ Corrective actions
→ Recordability review
→ Closure and trend reporting
```

### Controlled-document loop

```text
Draft version
→ Review and approval
→ Publish
→ Targeted access/acknowledgement
→ Audit events
→ Scheduled review
→ Superseding version
```

### Regulatory trace loop

```text
Official source snapshot and SHA-256
→ Exact provision version and jurisdiction
→ Reviewed plain-language requirement
→ Approved control mapping
→ Immutable form, course, or document version
→ Submitted answer, completion, or acknowledgement
→ Change detection and impact review
```

## Prototype decisions

- Use the MaintainOps architecture pattern: static GitHub-hosted frontend with Supabase as the authenticated data and security authority.
- Keep interactive form templates, PDF resources, assignments, completed
  records, and linked follow-ups as separate objects with explicit lineage.
- Make the default landing page a real-work queue and setup journey, not a
  percentage dashboard populated by empty-state zeroes.
- Keep active forms and company programs separate from the imported source
  archive; preserve exact originals and expose conversion or assignment as
  deliberate actions.
- Preserve `company_id` even though the first customer has one company.
- Use `location_id` on location-scoped work.
- Keep document classification separate from document access.
- Preserve form, course, and document versions used for signed/completed records.
- Preserve the exact regulatory provision version, source URL, source hash, jurisdiction, mapping rationale, and reviewer behind each compliance-sensitive control.
- Treat the eCFR as the current operational compilation while retaining GovInfo/Federal Register artifacts for legal-edition and amendment history.
- Never silently rewrite a published control when an OSHA or state-plan source changes.
- Use browser storage only for non-authoritative UI preferences such as theme and selected location.
- Use private Supabase Storage with signed access for evidence and controlled files.
- Never expose service-role credentials in GitHub Pages.
- Keep employees independent from Auth accounts and isolate each employee
  handoff from the facilitator's authenticated session.
- Treat typed citations as `review_required` trace inputs until a qualified,
  location-specific source review pins their lineage.

## Prototype success criteria

The prototype succeeds when a stakeholder can:

1. Switch between all-company and one-location views.
2. See within ten seconds what is overdue, due today, awaiting an employee,
   recently completed, or blocked by setup.
3. Start and submit an inspection.
4. Report an incident or near miss.
5. Assign training.
6. Review corrective actions.
7. See document acknowledgement and worker credential status.
8. Search the full OSHA reference corpus and see the selected location's state-plan context.
9. Open a citation from an inspection, course, document, or action and follow its source trace.
10. Understand how Supabase will enforce company, role, location, file, and regulatory-catalogue access.
11. Assign an employee form, hand over a tablet without creating an employee
    login, and see pending change to completed after one-time submission.
12. Find an approved operational form without navigating the source archive,
    while an administrator can still trace it to the exact imported original.

## Deliberately deferred

- Real production authentication and invitations
- Live Supabase data loading
- Offline queue/service worker
- File uploads
- Template/course builders
- Notifications and email delivery
- Regulatory calculations and filings
- Electronic-signature legal validation
- Production analytics and exports

These are deferred to keep the first prototype focused; the schema and interface anticipate them.
