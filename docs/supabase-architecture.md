# SafetyOps Supabase architecture

## Boundary

GitHub Pages serves public HTML, CSS, JavaScript, and the Supabase publishable key. Supabase owns authentication, authorization, durable records, private files, audit events, and privileged server work.

```text
GitHub Pages
  └── Browser app
        ├── Supabase Auth
        ├── Postgres + Row Level Security
        ├── Private Storage + signed URLs
        └── Edge Functions for privileged work
```

The browser publishable key is not a secret. The security boundary is Row Level Security. Service-role keys and third-party provider secrets must exist only in Supabase Edge Function secrets or protected deployment systems.

## Tenant and location model

```text
companies
├── company_memberships
│     └── role
├── locations
│     └── location_memberships
└── business records
      ├── company_id
      └── location_id, when scoped
```

Corporate administrators and safety managers can work across company locations. Location managers and supervisors require explicit location membership. Workers see their assigned work and accessible location records. Auditors receive read-only visibility.

## Data domains

- Identity: `profiles`, `company_memberships`, `location_memberships`
- Organization: `companies`, `locations`
- Forms: `form_templates`, `form_template_versions`, `template_location_assignments`, `inspections`
- Events: `incidents`, `corrective_actions`
- Learning: `training_courses`, `training_course_versions`, `training_assignments`, `certifications`
- Documents: `documents`, `document_versions`, `document_location_access`, `document_user_access`, `document_acknowledgements`
- Evidence: `evidence_files`, private Storage bucket
- Governance: `audit_events`

## Security properties

- All business tables enable RLS.
- Shared records include `company_id`.
- Location-scoped records use composite foreign keys tying the location to the same company.
- Security-definer helpers pin `search_path`.
- Submitted inspections and published template/course/document versions become immutable.
- Controlled-document permission is independent from location classification.
- Storage objects remain private and become readable only when matching metadata passes database authorization.
- Audit events are written by database triggers or narrowly scoped security-definer functions; authenticated clients receive read access only when their role permits it.
- Self-service training completion uses a narrow RPC rather than broad row-update permission.
- Assigned workers advance corrective actions only through a narrow RPC; managers retain review/closure authority.
- Workers may submit credentials as pending, but only authorized managers can set verification fields.

## Offline architecture planned for the next iteration

Field safety work requires more than browser caching. The production design should include:

- Explicit downloadable assignments and resources
- Encrypted device cache
- Durable local drafts
- Mutation UUID/idempotency keys
- Ordered sync queue
- Resumable evidence upload
- Visible last-sync and queued-change state
- Server-side immutable submission snapshots
- Clear conflict rules for templates and assignments changed while offline

Submitted safety records should never be silently overwritten by a later sync.

## Edge Functions

Use Edge Functions for operations that require secrets or elevated authority:

- User/company invitations
- Scheduled reminders and escalations
- Time-limited audit exports
- Document conversion or signing
- Email/SMS delivery
- Virus scanning or file processing
- Regulator/API integrations

Edge Functions must still validate the caller, company membership, location access, and requested operation.
