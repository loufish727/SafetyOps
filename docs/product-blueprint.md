# SafetyOps product blueprint

## Product promise

SafetyOps gives a company one reliable safety record across all locations without making frontline workers behave like database administrators.

## Primary users

- **Worker:** completes assigned inspections and training, reports hazards/incidents, reads documents, and manages credentials.
- **Supervisor:** reviews shift/site work, assigns corrective actions, verifies practical training, and monitors local readiness.
- **Location manager:** owns local compliance, investigations, overdue work, and worker readiness.
- **Safety manager:** standardizes company programs, templates, training, documents, and reporting across locations.
- **Corporate administrator:** manages identity, roles, locations, integrations, retention, and platform configuration.
- **Auditor:** receives time-bound, read-only access to approved records.

## Navigation model

```text
Overview
├── Command center
└── My work

Safety operations
├── Forms & inspections
├── Training
├── Incidents
└── Corrective actions

Compliance
├── OSHA reference
├── Documents
├── People & credentials
└── Locations

Workspace
└── Settings
```

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

## Prototype success criteria

The prototype succeeds when a stakeholder can:

1. Switch between all-company and one-location views.
2. Understand current safety health within ten seconds.
3. Start and submit an inspection.
4. Report an incident or near miss.
5. Assign training.
6. Review corrective actions.
7. See document acknowledgement and worker credential status.
8. Search the full OSHA reference corpus and see the selected location's state-plan context.
9. Open a citation from an inspection, course, document, or action and follow its source trace.
10. Understand how Supabase will enforce company, role, location, file, and regulatory-catalogue access.

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
