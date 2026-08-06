# SiteDocs product research and SafetyOps translation

**Research date:** August 6, 2026

**Decision context:** one company, five operating locations, safety employees facilitating forms on a shared tablet

**Purpose:** understand why SiteDocs is coherent, identify its limitations, and translate the useful product patterns into SafetyOps without copying its brand or interface.

## Executive conclusion

SiteDocs works because it is organized around work and evidence rather than around a file archive. Its core loop is:

```text
Template or resource
→ location visibility
→ worker assignment and due date
→ completion and signature
→ administrator review
→ linked follow-up
→ immutable retained record
```

The most important distinction is between:

1. **Form templates** — interactive documents workers complete.
2. **Resources** — reference or signable PDFs such as manuals, SDSs, policies, and procedures.
3. **Assignments** — who must complete or sign what, at which location, and by when.
4. **Completed records** — signed evidence that is retained rather than overwritten.
5. **Follow-ups** — corrective work linked to the exact question or event that created it.
6. **Operational monitoring** — what is completed, missing, overdue, unread, or awaiting review.

This separation is the main product pattern SafetyOps should adopt. The Drive archive remains valuable source evidence, but it should not be the everyday operating surface.

## How SiteDocs is structured

### Forms versus resources

SiteDocs explicitly separates interactive Forms from uploaded PDF Resources. Its public FAQ says an existing paper or PDF form must be rebuilt in the Form Builder to become interactive; uploading the PDF alone makes it a Resource. Resources can still be distributed, scheduled, acknowledged, and signed.

Sources:

- [Creating Forms and adding Resources](https://sitedocs.zendesk.com/hc/en-us/articles/360015294171-Creating-Forms-Adding-Resources)
- [SiteDocs features](https://www.sitedocs.com/features/)
- [SiteDocs FAQ](https://www.sitedocs.com/faq/)

SafetyOps should therefore give every approved source PDF three distinct paths:

- Open or download the exact original.
- Assign the PDF for reading and acknowledgement.
- Create or link a structured interactive template.

The original and the interactive template remain linked, but they are never represented as the same artifact.

### Location as the organizing context

Locations determine which workers, forms, resources, signatures, certifications, and completed records are relevant. Administrators can make a template visible at all locations or only selected locations. Location-specific menus can hide irrelevant content and place approved forms and resources into folders.

Sources:

- [Managing Locations 101](https://sitedocs.zendesk.com/hc/en-us/articles/360015290291-Managing-Locations-101)
- [Form template visibility](https://sitedocs.zendesk.com/hc/en-us/articles/360012451632-Form-Template-Visibility-Assigning-A-Form-To-A-Specific-Location)
- [Location-specific custom menus](https://sitedocs.zendesk.com/hc/en-us/articles/4410851876877-Custom-App-Menus-Form-Template-Visibility-Assigning-A-Form-To-A-Specific-Location)

For SafetyOps, the five locations remain first-class records. Location filters should affect active work, assignment choices, applicability, and reporting. The deep Drive folder hierarchy stays in the administrator library; worker-facing menus should normally remain no more than three levels deep.

## Role workflows

### Administrator and safety coordinator

The SiteDocs administrative center is the **Safety Monitor**. It behaves more like an email inbox plus saved searches than a conventional KPI dashboard. Administrators can save filter views in sections, search across worker/location/form/company/label, group records, switch between list and inbox preview layouts, and monitor scheduled or completed work.

Important statuses include Completed, Completed On-Time, Completed Late, Scheduled, Pending, Overdue, Missed, and Cancelled. Read/unread state is personal to each administrator.

Sources:

- [Monitor overview](https://sitedocs.zendesk.com/hc/en-us/articles/4407386731661-Monitor-Overview)
- [Monitor view templates](https://sitedocs.zendesk.com/hc/en-us/articles/30436621885965-Monitor-View-Template-Descriptions)
- [Read and unread records](https://sitedocs.zendesk.com/hc/en-us/articles/17526398007053-How-Can-I-Tell-Which-Forms-I-Have-Seen-Before)

The SafetyOps landing page should similarly answer these questions before showing percentages:

- What is overdue?
- What is due today?
- What is awaiting an employee handoff or signature?
- What requires manager review?
- What was completed recently?
- Which setup step is preventing real work?

### Worker experience

The SiteDocs worker experience is deliberately narrower. Its To-Do area separates **Today** from **Upcoming**; overdue work is included under Today. Selecting an item opens the exact assigned form, resource, signature request, or approval. Workers also have location-appropriate forms, resources, certifications, follow-ups, and sync controls.

Sources:

- [How the To-Do section works](https://sitedocs.zendesk.com/hc/en-us/articles/11624832111629-How-Does-The-To-Do-Section-Work)
- [Completing an assigned follow-up](https://sitedocs.zendesk.com/hc/en-us/articles/360055450432-How-to-Complete-a-Follow-Up-Form-assigned-to-you)
- [SiteDocs mobile app](https://apps.apple.com/us/app/sitedocs/id1503042604)

SafetyOps currently does not require employee logins. Its isolated handoff is therefore the worker experience: one assigned task, full-screen form, explicit consent and attestation, completion receipt, then a locked session.

### Shared-tablet signatures

SiteDocs permits a worker with no login access to sign on another worker's authenticated device. Each signature retains two identities:

- the employee whose signature was collected;
- the authenticated device user who collected it.

The signature may also include its image, worker name/title, date/time, GPS, comment, and photo.

Sources:

- [Four SiteDocs access levels](https://sitedocs.zendesk.com/hc/en-us/articles/360033649791-The-Four-Levels-Of-Access-In-SiteDocs)
- [Signature tracking](https://sitedocs.zendesk.com/hc/en-us/articles/24125019872269-Signature-Tracking-in-SiteDocs)
- [Multiple worker signatures](https://sitedocs.zendesk.com/hc/en-us/articles/360032869191-How-To-Have-Multiple-Workers-Sign-the-Same-Document)
- [Signature details](https://sitedocs.zendesk.com/hc/en-us/articles/20865524978701-What-Is-Included-In-A-SiteDocs-Signature)

SafetyOps improves this model by using a one-time employee-only capability instead of leaving the employee inside the safety person's authenticated interface. The record should always show both **signed by** and **facilitated by**, plus the location, exact template/document version, timestamp, and evidence hash.

## Operational workflows

### Scheduling and requested signatures

SiteDocs lets administrators schedule forms to a worker and location, select a due date/time, permit or block late completion, repeat the schedule, and request additional signatures.

- [Scheduling a form](https://sitedocs.zendesk.com/hc/en-us/articles/7630398291341-How-to-Schedule-a-Form)
- [Scheduling a resource](https://sitedocs.zendesk.com/hc/en-us/articles/7630521253133-How-to-Schedule-a-Resource)

SafetyOps should preserve separate states for Assigned, In Progress, Completed On-Time, Completed Late, Overdue, Missed, Cancelled, and Waived instead of reducing everything to a PDF filename.

### Corrective actions

SiteDocs attaches a follow-up to the exact failed or flagged form item. The follow-up has a type, assignee, due date, status, and evidence, and remains linked to the original record after completion.

- [Assigning a follow-up](https://sitedocs.zendesk.com/hc/en-us/articles/360052277412-How-to-Assign-a-Follow-Up-Form-to-someone-else-in-your-Account)
- [Corrective Actions](https://www.sitedocs.com/corrective-actions/)

SafetyOps already retains source IDs for action items. The interface should consistently expose the backlink from action → inspection, incident, meeting, or failed question.

### Immutable records and revisions

Signed SiteDocs Forms, Resources, and Follow-Ups cannot be deleted. Corrections create linked revisions; prior content and signatures remain available.

- [Why signed records cannot be deleted](https://sitedocs.zendesk.com/hc/en-us/articles/360030887691-Why-You-Cannot-Delete-A-Signed-Form-Or-Resource)
- [Revising a form](https://sitedocs.zendesk.com/hc/en-us/articles/360052715751-How-Do-I-Revise-a-Form-Web-App)

This is compatible with the existing LFES/SafetyOps model: signed submissions and evidence stay append-only, while corrections or superseding versions retain lineage.

### Training and credentials

SiteDocs is strong at training records, orientations, certifications, and expiry reminders, but its public material does not describe a full LMS course player comparable to a dedicated learning platform. Certification records include type, acquired/expiry dates, issuer, ticket number, and an image; notifications are sent 90 days, 30 days, and on the expiry day.

- [Certification tracking](https://sitedocs.zendesk.com/hc/en-us/articles/360015089252-Tracking-Worker-Certifications)
- [Certification notifications](https://sitedocs.zendesk.com/hc/en-us/articles/20333265920269-Certification-Notifications-Overview)
- [Worker orientation](https://www.sitedocs.com/worker-orientation/)

SafetyOps should continue to distinguish requirement, assignment, completion, certification, expiry, renewal, and retention rather than treating all training evidence as one uploaded certificate.

### Offline behavior

SiteDocs can operate offline after a device is signed in and synchronized. New work enters a device queue and uploads after connectivity returns. Users can control which signed forms, photos, PDFs, Resources, and certification images are stored offline.

- [Using SiteDocs offline](https://sitedocs.zendesk.com/hc/en-us/articles/205855258-Using-SiteDocs-Offline-Without-A-Wi-Fi-Or-Cellular-Data-Connection)
- [Device storage controls](https://sitedocs.zendesk.com/hc/en-us/articles/360060672591-How-Can-I-Control-What-Is-Stored-On-My-Device)

Public app-store feedback frequently mentions crashes, lost draft work, slow synchronization, storage, login, and location switching. SafetyOps should not claim offline support until it has encrypted draft persistence, visible Saved/Syncing/Offline/Failed states, retry behavior, and conflict tests.

## User feedback and limits

Administrator-oriented review sites generally praise form flexibility, support, centralized records, retrieval, and replacing paper. Frontline app-store ratings are materially weaker and contain repeated performance and sync complaints.

- [G2 SiteDocs reviews](https://www.g2.com/products/sitedocs/reviews)
- [Capterra SiteDocs reviews](https://www.capterra.com/p/143579/SiteDocs/reviews/)
- [US App Store listing](https://apps.apple.com/us/app/sitedocs/id1503042604)
- [Google Play listing](https://play.google.com/store/apps/details?id=com.sitedocs.mobile&hl=en_US)

The lesson is not to reproduce every SiteDocs feature. SafetyOps should borrow its object separation and task-first workflow while avoiding deep worker menus, complicated analytics builders, ambiguous signer selection, and device-only draft retention.

## SafetyOps information architecture decision

The first implementation keeps the existing view IDs and Supabase contracts but presents them in clearer language:

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

The landing screen is now work-first:

1. A setup journey based on real tenant counts.
2. Overdue, due-today, awaiting-employee, and completed-record status.
3. A prioritized Safety inbox.
4. Quick actions for the safety coordinator.
5. Location health, audit readiness, and activity as supporting context.

The Safety Monitor separates open work from recently completed evidence. It does not simulate read/unread review status because that requires an authoritative per-user review record.

## Next implementation stages

### Stage 1 — make existing records navigable

- Open incident, inspection, action, training, meeting, and employee records from their registers.
- Add an employee handoff board with Assigned, Ready, In Progress, Completed, Blocked, and Overdue states.
- Make current tabs, filters, and sorting controls real or remove them.
- Expand search so a result opens the exact record rather than only its module.

### Stage 2 — separate the operational library

- **Ready to use:** approved interactive forms.
- **Programs & policies:** controlled company content.
- **Documents & resources:** readable/signable PDFs.
- **Imports & source archive:** Drive ingestion, classification, privacy, and provenance.
- **Completed records:** retained evidence, shown in registers and employee records.

### Stage 3 — authoritative server features

- Per-user submission review/read state.
- Recurring assignment schedules and reminders.
- Corrective-action evidence and closeout approval.
- Incident investigation and closure.
- Encrypted server-backed drafts and a tested offline queue.
- Production conversion/linking workflow from original PDF to structured template.

These stages remain additive. Supabase RLS, narrow RPCs, private Storage, immutable evidence, source hashes, and regulatory lineage remain the security and traceability foundation.
