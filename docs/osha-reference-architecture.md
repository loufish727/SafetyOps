# OSHA reference architecture

## Purpose and boundary

SafetyOps should maintain a searchable, versioned occupational-safety reference library and connect every compliance-sensitive form, course, policy, inspection question, and corrective action to its source. The library is a reference and change-detection system; it must not claim that loading a standard proves applicability or compliance.

The full federal baseline is **29 CFR Title 29, Chapter XVII (parts 1900–1999)**. State-plan rules and jurisdiction exceptions are overlaid per location. The application should keep the full corpus in the background while showing users only the authorities relevant to their selected location, industry, task, and hazard.

The prototype manifest currently records an eCFR snapshot current through **2026-07-28**, latest amended and issued **2026-07-24**, with no import in progress. Those dates are snapshot metadata, not an evergreen claim; every screen and export must show the version actually used.

## Authority hierarchy

Store `authority_type` separately from `source_edition`. A regulation can be binding while the web compilation used to display it is unofficial.

| UI label | `authority_type` | Treatment |
| --- | --- | --- |
| Statute | `binding_statute` | OSH Act provisions in the current U.S. Code |
| Federal regulation | `binding_federal_regulation` | Paragraph-level 29 CFR content; display the edition and current-through date |
| State regulation | `binding_state_regulation` | Controlling state-plan code and state-specific requirements |
| Rulemaking | `official_rulemaking` | Federal Register or state-register action, including effective dates and affected citations |
| Interpretation | `official_interpretation` | Official agency application to stated facts; does not create new obligations |
| Enforcement policy | `enforcement_policy` | Directives, manuals, and procedures; not a substantive standard |
| Guidance | `nonbinding_guidance` | Technical manuals, topic pages, publications, alerts, and training aids |
| Data | `official_dataset` | Injury, illness, fatality, inspection, and citation data with coverage caveats |
| Incorporated standard | `third_party_ibr` | Citation and edition only unless redistribution rights are documented |

Search results must expose the label, issuing body, jurisdiction, citation, published/effective dates, current-through date, source link, and whether the item is current, superseded, or awaiting review.

## Official source hierarchy and URLs

### Binding federal authority

1. Current statute:
   - [29 USC Chapter 15](https://uscode.house.gov/view.xhtml?edition=prelim&path=%2Fprelim%40title29%2Fchapter15)
   - [General Duty Clause, 29 USC 654](https://uscode.house.gov/view.xhtml?req=%28title%3A29+section%3A654+edition%3Aprelim%29)
   - OSHA's [OSH Act presentation](https://www.osha.gov/laws-regs/oshact/completeoshact) is useful for navigation, but the page says it is amended only through January 1, 2004; do not use it as the current canonical statute.
2. Current regulatory compilation:
   - [eCFR Title 29, Chapter XVII](https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XVII)
   - [eCFR API documentation](https://www.ecfr.gov/developers/documentation/api/v1)
   - Title status: `https://www.ecfr.gov/api/versioner/v1/titles.json`
   - Dated hierarchy: `https://www.ecfr.gov/api/versioner/v1/structure/{YYYY-MM-DD}/title-29.json`
   - Dated part XML: `https://www.ecfr.gov/api/versioner/v1/full/{YYYY-MM-DD}/title-29.xml?part=1910`
   - Version events: `https://www.ecfr.gov/api/versioner/v1/versions/title-29.json?part=1910`
   - Corrections: `https://www.ecfr.gov/api/admin/v1/corrections/title/29.json`
3. Official legal edition and archive:
   - [GovInfo CFR help and package conventions](https://www.govinfo.gov/help/cfr)
   - [GovInfo CFR bulk data](https://www.govinfo.gov/bulkdata/CFR/)
4. Amendments and rulemaking:
   - [Federal Register API](https://www.federalregister.gov/developers/documentation/api/v1)
   - OSHA documents: `https://www.federalregister.gov/api/v1/documents.json?conditions[agencies][]=occupational-safety-and-health-administration&order=newest`
   - [OSHA Federal Register index](https://www.osha.gov/laws-regs/federalregister)
   - [Regulations.gov API](https://open.gsa.gov/api/regulationsgov/) for dockets and supporting material; its v4 API requires an api.data.gov key.

### Current compilation versus official legal edition

The eCFR is continuously updated and provides point-in-time structure and version APIs, but it is an **authoritative, unofficial** compilation. The official CFR is the annual edition published through GovInfo; Title 29 is revised as of July 1. FederalRegister.gov HTML/XML is also unofficial, while each rulemaking record links to the official GovInfo document.

Operationally:

- Use dated eCFR XML for current search, paragraph parsing, and change detection.
- Preserve the corresponding eCFR metadata and raw response hash.
- Preserve the official annual GovInfo Title 29 package as the legal-edition baseline.
- Preserve official GovInfo Federal Register artifacts for post-baseline amendments.
- Never display “current” if eCFR reports `import_in_progress=true`, the sync is stale, or a detected change is awaiting review.

### Full federal corpus

Ingest all of Chapter XVII, not only a hand-picked list. Give higher product priority to:

- Part 1903: inspections, citations, and penalties
- Part 1904: injury and illness recording and reporting
- Part 1905: variances
- Part 1908: consultation
- Part 1910: general industry
- Parts 1915, 1917, 1918, and 1919: maritime sectors
- Part 1926: construction
- Part 1928: agriculture
- Parts 1902 and 1952–1956: state-plan approval, changes, monitoring, withdrawal, and public-employee-only plans
- Parts 1960, 1975, and 1977: federal employee programs, coverage, and retaliation

Retain subpart, section, paragraph, appendix, table, figure, and note structure. Mark appendices as mandatory or nonmandatory from the source instead of inferring from their titles.

### Official explanatory and operational material

- Interpretations: [index](https://www.osha.gov/laws-regs/interpretations) and [RSS](https://www.osha.gov/laws-regs/standardinterpretations.xml)
- Directives: [overview](https://www.osha.gov/enforcement/directives) and [search](https://www.osha.gov/enforcement/directives/search)
- [OSHA Technical Manual](https://www.osha.gov/otm)
- [Safety and Health Topics](https://www.osha.gov/topics/text-index)
- [OSHA publications](https://www.osha.gov/publications/all)
- [Recordkeeping hub](https://www.osha.gov/recordkeeping) and [forms](https://www.osha.gov/recordkeeping/forms)
- [OSHA data catalog](https://www.osha.gov/data)
- [Establishment-specific injury and illness data](https://www.osha.gov/Establishment-Specific-Injury-and-Illness-Data)
- [Severe injury reports](https://www.osha.gov/severe-injury-reports)
- [Fatality inspection data](https://www.osha.gov/fatalities)

For directives, parse directive number, signature/effective date, cancellations, supersession, and “State Plan Impact.” A directive number alone is not a stable version key. For datasets, preserve their dictionaries, coverage dates, jurisdiction limitations, and validation warnings; an injury record does not itself establish fault or an OSHA violation.

## Location jurisdiction overlays

Jurisdiction is not determined by ZIP code alone. Each location profile must also record private/public employer status, industry and NAICS, maritime or federal-enclave activity, tribal/trust-land status where relevant, and any other retained federal jurisdiction.

| Example jurisdiction | Default program for a private company | Primary sources | Required treatment |
| --- | --- | --- | --- |
| Oregon location | Oregon OSHA State Plan | [OSHA state-plan page](https://www.osha.gov/stateplans/or); [Oregon OSHA current rules](https://osha.oregon.gov/rules/Pages/default.aspx); [OAR Chapter 437 database](https://secure.sos.state.or.us/oard/displayChapterRules.action?selectedChapter=437); [adopted rules](https://osha.oregon.gov/rules/making/Pages/adopted.aspx); [proposed rules](https://osha.oregon.gov/rules/making/Pages/proposed.aspx) | Apply OAR Chapter 437 and its adopted-by-reference federal provisions. Keep Oregon-initiated rules separate. Check Oregon's stated federal-jurisdiction exceptions, including maritime coverage. |
| Washington location | Washington DOSH State Plan | [OSHA state-plan page](https://www.osha.gov/stateplans/wa); [DOSH rules by chapter](https://www.lni.wa.gov/safety-health/safety-rules/rules-by-chapter/); [official Title 296 WAC](https://app.leg.wa.gov/WAC/default.aspx?cite=296); [DOSH rulemaking](https://www.lni.wa.gov/safety-health/safety-rules/rulemaking-stakeholder-information/) | Treat WAC requirements as controlling where DOSH has jurisdiction. Keep an independent applicability profile for each facility because hazards and assigned programs can differ. |
| California location | Cal/OSHA State Plan | [OSHA state-plan page](https://www.osha.gov/stateplans/ca); [official Title 8 search](https://www.dir.ca.gov/samples/search/query.htm); [Cal/OSHA regulations](https://www.dir.ca.gov/dosh/LawsAndRegulations.htm); [approved rulemaking](https://www.dir.ca.gov/Rulemaking/DIRApproved.html) | Apply controlling California Code of Regulations, Title 8 requirements and track California-specific programs such as the IIPP and applicable heat-illness rules. Keep the federal source as a baseline and retained-jurisdiction reference. |

### Oregon manufacturing index

The browser catalog includes 23 Oregon manufacturing-focused references ordered as a research aid. The default Oregon view starts with machine guarding, hazardous-energy control, powered industrial trucks, portable tools, cranes and slings, noise, welding and hot work, ventilation and air contaminants, respiratory protection, PPE, hazard communication, electrical safety, walking-working surfaces, emergency programs, safety committees, and recordkeeping. Exposure-dependent heat, wildfire-smoke, confined-space, compressed-gas, and finishing references remain visible below the core process topics. Construction fall protection is excluded from the default manufacturing view and remains available only in the full indexed-source view.

The ordering is non-legal metadata. A location is shown as a reviewed manufacturing profile only when its approved regulatory profile confirms industry/NAICS facts and contains a manufacturing NAICS in sectors 31–33. Draft profiles may use the manufacturing guide for research, but the UI must continue to show `industry profile review required` and every static reference remains a candidate until a qualified reviewer records applicability.

The canonical current-rule entry point is the [Oregon OSHA Division 2 index](https://osha.oregon.gov/rules/final/pages/division-2.aspx). High-value source subdivisions include [D — walking-working surfaces](https://osha.oregon.gov/OSHARules/div2/div2D.pdf), [G — ventilation and noise](https://osha.oregon.gov/OSHARules/div2/div2G.pdf), [I — PPE and respiratory protection](https://osha.oregon.gov/OSHARules/div2/div2I.pdf), [J — hazardous energy and confined spaces](https://osha.oregon.gov/OSHARules/div2/div2J.pdf), [N — material handling](https://osha.oregon.gov/OSHARules/div2/div2N.pdf), [O — machine guarding](https://osha.oregon.gov/OSHARules/div2/div2O.pdf), [Q — welding](https://osha.oregon.gov/OSHARules/div2/div2Q.pdf), and [S — electrical](https://osha.oregon.gov/OSHARules/div2/div2S.pdf).

Federal changes do not automatically become the controlling text in a state-plan jurisdiction. State plans can adopt an identical rule or an at-least-as-effective alternative. Track each federal change as `pending_state_action`, `adopted_identical`, `adopted_modified`, `not_applicable`, or `federal_retained_jurisdiction`. Although [29 CFR 1953.5](https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XVII/part-1953/section-1953.5) generally provides six months for permanent standards and 30 days for emergency temporary standards, the state's official adoption and effective date control. Do not rely solely on OSHA's [state adoption tracker](https://www.osha.gov/stateplans/adoption); reconcile it with each state's official code and rulemaking record.

## Immutable lineage

Every answer and product artifact must be reconstructable through this chain:

```text
issuing authority
  -> immutable raw source artifact
  -> ingestion run and parser version
  -> normalized regulatory node and node version
  -> location applicability decision
  -> form/course/policy/document version
  -> assignment or signed/completed record
```

Minimum fields:

- `source_id`, canonical URL, issuing body, authority type, source edition, jurisdiction, and rights status
- `artifact_id`, retrieval time, publication/effective/current-through dates, HTTP metadata, storage path, and SHA-256
- title/chapter/part/subpart/section/paragraph path and mandatory/nonmandatory status
- `valid_from`, `valid_to`, predecessor/successor, amendment document number, docket/RIN when available
- location, industry/hazard/task tags, applicability rationale, reviewer, approval time, and review expiry
- links such as `amends`, `interprets`, `implements`, `cites`, `cancels`, `supersedes`, `incorporates_by_reference`, and `state_equivalent`
- the exact citation versions pinned to each published template, course, policy, controlled document, and immutable completion/submission

Store raw XML, JSON, HTML, and PDFs in a private, versioned Supabase Storage bucket. Store normalized nodes, search text, lineage links, and review state in Postgres. Make ingestion and review events append-only. A later source fetch must create a new artifact and node version; it must never overwrite the evidence behind a previously completed record.

## Sync and review cadence

| Cadence | Work |
| --- | --- |
| Nightly | Check eCFR title status, affected-part versions, and corrections; query OSHA Federal Register documents; ingest interpretation RSS metadata. |
| Daily | Poll California, Oregon, and Washington official rulemaking/change pages relevant to active locations. Record availability and hash changes even when parsing is deferred. |
| Weekly | Reconcile and hash all Chapter XVII structures, directives, publications, state code sections, state adoption status, and link health. |
| Annually and on release | Archive the official GovInfo Title 29 annual edition and update the baseline-plus-Federal-Register amendment chain. |
| On demand | Permit an authorized compliance owner to request an immediate jurisdiction or citation refresh before publishing critical content. |

Every detected substantive change enters a review queue:

1. Save the new raw artifact and metadata.
2. Produce a paragraph-aware diff and classify additions, removals, effective-date changes, corrections, and supersession.
3. Traverse the lineage graph to identify affected locations, forms, courses, policies, documents, and completed-record citations.
4. Route the impact package to a qualified safety/compliance reviewer.
5. Record the decision: no impact, interpretation-only, revise prospectively, require acknowledgement, or require retraining.
6. Publish a new product-content version only after approval.
7. Retain prior versions and notify affected owners. Never silently alter an assigned course, signed inspection, approved policy, or historical export.

Failed or stale syncs must raise an operational alert and a visible “source update delayed” status. They must not silently preserve a “current” badge.

## Incorporated-by-reference and reuse limits

Federal-created DOL material is generally reusable under the [DOL copyright policy](https://www.dol.gov/general/aboutdol/copyright), but attribution must not imply endorsement and SafetyOps must not use DOL or OSHA seals or logos.

Many ANSI, NFPA, ISO, ICC, and other consensus standards are incorporated by reference without becoming freely redistributable:

- [29 CFR 1910.6, general industry](https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.6)
- [29 CFR 1926.6, construction](https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.6)

For third-party material, store only the CFR citation, incorporated edition, publisher, provisions for which it is approved, official inspection/access location, license status, and internal applicability notes unless counsel confirms broader rights. Do not scrape, reproduce, summarize extensively, or distribute the full standard without a license. State-source reuse terms can differ from federal policy, so keep a per-artifact rights flag: `federal_public_domain`, `licensed`, `third_party_copyright`, or `review_required`.

## Required disclaimer

Display this notice in the reference guide and regulatory exports:

> SafetyOps provides source-linked safety information for research and internal program administration. It is not legal advice, does not determine which requirements apply to a particular workplace, and does not guarantee compliance. Requirements may depend on jurisdiction, employer and worker status, industry, site conditions, exceptions, variances, incorporated standards, agency interpretations, and judicial or administrative decisions. Verify critical obligations against the linked official source and consult qualified safety or legal professionals.

## Operations checklist

- [ ] Confirm all five location profiles, worker classes, industries, and jurisdiction exceptions with the company safety owner.
- [ ] Require a successful eCFR status check and `import_in_progress=false` before a federal sync is marked current.
- [ ] Preserve raw source bytes, canonical URL, retrieval time, effective/current-through dates, SHA-256, and parser version.
- [ ] Validate paragraph counts and citation paths before promoting normalized content.
- [ ] Reconcile eCFR changes with GovInfo Federal Register artifacts and the official annual baseline.
- [ ] Reconcile every federal change separately for California, Oregon, and Washington; do not inherit federal applicability automatically.
- [ ] Monitor Idaho as federal jurisdiction for private-sector work and flag public-worker or excluded-industry cases for review.
- [ ] Parse cancellations, supersession, and State Plan Impact for directives.
- [ ] Mark interpretations, directives, guidance, datasets, and nonmandatory appendices distinctly from binding rules.
- [ ] Pin exact source versions to every published template, course, policy, and controlled document.
- [ ] Require human approval for substantive changes and preserve all prior versions.
- [ ] Alert on stale feeds, failed parsers, source-link failures, unexplained deletions, or hash changes.
- [ ] Review redistribution rights before storing or presenting incorporated or state-owned third-party content.
- [ ] Run a quarterly sample audit from a completed record back through every lineage link to the immutable source artifact.
- [ ] Review the disclaimer, retention rules, and jurisdiction model with qualified safety/legal counsel before production use.
