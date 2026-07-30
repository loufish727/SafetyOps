# SafetyOps prototype

SafetyOps is a responsive, clickable multi-tenant workplace safety-management prototype. It combines digital inspections, training, incidents, corrective actions, controlled documents, worker credentials, form originals, reusable templates, and location reporting.

The working name is temporary.

## What is implemented

- Company-wide and location-specific command center
- Generic five-location demonstration workspace
- Supabase email/password access and atomic first-company onboarding
- Membership-scoped company and live location bootstrap
- Interactive safety-program library that loads tenant data only after authorization
- Source-derived digital forms with drafts, signatures, submissions, and document lineage
- Original PDF preview/download, local company-form upload, and reusable template sections
- Binary and extracted-text SHA-256 fingerprints for imported source versions
- Today/My Work queue
- Inspection template library
- Functional inspection submission flow
- Training campaigns and assignment flow
- Functional incident/near-miss report flow
- Corrective-action register and creation flow
- Controlled-document acknowledgements
- Searchable OSHA reference guide covering all indexed sections and appendices in 29 CFR Chapter XVII
- Location-aware California, Oregon, Washington, and federal-baseline jurisdiction overlays
- Source-trace drawers connecting forms, questions, courses, documents, and actions to reviewed requirements
- Reproducible eCFR synchronization with current-through metadata and SHA-256 source fingerprints
- Worker training/credential view
- Location readiness cards
- Responsive desktop and mobile navigation
- Light/dark theme preference
- Supabase baseline schema with RLS and private Storage design
- GitHub Pages deployment workflow
- Desktop/mobile Playwright smoke tests

The public repository contains only the generic product shell and fictional demonstration records. Company names, locations, programs, source identities, original files, employee records, and accounts belong in private Supabase rows/objects protected by membership-aware RLS. For local development, ignored files under `private/` can overlay an authorized tenant without entering the public build.

## Local preview

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`.

## Validation

```bash
npm run build
npm run test:smoke
npm run test:public-boundary
npm run sync:osha
```

`sync:osha` retrieves current official eCFR metadata and structure, refuses to publish during an in-progress eCFR import, fingerprints the core OSHA part XML, and regenerates `osha-reference.js` plus `docs/osha-corpus-manifest.json`.

Company Drive sources are intentionally handled as private data. The public static client contains no tenant catalogue, fingerprints, original safety PDFs, or employee files. `test:public-boundary` rejects private directories, tenant denylist matches, and embedded Drive identities in `dist`. See `docs/google-drive-safety-program-ingestion.md` for the recursive Drive-to-private-Supabase workflow.

## Supabase setup

1. Create a separate Supabase project for SafetyOps.
2. Apply the migrations in `supabase/migrations/` in filename order.
3. Add the project URL and publishable/anon key to `supabase-config.js`.
4. Configure the Supabase Auth Site URL and redirect allowlist for the final GitHub Pages URL.
5. Keep all privileged credentials in Supabase Edge Function secrets or protected GitHub environments.

The publishable/anon key is visible in every browser app by design. Row Level Security is the actual authorization boundary. Never use a service-role key in this repository.

Company onboarding follows the same pattern as MaintainOps: the authenticated user calls a security-definer company-creation RPC, becomes the owner member, receives a default location, and can only access rows whose `company_id` is authorized by membership. Original and uploaded files are served through short-lived signed URLs; storage object paths never become public catalogue data.

## GitHub Pages

The included workflow verifies the prototype, builds a small `dist` artifact, and deploys it with GitHub Pages Actions after a push to `main`.

Repository settings must use **GitHub Actions** as the Pages source.

## Product and research documents

- `docs/competitive-research.md`
- `docs/google-drive-safety-program-ingestion.md`
- `docs/safety-programs-schema.md`
- `docs/osha-reference-architecture.md`
- `docs/osha-corpus-manifest.json`
- `docs/product-blueprint.md`
- `docs/supabase-architecture.md`
- `supabase/README.md`

## Next iteration

The next engineering milestone should connect the remaining live repositories, then implement:

1. Company invitations and multi-workspace switching
2. Live form-template versioning and schedules
3. Durable offline drafts and sync queue
4. Evidence uploads to private Storage
5. Training completion and practical verification
6. Document publishing and acknowledgement
7. Production OSHA/state-plan ingestion Edge Functions and scheduled change detection
8. Human-reviewed applicability and source-change impact workflows
9. RLS, catalogue immutability, and cross-location security tests
10. Last-admin protection and invitation lifecycle controls

This prototype is a software/design foundation. It does not itself certify compliance with OSHA or any other regulatory program.
