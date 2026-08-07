(function startSafetyOps() {
  "use strict";

  const app = document.querySelector("#app");
  const toastRegion = document.querySelector("#toast-region");
  const referencePanelRegion = document.querySelector("#reference-panel-region");
  const source = window.SafetyOpsData || {};
  const data = JSON.parse(JSON.stringify(source));
  const regulatory = window.SafetyOpsRegulatoryData || {
    meta: {},
    standards: [],
    requirements: [],
    regulatoryLinks: [],
    statePlans: [],
    parts: []
  };
  const stateRegulatory = window.SafetyOpsStateRegulatoryData || {
    meta: {},
    jurisdictions: [],
    standards: [],
    resources: []
  };
  const programLibrary = window.SafetyOpsProgramLibrary || {
    meta: { counts: {} },
    programs: [],
    forms: [],
    folders: [],
    looseResources: [],
    importCandidates: []
  };
  const uiStoragePrefix = "safetyops.ui.";
  const authHashParameters = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const authQueryParameters = new URLSearchParams(window.location.search);
  const employeeHandoffToken = authHashParameters.get("handoff") || "";
  const isEmployeeHandoffMode = /^[0-9a-f]{64}$/.test(employeeHandoffToken);
  const authQueryFlowHint = ["invite", "recovery"].includes(authQueryParameters.get("auth"))
    ? authQueryParameters.get("auth")
    : null;
  const authHashFlowHint = ["invite", "recovery"].includes(authHashParameters.get("type"))
    ? authHashParameters.get("type")
    : null;
  const hasImplicitAuthCallbackEvidence = Boolean(
    authHashParameters.get("access_token")
    && authHashParameters.get("refresh_token")
  );
  const hasPkceAuthCallbackEvidence = Boolean(
    authQueryParameters.get("code")
    && authQueryFlowHint
  );
  const hasAuthCallbackErrorEvidence = Boolean(
    authHashParameters.get("error")
    || authHashParameters.get("error_code")
    || authQueryParameters.get("error")
    || authQueryParameters.get("error_code")
  );
  const attemptedAuthCallbackFlow = (
    hasImplicitAuthCallbackEvidence
      ? authHashFlowHint || authQueryFlowHint
      : hasPkceAuthCallbackEvidence
        ? authQueryFlowHint
        : hasAuthCallbackErrorEvidence
          ? authHashFlowHint || authQueryFlowHint
          : null
  );
  const publicSignupEnabled = window.SAFETYOPS_ALLOW_PUBLIC_SIGNUP === true;
  const passwordMinimumLength = 8;
  const passwordPolicyMessage = "Use at least 8 characters with a capital letter and a special character.";
  const meetsPasswordPolicy = (password) => (
    password.length >= passwordMinimumLength
    && /[A-Z]/.test(password)
    && /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/.test(password)
  );

  const state = {
    view: localStorage.getItem(`${uiStoragePrefix}view`) || "dashboard",
    locationId: localStorage.getItem(`${uiStoragePrefix}location`) || "all",
    theme: localStorage.getItem(`${uiStoragePrefix}theme`) || "light",
    sidebarOpen: false,
    searchQuery: "",
    standardQuery: "",
    standardPart: "all",
    standardScope: "all",
    standardMode: "manufacturing",
    standardAuthority: "location",
    referenceId: null,
    programCategory: "programs",
    programQuery: "",
    formLibraryMode: localStorage.getItem(`${uiStoragePrefix}formsMode`) || "originals",
    formArchiveKind: localStorage.getItem(`${uiStoragePrefix}formArchiveKind`) || "all",
    formArchiveStatus: localStorage.getItem(`${uiStoragePrefix}formArchiveStatus`) || "all",
    formArchiveError: "",
    candidateReviewSavingId: null,
    localFormUploads: [],
    programDrawerId: null,
    employeeDrawerId: null,
    originalPreviewId: null,
    activeFormId: null,
    modal: null,
    modalContext: {},
    selectedTemplateId: null,
    authStatus: "configuration-required",
    authMode: "sign-in",
    authFlow: null,
    authUser: null,
    authMessage: "",
    authBusy: false,
    employeeHandoff: {
      status: isEmployeeHandoffMode ? "loading" : "inactive",
      data: null,
      error: "",
      receipt: null
    }
  };

  const formUploadDbName = "safetyops-private-form-uploads";
  const formUploadStoreName = "formUploads";
  const maxFormUploadBytes = 25 * 1024 * 1024;
  const allowedFormUploadTypes = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ]);
  const allowedFormUploadExtensions = new Set(["pdf", "docx", "xlsx"]);
  const localUploadStagingEnabled = (
    window.SAFETYOPS_ENABLE_LOCAL_UPLOAD_STAGING === true
    && ["127.0.0.1", "localhost"].includes(window.location.hostname)
  );
  if (!["originals", "archive", "uploads", "templates"].includes(state.formLibraryMode)) {
    state.formLibraryMode = "originals";
  }
  if (!localUploadStagingEnabled && state.formLibraryMode === "uploads") {
    state.formLibraryMode = "originals";
  }
  if (!["location", "federal", "combined"].includes(state.standardAuthority)) {
    state.standardAuthority = "location";
  }

  const hasSupabaseConfig = Boolean(
    window.SAFETYOPS_SUPABASE_URL &&
    window.SAFETYOPS_SUPABASE_ANON_KEY &&
    !String(window.SAFETYOPS_SUPABASE_URL).includes("YOUR_PROJECT") &&
    !String(window.SAFETYOPS_SUPABASE_ANON_KEY).includes("YOUR_PUBLISHABLE") &&
    window.supabase
  );

  let supabaseClient = null;
  let referenceReturnFocus = null;
  let pendingAuthCallbackFlow = attemptedAuthCallbackFlow;
  let authCallbackRejected = false;
  let authTransitionEpoch = 0;
  let workspaceLoadSequence = 0;
  let synchronizedAuthSessionKey = null;
  let synchronizedAuthSessionPromise = null;
  if (hasSupabaseConfig) {
    try {
      supabaseClient = window.supabase.createClient(
        window.SAFETYOPS_SUPABASE_URL,
        window.SAFETYOPS_SUPABASE_ANON_KEY,
        {
          auth: {
            persistSession: !isEmployeeHandoffMode && window.SAFETYOPS_ENABLE_PERSISTENT_AUTH_SESSION === true,
            autoRefreshToken: !isEmployeeHandoffMode,
            detectSessionInUrl: !isEmployeeHandoffMode
          }
        }
      );
    } catch (_error) {
      supabaseClient = null;
    }
  }
  state.authStatus = supabaseClient ? "loading" : "configuration-required";

  document.documentElement.dataset.theme = state.theme;

  const navGroups = [
    {
      label: "Today",
      items: [
        { id: "dashboard", label: "Today", icon: "01" },
        { id: "my-work", label: "Safety monitor", icon: "✓" }
      ]
    },
    {
      label: "Run safety",
      items: [
        { id: "inspections", label: "Forms", icon: "F" },
        { id: "committee", label: "Committee", icon: "C" },
        { id: "training", label: "Training", icon: "T" },
        { id: "incidents", label: "Incidents", icon: "!", danger: true },
        { id: "actions", label: "Action items", icon: "A" }
      ]
    },
    {
      label: "Library & compliance",
      items: [
        { id: "programs", label: "Forms & programs", icon: "P" },
        { id: "documents", label: "Documents", icon: "D" },
        { id: "standards", label: "OSHA guide", icon: "§" }
      ]
    },
    {
      label: "Company",
      items: [
        { id: "people", label: "Employees", icon: "E" },
        { id: "locations", label: "Locations", icon: "L" },
        { id: "settings", label: "Settings", icon: "S" }
      ]
    }
  ];

  const pageMeta = {
    dashboard: {
      eyebrow: "All-location workday",
      title: "Today",
      description: "Start the work, clear what is overdue, and see what your safety program needs next."
    },
    "my-work": {
      eyebrow: "Company work inbox",
      title: "Safety monitor",
      description: "Track scheduled work, employee signatures, follow-ups, and completed records in one place."
    },
    inspections: {
      eyebrow: "Field assurance",
      title: "Forms & inspections",
      description: "Schedule repeatable work, capture evidence in the field, and turn findings into accountable actions."
    },
    committee: {
      eyebrow: "Worker participation",
      title: "Safety committee",
      description: "Record meeting notes, attendance, decisions, and accountable follow-up work in one traceable record."
    },
    training: {
      eyebrow: "Worker readiness",
      title: "Training",
      description: "Assign courses, capture toolbox attendance, verify understanding, and keep completion records audit-ready."
    },
    incidents: {
      eyebrow: "Incident management",
      title: "Incidents & near misses",
      description: "Capture the first report quickly, investigate consistently, and connect every finding to follow-up work."
    },
    actions: {
      eyebrow: "Close the loop",
      title: "Action items",
      description: "Keep findings from inspections, hazards, and incidents visible until evidence is reviewed and accepted."
    },
    documents: {
      eyebrow: "Controlled library",
      title: "Company documents",
      description: "Publish the right version, target the right locations, and prove that required workers acknowledged it."
    },
    programs: {
      eyebrow: "Reusable safety content",
      title: "Forms & program library",
      description: "Find ready-to-use forms and programs first, with imports and source originals kept in their own review area."
    },
    standards: {
      eyebrow: "Oregon manufacturing reference",
      title: "Oregon OSHA manufacturing guide",
      description: "Start with Oregon general-industry rules prioritized for manufacturing, then trace each source to company controls and retained evidence."
    },
    people: {
      eyebrow: "Workforce compliance",
      title: "Employees & credentials",
      description: "Connect each worker’s location access, training, certifications, and role in one readiness record."
    },
    locations: {
      eyebrow: "Company workspace",
      title: "Locations",
      description: "Standardize the company program while preserving local owners, schedules, risks, and performance."
    },
    settings: {
      eyebrow: "Workspace administration",
      title: "Workspace settings",
      description: "Configure organization rules, permissions, notifications, and the Supabase connection model."
    },
    search: {
      eyebrow: "Workspace search",
      title: "Search results",
      description: "Search across people, forms, courses, documents, incidents, actions, and locations."
    }
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function locationById(id) {
    return data.locations.find((location) => location.id === id);
  }

  function activeLocation() {
    return state.locationId === "all" ? null : locationById(state.locationId);
  }

  function filterLocation(records) {
    if (state.locationId === "all") return records;
    return records.filter((record) => (
      record.locationId === state.locationId
      || (record.locationIds || []).includes(state.locationId)
    ));
  }

  function locationName(id) {
    return locationById(id)?.name || "Company-wide";
  }

  function average(values) {
    if (!values.length) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  function allLocationsLabel(lowercase = false) {
    const count = data.locations.length;
    const label = count ? `All ${count} location${count === 1 ? "" : "s"}` : "Company-wide";
    return lowercase ? `${label[0].toLowerCase()}${label.slice(1)}` : label;
  }

  function toneForStatus(status) {
    const normalized = String(status).toLowerCase();
    if (["current", "complete", "closed", "low"].some((value) => normalized.includes(value))) return "green";
    if (["critical", "overdue", "expired", "action needed", "high"].some((value) => normalized.includes(value))) return "red";
    if (["watch", "due soon", "awaiting", "assigned", "medium"].some((value) => normalized.includes(value))) return "amber";
    if (["in progress", "investigation", "scheduled", "open"].some((value) => normalized.includes(value))) return "blue";
    return "purple";
  }

  function statusPill(text, forcedTone) {
    return `<span class="status-pill ${forcedTone || toneForStatus(text)}">${escapeHtml(text)}</span>`;
  }

  function requirementById(id) {
    return regulatory.requirements.find((requirement) => requirement.id === id);
  }

  function allStandards() {
    return [
      ...stateRegulatory.standards.map((standard) => ({
        ...standard,
        catalogType: "state",
        bindingLevel: standard.bindingLevel || "state-plan"
      })),
      ...regulatory.standards.map((standard) => ({
        ...standard,
        catalogType: "federal",
        jurisdiction: standard.jurisdiction || "US-FED"
      }))
    ];
  }

  function standardById(id) {
    return allStandards().find((standard) => standard.id === id);
  }

  function standardByIdentifier(identifier) {
    return allStandards().find((standard) => standard.identifier === identifier);
  }

  function jurisdictionForLocation(location) {
    if (!location) return "US-FED";
    if (location.jurisdiction) return location.jurisdiction;
    const stateCode = String(location.stateCode || "").toUpperCase();
    if (["OR", "WA", "CA"].includes(stateCode)) return `US-${stateCode}`;
    const configuredPlan = regulatory.statePlans.find((plan) =>
      Array.isArray(plan.locationIds) && plan.locationIds.includes(location.id)
    );
    return configuredPlan?.jurisdiction || "US-FED";
  }

  function planForJurisdiction(jurisdiction) {
    const federalCode = jurisdiction === "US-FED-OSHA" ? "US-FED" : jurisdiction;
    const legacyPlan = regulatory.statePlans.find((plan) =>
      plan.jurisdiction === federalCode ||
      (federalCode === "US-FED" && plan.jurisdiction === "US-FED-OSHA")
    );
    const statePlan = stateRegulatory.jurisdictions.find((plan) =>
      plan.jurisdiction === federalCode || plan.code === federalCode || plan.id === federalCode
    );
    if (!statePlan) return legacyPlan || null;
    return {
      ...(legacyPlan || {}),
      ...statePlan,
      jurisdiction: statePlan.jurisdiction || statePlan.code || statePlan.id,
      name: legacyPlan?.name || statePlan.programName || statePlan.name,
      officialUrl: statePlan.officialUrl || statePlan.officialRulesUrl,
      legalCodeUrl: statePlan.legalCodeUrl || legacyPlan?.legalCodeUrl,
      coverage: statePlan.coverage || statePlan.coverageSummary || legacyPlan?.coverage || "State-plan occupational safety and health authority.",
      note: statePlan.note || legacyPlan?.note || "Verify the reviewed location profile, industry, activity, and any federal retained-jurisdiction exception."
    };
  }

  function jurisdictionLabel(jurisdiction) {
    return planForJurisdiction(jurisdiction)?.name
      || ({
        "US-OR": "Oregon OSHA",
        "US-WA": "Washington DOSH",
        "US-CA": "Cal/OSHA",
        "US-FED": "Federal OSHA"
      })[jurisdiction]
      || jurisdiction;
  }

  function locationRegulatoryContext(locationId = state.locationId) {
    if (locationId === "all") {
      const jurisdictions = [...new Set(data.locations.map(jurisdictionForLocation))];
      return {
        locationId,
        jurisdiction: "MULTI",
        jurisdictionName: "Location-specific authorities",
        jurisdictions,
        profileStatus: data.locations.length > 0
          && data.locations.every((location) => location.regulatoryProfileStatus === "approved")
          ? "approved"
          : "review_required",
        regulatoryProfileId: null
      };
    }
    const location = locationById(locationId);
    const jurisdiction = jurisdictionForLocation(location);
    return {
      locationId,
      jurisdiction,
      jurisdictionName: jurisdictionLabel(jurisdiction),
      jurisdictions: [jurisdiction],
      stateCode: location?.stateCode || null,
      profileStatus: location?.regulatoryProfileStatus || "review_required",
      regulatoryProfileId: location?.regulatoryProfileId || null,
      coverageStatus: location?.regulatoryCoverageStatus || "requires_review"
    };
  }

  function regulatoryLinksFor(entityType, entityId) {
    return regulatory.regulatoryLinks.filter(
      (link) => link.entityType === entityType && link.entityId === entityId
    );
  }

  function renderRequirementChips(requirementIds, label = "Regulatory basis") {
    const requirements = requirementIds
      .map(requirementById)
      .filter(Boolean);
    if (!requirements.length) return "";
    return `
      <div class="citation-strip" aria-label="${escapeHtml(label)}">
        <span class="trace-label">${escapeHtml(label)}</span>
        ${requirements.map((requirement) => `
          <button
            class="citation-chip"
            type="button"
            data-action="open-reference"
            data-reference-id="${requirement.id}"
            aria-label="Open trace for ${escapeHtml(requirement.citation)}"
          >${escapeHtml(requirement.citation)}</button>
        `).join("")}
      </div>
    `;
  }

  function renderCitationChips(entityType, entityId, max = 2) {
    const links = regulatoryLinksFor(entityType, entityId);
    if (!links.length) return "";
    const visible = links.slice(0, max);
    return `
      <div class="citation-strip" aria-label="Regulatory basis">
        <span class="trace-label">Regulatory basis</span>
        ${visible.map((link) => {
          const requirement = requirementById(link.requirementId);
          if (!requirement) return "";
          return `
            <button
              class="citation-chip"
              type="button"
              data-action="open-reference"
              data-reference-id="${requirement.id}"
              aria-label="Open trace for ${escapeHtml(requirement.citation)}"
            >${escapeHtml(requirement.citation)}</button>
          `;
        }).join("")}
        ${links.length > max ? `
          <button
            class="citation-chip"
            type="button"
            data-action="open-reference"
            data-reference-id="${links[max].requirementId}"
            aria-label="Open ${links.length - max} more regulatory references"
          >+${links.length - max}</button>
        ` : ""}
      </div>
    `;
  }

  function stateStandardsForInspection(templateId, jurisdiction) {
    const template = data.inspectionTemplates.find((item) => item.id === templateId);
    const templateText = `${template?.name || ""} ${template?.category || ""}`.toLowerCase();
    let terms = ["rules for all workplaces", "accident prevention program", "injury and illness prevention program"];
    if (/(incident|injury|record|report)/.test(templateText)) {
      terms = ["reporting", "recordkeeping", "occupational injury and illness records"];
    } else if (/(forklift|powered industrial|industrial truck)/.test(templateText)) {
      terms = ["powered industrial truck", "forklift", "industrial trucks"];
    } else if (/(hazard analysis|jha|personal protective|ppe)/.test(templateText)) {
      terms = ["personal protective equipment", "personal protective devices"];
    } else if (/(machine|guard)/.test(templateText)) {
      terms = ["machine safety", "guarding required"];
    } else if (/(lockout|tagout|energy control)/.test(templateText)) {
      terms = ["lockout/tagout", "control of hazardous energy"];
    }
    if (!terms.length || ["US-FED", "US-FED-OSHA"].includes(jurisdiction)) return [];
    return stateRegulatory.standards
      .filter((standard) => {
        if (standard.jurisdiction !== jurisdiction) return false;
        const haystack = `${standard.title} ${standard.citation} ${(standard.topics || []).join(" ")}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      })
      .slice(0, 2);
  }

  function renderStateInspectionChips(templateId, jurisdiction) {
    const standards = stateStandardsForInspection(templateId, jurisdiction);
    if (!standards.length) return "";
    return `
      <div class="citation-strip" aria-label="Location rule overlay">
        <span class="trace-label">Location rule overlay</span>
        ${standards.map((standard) => `
          <button
            class="citation-chip"
            type="button"
            data-action="open-reference"
            data-reference-id="${standard.id}"
            aria-label="Open trace for ${escapeHtml(standard.citation)}"
          >${escapeHtml(standard.citation)}</button>
        `).join("")}
      </div>
    `;
  }

  function entityLabel(entityType, entityId) {
    const collections = {
      inspection_template: data.inspectionTemplates,
      training_course: data.courses,
      document: data.documents,
      corrective_action: data.actions
    };
    const record = collections[entityType]?.find((item) => item.id === entityId);
    return record?.name || record?.title || entityId;
  }

  function resolveReference(referenceId) {
    const requirement = requirementById(referenceId);
    if (requirement) {
      return {
        requirement,
        standard: standardByIdentifier(requirement.standardIdentifier)
      };
    }
    const standard = standardById(referenceId);
    return standard ? { requirement: null, standard } : null;
  }

  function renderReferencePanel() {
    if (!referencePanelRegion) return;
    if (!state.referenceId) {
      referencePanelRegion.innerHTML = "";
      return;
    }

    const resolved = resolveReference(state.referenceId);
    if (!resolved?.standard && !resolved?.requirement) {
      referencePanelRegion.innerHTML = "";
      return;
    }

    const { requirement, standard } = resolved;
    const citation = requirement?.citation || standard.citation;
    const title = requirement?.heading || standard.title;
    const summary = requirement?.summary || standard.summary || "Open the official source for the complete provision and its context.";
    const officialUrl = requirement?.officialUrl || standard.officialUrl;
    const stateSource = standard?.catalogType === "state" || (
      standard?.jurisdiction && !["US-FED", "US-FED-OSHA"].includes(standard.jurisdiction)
    );
    const sourceDate = stateSource
      ? (standard.checkedOn || stateRegulatory.meta.checkedOn)
      : (requirement?.currentThrough || standard.currentThrough || regulatory.meta.currentThrough);
    const sourceHash = requirement?.sourceSha256
      || standard.sourceSha256
      || (stateSource ? null : regulatory.meta.structureSha256);
    const requirementIds = requirement
      ? [requirement.id]
      : regulatory.requirements
        .filter((item) => item.standardIdentifier === standard.identifier)
        .map((item) => item.id);
    const connectedLinks = regulatory.regulatoryLinks.filter((link) => requirementIds.includes(link.requirementId));
    const bindingLevel = standard?.bindingLevel || "regulation";

    referencePanelRegion.innerHTML = `
      <div class="reference-backdrop" data-action="backdrop-close-reference" aria-hidden="true"></div>
      <aside class="reference-drawer" role="dialog" aria-modal="true" aria-labelledby="reference-title">
        <header class="reference-drawer-header">
          <div>
            <p class="section-kicker">Verified regulatory trace</p>
            <h2 id="reference-title">${escapeHtml(citation)}</h2>
            <p>${escapeHtml(title)}</p>
          </div>
          <button class="icon-button" type="button" data-action="close-reference" aria-label="Close regulatory trace">&times;</button>
        </header>
        <div class="reference-drawer-body">
          <div class="reference-badges">
            <span class="binding-badge ${escapeHtml(bindingLevel)}">${escapeHtml(bindingLevel)}</span>
            ${standard?.jurisdiction ? `<span class="binding-badge ${stateSource ? "state-plan" : "regulation"}">${escapeHtml(standard.jurisdiction)}</span>` : ""}
            ${statusPill(stateSource ? "Official link verified" : "Official source", stateSource ? "blue" : "green")}
            ${standard && isManufacturingReference(standard) ? statusPill("Manufacturing focus", "purple") : ""}
          </div>

          <section class="reference-section">
            <h3>Plain-language summary</h3>
            <p>${escapeHtml(summary)}</p>
            <p class="reference-caution">Summary only. Read the full provision, definitions, exceptions, and jurisdiction-specific rules before making an applicability or compliance decision.</p>
          </section>

          ${stateSource ? `
            <section class="reference-section">
              <h3>Applicability context</h3>
              <dl class="reference-context-list">
                <div><dt>Authority type</dt><dd>${escapeHtml(standard.authorityType || "State-plan reference")}</dd></div>
                <div><dt>Review state</dt><dd>Candidate · human applicability review required</dd></div>
                ${standard.scopeCategory ? `<div><dt>Scope category</dt><dd>${escapeHtml(standard.scopeCategory)}</dd></div>` : ""}
                ${(standard.workAreas || []).length ? `<div><dt>Relevant work areas</dt><dd>${escapeHtml(standard.workAreas.join(", "))}</dd></div>` : ""}
                ${(standard.equipment || []).length ? `<div><dt>Equipment examples</dt><dd>${escapeHtml(standard.equipment.join(", "))}</dd></div>` : ""}
                ${standard.federalReferenceIdentifier ? `<div><dt>Adopted-source cross-reference</dt><dd>29 CFR ${escapeHtml(standard.federalReferenceIdentifier)} · Oregon adoption crosswalk pending review</dd></div>` : ""}
              </dl>
              ${standard.changeNote ? `<p class="reference-caution">Change watch: ${escapeHtml(standard.changeNote)}</p>` : ""}
            </section>
          ` : ""}

          <section class="source-fingerprint">
            <h3>Source fingerprint</h3>
            <dl>
              <div><dt>Authority</dt><dd>${escapeHtml(standard?.authority || regulatory.meta.authority)}</dd></div>
              <div><dt>Jurisdiction</dt><dd>${escapeHtml(jurisdictionLabel(standard?.jurisdiction || "US-FED"))}</dd></div>
              <div><dt>${stateSource ? "Official link checked" : "Current through"}</dt><dd>${escapeHtml(sourceDate || "Not recorded")}</dd></div>
              <div><dt>Retrieved</dt><dd>${escapeHtml(stateSource ? "Pending server-side source ingestion" : (regulatory.meta.generatedAt || "Not recorded"))}</dd></div>
              <div><dt>SHA-256</dt><dd><code>${escapeHtml(sourceHash || "Pending server-side source snapshot")}</code></dd></div>
            </dl>
            <a class="button small primary" href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">Open official source</a>
          </section>

          ${stateSource ? `
            <div class="prototype-note">
              <strong>State trace status</strong>
              <span>The official state link and citation were verified on ${escapeHtml(sourceDate || "the recorded check date")}. Exact source bytes, paragraph extraction, SHA-256, and the federal adoption crosswalk remain in the human review queue; this record is not yet a compliance-ready legal determination.</span>
            </div>
          ` : ""}

          <section class="reference-section">
            <h3>Connected company controls</h3>
            ${connectedLinks.length ? `
              <div class="trace-list">
                ${connectedLinks.map((link) => `
                  <article class="trace-item">
                    <div>
                      <strong>${escapeHtml(entityLabel(link.entityType, link.entityId))}</strong>
                      <span>${escapeHtml(link.relation.replaceAll("_", " "))} · ${escapeHtml(link.status)}</span>
                    </div>
                    <p>${escapeHtml(link.rationale)}</p>
                    <small>Linked by ${escapeHtml(link.linkedBy)} · Verified by ${escapeHtml(link.verifiedBy)} on ${escapeHtml(link.verifiedAt)}</small>
                  </article>
                `).join("")}
              </div>
            ` : `<p>No reviewed company-control mapping is attached to this provision yet.</p>`}
          </section>

          <div class="prototype-note">
            <strong>Trace, not a legal conclusion</strong>
            <span>This chain proves which source and version informed the control. It does not, by itself, certify that a location or activity is compliant.</span>
          </div>
        </div>
      </aside>
    `;
  }

  function openReference(referenceId, trigger) {
    if (!resolveReference(referenceId)) return;
    referenceReturnFocus = trigger || document.activeElement;
    state.referenceId = referenceId;
    renderReferencePanel();
    requestAnimationFrame(() => {
      referencePanelRegion.querySelector(".reference-drawer [data-action='close-reference']")?.focus();
    });
  }

  function closeReference() {
    state.referenceId = null;
    renderReferencePanel();
    referenceReturnFocus?.focus?.();
    referenceReturnFocus = null;
  }

  function renderLocationOptions(includeAll = true, selectedId = state.locationId) {
    return `
      ${includeAll ? `<option value="all" ${selectedId === "all" ? "selected" : ""}>${escapeHtml(allLocationsLabel())}</option>` : ""}
      ${data.locations.map((location) => `
        <option value="${location.id}" ${selectedId === location.id ? "selected" : ""}>${escapeHtml(location.name)}</option>
      `).join("")}
    `;
  }

  function readableRole(role) {
    return String(role || "worker")
      .split("_")
      .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
      .join(" ");
  }

  function readableStatus(status) {
    return String(status || "new")
      .split("_")
      .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
      .join(" ");
  }

  function currentRawRole() {
    return data.currentUser?.rawRole || "worker";
  }

  function canManageCompany() {
    return ["corporate_admin", "safety_manager"].includes(currentRawRole());
  }

  function isSignedInCompanyMember() {
    return state.authStatus === "ready"
      && Boolean(state.authUser?.id && data.company?.id && data.currentUser?.id);
  }

  function isReadOnlyAuditor() {
    return currentRawRole() === "auditor";
  }

  function canWriteLocation(locationId = state.locationId) {
    if (!data.locations.length) return false;
    if (canManageCompany()) return true;
    if (!["location_manager", "supervisor"].includes(currentRawRole())) return false;
    if (locationId === "all") return data.locations.length > 0;
    return data.locations.some((location) => location.id === locationId);
  }

  function hasAccessibleLocation(locationId = state.locationId) {
    if (!data.locations.length) return false;
    return locationId === "all"
      || data.locations.some((location) => location.id === locationId);
  }

  function formatShortDate(value, fallback = "Not scheduled") {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric"
    }).format(date);
  }

  function daysOpenSince(value) {
    if (!value) return 0;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  }

  function isoDateOffset(days = 0) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function renderAuthScreen() {
    const message = state.authMessage
      ? `<div class="auth-message" role="status">${escapeHtml(state.authMessage)}</div>`
      : "";
    let content = "";

    if (state.authStatus === "configuration-required") {
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Real workspace required</span>
          <h2>Connect SafetyOps to Supabase</h2>
          <p>This build contains no fictional company or employee records. Add the SafetyOps project URL and publishable key to activate secure sign-in and company setup.</p>
        </div>
        <div class="auth-boundary-note">
          <strong>No tenant data in GitHub</strong>
          <span>Companies, locations, accounts, forms, evidence, and operational records load only after Supabase Auth and Row Level Security authorize them.</span>
        </div>
        <div class="auth-readiness-list">
          <span>${statusPill("Public shell ready", "green")} GitHub Pages assets</span>
          <span>${statusPill("Schema ready", "blue")} Versioned SafetyOps migrations</span>
          <span>${statusPill("Connection required", "amber")} SafetyOps Supabase URL and publishable key</span>
        </div>
      `;
    } else if (state.authStatus === "loading") {
      content = `
        <div class="auth-loading" role="status">
          <span class="auth-spinner" aria-hidden="true"></span>
          <h2>Securing your workspace</h2>
          <p>Checking your Supabase session and company membership.</p>
        </div>
      `;
    } else if (state.authStatus === "workspace-error") {
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Workspace unavailable</span>
          <h2>Your session is still secure</h2>
          <p>SafetyOps could not load the authorized company records. No cached tenant workspace is being shown.</p>
        </div>
        ${message}
        <div class="auth-boundary-note">
          <strong>Recovery options</strong>
          <span>Retry after checking the Supabase migration and network status, or sign out cleanly. This read failure did not create or change company records.</span>
        </div>
        <button class="button primary auth-submit" type="button" data-action="retry-workspace">Retry workspace</button>
        <button class="button auth-submit" type="button" data-action="auth-sign-out">Sign out</button>
      `;
    } else if (state.authStatus === "provisioning-pending") {
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Provisioning pending</span>
          <h2>Your company access is being prepared</h2>
          <p>${escapeHtml(state.authUser?.email || "This invited account")} is authenticated, but it does not yet have an active SafetyOps company membership.</p>
        </div>
        ${message}
        <div class="auth-boundary-note">
          <strong>An administrator must finish provisioning</strong>
          <span>The company, locations, owner role, and regulatory-review records are created through the protected administrator workflow. This browser cannot create or join a tenant by itself.</span>
        </div>
        <button class="button primary auth-submit" type="button" data-action="retry-workspace">Check again</button>
        <button class="button auth-submit" type="button" data-action="auth-sign-out">Sign out</button>
      `;
    } else if (state.authStatus === "password-setup") {
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Secure account activation</span>
          <h2>${state.authFlow === "recovery" ? "Choose a new password" : "Finish your invitation"}</h2>
          <p>Set a private password for ${escapeHtml(state.authUser?.email || "this account")}. SafetyOps never sends or stores it in GitHub.</p>
        </div>
        ${message}
        <form id="auth-password-setup-form" class="auth-form">
           <label for="auth-new-password">New password</label>
           <input id="auth-new-password" name="password" type="password" autocomplete="new-password" minlength="${passwordMinimumLength}" required>
          <p class="field-hint">${passwordPolicyMessage}</p>
           <label for="auth-confirm-password">Confirm new password</label>
          <input id="auth-confirm-password" name="confirm_password" type="password" autocomplete="new-password" minlength="${passwordMinimumLength}" required>
          <button class="button primary auth-submit" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Securing account..." : "Set password and continue"}</button>
          <button class="button auth-submit" type="button" data-action="auth-sign-out">Cancel and sign out</button>
        </form>
      `;
    } else if (state.authMode === "recovery") {
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Account recovery</span>
          <h2>Reset your password</h2>
          <p>Enter your invited email address. If it is registered, Supabase will send a secure recovery link.</p>
        </div>
        ${message}
        <form id="auth-recovery-form" class="auth-form">
          <label for="auth-recovery-email">Email</label>
          <input id="auth-recovery-email" name="email" type="email" autocomplete="email" required>
          <button class="button primary auth-submit" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Sending..." : "Send recovery link"}</button>
          <button class="button auth-submit" type="button" data-action="auth-mode" data-mode="sign-in">Back to sign in</button>
        </form>
      `;
    } else {
      const signingUp = publicSignupEnabled && state.authMode === "sign-up";
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Secure company access</span>
          <h2>${signingUp ? "Create your account" : "Welcome back"}</h2>
          <p>${signingUp ? "Create a confirmed account for an approved deployment." : "Sign in to your private company safety workspace."}</p>
        </div>
        ${publicSignupEnabled ? `<div class="tabs auth-tabs" role="tablist" aria-label="Account access">
          <button class="tab ${!signingUp ? "active" : ""}" type="button" role="tab" aria-selected="${!signingUp}" data-action="auth-mode" data-mode="sign-in">Sign in</button>
          <button class="tab ${signingUp ? "active" : ""}" type="button" role="tab" aria-selected="${signingUp}" data-action="auth-mode" data-mode="sign-up">Create account</button>
        </div>` : ""}
        ${message}
        <form id="${signingUp ? "auth-signup-form" : "auth-signin-form"}" class="auth-form">
          ${signingUp ? `
            <label for="auth-full-name">Full name</label>
            <input id="auth-full-name" name="full_name" autocomplete="name" minlength="2" maxlength="120" required>
          ` : ""}
          <label for="auth-email">Email</label>
          <input id="auth-email" name="email" type="email" autocomplete="email" required>
          <label for="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" autocomplete="${signingUp ? "new-password" : "current-password"}" ${signingUp ? `minlength="${passwordMinimumLength}"` : ""} required>
          <button class="button primary auth-submit" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Please wait…" : signingUp ? "Create secure account" : "Sign in"}</button>
        </form>
        ${!signingUp ? `<button class="button auth-submit" type="button" data-action="auth-mode" data-mode="recovery">Forgot password?</button>` : ""}
        <p class="auth-legal">The browser receives only a publishable Supabase key. Database policies—not the UI—enforce company and location access.</p>
      `;
    }

    return `
      <main class="auth-shell">
        <section class="auth-story" aria-label="SafetyOps product overview">
          <div class="auth-brand"><span>SO</span><strong>SafetyOps</strong></div>
          <div>
            <p class="eyebrow">Paperless safety operations</p>
            <h1>One private system for training, forms, programs, and proof.</h1>
            <p>Run a multi-location safety program without putting company files or worker records in the public GitHub application.</p>
          </div>
          <ul class="auth-feature-list">
            <li><strong>Tenant isolation</strong><span>Company membership and location-aware RLS on every business record.</span></li>
            <li><strong>Traceable forms</strong><span>Immutable originals, versioned templates, signed submissions, and SHA-256 lineage.</span></li>
            <li><strong>Private files</strong><span>Supabase Storage with short-lived signed URLs and server-side verification.</span></li>
          </ul>
        </section>
        <section class="auth-panel">
          <div class="auth-card">${content}</div>
        </section>
      </main>
    `;
  }

  function resetTenantOperationalData() {
    [
      "tasks",
      "inspectionTemplates",
      "inspections",
      "courses",
      "people",
      "trainingAssignments",
      "trainingRequirements",
      "trainingCompletions",
      "committeeMeetings",
      "employeeDocuments",
      "employeeSignatures",
      "employeeFormAssignments",
      "employeeFormSubmissions",
      "incidents",
      "actions",
      "documents",
      "activity",
      "programAssignments",
      "programSubmissions"
    ].forEach((key) => {
      data[key] = [];
    });
  }

  function resetTenantProgramLibrary() {
    programLibrary.meta = {
      sourceName: "Company safety library",
      sourceFolderId: null,
      sourceUrl: null,
      sourceCapturedOn: null,
      privacy: "Tenant data loads after authentication",
      ingestionMode: "Create a company or sign in to load its private programs, forms, and source files.",
      counts: {
        programs: 0,
        digitalForms: 0,
        folders: 0,
        looseResources: 0
      },
      extraction: {
        extracted: 0,
        imageOnly: 0,
        ocrRequired: 0
      },
      binaryIngestion: {
        filesVerified: 0,
        totalBytes: 0,
        capturedOn: null,
        storageTarget: "Private Supabase Storage"
      }
    };
    programLibrary.programs = [];
    programLibrary.forms = [];
    programLibrary.folders = [];
    programLibrary.looseResources = [];
    programLibrary.importCandidates = [];
    programLibrary.extracts = {};
  }

  function purgeTenantWorkspace() {
    data.company = null;
    data.currentUser = null;
    data.locations = [];
    resetTenantOperationalData();
    resetTenantProgramLibrary();
    state.locationId = "all";
    state.searchQuery = "";
    state.programQuery = "";
    state.modal = null;
    state.modalContext = {};
    state.referenceId = null;
    state.programDrawerId = null;
    state.employeeDrawerId = null;
    state.originalPreviewId = null;
    state.activeFormId = null;
    state.selectedTemplateId = null;
    state.localFormUploads = [];
  }

  async function loadAuthenticatedWorkspace(user, transitionEpoch = authTransitionEpoch) {
    const requestSequence = ++workspaceLoadSequence;
    const isCurrentRequest = () => (
      transitionEpoch === authTransitionEpoch
      && requestSequence === workspaceLoadSequence
      && state.authUser?.id === user.id
    );
    if (!isCurrentRequest()) return;
    try {
      const membershipResult = await supabaseClient
        .from("company_memberships")
        .select("company_id, role, default_location_id, created_at")
        .eq("user_id", user.id)
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!isCurrentRequest()) return;
      if (membershipResult.error) throw membershipResult.error;

      if (!membershipResult.data) {
        purgeTenantWorkspace();
        state.authUser = user;
        state.authStatus = "provisioning-pending";
        state.authBusy = false;
        render();
        return;
      }

      const membership = membershipResult.data;
      const [
        companyResult,
        locationsResult,
        profileResult,
        regulatoryProfilesResult,
        templatesResult,
        inspectionsResult,
        inspectionContextsResult,
        coursesResult,
        trainingAssignmentsResult,
        trainingRequirementsResult,
        trainingCompletionsResult,
        incidentsResult,
        actionsResult,
        committeeMeetingsResult,
        employeesResult,
        documentsResult,
        documentAcknowledgementsResult,
        employeeDocumentsResult,
        employeeSignaturesResult,
        employeeFormAssignmentsResult,
        employeeFormSubmissionsResult,
        membersResult,
        certificationsResult,
        auditResult,
        programsResult,
        programVersionsResult,
        programApplicabilityResult,
        programFormTemplatesResult,
        programFormVersionsResult,
        programFormFieldsResult,
        programAssignmentsResult,
        programSubmissionsResult,
        programRegulatoryLinksResult,
        programFormFilesResult,
        importCandidatesResult
      ] = await Promise.all([
        supabaseClient
          .from("companies")
          .select("id, name, slug, timezone")
          .eq("id", membership.company_id)
          .single(),
        supabaseClient
          .from("locations")
          .select("id, name, code, address, timezone, active")
          .eq("company_id", membership.company_id)
          .eq("active", true)
          .order("created_at", { ascending: true })
          .limit(100),
        supabaseClient
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle(),
        supabaseClient
          .from("location_regulatory_profiles")
          .select("id, location_id, version, state_code, employer_type, naics_codes, operation_facts, hazard_facts, status, effective_from, effective_to, reviewed_by, reviewed_at, updated_at, location_jurisdiction_assignments(coverage_status, valid_from, valid_to, reviewed_by, reviewed_at, jurisdiction:regulatory_jurisdictions(code, name))")
          .eq("company_id", membership.company_id)
          .order("version", { ascending: false })
          .limit(500),
        supabaseClient
          .from("form_templates")
          .select("id, name, category, current_version, active, created_at, updated_at, form_template_versions(id, version, published, schema_json)")
          .eq("company_id", membership.company_id)
          .eq("active", true)
          .order("updated_at", { ascending: false })
          .limit(500),
        supabaseClient
          .from("inspections")
          .select("id, location_id, template_id, template_version_id, title, status, score, scheduled_for, submitted_at, created_at, responses, form_templates(name)")
          .eq("company_id", membership.company_id)
          .order("created_at", { ascending: false })
          .limit(100),
        supabaseClient
          .from("inspection_regulatory_contexts")
          .select("inspection_id, regulatory_profile_id, trace_status, template_schema_sha256, submission_payload_sha256, profile_sha256, mapping_count, evidence_count, excluded_count, unresolved_count, context_manifest, context_sha256, captured_at")
          .eq("company_id", membership.company_id)
          .order("captured_at", { ascending: false })
          .limit(100),
        supabaseClient
          .from("training_courses")
          .select("id, title, category, description, estimated_minutes, active, current_version, validity_months, default_retention_months, retention_basis, created_at, updated_at, training_course_versions(id, version, published)")
          .eq("company_id", membership.company_id)
          .eq("active", true)
          .order("updated_at", { ascending: false })
          .limit(500),
        supabaseClient
          .from("training_assignments")
          .select("id, location_id, course_id, course_version, employee_id, worker_profile_id, requirement_id, status, assigned_at, due_at, completed_at, quiz_score, valid_until, retain_until, retention_status")
          .eq("company_id", membership.company_id)
          .order("assigned_at", { ascending: false })
          .limit(1000),
        supabaseClient
          .from("training_requirements")
          .select("id, location_id, employee_id, course_id, requirement_reason, cadence_months, retention_months, retention_basis, regulatory_basis, active, created_at, updated_at")
          .eq("company_id", membership.company_id)
          .eq("active", true)
          .order("updated_at", { ascending: false })
          .limit(1000),
        supabaseClient
          .from("training_completions")
          .select("id, location_id, assignment_id, employee_id, course_id, course_version, requirement_id, completed_at, valid_until, retain_until, retention_status, completion_method, quiz_score, instructor_name, verified_by, completion_sha256, created_at")
          .eq("company_id", membership.company_id)
          .order("completed_at", { ascending: false })
          .limit(2000),
        supabaseClient
          .from("incidents")
          .select("id, location_id, incident_number, title, incident_type, potential_severity, status, occurred_at, reported_by, created_at")
          .eq("company_id", membership.company_id)
          .order("occurred_at", { ascending: false })
          .limit(100),
        supabaseClient
          .from("corrective_actions")
          .select("id, location_id, source_type, source_id, committee_meeting_id, title, description, priority, status, assigned_employee_id, assigned_to, due_at, required_evidence, closeout_note, created_at")
          .eq("company_id", membership.company_id)
          .order("created_at", { ascending: false })
          .limit(150),
        supabaseClient
          .from("safety_committee_meetings")
          .select("id, location_id, scope, title, meeting_date, status, chair_employee_id, agenda, notes, decisions, next_meeting_at, prepared_by, finalized_by, finalized_at, minutes_sha256, created_at, updated_at, safety_committee_attendees(id, employee_id, committee_role, attendance_status, attendance_method)")
          .eq("company_id", membership.company_id)
          .order("meeting_date", { ascending: false })
          .limit(500),
        supabaseClient
          .from("employees")
          .select("id, user_id, employee_number, full_name, work_email, job_title, department, employment_status, hired_on, separated_on, primary_location_id, created_at, updated_at, employee_location_assignments(id, location_id, is_primary)")
          .eq("company_id", membership.company_id)
          .order("full_name", { ascending: true })
          .limit(2000),
        supabaseClient
          .from("documents")
          .select("id, title, document_type, owner_profile_id, current_version, acknowledgement_required, effective_at, review_at, active, updated_at, document_versions(id, version, published, checksum_sha256, published_at)")
          .eq("company_id", membership.company_id)
          .eq("active", true)
          .order("updated_at", { ascending: false })
          .limit(500),
        supabaseClient
          .from("document_acknowledgements")
          .select("id, document_id, document_version_id, user_id, acknowledged_at, acknowledgement_record")
          .eq("company_id", membership.company_id)
          .eq("user_id", user.id)
          .limit(1000),
        supabaseClient
          .from("employee_documents")
          .select("id, company_id, location_id, employee_id, document_kind, title, document_date, status, original_filename, mime_type, size_bytes, document_sha256, validation_status, malware_scan_status, signature_intent, consent_version, signature_due_at, retention_basis, retain_until, legal_hold, employee_can_view, manager_visibility, audit_visible, uploaded_by, created_by, signed_at, created_at, updated_at")
          .eq("company_id", membership.company_id)
          .order("created_at", { ascending: false })
          .limit(2000),
        supabaseClient
          .from("employee_document_signatures")
          .select("id, employee_document_id, employee_id, authenticated_actor_user_id, facilitator_user_id, signer_name_snapshot, authenticated_actor_role_snapshot, signature_method, identity_verification_method, facilitator_attestation, signature_intent, consent_version, typed_name_confirmation, signed_source_sha256, signature_sha256, signed_at")
          .eq("company_id", membership.company_id)
          .order("signed_at", { ascending: false })
          .limit(2000),
        supabaseClient
          .from("employee_form_assignments")
          .select("id, company_id, location_id, employee_id, program_version_id, form_template_version_id, title, instructions, status, due_at, assigned_by, assigned_at, started_at, completed_at, created_at, updated_at")
          .eq("company_id", membership.company_id)
          .order("assigned_at", { ascending: false })
          .limit(2000),
        supabaseClient
          .from("employee_form_submissions")
          .select("id, company_id, location_id, assignment_id, employee_id, program_version_id, form_template_version_id, facilitator_user_id, employee_name_snapshot, facilitator_name_snapshot, facilitator_role_snapshot, identity_verification_method, form_schema_sha256, signature_intent, consent_version, typed_name_confirmation, employee_attestation, was_overdue, submitted_at, submission_sha256, created_at")
          .eq("company_id", membership.company_id)
          .order("submitted_at", { ascending: false })
          .limit(2000),
        supabaseClient
          .from("company_memberships")
          .select("user_id, role, active, profiles(full_name), location_memberships(location_id)")
          .eq("company_id", membership.company_id)
          .eq("active", true)
          .order("created_at", { ascending: true })
          .limit(500),
        supabaseClient
          .from("certifications")
          .select("id, worker_profile_id, location_id, certification_type, expires_at, verification_status")
          .eq("company_id", membership.company_id)
          .limit(1000),
        supabaseClient
          .from("audit_events")
          .select("id, location_id, actor_user_id, entity_type, action, details, occurred_at")
          .eq("company_id", membership.company_id)
          .order("occurred_at", { ascending: false })
          .limit(30),
        supabaseClient
          .from("safety_programs")
          .select("id, program_code, title, description, category, owner_profile_id, lifecycle_status, review_interval_months, created_at, updated_at")
          .eq("company_id", membership.company_id)
          .eq("lifecycle_status", "active")
          .order("updated_at", { ascending: false })
          .limit(500),
        supabaseClient
          .from("safety_program_versions")
          .select("id, program_id, version, status, change_summary, effective_from, effective_to, next_review_at, source_manifest_sha256, content_manifest_sha256, published_at, created_at, updated_at")
          .eq("company_id", membership.company_id)
          .order("version", { ascending: false })
          .limit(1000),
        supabaseClient
          .from("safety_program_location_applicability")
          .select("id, program_version_id, location_id, regulatory_profile_id, applicability_status, rationale, conditions, local_addenda, review_status, effective_from, effective_to, applicability_sha256, reviewed_at")
          .eq("company_id", membership.company_id)
          .limit(1000),
        supabaseClient
          .from("safety_program_form_templates")
          .select("id, program_id, template_key, name, purpose, created_at")
          .eq("company_id", membership.company_id)
          .order("created_at", { ascending: true })
          .limit(1000),
        supabaseClient
          .from("safety_program_form_template_versions")
          .select("id, program_id, program_version_id, template_id, version, title, instructions_markdown, status, completion_policy, signature_policy, schema_sha256, origin_kind, source_manifest_sha256, published_at, created_at, updated_at")
          .eq("company_id", membership.company_id)
          .order("version", { ascending: false })
          .limit(1000),
        supabaseClient
          .from("safety_program_form_fields")
          .select("id, program_version_id, form_template_version_id, parent_field_id, field_key, field_type, label, help_text, placeholder, required, sort_order, options, default_value, validation_rules, display_logic, data_classification, field_sha256")
          .eq("company_id", membership.company_id)
          .order("sort_order", { ascending: true })
          .limit(1000),
        supabaseClient
          .from("safety_program_assignments")
          .select("id, program_version_id, location_id, assignee_user_id, assignment_type, form_template_version_id, training_course_version_id, title, instructions, status, assigned_at, due_at, started_at, completed_at, assigned_by")
          .eq("company_id", membership.company_id)
          .order("assigned_at", { ascending: false })
          .limit(250),
        supabaseClient
          .from("safety_program_form_submissions")
          .select("id, program_version_id, location_id, form_template_version_id, assignment_id, submitted_by, status, client_submission_key, form_schema_sha256, submitted_payload_sha256, submission_context, started_at, submitted_at, reviewed_at, created_at, updated_at")
          .eq("company_id", membership.company_id)
          .order("created_at", { ascending: false })
          .limit(250),
        supabaseClient
          .from("safety_program_regulatory_links")
          .select("id, program_version_id, target_kind, form_template_version_id, form_field_id, location_id, jurisdiction_id, requirement_version_id, regulatory_unit_version_id, relationship, coverage_kind, source_locator, exact_excerpt_sha256, rationale, trace_sha256, reviewed_at, jurisdiction:regulatory_jurisdictions(code, name), requirement:compliance_requirement_versions(id, version, status, compliance_requirements(requirement_code, title)), regulatory_unit:regulatory_unit_versions(id, canonical_citation, legal_status, content_sha256, source_locator)")
          .eq("company_id", membership.company_id)
          .limit(1000),
        supabaseClient
          .from("safety_program_form_template_files")
          .select("id, program_version_id, form_template_version_id, file_role, is_primary, source_locator, created_at")
          .eq("company_id", membership.company_id)
          .limit(1000),
        supabaseClient
          .from("safety_program_import_candidates")
          .select("id, company_id, display_name, source_collection, folder_hint, candidate_kind, review_status, access_scope, classification, language, proposed_location_codes, page_count, render_verified, mime_type, size_bytes, content_sha256, source_path_sha256, created_at")
          .eq("company_id", membership.company_id)
          .order("display_name", { ascending: true })
          .limit(2000)
      ]);
      if (!isCurrentRequest()) return;
      const failedResult = [
        companyResult,
        locationsResult,
        profileResult,
        regulatoryProfilesResult,
        templatesResult,
        inspectionsResult,
        inspectionContextsResult,
        coursesResult,
        trainingAssignmentsResult,
        trainingRequirementsResult,
        trainingCompletionsResult,
        incidentsResult,
        actionsResult,
        committeeMeetingsResult,
        employeesResult,
        documentsResult,
        documentAcknowledgementsResult,
        employeeDocumentsResult,
        employeeSignaturesResult,
        employeeFormAssignmentsResult,
        employeeFormSubmissionsResult,
        membersResult,
        certificationsResult,
        auditResult,
        programsResult,
        programVersionsResult,
        programApplicabilityResult,
        programFormTemplatesResult,
        programFormVersionsResult,
        programFormFieldsResult,
        programAssignmentsResult,
        programSubmissionsResult,
        programRegulatoryLinksResult,
        programFormFilesResult
      ].find((result) => result?.error);
      if (failedResult) throw failedResult.error;

      const fullName = profileResult.data?.full_name?.trim()
        || user.user_metadata?.full_name
        || user.email?.split("@")[0]
        || "SafetyOps user";
      const initials = fullName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("") || "SO";

      resetTenantOperationalData();
      const rawMembers = membersResult.data || [];
      const rawRole = membership.role || "worker";
      const rawAssignments = trainingAssignmentsResult.data || [];
      const rawTrainingRequirements = trainingRequirementsResult.data || [];
      const rawTrainingCompletions = trainingCompletionsResult.data || [];
      const rawEmployees = employeesResult.data || [];
      const rawCommitteeMeetings = committeeMeetingsResult.data || [];
      const rawEmployeeDocuments = employeeDocumentsResult.data || [];
      const rawEmployeeSignatures = employeeSignaturesResult.data || [];
      const rawEmployeeFormAssignments = employeeFormAssignmentsResult.data || [];
      const rawEmployeeFormSubmissions = employeeFormSubmissionsResult.data || [];
      const rawCertifications = certificationsResult.data || [];
      const rawPrograms = programsResult.data || [];
      const rawProgramVersions = programVersionsResult.data || [];
      const rawProgramApplicability = programApplicabilityResult.data || [];
      const rawProgramFormTemplates = programFormTemplatesResult.data || [];
      const rawProgramFormVersions = programFormVersionsResult.data || [];
      const rawProgramFormFields = programFormFieldsResult.data || [];
      const rawProgramAssignments = programAssignmentsResult.data || [];
      const rawProgramSubmissions = programSubmissionsResult.data || [];
      const rawProgramRegulatoryLinks = programRegulatoryLinksResult.data || [];
      const rawProgramFormFiles = programFormFilesResult.data || [];
      const rawImportCandidates = importCandidatesResult?.error
        ? []
        : importCandidatesResult.data || [];
      state.formArchiveError = importCandidatesResult?.error
        ? "The private Drive archive is temporarily unavailable. The rest of the workspace remains active."
        : "";
      const memberNameById = new Map(rawMembers.map((member) => [
        member.user_id,
        member.profiles?.full_name?.trim() || "Team member"
      ]));
      const memberRoleById = new Map(rawMembers.map((member) => [
        member.user_id,
        member.role
      ]));
      memberNameById.set(user.id, fullName);

      data.company = {
        id: companyResult.data.id,
        name: companyResult.data.name,
        slug: companyResult.data.slug,
        timezone: companyResult.data.timezone,
        plan: "Private Supabase workspace",
        activeWorkers: rawEmployees.filter((employee) => employee.employment_status === "active").length,
        daysWithoutRecordable: null
      };
      data.currentUser = {
        id: user.id,
        name: fullName,
        initials,
        role: readableRole(rawRole),
        rawRole
      };

      data.people = rawEmployees.map((employee) => {
        const name = employee.full_name?.trim() || "Employee record";
        const workerAssignments = rawAssignments.filter((assignment) =>
          assignment.employee_id === employee.id
        );
        const completeAssignments = workerAssignments.filter((assignment) =>
          ["complete", "completed"].includes(assignment.status)
        ).length;
        const workerCertifications = rawCertifications.filter((certification) =>
          employee.user_id && certification.worker_profile_id === employee.user_id
        );
        const workerDocuments = rawEmployeeDocuments.filter((documentRecord) =>
          documentRecord.employee_id === employee.id
        );
        const workerEmployeeForms = rawEmployeeFormAssignments.filter((assignment) =>
          assignment.employee_id === employee.id
        );
        const now = Date.now();
        const hasExpired = workerCertifications.some((certification) =>
          certification.verification_status === "expired" ||
          (certification.expires_at && new Date(certification.expires_at).getTime() < now)
        );
        const hasDueSoon = workerCertifications.some((certification) => {
          if (!certification.expires_at) return false;
          const remaining = new Date(certification.expires_at).getTime() - now;
          return remaining >= 0 && remaining <= 30 * 86_400_000;
        });
        const hasTrainingDue = workerAssignments.some((assignment) =>
          !["complete", "completed", "waived"].includes(assignment.status)
        );
        const locationIds = [...new Set(
          (employee.employee_location_assignments || [])
            .map((item) => item.location_id)
            .filter(Boolean)
        )];
        const primaryLocationId = employee.primary_location_id || locationIds[0] || null;
        const linkedRole = employee.user_id ? memberRoleById.get(employee.user_id) : null;
        const pendingDocuments = workerDocuments.filter((documentRecord) =>
          documentRecord.status === "awaiting_signature"
        ).length;
        const pendingEmployeeForms = workerEmployeeForms.filter((assignment) =>
          ["assigned", "in_progress"].includes(assignment.status)
        ).length;
        const completedEmployeeForms = workerEmployeeForms.filter((assignment) =>
          assignment.status === "completed"
        ).length;
        return {
          id: employee.id,
          userId: employee.user_id || null,
          employeeNumber: employee.employee_number || null,
          name,
          initials: name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "SO",
          role: linkedRole ? readableRole(linkedRole) : employee.job_title || "Employee",
          jobTitle: employee.job_title || "",
          department: employee.department || "",
          workEmail: employee.work_email || "",
          employmentStatus: readableStatus(employee.employment_status),
          locationId: primaryLocationId,
          locationIds,
          training: workerAssignments.length
            ? Math.round((completeAssignments / workerAssignments.length) * 100)
            : 0,
          credentials: `${workerCertifications.length} record${workerCertifications.length === 1 ? "" : "s"}`,
          documentCount: workerDocuments.length + workerEmployeeForms.length,
          pendingDocuments: pendingDocuments + pendingEmployeeForms,
          pendingEmployeeForms,
          completedEmployeeForms,
          status: hasExpired
            ? "Expired"
            : hasDueSoon
              ? "Due soon"
              : pendingDocuments || pendingEmployeeForms
                ? "Form due"
                : hasTrainingDue
                  ? "Training due"
                  : "Current"
        };
      });

      data.inspectionTemplates = (templatesResult.data || []).map((template) => {
        const currentVersion = template.form_template_versions?.find((version) =>
          version.version === template.current_version
        );
        const schema = currentVersion?.schema_json || {};
        const schemaQuestions = Array.isArray(schema.questions)
          ? schema.questions
          : Array.isArray(schema.fields)
            ? schema.fields
            : [];
        const templateInspections = (inspectionsResult.data || []).filter((inspection) =>
          inspection.template_id === template.id
        );
        const lastUsed = templateInspections[0]?.submitted_at || templateInspections[0]?.created_at;
        return {
          id: template.id,
          name: template.name,
          category: template.category,
          questions: schemaQuestions.length,
          questionDefinitions: schemaQuestions,
          frequency: "As assigned",
          used: templateInspections.length,
          lastUsed: lastUsed ? formatShortDate(lastUsed) : "Not yet used",
          currentVersion: template.current_version,
          currentVersionId: currentVersion?.id || null,
          published: Boolean(currentVersion?.published)
        };
      });

      const inspectionContextById = new Map(
        (inspectionContextsResult.data || []).map((context) => [context.inspection_id, context])
      );
      data.inspections = (inspectionsResult.data || []).map((inspection) => {
        const responseValues = Object.values(inspection.responses?.answers || {});
        const findings = responseValues.filter((response) =>
          response === "fail" || response?.value === "fail"
        ).length;
        const regulatoryContext = inspectionContextById.get(inspection.id);
        return {
          id: inspection.id,
          template: inspection.form_templates?.name || inspection.title,
          templateVersionId: inspection.template_version_id,
          locationId: inspection.location_id,
          assignee: inspection.submitted_at ? "Signed submission" : "Draft owner",
          score: inspection.score === null ? null : Number(inspection.score),
          status: readableStatus(inspection.status),
          due: formatShortDate(inspection.scheduled_for || inspection.submitted_at || inspection.created_at),
          submittedAt: inspection.submitted_at,
          findings,
          regulatorySnapshot: inspection.responses?.regulatorySnapshot || null,
          regulatoryTraceStatus: regulatoryContext?.trace_status
            ? readableStatus(regulatoryContext.trace_status)
            : null,
          regulatoryEvidenceCount: Number(regulatoryContext?.evidence_count || 0),
          regulatoryUnresolvedCount: Number(regulatoryContext?.unresolved_count || 0),
          regulatoryContextSha256: regulatoryContext?.context_sha256 || null
        };
      });

      data.courses = (coursesResult.data || []).map((course) => {
        const assignments = rawAssignments.filter((assignment) => assignment.course_id === course.id);
        const complete = assignments.filter((assignment) =>
          ["complete", "completed"].includes(assignment.status)
        ).length;
        const dueDates = assignments.map((assignment) => assignment.due_at).filter(Boolean).sort();
        const currentVersion = course.training_course_versions?.find((version) =>
          version.version === course.current_version
        );
        return {
          id: course.id,
          name: course.title,
          category: course.category,
          description: course.description,
          duration: `${course.estimated_minutes} min`,
          format: "Supabase course",
          assigned: assignments.length,
          complete: assignments.length ? Math.round((complete / assignments.length) * 100) : 0,
          due: dueDates.length ? formatShortDate(dueDates[0]) : "Not assigned",
          currentVersion: course.current_version,
          currentVersionId: currentVersion?.id || null,
          published: Boolean(currentVersion?.published),
          validityMonths: course.validity_months,
          retentionMonths: course.default_retention_months,
          retentionBasis: course.retention_basis || { status: "review_required" }
        };
      });

      data.incidents = (incidentsResult.data || []).map((incident) => ({
        id: `INC-${incident.incident_number}`,
        databaseId: incident.id,
        title: incident.title,
        type: incident.incident_type,
        severity: readableStatus(incident.potential_severity),
        locationId: incident.location_id,
        reportedBy: memberNameById.get(incident.reported_by) || "Authorized reporter",
        date: formatShortDate(incident.occurred_at),
        status: readableStatus(incident.status),
        daysOpen: daysOpenSince(incident.created_at)
      }));

      data.actions = (actionsResult.data || []).map((action) => ({
        id: action.id,
        title: action.title,
        description: action.description || "",
        source: readableStatus(action.source_type),
        sourceId: action.source_id,
        committeeMeetingId: action.committee_meeting_id,
        ownerId: action.assigned_employee_id,
        owner: data.people.find((person) => person.id === action.assigned_employee_id)?.name
          || memberNameById.get(action.assigned_to)
          || "Unassigned",
        locationId: action.location_id,
        due: formatShortDate(action.due_at),
        dueAt: action.due_at,
        priority: readableStatus(action.priority),
        status: readableStatus(action.status),
        requiredEvidence: action.required_evidence || "",
        closeoutNote: action.closeout_note || "",
        createdAt: action.created_at
      }));

      data.trainingRequirements = rawTrainingRequirements.map((requirement) => ({
        id: requirement.id,
        locationId: requirement.location_id,
        employeeId: requirement.employee_id,
        courseId: requirement.course_id,
        reason: requirement.requirement_reason,
        cadenceMonths: requirement.cadence_months,
        retentionMonths: requirement.retention_months,
        retentionBasis: requirement.retention_basis || { status: "review_required" },
        regulatoryBasis: requirement.regulatory_basis || [],
        active: requirement.active
      }));

      data.trainingCompletions = rawTrainingCompletions.map((completion) => ({
        id: completion.id,
        assignmentId: completion.assignment_id,
        employeeId: completion.employee_id,
        locationId: completion.location_id,
        courseId: completion.course_id,
        courseVersion: completion.course_version,
        requirementId: completion.requirement_id,
        completedAt: completion.completed_at,
        completed: formatShortDate(completion.completed_at),
        validUntil: completion.valid_until,
        validThrough: formatShortDate(completion.valid_until, "No renewal set"),
        retainUntil: completion.retain_until,
        retainThrough: formatShortDate(completion.retain_until, "Policy review required"),
        retentionStatus: readableStatus(completion.retention_status),
        completionMethod: readableStatus(completion.completion_method),
        quizScore: completion.quiz_score,
        instructorName: completion.instructor_name || "",
        completionSha256: completion.completion_sha256
      }));

      data.trainingAssignments = rawAssignments.map((assignment) => {
        const completion = data.trainingCompletions.find((item) =>
          item.assignmentId === assignment.id
        );
        const requirement = data.trainingRequirements.find((item) =>
          item.id === assignment.requirement_id
        );
        const dueTime = assignment.due_at ? new Date(assignment.due_at).getTime() : null;
        const terminal = ["complete", "completed", "waived"].includes(assignment.status);
        return {
          id: assignment.id,
          employeeId: assignment.employee_id,
          employee: data.people.find((person) => person.id === assignment.employee_id)?.name || "Employee record",
          locationId: assignment.location_id,
          courseId: assignment.course_id,
          course: data.courses.find((course) => course.id === assignment.course_id)?.name || "Training course",
          courseVersion: assignment.course_version,
          requirementId: assignment.requirement_id,
          reason: requirement?.reason || "Company safety requirement",
          assignedAt: assignment.assigned_at,
          assigned: formatShortDate(assignment.assigned_at),
          dueAt: assignment.due_at,
          due: formatShortDate(assignment.due_at),
          completedAt: assignment.completed_at,
          validUntil: completion?.validUntil || assignment.valid_until,
          retainUntil: completion?.retainUntil || assignment.retain_until,
          retainThrough: completion?.retainThrough
            || formatShortDate(assignment.retain_until, "Policy review required"),
          retentionStatus: completion?.retentionStatus || readableStatus(assignment.retention_status),
          status: !terminal && dueTime && dueTime < Date.now()
            ? "Overdue"
            : readableStatus(assignment.status),
          completion
        };
      });

      data.employeeSignatures = rawEmployeeSignatures.map((signature) => ({
        id: signature.id,
        employeeDocumentId: signature.employee_document_id,
        employeeId: signature.employee_id,
        authenticatedActorUserId: signature.authenticated_actor_user_id,
        facilitatorUserId: signature.facilitator_user_id,
        signerName: signature.signer_name_snapshot,
        authenticatedActorRole: readableRole(signature.authenticated_actor_role_snapshot),
        method: readableStatus(signature.signature_method),
        identityVerification: readableStatus(signature.identity_verification_method),
        facilitatorAttestation: signature.facilitator_attestation,
        intent: signature.signature_intent,
        sourceSha256: signature.signed_source_sha256,
        signatureSha256: signature.signature_sha256,
        signedAt: signature.signed_at
      }));

      data.employeeDocuments = rawEmployeeDocuments.map((documentRecord) => {
        const signature = data.employeeSignatures.find((item) =>
          item.employeeDocumentId === documentRecord.id
        );
        return {
          id: documentRecord.id,
          employeeId: documentRecord.employee_id,
          employee: data.people.find((person) => person.id === documentRecord.employee_id)?.name || "Employee record",
          locationId: documentRecord.location_id,
          kind: documentRecord.document_kind,
          title: documentRecord.title,
          documentDate: documentRecord.document_date,
          status: readableStatus(documentRecord.status),
          rawStatus: documentRecord.status,
          filename: documentRecord.original_filename,
          mimeType: documentRecord.mime_type,
          sizeBytes: Number(documentRecord.size_bytes || 0),
          contentSha256: documentRecord.document_sha256,
          validationStatus: readableStatus(documentRecord.validation_status),
          malwareScanStatus: readableStatus(documentRecord.malware_scan_status),
          signatureIntent: documentRecord.signature_intent,
          signatureDueAt: documentRecord.signature_due_at,
          signatureDue: formatShortDate(documentRecord.signature_due_at, "No due date"),
          retentionBasis: documentRecord.retention_basis || { status: "review_required" },
          retainUntil: documentRecord.retain_until,
          retainThrough: formatShortDate(documentRecord.retain_until, "Policy review required"),
          legalHold: documentRecord.legal_hold,
          signedAt: documentRecord.signed_at,
          signature
        };
      });

      data.employeeFormSubmissions = rawEmployeeFormSubmissions.map((submission) => ({
        id: submission.id,
        assignmentId: submission.assignment_id,
        employeeId: submission.employee_id,
        locationId: submission.location_id,
        programVersionId: submission.program_version_id,
        formTemplateVersionId: submission.form_template_version_id,
        employeeName: submission.employee_name_snapshot,
        facilitatorName: submission.facilitator_name_snapshot,
        facilitatorRole: readableRole(submission.facilitator_role_snapshot),
        identityVerification: readableStatus(submission.identity_verification_method),
        schemaSha256: submission.form_schema_sha256,
        wasOverdue: Boolean(submission.was_overdue),
        submittedAt: submission.submitted_at,
        submitted: formatShortDate(submission.submitted_at),
        submissionSha256: submission.submission_sha256
      }));

      data.employeeFormAssignments = rawEmployeeFormAssignments.map((assignment) => {
        const formVersion = rawProgramFormVersions.find((version) =>
          version.id === assignment.form_template_version_id
        );
        const formTemplate = rawProgramFormTemplates.find((template) =>
          template.id === formVersion?.template_id
        );
        const submission = data.employeeFormSubmissions.find((item) =>
          item.assignmentId === assignment.id
        );
        const dueTime = assignment.due_at ? new Date(assignment.due_at).getTime() : null;
        const open = ["assigned", "in_progress"].includes(assignment.status);
        return {
          id: assignment.id,
          employeeId: assignment.employee_id,
          employee: data.people.find((person) => person.id === assignment.employee_id)?.name || "Employee record",
          locationId: assignment.location_id,
          programVersionId: assignment.program_version_id,
          formTemplateVersionId: assignment.form_template_version_id,
          formTemplateId: formVersion?.template_id || null,
          formTitle: formVersion?.title || formTemplate?.name || assignment.title,
          title: assignment.title,
          instructions: assignment.instructions || "",
          rawStatus: assignment.status,
          status: open && dueTime && dueTime < Date.now()
            ? "Overdue"
            : readableStatus(assignment.status),
          dueAt: assignment.due_at,
          due: formatShortDate(assignment.due_at, "No due date"),
          assignedAt: assignment.assigned_at,
          startedAt: assignment.started_at,
          completedAt: assignment.completed_at,
          submission
        };
      });

      data.committeeMeetings = rawCommitteeMeetings.map((meeting) => ({
        id: meeting.id,
        locationId: meeting.location_id,
        scope: meeting.scope,
        title: meeting.title,
        meetingDate: meeting.meeting_date,
        date: formatShortDate(meeting.meeting_date),
        status: readableStatus(meeting.status),
        rawStatus: meeting.status,
        chairEmployeeId: meeting.chair_employee_id,
        chair: data.people.find((person) => person.id === meeting.chair_employee_id)?.name || "Unassigned",
        agenda: meeting.agenda || "",
        notes: meeting.notes || "",
        decisions: meeting.decisions || "",
        nextMeetingAt: meeting.next_meeting_at,
        minutesSha256: meeting.minutes_sha256,
        attendees: (meeting.safety_committee_attendees || []).map((attendee) => ({
          id: attendee.id,
          employeeId: attendee.employee_id,
          employee: data.people.find((person) => person.id === attendee.employee_id)?.name || "Employee record",
          role: readableStatus(attendee.committee_role),
          status: readableStatus(attendee.attendance_status),
          method: readableStatus(attendee.attendance_method)
        })),
        actionCount: data.actions.filter((action) => action.committeeMeetingId === meeting.id).length,
        openActionCount: data.actions.filter((action) =>
          action.committeeMeetingId === meeting.id && action.status !== "Closed"
        ).length
      }));

      data.documents = (documentsResult.data || []).map((documentRecord) => {
        const currentVersion = documentRecord.document_versions?.find((version) =>
          version.version === documentRecord.current_version
        );
        const acknowledgement = (documentAcknowledgementsResult.data || []).find((record) =>
          record.document_id === documentRecord.id
          && record.document_version_id === currentVersion?.id
          && record.user_id === user.id
        );
        return {
          id: documentRecord.id,
          name: documentRecord.title,
          type: documentRecord.document_type,
          version: `v${documentRecord.current_version}`,
          versionNumber: documentRecord.current_version,
          currentVersionId: currentVersion?.id || null,
          versionPublished: Boolean(currentVersion?.published),
          versionChecksumSha256: currentVersion?.checksum_sha256 || null,
          owner: memberNameById.get(documentRecord.owner_profile_id) || "Unassigned",
          updated: formatShortDate(documentRecord.updated_at),
          review: formatShortDate(documentRecord.review_at),
          acknowledgement: documentRecord.acknowledgement_required && currentVersion
            ? acknowledgement ? 100 : 0
            : null,
          acknowledgedAt: acknowledgement?.acknowledged_at || null,
          acknowledgementRequired: documentRecord.acknowledgement_required,
          status: documentRecord.review_at && new Date(documentRecord.review_at).getTime() < Date.now()
            ? "Review due"
            : documentRecord.acknowledgement_required && !acknowledgement
              ? "Acknowledgement due"
              : acknowledgement
                ? "Acknowledged"
                : "Current"
        };
      });

      const operationalDate = new Date().toISOString().slice(0, 10);
      const programVersionIsEffective = (version) => Boolean(
        version
        && (!version.effective_from || version.effective_from <= operationalDate)
        && (!version.effective_to || version.effective_to >= operationalDate)
      );
      const programVersionRank = (version) => {
        if (!version) return -1;
        if (version.status === "published" && programVersionIsEffective(version)) return 4;
        if (version.status === "approved" && programVersionIsEffective(version)) return 3;
        if (version.status === "in_review") return 2;
        if (version.status === "draft") return 1;
        return 0;
      };
      const currentProgramVersionByProgramId = new Map();
      rawProgramVersions.forEach((version) => {
        const current = currentProgramVersionByProgramId.get(version.program_id);
        const versionRank = programVersionRank(version);
        const currentRank = programVersionRank(current);
        if (!current || versionRank > currentRank || (
          versionRank === currentRank && Number(version.version) > Number(current.version)
        )) {
          currentProgramVersionByProgramId.set(version.program_id, version);
        }
      });

      const regulatoryCitationsFor = (programVersionId, formTemplateVersionId = null) => (
        rawProgramRegulatoryLinks
          .filter((link) => (
            link.program_version_id === programVersionId
            && (!formTemplateVersionId || (
              link.target_kind === "program_version"
              || link.form_template_version_id === formTemplateVersionId
            ))
          ))
          .map((link) => (
            link.regulatory_unit?.canonical_citation
            || link.requirement?.compliance_requirements?.requirement_code
            || link.source_locator?.citation
            || link.source_locator?.identifier
            || link.source_locator?.officialUrl
            || link.source_locator?.official_url
            || null
          ))
          .filter(Boolean)
          .filter((value, index, rows) => rows.indexOf(value) === index)
      );

      const regulatoryTraceFor = (programVersionId, formTemplateVersionId = null) => (
        rawProgramRegulatoryLinks
          .filter((link) => (
            link.program_version_id === programVersionId
            && (!formTemplateVersionId || (
              link.target_kind === "program_version"
              || link.form_template_version_id === formTemplateVersionId
            ))
          ))
          .map((link) => ({
            id: link.id,
            jurisdiction: link.jurisdiction?.code || null,
            citation: link.regulatory_unit?.canonical_citation
              || link.requirement?.compliance_requirements?.requirement_code
              || link.source_locator?.citation
              || null,
            regulatoryUnitVersionId: link.regulatory_unit_version_id,
            requirementVersionId: link.requirement_version_id,
            regulatoryContentSha256: link.regulatory_unit?.content_sha256 || null,
            exactExcerptSha256: link.exact_excerpt_sha256,
            traceSha256: link.trace_sha256,
            relationship: link.relationship,
            coverageKind: link.coverage_kind,
            reviewedAt: link.reviewed_at
          }))
      );

      const applicableLocationsFor = (programVersionId) => {
        const programVersion = rawProgramVersions.find((version) => version.id === programVersionId);
        if (
          programVersion?.status !== "published"
          || !programVersionIsEffective(programVersion)
        ) return [];
        return rawProgramApplicability.filter((row) => (
          row.program_version_id === programVersionId
          && row.review_status === "reviewed"
          && ["applies", "conditional"].includes(row.applicability_status)
          && (!row.effective_from || row.effective_from <= operationalDate)
          && (!row.effective_to || row.effective_to >= operationalDate)
        ))
        .map((row) => row.location_id);
      };

      programLibrary.programs = rawPrograms.map((program) => {
        const version = currentProgramVersionByProgramId.get(program.id);
        const relatedForms = rawProgramFormTemplates
          .filter((template) => template.program_id === program.id)
          .map((template) => template.id);
        return {
          id: program.id,
          number: program.program_code,
          title: program.title,
          sourceName: `SafetyOps controlled program ${program.program_code}`,
          description: program.description || "",
          category: program.category,
          language: "English",
          type: "Program",
          version: version ? `v${version.version}` : "No version",
          mappingStatus: version ? readableStatus(version.status) : "Version required",
          privacy: "Private tenant record",
          sourceId: version?.id || program.id,
          sourceCapturedOn: version?.published_at || version?.updated_at || program.updated_at,
          sourceSystem: "Supabase controlled records",
          topics: [],
          citations: version ? regulatoryCitationsFor(version.id) : [],
          regulatoryTrace: version ? regulatoryTraceFor(version.id) : [],
          locations: version ? applicableLocationsFor(version.id) : [],
          relatedForms,
          programVersionId: version?.id || null,
          programStatus: version?.status || null,
          sourceManifestSha256: version?.source_manifest_sha256 || null,
          contentManifestSha256: version?.content_manifest_sha256 || null,
          nextReviewAt: version?.next_review_at || null
        };
      });

      const currentFormVersionByTemplateId = new Map();
      rawProgramFormVersions.forEach((version) => {
        const current = currentFormVersionByTemplateId.get(version.template_id);
        const selectedProgramVersionId = currentProgramVersionByProgramId.get(version.program_id)?.id;
        const versionRank = (version.program_version_id === selectedProgramVersionId ? 2 : 0)
          + (version.status === "published" ? 1 : 0);
        const currentRank = current
          ? (current.program_version_id === selectedProgramVersionId ? 2 : 0)
            + (current.status === "published" ? 1 : 0)
          : -1;
        if (!current || versionRank > currentRank || (
          versionRank === currentRank && Number(version.version) > Number(current.version)
        )) {
          currentFormVersionByTemplateId.set(version.template_id, version);
        }
      });

      const fieldTypeForRunner = (fieldType) => ({
        instruction: "instruction",
        short_text: "text",
        long_text: "textarea",
        number: "number",
        date: "date",
        time: "time",
        datetime: "datetime-local",
        boolean: "yesno",
        single_choice: "select",
        multi_choice: "multiselect",
        employee: "employee",
        location: "location",
        file: "file",
        signature: "signature",
        acknowledgement: "acknowledgement"
      })[fieldType] || "text";

      programLibrary.forms = rawProgramFormTemplates
        .map((template) => {
          const version = currentFormVersionByTemplateId.get(template.id);
          if (!version) return null;
          const program = rawPrograms.find((item) => item.id === template.program_id);
          const formFields = rawProgramFormFields
            .filter((field) => field.form_template_version_id === version.id)
            .sort((left, right) => Number(left.sort_order) - Number(right.sort_order))
            .map((field) => ({
              id: field.field_key,
              databaseId: field.id,
              type: fieldTypeForRunner(field.field_type),
              databaseType: field.field_type,
              label: field.label,
              helpText: field.help_text,
              placeholder: field.placeholder,
              required: field.required,
              options: field.options || [],
              dataClassification: field.data_classification,
              fieldSha256: field.field_sha256
            }));
          const primaryFile = rawProgramFormFiles.find((file) => (
            file.form_template_version_id === version.id
            && file.file_role === "original"
            && file.is_primary
          ));
          return {
            id: template.id,
            title: version.title || template.name,
            sourceName: program?.title || "Company safety program",
            description: template.purpose || version.instructions_markdown || "",
            category: program?.category || "Company form",
            language: "English",
            type: "Form",
            version: `v${version.version}`,
            mappingStatus: version.status === "published"
              ? "Published and schema-pinned"
              : "Draft — not available for submission",
            privacy: "Private tenant record",
            sourceId: version.id,
            sourceCapturedOn: version.published_at || version.updated_at || version.created_at,
            sourceSystem: "Supabase controlled records",
            topics: [],
            citations: regulatoryCitationsFor(version.program_version_id, version.id),
            regulatoryTrace: regulatoryTraceFor(version.program_version_id, version.id),
            locations: applicableLocationsFor(version.program_version_id),
            fields: formFields,
            programId: template.program_id,
            programVersionId: version.program_version_id,
            formTemplateVersionId: version.id,
            schemaSha256: version.schema_sha256,
            status: version.status,
            completionPolicy: version.completion_policy || {},
            signaturePolicy: version.signature_policy || {},
            sourceManifestSha256: version.source_manifest_sha256 || null,
            originalFile: primaryFile ? {
              id: primaryFile.id,
              filename: "Authorized original",
              access: "Short-lived signed download required",
              sourceLocator: primaryFile.source_locator || {}
            } : null
          };
        })
        .filter(Boolean);

      programLibrary.meta = {
        sourceName: `${companyResult.data.name} safety library`,
        sourceFolderId: null,
        sourceUrl: null,
        sourceCapturedOn: null,
        privacy: "Tenant records authorized by Supabase RLS",
        ingestionMode: "Programs, versions, applicability, forms, assignments, and submissions load from the authenticated tenant.",
        counts: {
          programs: programLibrary.programs.length,
          digitalForms: programLibrary.forms.length,
          folders: 0,
          looseResources: 0,
          importCandidates: rawImportCandidates.length
        },
        extraction: {
          extracted: rawProgramVersions.filter((version) => version.content_manifest_sha256).length,
          imageOnly: 0,
          ocrRequired: 0
        },
        binaryIngestion: {
          filesVerified: rawProgramFormFiles.length
            + rawImportCandidates.filter((candidate) => candidate.render_verified).length,
          totalBytes: rawImportCandidates.reduce((sum, candidate) => (
            sum + Number(candidate.size_bytes || 0)
          ), 0),
          capturedOn: null,
          storageTarget: "Private Supabase Storage"
        }
      };
      programLibrary.folders = [];
      programLibrary.looseResources = [];
      programLibrary.extracts = {};

      data.programAssignments = rawProgramAssignments.map((assignment) => ({
        id: assignment.id,
        programVersionId: assignment.program_version_id,
        formTemplateVersionId: assignment.form_template_version_id,
        locationId: assignment.location_id,
        assigneeUserId: assignment.assignee_user_id,
        assignee: memberNameById.get(assignment.assignee_user_id) || "Authorized worker",
        assignedBy: memberNameById.get(assignment.assigned_by) || "Authorized manager",
        assignmentType: assignment.assignment_type,
        title: assignment.title,
        instructions: assignment.instructions,
        status: readableStatus(assignment.status),
        dueAt: assignment.due_at,
        due: formatShortDate(assignment.due_at),
        assignedAt: assignment.assigned_at,
        completedAt: assignment.completed_at
      }));
      data.programSubmissions = rawProgramSubmissions.map((submission) => ({
        id: submission.id,
        programVersionId: submission.program_version_id,
        formTemplateVersionId: submission.form_template_version_id,
        assignmentId: submission.assignment_id,
        locationId: submission.location_id,
        submittedBy: memberNameById.get(submission.submitted_by) || "Authorized user",
        submittedByUserId: submission.submitted_by,
        status: readableStatus(submission.status),
        schemaSha256: submission.form_schema_sha256,
        payloadSha256: submission.submitted_payload_sha256,
        regulatoryContext: submission.submission_context || null,
        startedAt: submission.started_at,
        submittedAt: submission.submitted_at,
        reviewedAt: submission.reviewed_at
      }));

      data.tasks = [
        ...data.actions
          .filter((action) => action.status !== "Closed")
          .map((action) => ({
            id: `task-action-${action.id}`,
            type: "Corrective action",
            title: action.title,
            locationId: action.locationId,
            owner: action.owner,
            dueAt: action.dueAt,
            due: action.due,
            priority: action.priority,
            progress: 0,
            status: action.status,
            targetView: "actions"
          })),
        ...data.trainingAssignments
          .filter((assignment) => !["Complete", "Completed", "Waived"].includes(assignment.status))
          .map((assignment) => ({
            id: `task-training-${assignment.id}`,
            type: "Training",
            title: assignment.course,
            locationId: assignment.locationId,
            owner: assignment.employee,
            dueAt: assignment.dueAt,
            due: assignment.due,
            priority: "Medium",
            progress: assignment.status === "In Progress" ? 50 : 0,
            status: assignment.status,
            targetView: "training"
          })),
        ...data.employeeFormAssignments
          .filter((assignment) => ["assigned", "in_progress"].includes(assignment.rawStatus))
          .map((assignment) => ({
            id: `task-employee-form-${assignment.id}`,
            type: "Employee form",
            title: assignment.title,
            locationId: assignment.locationId,
            owner: assignment.employee,
            dueAt: assignment.dueAt,
            due: assignment.due,
            priority: assignment.status === "Overdue" ? "High" : "Medium",
            progress: assignment.rawStatus === "in_progress" ? 25 : 0,
            status: assignment.status,
            targetView: "people",
            employeeFormAssignmentId: assignment.id
          })),
        ...data.employeeDocuments
          .filter((documentRecord) => documentRecord.rawStatus === "awaiting_signature")
          .map((documentRecord) => ({
            id: `task-employee-document-${documentRecord.id}`,
            type: "Employee form",
            title: documentRecord.title,
            locationId: documentRecord.locationId,
            owner: documentRecord.employee,
            dueAt: documentRecord.signatureDueAt,
            due: documentRecord.signatureDue,
            priority: "High",
            progress: 0,
            status: "Awaiting signature",
            targetView: "people",
            employeeDocumentId: documentRecord.id
          })),
        ...data.programAssignments
          .filter((assignment) => (
            assignment.assigneeUserId === user.id
            && !["Completed", "Waived", "Cancelled"].includes(assignment.status)
          ))
          .map((assignment) => ({
            id: `task-program-${assignment.id}`,
            type: assignment.assignmentType === "complete_form"
              ? "Company form"
              : "Safety program",
            title: assignment.title,
            locationId: assignment.locationId,
            owner: assignment.assignee,
            dueAt: assignment.dueAt,
            due: assignment.due,
            priority: "Medium",
            progress: assignment.status === "In Progress" ? 50 : 0,
            status: assignment.status,
            targetView: "programs"
          }))
      ];

      data.activity = (auditResult.data || []).map((event) => ({
        id: event.id,
        icon: event.action.includes("created") ? "+" : "•",
        tone: event.action.includes("closed") ? "green" : "blue",
        text: `${memberNameById.get(event.actor_user_id) || "Authorized user"} ${readableStatus(event.action).toLowerCase()} ${readableStatus(event.entity_type).toLowerCase()}.`,
        time: formatShortDate(event.occurred_at)
      }));

      const profilesByLocation = new Map();
      (regulatoryProfilesResult.data || []).forEach((profile) => {
        if (!profilesByLocation.has(profile.location_id)) profilesByLocation.set(profile.location_id, []);
        profilesByLocation.get(profile.location_id).push(profile);
      });
      data.locations = (locationsResult.data || []).map((location, index) => {
        const today = new Date().toISOString().slice(0, 10);
        const locationProfiles = profilesByLocation.get(location.id) || [];
        const profileIsEffective = (profile) => (
          (!profile.effective_from || profile.effective_from <= today)
          && (!profile.effective_to || profile.effective_to >= today)
        );
        const approvedProfile = locationProfiles.find((profile) => (
          profile.status === "approved"
          && profile.reviewed_by
          && profile.reviewed_at
          && profileIsEffective(profile)
        ));
        const regulatoryProfile = approvedProfile || locationProfiles[0];
        const expectedJurisdiction = regulatoryProfile?.state_code
          ? `US-${regulatoryProfile.state_code}`
          : "US-FED";
        const assignmentRank = (item) => {
          const reviewedAndEffective = Boolean(
            item?.reviewed_by
            && item?.reviewed_at
            && (!item.valid_from || item.valid_from <= today)
            && (!item.valid_to || item.valid_to >= today)
          );
          const coverageRank = {
            applies: 4,
            partial: 3,
            requires_review: 2,
            does_not_apply: 0
          }[item?.coverage_status] || 0;
          return (item?.jurisdiction?.code === expectedJurisdiction ? 10 : 0)
            + (reviewedAndEffective ? 5 : 0)
            + coverageRank;
        };
        const assignment = [...(regulatoryProfile?.location_jurisdiction_assignments || [])]
          .filter((item) => item.coverage_status !== "does_not_apply")
          .sort((left, right) => assignmentRank(right) - assignmentRank(left))[0]
          || regulatoryProfile?.location_jurisdiction_assignments?.[0];
        const assignmentReviewedAndEffective = Boolean(
          assignment?.reviewed_by
          && assignment?.reviewed_at
          && (!assignment.valid_from || assignment.valid_from <= today)
          && (!assignment.valid_to || assignment.valid_to >= today)
        );
        const profileApproved = Boolean(
          approvedProfile
          && assignmentReviewedAndEffective
          && ["applies", "partial"].includes(assignment?.coverage_status)
        );
        const locationMembers = data.people.filter((person) =>
          person.locationIds?.includes(location.id)
        );
        const locationAssignments = rawAssignments.filter((item) => item.location_id === location.id);
        const locationTrainingComplete = locationAssignments.filter((item) =>
          ["complete", "completed"].includes(item.status)
        ).length;
        const locationInspections = data.inspections.filter((item) => item.locationId === location.id);
        const completedInspections = locationInspections.filter((item) =>
          ["Submitted", "Complete", "Closed"].includes(item.status)
        ).length;
        const openActions = data.actions.filter((item) =>
          item.locationId === location.id && item.status !== "Closed"
        );
        return {
          id: location.id,
          name: location.name,
          short: location.code,
          city: location.address || "Address not set",
          type: index === 0 ? "Primary location" : "Company location",
          manager: "Unassigned",
          people: locationMembers.length,
          training: locationAssignments.length
            ? Math.round((locationTrainingComplete / locationAssignments.length) * 100)
            : 0,
          inspections: locationInspections.length
            ? Math.round((completedInspections / locationInspections.length) * 100)
            : 0,
          openActions: openActions.length,
          hasTrainingData: locationAssignments.length > 0,
          hasInspectionData: locationInspections.length > 0,
          hasActionData: data.actions.some((item) => item.locationId === location.id),
          risk: openActions.some((item) => item.priority === "Critical")
            ? "Elevated"
            : openActions.length
              ? "Watch"
              : "New",
          stateCode: regulatoryProfile?.state_code || null,
          jurisdiction: assignment?.jurisdiction?.code
            || (regulatoryProfile?.state_code ? `US-${regulatoryProfile.state_code}` : "US-FED"),
          regulatoryProfileId: regulatoryProfile?.id || null,
          regulatoryProfileStatus: profileApproved ? "approved" : "review_required",
          regulatoryCoverageStatus: assignment?.coverage_status || "requires_review",
          regulatoryEmployerType: regulatoryProfile?.employer_type || "other",
          regulatoryNaicsCodes: Array.isArray(regulatoryProfile?.naics_codes)
            ? regulatoryProfile.naics_codes
            : [],
          regulatoryOperationFacts: regulatoryProfile?.operation_facts || {},
          regulatoryHazardFacts: regulatoryProfile?.hazard_facts || {},
          regulatoryReviewPending: Boolean(
            approvedProfile
            && locationProfiles[0]
            && Number(locationProfiles[0].version) > Number(approvedProfile.version)
          ),
          accent: ["#24a37a", "#3c8ce7", "#e0a12b", "#8b6bd6", "#df655d"][index % 5]
        };
      });
      const locationIdByCode = new Map(data.locations.map((location) => [
        String(location.short || "").toUpperCase(),
        location.id
      ]));
      programLibrary.importCandidates = rawImportCandidates.map((candidate) => {
        const proposedLocationCodes = Array.isArray(candidate.proposed_location_codes)
          ? candidate.proposed_location_codes.map((code) => String(code)).filter(Boolean)
          : [];
        return {
          id: candidate.id,
          title: candidate.display_name || "Unnamed source item",
          displayName: candidate.display_name || "Unnamed source item",
          sourceCollection: String(candidate.source_collection || "").trim(),
          folderHint: candidate.folder_hint || "Source folder not classified",
          candidateKind: candidate.candidate_kind || "unknown",
          classification: candidate.classification || "unknown",
          archiveKind: importCandidateKind(candidate.candidate_kind),
          reviewStatus: candidate.review_status || "pending_review",
          accessScope: candidate.access_scope === "company"
            ? "company"
            : "safety_admin_private",
          language: candidate.language || "Unspecified",
          proposedLocationCodes,
          proposedLocationIds: proposedLocationCodes
            .map((code) => locationIdByCode.get(String(code).toUpperCase()))
            .filter(Boolean),
          locations: [],
          pageCount: Number(candidate.page_count || 0),
          renderVerified: Boolean(candidate.render_verified),
          mimeType: candidate.mime_type || "application/octet-stream",
          sizeBytes: Number(candidate.size_bytes || 0),
          contentSha256: candidate.content_sha256 || null,
          sourcePathSha256: candidate.source_path_sha256 || null,
          createdAt: candidate.created_at || null
        };
      });
      if (
        state.formArchiveKind !== "all"
        && !importCandidateKinds.some((definition) => definition.id === state.formArchiveKind)
      ) {
        state.formArchiveKind = "all";
        localStorage.setItem(`${uiStoragePrefix}formArchiveKind`, state.formArchiveKind);
      }
      if (
        state.formArchiveStatus !== "all"
        && !programLibrary.importCandidates.some((candidate) => (
          candidate.reviewStatus === state.formArchiveStatus
        ))
      ) {
        state.formArchiveStatus = "all";
        localStorage.setItem(`${uiStoragePrefix}formArchiveStatus`, state.formArchiveStatus);
      }
      state.localFormUploads = [];
      state.locationId = membership.default_location_id
        && data.locations.some((location) => location.id === membership.default_location_id)
        ? membership.default_location_id
        : "all";
      state.authUser = user;
      state.authStatus = "ready";
      state.authMessage = "";
      state.authBusy = false;
      try {
        if (!localUploadStagingEnabled) return render();
        const localFormUploads = await listLocalFormUploads();
        if (!isCurrentRequest()) return;
        state.localFormUploads = localFormUploads;
      } catch (_error) {
        if (!isCurrentRequest()) return;
        state.localFormUploads = [];
      }
      render();
    } catch (error) {
      if (!isCurrentRequest()) return;
      purgeTenantWorkspace();
      state.authUser = user;
      state.authStatus = "workspace-error";
      state.authMessage = error?.message || "The private workspace could not be loaded.";
      state.authBusy = false;
      render();
    }
  }

  async function applyAuthSession(session, transitionEpoch) {
    if (transitionEpoch !== authTransitionEpoch) return;
    if (!session?.user) {
      const previousCompanyId = data.company?.id;
      const previousUserId = state.authUser?.id;
      purgeTenantWorkspace();
      state.authUser = null;
      state.localFormUploads = [];
      state.authStatus = "signed-out";
      state.authBusy = false;
      render();
      if (previousCompanyId && previousUserId) {
        try {
          await clearLocalFormUploads(previousCompanyId, previousUserId);
        } catch (_error) {
          // Local staging is best-effort and never the system of record.
        }
      }
      return;
    }
    if (state.authUser?.id && state.authUser.id !== session.user.id) {
      purgeTenantWorkspace();
    }
    state.authUser = session.user;
    if (["invite", "recovery"].includes(state.authFlow)) {
      purgeTenantWorkspace();
      state.authUser = session.user;
      state.authStatus = "password-setup";
      state.authBusy = false;
      render();
      return;
    }
    state.authStatus = "loading";
    state.authBusy = false;
    render();
    await loadAuthenticatedWorkspace(session.user, transitionEpoch);
  }

  function authSessionKey(session) {
    if (!session?.user) return "signed-out";
    return `${session.user.id}:${session.access_token || "session"}`;
  }

  function invalidateAuthTransition() {
    authTransitionEpoch += 1;
    workspaceLoadSequence += 1;
    synchronizedAuthSessionKey = null;
    synchronizedAuthSessionPromise = null;
  }

  function synchronizeAuthSession(session, options = {}) {
    const key = authSessionKey(session);
    if (!options.force && synchronizedAuthSessionKey === key && synchronizedAuthSessionPromise) {
      return synchronizedAuthSessionPromise;
    }
    authTransitionEpoch += 1;
    workspaceLoadSequence += 1;
    const transitionEpoch = authTransitionEpoch;
    synchronizedAuthSessionKey = key;
    synchronizedAuthSessionPromise = applyAuthSession(session, transitionEpoch);
    return synchronizedAuthSessionPromise;
  }

  function authRedirectUrl(flow) {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.set("auth", flow);
    return url.toString();
  }

  function clearAuthFlowUrl() {
    const url = new URL(window.location.href);
    url.hash = "";
    ["auth", "code", "error", "error_code", "error_description", "type"].forEach((parameter) => {
      url.searchParams.delete(parameter);
    });
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }

  function activateVerifiedAuthFlow(event, session) {
    if (!session?.user) return false;
    if (event === "PASSWORD_RECOVERY") {
      state.authFlow = "recovery";
      pendingAuthCallbackFlow = null;
      return true;
    }
    if (
      pendingAuthCallbackFlow
      && ["INITIAL_SESSION", "SIGNED_IN"].includes(event)
    ) {
      state.authFlow = pendingAuthCallbackFlow;
      pendingAuthCallbackFlow = null;
      return true;
    }
    return false;
  }

  function rejectAuthCallback(flow) {
    authCallbackRejected = true;
    pendingAuthCallbackFlow = null;
    invalidateAuthTransition();
    purgeTenantWorkspace();
    state.authFlow = null;
    state.authUser = null;
    state.authStatus = "signed-out";
    state.authMode = flow === "recovery" ? "recovery" : "sign-in";
    state.authMessage = flow === "recovery"
      ? "This password-recovery link is invalid or expired. Request a new recovery link."
      : "This invitation link is invalid or expired. Ask your SafetyOps administrator for a new invitation.";
    state.authBusy = false;
    clearAuthFlowUrl();
    render();
  }

  async function initializeAuth() {
    supabaseClient.auth.onAuthStateChange((event, session) => {
      const activatedFlow = activateVerifiedAuthFlow(event, session);
      if (activatedFlow || authSessionKey(session) !== synchronizedAuthSessionKey) {
        // Invalidate in the callback's synchronous phase. Supabase recommends
        // deferring API work from this callback, but an old tenant request must
        // lose commit authority as soon as a new auth event is observed.
        invalidateAuthTransition();
      }
      if (event === "SIGNED_OUT") {
        state.authFlow = null;
        pendingAuthCallbackFlow = null;
        clearAuthFlowUrl();
      }
      window.setTimeout(() => {
        if (authCallbackRejected) return;
        synchronizeAuthSession(session, { force: activatedFlow });
      }, 0);
    });

    const initializationResult = typeof supabaseClient.auth.initialize === "function"
      ? await supabaseClient.auth.initialize()
      : { error: null };
    if (initializationResult?.error && attemptedAuthCallbackFlow) {
      rejectAuthCallback(attemptedAuthCallbackFlow);
      return;
    }

    const sessionResult = await supabaseClient.auth.getSession();
    if (sessionResult.error) {
      if (attemptedAuthCallbackFlow) {
        rejectAuthCallback(attemptedAuthCallbackFlow);
        return;
      }
      state.authStatus = "signed-out";
      state.authMessage = sessionResult.error.message;
      render();
      return;
    }
    if (attemptedAuthCallbackFlow && !sessionResult.data.session) {
      rejectAuthCallback(attemptedAuthCallbackFlow);
      return;
    }
    const activatedFlow = activateVerifiedAuthFlow("INITIAL_SESSION", sessionResult.data.session);
    await synchronizeAuthSession(sessionResult.data.session, { force: activatedFlow });
  }

  async function handleAuthSubmit(form) {
    const formData = new FormData(form);
    state.authBusy = true;
    state.authMessage = "";
    render();
    try {
      if (form.id === "auth-signin-form") {
        authCallbackRejected = false;
        pendingAuthCallbackFlow = null;
        state.authFlow = null;
        clearAuthFlowUrl();
        const result = await supabaseClient.auth.signInWithPassword({
          email: String(formData.get("email") || "").trim(),
          password: String(formData.get("password") || "")
        });
        if (result.error) throw result.error;
        await synchronizeAuthSession(result.data.session);
        return;
      }

      if (!publicSignupEnabled) {
        throw new Error("Account creation is invite-only. Ask a SafetyOps administrator for access.");
      }

      const signupPassword = String(formData.get("password") || "");
      if (!meetsPasswordPolicy(signupPassword)) {
        state.authStatus = "signed-out";
        state.authMessage = passwordPolicyMessage;
        state.authBusy = false;
        render();
        return;
      }

      const result = await supabaseClient.auth.signUp({
        email: String(formData.get("email") || "").trim(),
        password: signupPassword,
        options: {
          data: { full_name: String(formData.get("full_name") || "").trim() },
          emailRedirectTo: authRedirectUrl("invite")
        }
      });
      if (result.error) throw result.error;
      if (result.data.session) {
        await synchronizeAuthSession(result.data.session);
      } else {
        state.authStatus = "signed-out";
        state.authMode = "sign-in";
        state.authMessage = "Account created. Check your email to confirm the address, then sign in.";
        state.authBusy = false;
        render();
      }
    } catch (error) {
      state.authStatus = "signed-out";
      state.authMessage = error?.message || "Account access failed.";
      state.authBusy = false;
      render();
    }
  }

  async function handleRecoveryRequest(form) {
    const formData = new FormData(form);
    state.authBusy = true;
    state.authMessage = "";
    render();
    try {
      const result = await supabaseClient.auth.resetPasswordForEmail(
        String(formData.get("email") || "").trim(),
        { redirectTo: authRedirectUrl("recovery") }
      );
      if (result.error) throw result.error;
      state.authStatus = "signed-out";
      state.authMode = "sign-in";
      state.authMessage = "If that invited account exists, a recovery link has been sent.";
      state.authBusy = false;
      render();
    } catch (error) {
      state.authStatus = "signed-out";
      state.authMode = "sign-in";
      // Keep recovery responses indistinguishable so account existence and
      // provider details cannot be inferred from the UI.
      state.authMessage = "If that invited account exists, a recovery link has been sent.";
      state.authBusy = false;
      render();
    }
  }

  async function handlePasswordSetup(form) {
    const formData = new FormData(form);
    const password = String(formData.get("password") || "");
    const confirmation = String(formData.get("confirm_password") || "");
    if (!meetsPasswordPolicy(password) || password !== confirmation) {
      state.authMessage = !meetsPasswordPolicy(password)
        ? passwordPolicyMessage
        : "The passwords do not match.";
      render();
      return;
    }
    state.authBusy = true;
    state.authMessage = "";
    render();
    try {
      const updateResult = await supabaseClient.auth.updateUser({ password });
      if (updateResult.error) throw updateResult.error;
      state.authFlow = null;
      clearAuthFlowUrl();
      const sessionResult = await supabaseClient.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      await synchronizeAuthSession(sessionResult.data.session, { force: true });
    } catch (error) {
      state.authStatus = "password-setup";
      state.authMessage = error?.message || "The password could not be set.";
      state.authBusy = false;
      render();
    }
  }

  async function handleLocationCreate(form) {
    if (!canManageCompany()) {
      showToast("Location was not created", "Only corporate administrators and safety managers can create locations.");
      return;
    }
    const formData = new FormData(form);
    const stateCode = String(formData.get("state_code") || "").trim().toUpperCase();
    const locationTimezone = String(
      formData.get("timezone") || "America/Los_Angeles"
    );
    if (["WA", "CA"].includes(stateCode)
        && locationTimezone !== "America/Los_Angeles") {
      showToast(
        "Location was not created",
        "Washington and California locations must use Pacific time."
      );
      return;
    }
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Creating…";
    }
    try {
      const result = await supabaseClient.rpc("create_company_location", {
        target_company_id: data.company.id,
        location_name: String(formData.get("name") || "").trim(),
        location_code: String(formData.get("code") || "").trim(),
        state_code: stateCode,
        location_address: String(formData.get("address") || "").trim() || null,
        location_timezone: locationTimezone
      });
      if (result.error) throw result.error;
      const newLocationId = result.data;
      state.modal = null;
      await loadAuthenticatedWorkspace(state.authUser);
      if (data.locations.some((location) => location.id === newLocationId)) {
        state.locationId = newLocationId;
        localStorage.setItem(`${uiStoragePrefix}location`, state.locationId);
      }
      state.view = "locations";
      render();
      showToast(
        "Location created",
        "The location is active. Its state-plan assignment remains review-required until an authorized applicability review is completed."
      );
    } catch (error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Create location";
      }
      showToast("Location was not created", error?.message || "Supabase rejected the location.");
    }
  }

  async function handleAuthSignOut() {
    state.authBusy = true;
    state.localFormUploads = [];
    render();
    const result = await supabaseClient.auth.signOut();
    if (result.error) {
      state.authMessage = result.error.message;
      state.authBusy = false;
      render();
      return;
    }
    state.authFlow = null;
    pendingAuthCallbackFlow = null;
    clearAuthFlowUrl();
    await synchronizeAuthSession(null, { force: true });
  }

  function navItem(item) {
    const liveCount = {
      "my-work": data.tasks.length,
      committee: data.committeeMeetings.filter((meeting) => meeting.rawStatus === "draft").length,
      training: data.tasks.filter((task) => task.type === "Training").length,
      incidents: data.incidents.filter((incident) => incident.status !== "Closed").length,
      actions: data.actions.filter((action) => action.status !== "Closed").length
    }[item.id] || 0;
    return `
      <button
        class="nav-button ${state.view === item.id ? "active" : ""}"
        type="button"
        data-action="navigate"
        data-view="${item.id}"
        ${state.view === item.id ? 'aria-current="page"' : ""}
      >
        <span class="nav-icon" aria-hidden="true">${item.icon}</span>
        <span class="nav-text">${escapeHtml(item.label)}</span>
        ${liveCount ? `<span class="nav-count ${item.danger ? "danger" : ""}">${liveCount}</span>` : ""}
      </button>
    `;
  }

  function renderSidebar() {
    const authActions = supabaseClient && state.authStatus === "ready"
      ? `
        <button class="icon-button" type="button" data-action="auth-sign-out" aria-label="Sign out">
          ↪
        </button>
      `
      : "";
    return `
      <aside class="sidebar ${state.sidebarOpen ? "open" : ""}" aria-label="Primary navigation">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">SO</div>
          <div>
            <p class="brand-name">SafetyOps</p>
            <p class="brand-subtitle">Safety work center</p>
          </div>
        </div>
        <div class="workspace-card">
          <strong>${escapeHtml(data.company.name)}</strong>
          <span>${data.locations.length} location${data.locations.length === 1 ? "" : "s"} · ${data.company.activeWorkers} active workers</span>
        </div>
        ${navGroups.map((group) => `
          <p class="nav-label">${escapeHtml(group.label)}</p>
          <div class="nav-list">${group.items.map(navItem).join("")}</div>
        `).join("")}
        <div class="sidebar-spacer"></div>
        <div class="user-card">
          <span class="avatar">${escapeHtml(data.currentUser.initials)}</span>
          <div>
            <strong>${escapeHtml(data.currentUser.name)}</strong>
            <span>${escapeHtml(data.currentUser.role)}</span>
          </div>
          <div class="user-card-actions">
            <button class="icon-button" type="button" data-action="toggle-theme" aria-label="Toggle color theme">
              ${state.theme === "light" ? "◐" : "☀"}
            </button>
            ${authActions}
          </div>
        </div>
      </aside>
    `;
  }

  function renderTopbar() {
    return `
      <header class="topbar">
        <button class="icon-button mobile-menu-button" type="button" data-action="toggle-sidebar" aria-label="Open navigation">☰</button>
        <form class="search-form" id="search-form" role="search">
          <input
            class="search-input"
            id="global-search"
            name="query"
            type="search"
            value="${escapeHtml(state.searchQuery)}"
            placeholder="Search people, forms, training, documents…"
            aria-label="Search the safety workspace"
          >
        </form>
        <label class="location-control">
          <span>Location</span>
          <select id="location-select" aria-label="Filter by location">
            ${renderLocationOptions(true)}
          </select>
        </label>
        <div class="topbar-actions">
          <div class="connection-banner" title="Supabase client configured">
            <span class="status-dot" aria-hidden="true"></span>
            <span>Supabase ready</span>
          </div>
          <button class="icon-button" type="button" data-action="navigate" data-view="settings" aria-label="Open settings">⚙</button>
        </div>
      </header>
    `;
  }

  function renderMobileNav() {
    const items = [
      { id: "dashboard", label: "Today", icon: "⌂" },
      { id: "inspections", label: "Forms", icon: "F" },
      { id: "training", label: "Train", icon: "T" },
      { id: "programs", label: "Library", icon: "P" },
      { id: "my-work", label: "Monitor", icon: "✓" }
    ];
    return `
      <nav class="mobile-nav" aria-label="Mobile navigation">
        ${items.map((item) => `
          <button
            type="button"
            class="${state.view === item.id ? "active" : ""}"
            data-action="navigate"
            data-view="${item.id}"
          >
            <span aria-hidden="true">${item.icon}</span>
            <span>${item.label}</span>
          </button>
        `).join("")}
      </nav>
    `;
  }

  function headingActions(view) {
    const hasLocation = data.locations.length > 0;
    const canReport = hasLocation && !isReadOnlyAuditor();
    const hasStartableTemplate = data.inspectionTemplates.some((template) =>
      template.published && template.currentVersionId && template.questions > 0
    );
    if (view === "dashboard") return "";
    if (view === "my-work") {
      return `
        <button class="button" type="button" ${canReport ? "" : "disabled"} data-action="open-modal" data-modal="incident">Report incident</button>
        <button class="button primary" type="button" ${canReport && hasStartableTemplate ? "" : "disabled"} data-action="open-modal" data-modal="inspection">Start inspection</button>
      `;
    }
    if (view === "inspections") {
      return `
        <button class="button" type="button" data-action="prototype-action" data-message="Template authoring requires the controlled publication service before it can be enabled.">Create template</button>
        <button class="button primary" type="button" ${canReport && hasStartableTemplate ? "" : "disabled"} data-action="open-modal" data-modal="inspection">Start inspection</button>
      `;
    }
    if (view === "committee") {
      return `<button class="button primary" type="button" ${canWriteLocation() ? "" : "disabled"} data-action="open-modal" data-modal="committee">New meeting</button>`;
    }
    if (view === "training") {
      return `
        <button class="button" type="button" data-action="prototype-action" data-message="Course authoring will support video, PDF, quiz, and practical verification blocks.">Create course</button>
        <button class="button primary" type="button" ${canWriteLocation() && data.courses.some((course) => course.published && course.currentVersionId) ? "" : "disabled"} data-action="open-modal" data-modal="training">Assign training</button>
      `;
    }
    if (view === "incidents") {
      return `<button class="button primary" type="button" ${canReport ? "" : "disabled"} data-action="open-modal" data-modal="incident">Report incident</button>`;
    }
    if (view === "actions") {
      return `<button class="button primary" type="button" ${canWriteLocation() ? "" : "disabled"} data-action="open-modal" data-modal="action">New action</button>`;
    }
    if (view === "programs") {
      return `
        ${programLibrary.meta.sourceUrl ? `<a class="button" href="${escapeHtml(programLibrary.meta.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open private source</a>` : ""}
        <button class="button" type="button" data-action="program-import-status">Review ingestion status</button>
        <button class="button primary" type="button" data-action="open-modal" data-modal="form-upload" ${localUploadStagingEnabled ? "" : "disabled"} title="${localUploadStagingEnabled ? "Stage a development-only local copy" : "Deploy the private prepare/scan/commit upload service first"}">${localUploadStagingEnabled ? "Stage form locally" : "Upload service required"}</button>
      `;
    }
    if (view === "documents") {
      return `<button class="button primary" type="button" data-action="prototype-action" data-message="The upload workflow will create an immutable document version in private Supabase Storage.">Upload document</button>`;
    }
    if (view === "standards") {
      const jurisdiction = activeLocation() ? jurisdictionForLocation(activeLocation()) : null;
      const plan = jurisdiction ? planForJurisdiction(jurisdiction) : null;
      const federalView = state.standardAuthority === "federal";
      const officialUrl = federalView
        ? "https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XVII"
        : jurisdiction === "US-OR"
          ? "https://osha.oregon.gov/rules/final/pages/division-2.aspx"
          : plan?.officialUrl;
      const officialLabel = federalView
        ? "Open official eCFR"
        : jurisdiction === "US-OR"
          ? "Open Oregon Division 2"
          : jurisdiction
            ? `Open ${jurisdictionLabel(jurisdiction)} rules`
            : "Select a location for official rules";
      return `
        <button class="button" type="button" data-action="check-osha-update">Check source status</button>
        ${officialUrl
          ? `<a class="button primary" href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(officialLabel)}</a>`
          : `<button class="button primary" type="button" disabled>${escapeHtml(officialLabel)}</button>`}
      `;
    }
    if (view === "people") {
      return `
        <button class="button" type="button" ${canManageCompany() ? "" : "disabled"} data-action="open-modal" data-modal="employee">Add employee</button>
        <button class="button primary" type="button" ${canWriteLocation() && data.people.length ? "" : "disabled"} data-action="open-modal" data-modal="employee-form-assignment">Assign form</button>
        <button class="button" type="button" ${canWriteLocation() && data.people.length ? "" : "disabled"} data-action="open-modal" data-modal="employee-document">Employee PDF</button>
      `;
    }
    if (view === "locations") {
      return `<button class="button primary" type="button" ${canManageCompany() ? "" : "disabled"} data-action="open-modal" data-modal="location">Add location</button>`;
    }
    return "";
  }

  function renderPageHeading(view = state.view) {
    let meta = pageMeta[view] || pageMeta.dashboard;
    const place = activeLocation();
    if (view === "standards") {
      const jurisdiction = place ? jurisdictionForLocation(place) : "MULTI";
      const titles = {
        "US-OR": "Oregon OSHA manufacturing guide",
        "US-WA": "Washington DOSH safety reference",
        "US-CA": "Cal/OSHA safety reference",
        MULTI: "State OSHA safety reference"
      };
      meta = {
        ...meta,
        eyebrow: jurisdiction === "US-OR" ? "Oregon manufacturing reference" : "Location-specific regulatory reference",
        title: titles[jurisdiction] || "Manufacturing safety reference",
        description: jurisdiction === "US-OR"
          ? "Start with Oregon Division 2 general-industry rules prioritized for manufacturing, then trace each source to company controls and retained evidence."
          : jurisdiction === "MULTI"
            ? "Choose a location before treating any state-plan rule as primary; Oregon, Washington, and California each retain their own authority."
            : "Use the selected location's state-plan sources as primary and the federal catalog only as a documented baseline."
      };
    }
    const eyebrow = place && view !== "locations" ? `${place.name} · ${meta.eyebrow}` : meta.eyebrow;
    return `
      <section class="page-heading">
        <div>
          <p class="eyebrow">${escapeHtml(eyebrow)}</p>
          <h1 tabindex="-1">${escapeHtml(meta.title)}</h1>
          <p>${escapeHtml(meta.description)}</p>
        </div>
        <div class="heading-actions">${headingActions(view)}</div>
      </section>
    `;
  }

  function computeMetrics() {
    const selectedLocations = activeLocation() ? [activeLocation()] : data.locations;
    const selectedActions = filterLocation(data.actions);
    const selectedIncidents = filterLocation(data.incidents);
    const training = average(selectedLocations.map((location) => location.training));
    const inspections = average(selectedLocations.map((location) => location.inspections));
    const urgent = selectedActions.filter((action) => ["Critical", "High"].includes(action.priority) && action.status !== "Closed").length;
    const openIncidents = selectedIncidents.filter((incident) => incident.status !== "Closed").length;
    const knownAcknowledgements = data.documents
      .map((documentRecord) => documentRecord.acknowledgement)
      .filter((value) => typeof value === "number");
    const documentAcknowledgements = average(knownAcknowledgements);
    const selectedPeople = filterLocation(data.people);
    const selectedEmployeeDocuments = filterLocation(data.employeeDocuments);
    const selectedEmployeeFormAssignments = filterLocation(data.employeeFormAssignments);
    const employeeFormsPending = selectedEmployeeDocuments.filter((documentRecord) =>
      documentRecord.rawStatus === "awaiting_signature"
    ).length + selectedEmployeeFormAssignments.filter((assignment) =>
      ["assigned", "in_progress"].includes(assignment.rawStatus)
    ).length;
    const employeeFormsComplete = selectedEmployeeDocuments.filter((documentRecord) =>
      ["signed", "signed_upload"].includes(documentRecord.rawStatus)
    ).length + selectedEmployeeFormAssignments.filter((assignment) =>
      assignment.rawStatus === "completed"
    ).length;
    const credentialsCurrent = selectedPeople.length
      ? Math.round((selectedPeople.filter((person) => person.status === "Current").length / selectedPeople.length) * 100)
      : 0;
    return {
      training,
      inspections,
      urgent,
      openIncidents,
      documentAcknowledgements,
      credentialsCurrent,
      employeeFormsPending,
      employeeFormsComplete
    };
  }

  function locationReadinessScore(location) {
    const values = [];
    if (location?.hasTrainingData) values.push(location.training);
    if (location?.hasInspectionData) values.push(location.inspections);
    if (location?.hasActionData) values.push(Math.max(0, 100 - location.openActions * 10));
    return average(values);
  }

  function renderMetricCard(label, value, meta, symbol, accent, trend, negative = false) {
    return `
      <article class="metric-card" style="--metric-accent:${accent}">
        <div class="metric-label"><span>${escapeHtml(label)}</span><span aria-hidden="true">${symbol}</span></div>
        <div class="metric-value">${escapeHtml(value)}</div>
        <div class="metric-meta">
          ${trend ? `<span class="metric-trend ${negative ? "negative" : ""}">${escapeHtml(trend)}</span>` : ""}
          <span>${escapeHtml(meta)}</span>
        </div>
      </article>
    `;
  }

  function taskIconClass(type) {
    if (type === "Training") return "training";
    if (type === "Corrective action") return "action";
    if (["Document", "Employee form"].includes(type)) return "document";
    return "";
  }

  function taskIcon(type) {
    const map = { Inspection: "F", Training: "T", "Corrective action": "A", Document: "D", "Employee form": "E" };
    return map[type] || "•";
  }

  function calendarDay(value) {
    if (!value) return "";
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function taskDueBucket(task) {
    if (["Overdue", "Missed"].includes(task.status)) return "overdue";
    const dueDay = calendarDay(task.dueAt);
    if (!dueDay) return "open";
    const today = calendarDay(new Date());
    if (dueDay < today) return "overdue";
    if (dueDay === today) return "today";
    return "upcoming";
  }

  function orderedTasks(tasks) {
    const bucketRank = { overdue: 0, today: 1, open: 2, upcoming: 3 };
    const priorityRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    return [...tasks].sort((left, right) => {
      const bucketDifference = bucketRank[taskDueBucket(left)] - bucketRank[taskDueBucket(right)];
      if (bucketDifference) return bucketDifference;
      const priorityDifference = (priorityRank[left.priority] ?? 4) - (priorityRank[right.priority] ?? 4);
      if (priorityDifference) return priorityDifference;
      const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return String(left.title).localeCompare(String(right.title));
    });
  }

  function completedWorkRecords() {
    const formTitle = (formTemplateVersionId, fallback = "Company form") => (
      allFormTemplates().find((template) => (
        template.formTemplateVersionId === formTemplateVersionId
        || template.currentVersionId === formTemplateVersionId
      ))?.title || fallback
    );
    const rows = [
      ...(data.inspections || [])
        .filter((inspection) => inspection.submittedAt)
        .map((inspection) => ({
          id: `record-inspection-${inspection.id}`,
          type: "Inspection",
          title: inspection.template,
          locationId: inspection.locationId,
          owner: inspection.assignee,
          completedAt: inspection.submittedAt,
          status: inspection.status
        })),
      ...(data.programSubmissions || [])
        .filter((submission) => submission.submittedAt)
        .map((submission) => ({
          id: `record-program-${submission.id}`,
          type: "Company form",
          title: formTitle(submission.formTemplateVersionId),
          locationId: submission.locationId,
          owner: submission.submittedBy,
          completedAt: submission.submittedAt,
          status: submission.status
        })),
      ...(data.employeeFormSubmissions || [])
        .filter((submission) => submission.submittedAt)
        .map((submission) => ({
          id: `record-employee-form-${submission.id}`,
          type: "Employee form",
          title: formTitle(submission.formTemplateVersionId, "Employee form"),
          locationId: submission.locationId,
          owner: submission.employeeName,
          completedAt: submission.submittedAt,
          status: "Completed"
        })),
      ...(data.employeeDocuments || [])
        .filter((documentRecord) => documentRecord.signedAt)
        .map((documentRecord) => ({
          id: `record-employee-document-${documentRecord.id}`,
          type: "Signed document",
          title: documentRecord.title,
          locationId: documentRecord.locationId,
          owner: documentRecord.employee,
          completedAt: documentRecord.signedAt,
          status: documentRecord.status
        })),
      ...(data.trainingCompletions || [])
        .filter((completion) => completion.completedAt)
        .map((completion) => ({
          id: `record-training-${completion.id}`,
          type: "Training",
          title: data.courses.find((course) => course.id === completion.courseId)?.name || "Training completion",
          locationId: completion.locationId,
          owner: data.people.find((person) => person.id === completion.employeeId)?.name || "Employee record",
          completedAt: completion.completedAt,
          status: "Completed"
        }))
    ];
    return rows.sort((left, right) => (
      new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime()
    ));
  }

  function setupJourney() {
    const sourceCount = Number(
      programLibrary.meta?.counts?.importCandidates
      ?? programLibrary.importCandidates?.length
      ?? 0
    );
    const publishedForms = allFormTemplates().filter(formAvailableForSubmission).length;
    const completedRecords = completedWorkRecords().length;
    const steps = [
      {
        id: "locations",
        label: "Locations",
        detail: data.locations.length
          ? `${data.locations.length} active location${data.locations.length === 1 ? "" : "s"}`
          : "Add the first operating location",
        complete: data.locations.length > 0,
        modal: "location",
        actionLabel: "Add location",
        available: canManageCompany()
      },
      {
        id: "employees",
        label: "Employees",
        detail: data.people.length
          ? `${data.people.length} employee record${data.people.length === 1 ? "" : "s"}`
          : "Add employees who will receive forms and training",
        complete: data.people.length > 0,
        modal: "employee",
        actionLabel: "Add employee",
        available: canManageCompany()
      },
      {
        id: "sources",
        label: "Source library",
        detail: sourceCount
          ? `${sourceCount} imported source file${sourceCount === 1 ? "" : "s"}`
          : "Load authorized company forms and programs",
        complete: sourceCount > 0 || (programLibrary.programs || []).length > 0,
        view: "programs",
        actionLabel: "Open library",
        available: true
      },
      {
        id: "forms",
        label: "Ready-to-use forms",
        detail: publishedForms
          ? `${publishedForms} published interactive form${publishedForms === 1 ? "" : "s"}`
          : "Choose the first approved original to make operational",
        complete: publishedForms > 0,
        view: "programs",
        actionLabel: "Review forms",
        available: true
      },
      {
        id: "records",
        label: "First completed record",
        detail: completedRecords
          ? `${completedRecords} completed record${completedRecords === 1 ? "" : "s"}`
          : "Assign or start a form and retain its signed evidence",
        complete: completedRecords > 0,
        view: "my-work",
        actionLabel: "Open monitor",
        available: true
      }
    ];
    const completeCount = steps.filter((step) => step.complete).length;
    return {
      steps,
      completeCount,
      percent: Math.round((completeCount / steps.length) * 100),
      next: steps.find((step) => !step.complete) || null
    };
  }

  function renderSetupJourney() {
    const setup = setupJourney();
    if (!setup.next) return "";
    const nextAction = setup.next.view
      ? `<button class="button small primary" type="button" data-action="navigate" data-view="${setup.next.view}">${escapeHtml(setup.next.actionLabel)}</button>`
      : `<button class="button small primary" type="button" data-action="open-modal" data-modal="${setup.next.modal}" ${setup.next.available ? "" : "disabled"}>${escapeHtml(setup.next.actionLabel)}</button>`;
    return `
      <section class="setup-journey" aria-labelledby="setup-journey-title">
        <div class="setup-journey-header">
          <div>
            <p class="section-kicker">Current company setup</p>
            <h2 id="setup-journey-title">Turn the source library into daily safety work</h2>
            <p>${setup.completeCount} of ${setup.steps.length} foundations are ready. The next useful step is highlighted.</p>
          </div>
          <div class="setup-progress" aria-label="${setup.percent}% setup complete">
            <strong>${setup.percent}%</strong>
            <span><i style="--progress:${setup.percent}%"></i></span>
          </div>
        </div>
        <ol class="setup-step-list">
          ${setup.steps.map((step, index) => `
            <li class="setup-step ${step.complete ? "complete" : step.id === setup.next.id ? "next" : ""}">
              <span class="setup-step-marker" aria-hidden="true">${step.complete ? "✓" : index + 1}</span>
              <span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.detail)}</small></span>
            </li>
          `).join("")}
        </ol>
        <div class="setup-next-action">
          <span><strong>Next:</strong> ${escapeHtml(setup.next.detail)}</span>
          ${nextAction}
        </div>
      </section>
    `;
  }

  function renderQuickActions() {
    const hasLocation = data.locations.length > 0;
    const canReport = hasLocation && !isReadOnlyAuditor();
    const canOperate = canWriteLocation();
    const startableInspections = data.inspectionTemplates.filter((template) => (
      template.published && template.currentVersionId && template.questions > 0
    ));
    const assignableForms = allFormTemplates().filter(formAvailableForSubmission);
    const actions = [
      {
        icon: "F",
        title: "Start a form",
        detail: startableInspections.length ? `${startableInspections.length} inspection form${startableInspections.length === 1 ? "" : "s"} ready` : "No inspection form is published yet",
        modal: "inspection",
        enabled: canReport && startableInspections.length > 0
      },
      {
        icon: "E",
        title: "Assign employee form",
        detail: assignableForms.length ? "Prepare a secure tablet handoff" : "Publish an interactive form first",
        modal: "employee-form-assignment",
        enabled: canOperate && data.people.length > 0 && assignableForms.length > 0
      },
      {
        icon: "!",
        title: "Report incident",
        detail: "Capture an incident or near miss",
        modal: "incident",
        enabled: canReport
      },
      {
        icon: "C",
        title: "Record committee meeting",
        detail: "Minutes, decisions, owners, and due dates",
        modal: "committee",
        enabled: canOperate
      },
      {
        icon: "T",
        title: "Assign training",
        detail: data.courses.some((course) => course.published && course.currentVersionId)
          ? "Send required training to an employee"
          : "Publish a training course first",
        modal: "training",
        enabled: canOperate && data.courses.some((course) => course.published && course.currentVersionId)
      },
      {
        icon: "P",
        title: "Open forms library",
        detail: `${Number(programLibrary.meta?.counts?.importCandidates || 0)} source files organized by folder`,
        view: "programs",
        enabled: true
      }
    ];
    return `
      <article class="card quick-start-card">
        <div class="card-header">
          <div><h2>Quick start</h2><p>Common safety-person workflows</p></div>
        </div>
        <div class="quick-action-grid">
          ${actions.map((action) => `
            <button
              class="quick-action"
              type="button"
              data-action="${action.view ? "navigate" : "open-modal"}"
              ${action.view ? `data-view="${action.view}"` : `data-modal="${action.modal}"`}
              ${action.enabled ? "" : "disabled"}
            >
              <span class="quick-action-icon" aria-hidden="true">${action.icon}</span>
              <span><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.detail)}</small></span>
              <span class="quick-action-arrow" aria-hidden="true">→</span>
            </button>
          `).join("")}
        </div>
      </article>
    `;
  }

  function renderTaskRows(tasks) {
    if (!tasks.length) {
      return renderEmptyState("✓", "Nothing due here", "No assignments match the current location and filters.");
    }
    return `
      <div class="task-list">
        ${tasks.map((task) => `
          <article class="task-row">
            <div class="type-icon ${taskIconClass(task.type)}" aria-hidden="true">${taskIcon(task.type)}</div>
            <div>
              <div class="task-title">${escapeHtml(task.title)}</div>
              <div class="task-meta">
                <span>${escapeHtml(task.type)}</span>
                <span>${escapeHtml(locationName(task.locationId))}</span>
                <span>${escapeHtml(task.owner)}</span>
                ${statusPill(task.status)}
              </div>
            </div>
            <div class="task-side">
              <span class="task-due">${escapeHtml(task.due)}</span>
              ${task.employeeFormAssignmentId ? `<button class="button small primary" type="button" data-action="start-employee-form-handoff" data-assignment-id="${task.employeeFormAssignmentId}">Start tablet form</button>` : ""}
              ${task.employeeDocumentId ? `<button class="button small primary" type="button" data-action="open-employee-sign" data-document-id="${task.employeeDocumentId}">Review &amp; sign</button>` : ""}
              ${!task.employeeFormAssignmentId && !task.employeeDocumentId && task.targetView ? `<button class="button small" type="button" data-action="navigate" data-view="${task.targetView}">Open</button>` : ""}
              <div class="progress" title="${task.progress}% complete">
                <span style="--progress:${task.progress}%;--progress-color:${task.priority === "Critical" ? "var(--red)" : "var(--accent)"}"></span>
              </div>
            </div>
          </article>
        `).join("")}
      </div>
    `;
  }

  function renderDashboard() {
    const metrics = computeMetrics();
    const tasks = orderedTasks(filterLocation(data.tasks));
    const overdueTasks = tasks.filter((task) => taskDueBucket(task) === "overdue");
    const dueTodayTasks = tasks.filter((task) => taskDueBucket(task) === "today");
    const completedRecords = completedWorkRecords().filter((record) => (
      state.locationId === "all" || record.locationId === state.locationId
    ));
    const selectedLocations = activeLocation() ? [activeLocation()] : data.locations;
    const trainingMeasured = selectedLocations.some((location) => location.hasTrainingData);
    const inspectionsMeasured = selectedLocations.some((location) => location.hasInspectionData);
    const credentialsMeasured = filterLocation(data.people).some((person) => !String(person.credentials).startsWith("0 "));
    const acknowledgementsMeasured = data.documents.some((documentRecord) => typeof documentRecord.acknowledgement === "number");
    const readinessValues = [];
    if (trainingMeasured) readinessValues.push(metrics.training);
    if (inspectionsMeasured) readinessValues.push(metrics.inspections);
    if (acknowledgementsMeasured) readinessValues.push(metrics.documentAcknowledgements);
    if (credentialsMeasured) readinessValues.push(metrics.credentialsCurrent);
    const readiness = average(readinessValues);
    const readinessMeasured = readinessValues.length > 0;

    return `
      ${renderPageHeading()}
      ${renderSetupJourney()}
      <section class="metric-grid status-metrics" aria-label="Current work status">
        ${renderMetricCard("Overdue work", overdueTasks.length, "items past their due date", "!", "var(--red)", overdueTasks.length ? "Needs attention" : "Clear", Boolean(overdueTasks.length))}
        ${renderMetricCard("Due today", dueTodayTasks.length, "scheduled for today", "D", "var(--amber)", dueTodayTasks.length ? "Workday queue" : "Nothing scheduled")}
        ${renderMetricCard("Awaiting employee", metrics.employeeFormsPending, `${metrics.employeeFormsComplete} employee records completed`, "E", "var(--purple)", metrics.employeeFormsPending ? "Tablet handoff needed" : "Current", Boolean(metrics.employeeFormsPending))}
        ${renderMetricCard("Completed records", completedRecords.length, "signed or submitted evidence", "✓", "var(--accent)", completedRecords.length ? "Evidence retained" : "No records yet")}
      </section>
      <section class="monitor-lead-grid">
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h2>Safety inbox</h2>
                <p>Overdue and due-today work appears first</p>
              </div>
              <button class="link-button" type="button" data-action="navigate" data-view="my-work">Open monitor →</button>
            </div>
            ${renderTaskRows(tasks.slice(0, 5))}
          </article>
        </div>
        ${renderQuickActions()}
      </section>
      <section class="dashboard-grid supporting-dashboard-grid">
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h2>Location health</h2>
                <p>Weighted readiness score by site</p>
              </div>
              <button class="link-button" type="button" data-action="navigate" data-view="locations">Details →</button>
            </div>
            <div class="risk-list">
              ${selectedLocations.map((location) => {
                const measured = location.hasTrainingData || location.hasInspectionData || location.hasActionData;
                const score = locationReadinessScore(location);
                const color = score < 82 ? "var(--red)" : score < 90 ? "var(--amber)" : "var(--accent)";
                return `
                  <div class="risk-row ${measured ? "" : "not-measured"}">
                    <span class="risk-name">${escapeHtml(location.name)}</span>
                    <span class="risk-score">${measured ? `${score}%` : "Not measured"}</span>
                    <div class="progress"><span style="--progress:${measured ? score : 0}%;--progress-color:${color}"></span></div>
                  </div>
                `;
              }).join("") || renderEmptyState("L", "No locations", "Create the first authorized company location to begin location reporting.")}
            </div>
          </article>
          <article class="card">
            <div class="card-header">
              <div>
                <h2>Audit readiness</h2>
                <p>Required records available and current</p>
              </div>
            </div>
            <div class="readiness">
              <div class="donut ${readinessMeasured ? "" : "not-measured"}" style="--value:${readinessMeasured ? readiness : 0}">
                <strong>${readinessMeasured ? `${readiness}%` : "—"}</strong>
                <small>${readinessMeasured ? "ready" : "not measured"}</small>
              </div>
              <div class="readiness-list">
                <div class="readiness-item"><span>Training records</span><strong>${trainingMeasured ? `${metrics.training}%` : "—"}</strong></div>
                <div class="readiness-item"><span>Inspection records</span><strong>${inspectionsMeasured ? `${metrics.inspections}%` : "—"}</strong></div>
                <div class="readiness-item"><span>Document acknowledgements</span><strong>${acknowledgementsMeasured ? `${metrics.documentAcknowledgements}%` : "—"}</strong></div>
                <div class="readiness-item"><span>Credentials current</span><strong>${credentialsMeasured ? `${metrics.credentialsCurrent}%` : "—"}</strong></div>
              </div>
            </div>
          </article>
        </div>
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h2>Recent activity</h2>
                <p>Database-authored events supporting the audit trail</p>
              </div>
            </div>
            <div class="activity-list">
              ${data.activity.slice(0, 8).map((item) => `
                <div class="activity-item">
                  <span class="activity-icon ${item.tone}" aria-hidden="true">${item.icon}</span>
                  <p class="activity-text">${escapeHtml(item.text)}</p>
                  <span class="activity-time">${escapeHtml(item.time)}</span>
                </div>
              `).join("") || renderEmptyState("•", "No activity yet", "Completed work and administrative changes will appear here as the company starts using SafetyOps.")}
            </div>
          </article>
        </div>
      </section>
    `;
  }

  function renderMyWork() {
    const tasks = orderedTasks(filterLocation(data.tasks));
    const overdue = tasks.filter((task) => taskDueBucket(task) === "overdue");
    const dueToday = tasks.filter((task) => taskDueBucket(task) === "today");
    const upcoming = tasks.filter((task) => taskDueBucket(task) === "upcoming");
    const completedRecords = completedWorkRecords().filter((record) => (
      state.locationId === "all" || record.locationId === state.locationId
    ));
    return `
      ${renderPageHeading()}
      <section class="monitor-summary-grid" aria-label="Safety monitor status">
        <article class="monitor-summary-card overdue"><span>Overdue</span><strong>${overdue.length}</strong><small>Past the required date</small></article>
        <article class="monitor-summary-card today"><span>Due today</span><strong>${dueToday.length}</strong><small>Scheduled for this workday</small></article>
        <article class="monitor-summary-card"><span>Upcoming</span><strong>${upcoming.length}</strong><small>Future assigned work</small></article>
        <article class="monitor-summary-card complete"><span>Completed records</span><strong>${completedRecords.length}</strong><small>Signed or submitted evidence</small></article>
      </section>
      <section class="monitor-register-grid">
        <article class="card monitor-open-work">
          <div class="card-header">
            <div>
              <h2>Open work</h2>
              <p>Forms, signatures, training, and action items ordered by urgency</p>
            </div>
            <span class="status-pill ${overdue.length ? "red" : "green"}">${overdue.length ? `${overdue.length} overdue` : "On track"}</span>
          </div>
          ${renderTaskRows(tasks)}
        </article>
        <section class="table-card monitor-completed-card">
          <div class="table-header">
            <div><h2>Recent completed records</h2><p>Immutable submissions and completion evidence</p></div>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Record</th><th>Type</th><th>Employee / signer</th><th>Location</th><th>Completed</th><th>Status</th></tr></thead>
              <tbody>
                ${completedRecords.slice(0, 12).map((record) => `
                  <tr>
                    <td class="primary-cell">${escapeHtml(record.title)}</td>
                    <td>${escapeHtml(record.type)}</td>
                    <td>${escapeHtml(record.owner)}</td>
                    <td>${escapeHtml(locationName(record.locationId))}</td>
                    <td>${escapeHtml(formatShortDate(record.completedAt))}</td>
                    <td>${statusPill(record.status)}</td>
                  </tr>
                `).join("") || `<tr><td colspan="6">${renderEmptyState("✓", "No completed records yet", "Signed forms, inspection submissions, training completions, and employee acknowledgements will appear here.")}</td></tr>`}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    `;
  }

  function renderInspections() {
    const inspections = filterLocation(data.inspections);
    return `
      ${renderPageHeading()}
      <div class="toolbar">
        <div class="tabs" aria-label="Inspection views">
          <button class="tab active" type="button">Templates</button>
          <button class="tab" type="button" data-action="prototype-action" data-message="Scheduled work will support recurring rules, shift windows, and grace periods.">Scheduled</button>
          <button class="tab" type="button" data-action="prototype-action" data-message="Submitted inspections will preserve the exact template version and signed evidence.">Submitted</button>
        </div>
        <select class="filter-select" aria-label="Filter inspection category">
          <option>All categories</option>
          <option>General</option>
          <option>Pre-task</option>
          <option>Equipment</option>
          <option>Emergency</option>
        </select>
      </div>
      <section class="template-grid" aria-label="Inspection templates">
        ${data.inspectionTemplates.map((template) => `
          <article class="template-card">
            <div class="template-top">
              <span class="category-badge">${escapeHtml(template.category)}</span>
              <button class="icon-button" type="button" data-action="prototype-action" data-message="Template version history and assignment settings will open here." aria-label="Open template menu">•••</button>
            </div>
            <h3>${escapeHtml(template.name)}</h3>
            <p>${template.questions} response items · ${escapeHtml(template.frequency)}</p>
            ${renderCitationChips("inspection_template", template.id)}
            <div class="card-stats">
              <span>${template.used} submissions</span>
              <span>Last used ${escapeHtml(template.lastUsed)}</span>
            </div>
            <div class="card-footer">
              <small>Version ${escapeHtml(template.currentVersion || 1)}</small>
              <button class="button small primary" type="button" ${!isReadOnlyAuditor() && template.published && template.currentVersionId && template.questions > 0 ? "" : "disabled"} data-action="open-modal" data-modal="inspection" data-template-id="${template.id}">Start</button>
            </div>
          </article>
        `).join("") || renderEmptyState("F", "No inspection templates", "Create and publish the first versioned template before scheduling field work.")}
      </section>
      <div style="height:17px"></div>
      <section class="table-card">
        <div class="table-header">
          <h2>Latest inspections</h2>
          <button class="link-button" type="button" data-action="prototype-action" data-message="A full inspection register will support saved views, exports, and audit history.">Open register →</button>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Inspection</th><th>Location</th><th>Assignee</th><th>Due</th><th>Score</th><th>Status</th></tr></thead>
            <tbody>
              ${inspections.map((inspection) => {
                const template = data.inspectionTemplates.find((item) => item.name === inspection.template);
                return `
                  <tr>
                    <td class="primary-cell">
                      ${escapeHtml(inspection.template)}
                      <span class="secondary-line">${inspection.id} · ${inspection.findings} finding${inspection.findings === 1 ? "" : "s"}</span>
                      ${inspection.regulatoryTraceStatus ? `
                        <span class="secondary-line">Regulatory trace: ${escapeHtml(inspection.regulatoryTraceStatus)} · ${inspection.regulatoryEvidenceCount} verified evidence link${inspection.regulatoryEvidenceCount === 1 ? "" : "s"}${inspection.regulatoryUnresolvedCount ? ` · ${inspection.regulatoryUnresolvedCount} unresolved` : ""}</span>
                        ${inspection.regulatoryContextSha256 ? `<span class="secondary-line">Context SHA-256 ${escapeHtml(inspection.regulatoryContextSha256.slice(0, 12))}...</span>` : ""}
                      ` : inspection.regulatorySnapshot ? `<span class="secondary-line">Legacy trace context available</span>` : ""}
                      ${template ? renderCitationChips("inspection_template", template.id) : ""}
                    </td>
                    <td>${escapeHtml(locationName(inspection.locationId))}</td>
                    <td>${escapeHtml(inspection.assignee)}</td>
                    <td>${escapeHtml(inspection.due)}</td>
                    <td>${inspection.score === null ? "—" : `${inspection.score}%`}</td>
                    <td>${statusPill(inspection.status)}</td>
                  </tr>
                `;
              }).join("") || `<tr><td colspan="6">${renderEmptyState("F", "No inspections", "No inspection records match this location.")}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderCommittee() {
    const meetings = filterLocation(data.committeeMeetings);
    const meetingIds = new Set(meetings.map((meeting) => meeting.id));
    const committeeActions = filterLocation(data.actions).filter((action) =>
      action.committeeMeetingId && meetingIds.has(action.committeeMeetingId)
    );
    const openActions = committeeActions.filter((action) => action.status !== "Closed");
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Meetings recorded</span><strong>${meetings.length}</strong></article>
        <article class="summary-card"><span>Draft minutes</span><strong>${meetings.filter((meeting) => meeting.rawStatus === "draft").length}</strong></article>
        <article class="summary-card"><span>Open action items</span><strong>${openActions.length}</strong></article>
      </section>
      <section class="committee-grid" aria-label="Safety committee meeting records">
        ${meetings.map((meeting) => {
          const meetingActions = committeeActions.filter((action) =>
            action.committeeMeetingId === meeting.id
          );
          return `
            <article class="meeting-card">
              <header>
                <div>
                  <p class="section-kicker">${escapeHtml(meeting.date)} · ${escapeHtml(locationName(meeting.locationId))}</p>
                  <h2>${escapeHtml(meeting.title)}</h2>
                </div>
                ${statusPill(meeting.status, meeting.rawStatus === "finalized" ? "green" : "amber")}
              </header>
              <div class="meeting-meta">
                <span><strong>${meeting.attendees.length}</strong> attendee${meeting.attendees.length === 1 ? "" : "s"}</span>
                <span><strong>${meetingActions.length}</strong> action item${meetingActions.length === 1 ? "" : "s"}</span>
                <span>Chair: <strong>${escapeHtml(meeting.chair)}</strong></span>
              </div>
              <div class="employee-record-grid">
                <section class="employee-record-section">
                  <span>Notes</span>
                  <p>${escapeHtml(meeting.notes || "No notes recorded yet.")}</p>
                </section>
                <section class="employee-record-section">
                  <span>Decisions</span>
                  <p>${escapeHtml(meeting.decisions || "No decisions recorded yet.")}</p>
                </section>
              </div>
              ${meetingActions.length ? `
                <div class="employee-document-list">
                  ${meetingActions.map((action) => `
                    <div class="employee-document-row">
                      <div><strong>${escapeHtml(action.title)}</strong><span>${escapeHtml(action.owner)} · due ${escapeHtml(action.due)}</span></div>
                      ${statusPill(action.status)}
                    </div>
                  `).join("")}
                </div>
              ` : ""}
              ${meeting.minutesSha256 ? `<p class="secondary-line">Final minutes SHA-256 · <code>${escapeHtml(meeting.minutesSha256.slice(0, 16))}…</code></p>` : ""}
              <footer class="card-footer row-actions">
                <button class="button small" type="button" ${meeting.rawStatus === "draft" && canWriteLocation(meeting.locationId) ? "" : "disabled"} data-action="open-modal" data-modal="action" data-meeting-id="${meeting.id}">Add action</button>
                <button class="button small primary" type="button" ${meeting.rawStatus === "draft" && canWriteLocation(meeting.locationId) && meeting.notes.trim() ? "" : "disabled"} data-action="finalize-committee" data-meeting-id="${meeting.id}">Finalize minutes</button>
              </footer>
            </article>
          `;
        }).join("") || renderEmptyState("C", "No committee meetings", "Record the first meeting to connect minutes, attendance, owners, due dates, and training needs.")}
      </section>
    `;
  }

  function renderTraining() {
    const people = filterLocation(data.people);
    const assignments = filterLocation(data.trainingAssignments);
    const avg = average(people.map((person) => person.training));
    const assignmentsDue = filterLocation(data.tasks).filter((task) => task.type === "Training").length;
    const credentialsExpiring = people.filter((person) => ["Due soon", "Expired"].includes(person.status)).length;
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Training current</span><strong>${avg}%</strong></article>
        <article class="summary-card"><span>Assignments due</span><strong>${assignmentsDue}</strong></article>
        <article class="summary-card"><span>Credentials expiring</span><strong>${credentialsExpiring}</strong></article>
      </section>
      <section class="course-grid" aria-label="Active training campaigns">
        ${data.courses.map((course) => `
          <article class="course-card">
            <div class="course-top">
              <span class="category-badge">${escapeHtml(course.category)}</span>
              <span class="status-pill purple">Version ${escapeHtml(course.currentVersion || 1)}</span>
            </div>
            <h3>${escapeHtml(course.name)}</h3>
            <p>${escapeHtml(course.format)} · ${escapeHtml(course.duration)} · ${course.assigned} workers</p>
            ${renderCitationChips("training_course", course.id)}
            <div class="course-progress">
              <div class="course-progress-header"><span>Completion</span><strong>${course.complete}%</strong></div>
              <div class="progress"><span style="--progress:${course.complete}%;--progress-color:${course.complete < 80 ? "var(--amber)" : "var(--purple)"}"></span></div>
            </div>
            <div class="card-footer">
              <small>Due ${escapeHtml(course.due)}</small>
              <button class="button small" type="button" ${course.published ? "" : "disabled"} data-action="open-modal" data-modal="training" data-course-id="${course.id}">Assign</button>
            </div>
          </article>
        `).join("") || renderEmptyState("T", "No training courses", "Create and publish a course before assigning training.")}
      </section>
      <div style="height:17px"></div>
      <section class="table-card">
        <div class="table-header">
          <h2>Worker readiness</h2>
          <button class="link-button" type="button" data-action="navigate" data-view="people">View credentials →</button>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Worker</th><th>Location</th><th>Required training</th><th>Credentials</th><th>Status</th></tr></thead>
            <tbody>
              ${people.map((person) => `
                <tr>
                  <td>
                    <div class="person-cell">
                      <span class="avatar">${person.initials}</span>
                      <span class="primary-cell">${escapeHtml(person.name)}<span class="secondary-line">${escapeHtml(person.role)}</span></span>
                    </div>
                  </td>
                  <td>${escapeHtml(locationName(person.locationId))}</td>
                  <td>
                    <div class="training-progress">
                      <strong>${person.training}% complete</strong>
                      <div class="progress"><span style="--progress:${person.training}%;--progress-color:${person.training < 85 ? "var(--amber)" : "var(--accent)"}"></span></div>
                    </div>
                  </td>
                  <td>${escapeHtml(person.credentials)}</td>
                  <td>${statusPill(person.status)}</td>
                </tr>
              `).join("") || `<tr><td colspan="5">${renderEmptyState("P", "No employees", "Add employees and assign them to locations to begin readiness tracking.")}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
      <div style="height:17px"></div>
      <section class="table-card">
        <div class="table-header">
          <div><h2>Training assignment &amp; retention register</h2><p>Who needs what, when it was completed, and how long the proof is retained</p></div>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Employee</th><th>Requirement</th><th>Due / completed</th><th>Valid through</th><th>Retain through</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${assignments.map((assignment) => `
                <tr>
                  <td class="primary-cell">${escapeHtml(assignment.employee)}<span class="secondary-line">${escapeHtml(locationName(assignment.locationId))}</span></td>
                  <td class="primary-cell">${escapeHtml(assignment.course)}<span class="secondary-line">${escapeHtml(assignment.reason)}</span></td>
                  <td>${assignment.completedAt ? escapeHtml(formatShortDate(assignment.completedAt)) : escapeHtml(assignment.due)}</td>
                  <td>${escapeHtml(formatShortDate(assignment.validUntil, "No renewal set"))}</td>
                  <td><span class="retention-badge ${assignment.retainUntil ? "" : "review"}">${escapeHtml(assignment.retainThrough)}</span></td>
                  <td>${statusPill(assignment.status)}</td>
                  <td><button class="button small" type="button" ${["Complete", "Completed", "Waived"].includes(assignment.status) || !canWriteLocation(assignment.locationId) ? "disabled" : ""} data-action="open-modal" data-modal="training-completion" data-assignment-id="${assignment.id}">Record completion</button></td>
                </tr>
              `).join("") || `<tr><td colspan="7">${renderEmptyState("T", "No training assignments", "Assign a published course to one employee or a location roster.")}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderIncidents() {
    const incidents = filterLocation(data.incidents);
    const open = incidents.filter((incident) => incident.status !== "Closed");
    const closed = incidents.filter((incident) => incident.status === "Closed");
    const medianCloseDays = closed.length
      ? [...closed].sort((a, b) => a.daysOpen - b.daysOpen)[Math.floor((closed.length - 1) / 2)].daysOpen
      : null;
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Open investigations</span><strong>${open.length}</strong></article>
        <article class="summary-card"><span>Near misses · 30 days</span><strong>${incidents.filter((incident) => incident.type === "Near miss").length}</strong></article>
        <article class="summary-card"><span>Median days to close</span><strong>${medianCloseDays ?? "—"}</strong></article>
      </section>
      <section class="table-card">
        <div class="table-header">
          <h2>Incident register</h2>
          <select class="filter-select" aria-label="Filter incident status">
            <option>All statuses</option>
            <option>Open</option>
            <option>Investigation</option>
            <option>Closed</option>
          </select>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Incident</th><th>Location</th><th>Type</th><th>Reported</th><th>Severity</th><th>Status</th></tr></thead>
            <tbody>
              ${incidents.map((incident) => `
                <tr>
                  <td class="primary-cell">${escapeHtml(incident.title)}<span class="secondary-line">${incident.id} · ${incident.daysOpen} day${incident.daysOpen === 1 ? "" : "s"} open</span></td>
                  <td>${escapeHtml(locationName(incident.locationId))}</td>
                  <td>${escapeHtml(incident.type)}</td>
                  <td>${escapeHtml(incident.date)}<span class="secondary-line">${escapeHtml(incident.reportedBy)}</span></td>
                  <td>${statusPill(incident.severity)}</td>
                  <td>${statusPill(incident.status)}</td>
                </tr>
              `).join("") || `<tr><td colspan="6">${renderEmptyState("!", "No incidents", "No incident records match this location.")}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderActions() {
    const actions = filterLocation(data.actions);
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Open</span><strong>${actions.filter((action) => action.status !== "Closed").length}</strong></article>
        <article class="summary-card"><span>Overdue</span><strong>${actions.filter((action) => action.status === "Overdue").length}</strong></article>
        <article class="summary-card"><span>Critical / high</span><strong>${actions.filter((action) => ["Critical", "High"].includes(action.priority)).length}</strong></article>
      </section>
      <section class="table-card">
        <div class="table-header">
          <h2>Corrective action register</h2>
          <select class="filter-select" aria-label="Sort corrective actions">
            <option>Priority first</option>
            <option>Due date</option>
            <option>Owner</option>
          </select>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Action</th><th>Source</th><th>Location</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th></tr></thead>
            <tbody>
              ${actions.map((action) => `
                <tr>
                  <td class="primary-cell">${escapeHtml(action.title)}${renderCitationChips("corrective_action", action.id)}</td>
                  <td>${escapeHtml(action.source)}</td>
                  <td>${escapeHtml(locationName(action.locationId))}</td>
                  <td>${escapeHtml(action.owner)}</td>
                  <td>${escapeHtml(action.due)}</td>
                  <td>${statusPill(action.priority)}</td>
                  <td>${statusPill(action.status)}</td>
                </tr>
              `).join("") || `<tr><td colspan="7">${renderEmptyState("✓", "No actions", "No corrective actions match this location.")}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function programLibraryItems() {
    return [
      ...(programLibrary.programs || []),
      ...(programLibrary.forms || []),
      ...(programLibrary.folders || []),
      ...(programLibrary.looseResources || [])
    ];
  }

  function allFormTemplates() {
    return programLibrary.forms || [];
  }

  function formAvailableForSubmission(item) {
    return Boolean(
      !isReadOnlyAuditor()
      && item?.status === "published"
      && item.schemaSha256
      && item.programVersionId
      && item.formTemplateVersionId
      && (item.locations || []).length
    );
  }

  function originalFormTemplates() {
    return allFormTemplates().filter((item) => item.originalFile?.id);
  }

  const importCandidateKinds = [
    { id: "form_candidate", label: "Reusable forms", singular: "Reusable form candidate", tone: "form" },
    { id: "completed_record", label: "Completed records", singular: "Completed record", tone: "record" },
    { id: "program", label: "Programs", singular: "Safety program", tone: "program" },
    { id: "training", label: "Training", singular: "Training material", tone: "training" },
    { id: "reference", label: "References", singular: "Reference material", tone: "reference" },
    { id: "evidence", label: "Evidence", singular: "Safety evidence", tone: "evidence" },
    { id: "unknown", label: "Unclassified", singular: "Unclassified item", tone: "unknown" }
  ];
  const importCandidateReviewStatuses = [
    "pending_review",
    "needs_information",
    "approved",
    "rejected",
    "duplicate"
  ];
  const downloadableImportCandidateStatuses = new Set([
    "pending_review",
    "needs_information",
    "approved",
    "imported"
  ]);

  function importCandidateKind(candidateKind) {
    const values = [candidateKind]
      .map((value) => String(value || "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "_"));
    const exactAliases = {
      form: "form_candidate",
      form_candidate: "form_candidate",
      form_template: "form_candidate",
      reusable_form: "form_candidate",
      template: "form_candidate",
      completed_form: "completed_record",
      completed_record: "completed_record",
      record: "completed_record",
      submission: "completed_record",
      safety_program: "program",
      program: "program",
      program_document: "program",
      policy: "program",
      procedure: "program",
      course: "training",
      training: "training",
      training_material: "training",
      reference: "reference",
      guide: "reference",
      manual: "reference",
      evidence: "evidence",
      proof: "evidence",
      unknown: "unknown",
      unclassified: "unknown"
    };
    for (const value of values) {
      if (exactAliases[value]) return exactAliases[value];
    }
    const signal = values.join(" ");
    if (/(completed|filled|signed|submission|record)/.test(signal)) return "completed_record";
    if (/(evidence|proof|photo|incident)/.test(signal)) return "evidence";
    if (/(training|course|lesson|quiz)/.test(signal)) return "training";
    if (/(program|policy|procedure|plan)/.test(signal)) return "program";
    if (/(reference|guide|manual|appendix|resource)/.test(signal)) return "reference";
    if (/(form|template|checklist|inspection)/.test(signal)) return "form_candidate";
    return "unknown";
  }

  function importCandidateKindDefinition(kind) {
    return importCandidateKinds.find((definition) => definition.id === kind)
      || importCandidateKinds[importCandidateKinds.length - 1];
  }

  function importCandidateRows() {
    if (!isSignedInCompanyMember()) return [];
    const candidates = programLibrary.importCandidates || [];
    return canManageCompany()
      ? candidates
      : candidates.filter((candidate) => (
        candidate.accessScope === "company"
        && !forcesPrivateCandidateAccess(candidate)
      ));
  }

  function forcesPrivateCandidateAccess(candidate) {
    return ["confidential", "restricted"].includes(candidate?.classification)
      || ["completed_record", "evidence", "unknown"].includes(candidate?.archiveKind);
  }

  function isPdfImportCandidate(item) {
    return item?.mimeType === "application/pdf";
  }

  function isVerifiedPdfImportCandidate(item) {
    return isPdfImportCandidate(item)
      && item.renderVerified === true
      && Number.isInteger(item.pageCount)
      && item.pageCount > 0;
  }

  function importCandidateOriginalLabel(item) {
    if (isPdfImportCandidate(item)) {
      const pages = item.pageCount > 0
        ? ` · ${item.pageCount} page${item.pageCount === 1 ? "" : "s"}`
        : "";
      return isVerifiedPdfImportCandidate(item)
        ? `Verified original PDF${pages}`
        : `PDF source${pages} · full-document verification pending`;
    }
    const format = ({
      "application/msword": "DOC",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
      "image/jpeg": "JPEG",
      "image/png": "PNG",
      "image/x-adobe-dng": "DNG"
    })[item.mimeType] || "source file";
    return `Verified original ${format} · SHA-256 matched`;
  }

  function formatFileSize(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function openFormUploadDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("This browser does not provide IndexedDB storage."));
        return;
      }
      const request = window.indexedDB.open(formUploadDbName, 1);
      request.onerror = () => reject(request.error || new Error("The private form store could not be opened."));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(formUploadStoreName)) return;
        const store = db.createObjectStore(formUploadStoreName, { keyPath: "id" });
        store.createIndex("companyId", "companyId", { unique: false });
        store.createIndex("sha256", "sha256", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function localFormUploadOwnerId() {
    return state.authUser?.id || null;
  }

  async function listLocalFormUploads() {
    const ownerId = localFormUploadOwnerId();
    if (!ownerId) return [];
    const db = await openFormUploadDb();
    try {
      const records = await new Promise((resolve, reject) => {
        const request = db
          .transaction(formUploadStoreName, "readonly")
          .objectStore(formUploadStoreName)
          .getAll();
        request.onerror = () => reject(request.error || new Error("Uploaded forms could not be read."));
        request.onsuccess = () => resolve(request.result || []);
      });
      return records
        .filter((record) => (
          record.companyId === data.company.id
          && record.userId === ownerId
        ))
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    } finally {
      db.close();
    }
  }

  async function putLocalFormUpload(record) {
    const db = await openFormUploadDb();
    try {
      await new Promise((resolve, reject) => {
        const request = db
          .transaction(formUploadStoreName, "readwrite")
          .objectStore(formUploadStoreName)
          .put(record);
        request.onerror = () => reject(request.error || new Error("The form could not be saved."));
        request.onsuccess = () => resolve();
      });
    } finally {
      db.close();
    }
  }

  async function clearLocalFormUploads(companyId, userId) {
    if (!companyId || !userId || !window.indexedDB) return;
    const db = await openFormUploadDb();
    try {
      const records = await new Promise((resolve, reject) => {
        const request = db
          .transaction(formUploadStoreName, "readonly")
          .objectStore(formUploadStoreName)
          .getAll();
        request.onerror = () => reject(request.error || new Error("Local staging could not be inspected."));
        request.onsuccess = () => resolve(request.result || []);
      });
      const matchingIds = records
        .filter((record) => record.companyId === companyId && record.userId === userId)
        .map((record) => record.id);
      if (!matchingIds.length) return;
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(formUploadStoreName, "readwrite");
        const store = transaction.objectStore(formUploadStoreName);
        matchingIds.forEach((id) => store.delete(id));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Local staging could not be cleared."));
        transaction.onabort = () => reject(transaction.error || new Error("Local staging clear was aborted."));
      });
    } finally {
      db.close();
    }
  }

  async function getLocalFormUpload(id) {
    const db = await openFormUploadDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction(formUploadStoreName, "readonly")
          .objectStore(formUploadStoreName)
          .get(id);
        request.onerror = () => reject(request.error || new Error("The uploaded form could not be opened."));
        request.onsuccess = () => resolve(request.result || null);
      });
    } finally {
      db.close();
    }
  }

  async function sha256Hex(file) {
    if (!window.crypto?.subtle) throw new Error("This browser cannot calculate a secure file fingerprint.");
    const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function sha256Text(value) {
    if (!window.crypto?.subtle) throw new Error("This browser cannot calculate a secure record fingerprint.");
    const digest = await window.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(value))
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hydrateLocalFormUploads() {
    if (!localUploadStagingEnabled) {
      state.localFormUploads = [];
      return;
    }
    try {
      state.localFormUploads = await listLocalFormUploads();
      if (state.view === "programs" && state.programCategory === "forms") render();
    } catch (_error) {
      state.localFormUploads = [];
    }
  }

  function programCategoryRows(category = state.programCategory) {
    const folders = programLibrary.folders || [];
    const formRows = state.formLibraryMode === "uploads"
      ? state.localFormUploads
      : state.formLibraryMode === "templates"
        ? allFormTemplates()
        : state.formLibraryMode === "archive"
          ? importCandidateRows().filter((item) => (
            (state.formArchiveKind === "all" || item.archiveKind === state.formArchiveKind)
            && (state.formArchiveStatus === "all" || item.reviewStatus === state.formArchiveStatus)
          ))
          : originalFormTemplates();
    const categoryMap = {
      programs: programLibrary.programs || [],
      forms: formRows,
      folders: folders.filter((item) => item.language !== "Spanish"),
      translations: folders.filter((item) => item.language === "Spanish"),
      resources: programLibrary.looseResources || []
    };
    return categoryMap[category] || categoryMap.programs;
  }

  function programMatchesLocation(item) {
    const locations = item.locations || item.locationIds;
    if (state.locationId === "all" || !locations?.length || locations.includes("all")) return true;
    return locations.includes(state.locationId);
  }

  function programSearchText(item) {
    return [
      item.number,
      item.title,
      item.sourceName,
      item.description,
      item.category,
      item.language,
      item.type,
      item.filename,
      item.sha256,
      item.displayName,
      item.sourceCollection,
      item.folderHint,
      item.candidateKind,
      item.classification,
      item.reviewStatus,
      item.mimeType,
      item.contentSha256,
      item.sourcePathSha256,
      ...(item.proposedLocationCodes || []),
      ...(item.topics || []),
      ...(item.citations || []),
      ...(item.children || [])
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function filteredProgramRows() {
    const query = state.programQuery.trim().toLowerCase();
    return programCategoryRows().filter((item) => (
      programMatchesLocation(item) &&
      (!query || programSearchText(item).includes(query))
    ));
  }

  const importSourceFallbackLabel = "Uncategorized source";
  const importRootFolderAliases = new Set([
    "",
    "drive root",
    "root",
    "source folder not classified",
    "folder not classified",
    "not classified",
    "unclassified",
    "unknown",
    "uncategorized"
  ]);
  const importFolderCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "variant"
  });

  function importCandidateSourceCollection(sourceCollection) {
    return String(sourceCollection || "").trim() || importSourceFallbackLabel;
  }

  function importCandidateFolderSegments(folderHint) {
    const segments = String(folderHint || "")
      .replaceAll("\\", "/")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const firstSegment = String(segments[0] || "").toLowerCase();
    if (!segments.length || importRootFolderAliases.has(firstSegment)) {
      return segments.slice(1);
    }
    return segments;
  }

  function importFolderYear(name) {
    return /^\d{4}$/.test(String(name || "")) ? Number(name) : null;
  }

  function compareImportFolderNodes(left, right) {
    if (left.isUncategorizedSource !== right.isUncategorizedSource) {
      return left.isUncategorizedSource ? 1 : -1;
    }
    const leftYear = importFolderYear(left.name);
    const rightYear = importFolderYear(right.name);
    if (leftYear !== null && rightYear !== null && leftYear !== rightYear) {
      return rightYear - leftYear;
    }
    return importFolderCollator.compare(left.name, right.name);
  }

  function compareImportCandidateFiles(left, right) {
    const byDisplayName = importFolderCollator.compare(
      left.displayName || left.title || "",
      right.displayName || right.title || ""
    );
    if (byDisplayName) return byDisplayName;
    const bySourcePath = String(left.sourcePathSha256 || "")
      .localeCompare(String(right.sourcePathSha256 || ""));
    if (bySourcePath) return bySourcePath;
    return String(left.id || "").localeCompare(String(right.id || ""));
  }

  function buildImportCandidateFolderTree(items) {
    const roots = new Map();
    items.forEach((item) => {
      const collectionName = importCandidateSourceCollection(item.sourceCollection);
      if (!roots.has(collectionName)) {
        roots.set(collectionName, {
          name: collectionName,
          isSourceCollection: true,
          isUncategorizedSource: collectionName === importSourceFallbackLabel,
          items: [],
          children: new Map()
        });
      }
      const segments = importCandidateFolderSegments(item.folderHint);
      let node = roots.get(collectionName);
      let folderMap = node.children;
      segments.forEach((segment) => {
        if (!folderMap.has(segment)) {
          folderMap.set(segment, {
            name: segment,
            isSourceCollection: false,
            isUncategorizedSource: false,
            items: [],
            children: new Map()
          });
        }
        node = folderMap.get(segment);
        folderMap = node.children;
      });
      node.items.push(item);
    });

    function finalizeNode(node) {
      const children = [...node.children.values()]
        .map(finalizeNode)
        .sort(compareImportFolderNodes);
      const sortedItems = [...node.items].sort(compareImportCandidateFiles);
      return {
        ...node,
        items: sortedItems,
        children,
        itemCount: sortedItems.length + children.reduce((sum, child) => sum + child.itemCount, 0),
        folderCount: children.length + children.reduce((sum, child) => sum + child.folderCount, 0)
      };
    }

    return [...roots.values()]
      .map(finalizeNode)
      .sort(compareImportFolderNodes);
  }

  function renderImportCandidateFolder(node, options = {}) {
    const depth = Number(options.depth || 0);
    const parentPath = options.parentPath || [];
    const folderPath = [...parentPath, node.name];
    const isHeadline = depth === 0;
    const folderClass = isHeadline ? "import-folder-group" : "import-folder-category";
    const folderDataAttribute = isHeadline ? "data-folder-headline" : "data-folder-category";
    const folderDataValue = node.name;
    const shouldOpen = Boolean(options.expandAll || options.openBranch);
    const directFileCount = node.items.length;
    const childFolderCount = node.children.length;
    const directFilesLabel = directFileCount
      ? `<p class="import-folder-direct-label">${directFileCount} file${directFileCount === 1 ? "" : "s"} stored directly in this ${isHeadline ? "source collection" : "folder"}</p>`
      : "";
    return `
      <details class="${folderClass}${node.isUncategorizedSource ? " is-uncategorized" : ""}" ${folderDataAttribute}="${escapeHtml(folderDataValue)}" data-folder-path="${escapeHtml(folderPath.join(" / "))}" data-folder-depth="${depth}" ${shouldOpen ? "open" : ""}>
        <summary class="import-folder-summary">
          <span class="import-folder-glyph" aria-hidden="true"></span>
          <span class="import-folder-title">${escapeHtml(node.name)}</span>
          <span class="import-folder-count">${node.itemCount} file${node.itemCount === 1 ? "" : "s"}</span>
          <span class="import-folder-disclosure" aria-hidden="true"></span>
          ${node.isUncategorizedSource
            ? `<span class="import-folder-note">Source collection not identified</span>`
            : isHeadline
              ? `<span class="import-folder-note">${node.folderCount
                  ? `${node.folderCount} folder${node.folderCount === 1 ? "" : "s"} in this source collection`
                  : "Source collection root"}</span>`
              : childFolderCount
                ? `<span class="import-folder-note">${childFolderCount} subfolder${childFolderCount === 1 ? "" : "s"}</span>`
                : ""}
        </summary>
        <div class="import-folder-children">
          ${directFilesLabel}
          ${directFileCount ? `
            <div class="import-folder-file-grid program-grid import-archive-grid">
              ${node.items.map(renderImportCandidateCard).join("")}
            </div>
          ` : ""}
          ${childFolderCount
            ? node.children.map((child) => renderImportCandidateFolder(child, {
                depth: depth + 1,
                parentPath: folderPath,
                openBranch: false,
                expandAll: options.expandAll
              })).join("")
            : ""}
        </div>
      </details>
    `;
  }

  function renderImportCandidateLibrary(rows) {
    if (!rows.length) {
      return renderEmptyState("⌕", "No source items found", "Try another folder, location, filter, or search term.");
    }
    const folders = buildImportCandidateFolderTree(rows);
    const expandAll = Boolean(
      state.programQuery.trim()
      || state.formArchiveKind !== "all"
      || state.formArchiveStatus !== "all"
    );
    return `
      <div class="import-folder-library" aria-label="Drive folder library">
        ${folders.map((folder, index) => renderImportCandidateFolder(folder, {
          depth: 0,
          parentPath: [],
          openBranch: index === 0,
          expandAll
        })).join("")}
      </div>
    `;
  }

  function renderOriginalFormCard(item) {
    const original = item.originalFile;
    const tags = item.citations || [];
    return `
      <article class="program-card private form-file-card">
        <div class="program-card-top">
          <span class="program-type form">FILE</span>
          <span class="private-source-badge">Controlled original</span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <p class="program-card-description">The original is linked to this exact template version. Access is re-authorized before a short-lived private download is issued.</p>
        <div class="program-tags">
          ${tags.map((tag) => `<span class="program-tag">${escapeHtml(tag)}</span>`).join("")}
        </div>
        <div class="program-card-meta">
          <span>${escapeHtml(item.version)}</span>
          <span>${escapeHtml(original.access)}</span>
          <span>Tenant authorized</span>
        </div>
        <div class="program-card-footer">
          <span class="program-version" title="${escapeHtml(item.sourceManifestSha256 || "")}">${item.sourceManifestSha256
            ? `Source manifest · ${escapeHtml(item.sourceManifestSha256.slice(0, 12))}…`
            : "Source manifest pending"}</span>
          <div class="program-card-actions">
            <button class="button small" type="button" data-action="download-form-original" data-form-id="${escapeHtml(item.id)}">Download original</button>
            <button class="button small primary" type="button" data-action="start-program-form" data-form-id="${escapeHtml(item.id)}" ${formAvailableForSubmission(item) ? "" : "disabled"}>Use template</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderUploadedFormCard(item) {
    const created = item.createdAt
      ? new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "Stored locally";
    return `
      <article class="program-card private form-file-card">
        <div class="program-card-top">
          <span class="program-type form">${escapeHtml((item.extension || "FILE").toUpperCase())}</span>
          <span class="local-only-badge">Local only</span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <p class="program-card-description">${escapeHtml(item.filename)} is stored in this browser's development-only private IndexedDB staging area. It is not included in the public GitHub build.</p>
        <div class="program-tags">
          <span class="program-tag">${escapeHtml(item.category || "Company form")}</span>
          ${(item.locationIds || []).map((id) => `<span class="program-tag">${escapeHtml(id === "all" ? "All locations" : locationName(id))}</span>`).join("")}
        </div>
        <div class="program-card-meta">
          <span>${escapeHtml(formatFileSize(item.sizeBytes))}</span>
          <span>Uploaded ${escapeHtml(created)}</span>
          <span>${escapeHtml(item.syncStatus === "local_only" ? "Awaiting private Supabase sync" : item.syncStatus)}</span>
        </div>
        <div class="program-card-footer">
          <span class="program-version" title="${escapeHtml(item.sha256)}">SHA-256 · ${escapeHtml(String(item.sha256 || "").slice(0, 12))}…</span>
          <div class="program-card-actions">
            <button class="button small primary" type="button" data-action="download-form-upload" data-upload-id="${escapeHtml(item.id)}">Download copy</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderImportCandidateCard(item) {
    const kind = importCandidateKindDefinition(item.archiveKind);
    const proposedLocations = item.proposedLocationCodes.length
      ? item.proposedLocationCodes.join(", ")
      : "None proposed · review required";
    const contentSha = item.contentSha256
      ? String(item.contentSha256)
      : "Pending";
    const sourcePathSha = item.sourcePathSha256
      ? String(item.sourcePathSha256)
      : "Pending";
    const sensitivity = ["internal", "confidential", "restricted"].includes(item.classification)
      ? item.classification
      : "internal";
    const verifiedOriginal = isPdfImportCandidate(item)
      ? isVerifiedPdfImportCandidate(item)
      : Boolean(item.contentSha256 && item.sizeBytes > 0);
    const forcedPrivate = forcesPrivateCandidateAccess(item);
    const isCompanyAccess = item.accessScope === "company" && !forcedPrivate;
    const accessLabel = isCompanyAccess ? "Company access" : "Safety/admin private";
    const reviewEditable = importCandidateReviewStatuses.includes(item.reviewStatus)
      && item.reviewStatus !== "duplicate";
    const downloadAvailable = downloadableImportCandidateStatuses.has(item.reviewStatus);
    const reviewSaving = state.candidateReviewSavingId === item.id;
    const controlSuffix = String(item.id || "candidate").replaceAll(/[^a-zA-Z0-9_-]/g, "-");
    const privacyControlId = `candidate-private-${controlSuffix}`;
    const reviewControlId = `candidate-review-${controlSuffix}`;
    const reviewHelpId = `candidate-review-help-${controlSuffix}`;
    return `
      <article class="program-card ${isCompanyAccess ? "company-access" : "private"} form-file-card import-candidate-card kind-${escapeHtml(kind.tone)} sensitivity-${escapeHtml(sensitivity)}" data-candidate-kind="${escapeHtml(kind.id)}" data-access-scope="${escapeHtml(item.accessScope)}">
        <div class="program-card-top">
          <span class="import-kind-badge kind-${escapeHtml(kind.tone)}">${escapeHtml(kind.singular)}</span>
          <span class="import-review-badge">${escapeHtml(readableStatus(item.reviewStatus))}</span>
          <span class="import-sensitivity-badge ${escapeHtml(sensitivity)}">${escapeHtml(readableStatus(sensitivity))}</span>
          <span class="import-access-badge ${isCompanyAccess ? "company" : "private"}" aria-label="Access: ${escapeHtml(accessLabel)}">${escapeHtml(accessLabel)}</span>
        </div>
        <h3>${escapeHtml(item.displayName)}</h3>
        <p class="import-original-status ${verifiedOriginal ? "verified" : "pending"}">${escapeHtml(importCandidateOriginalLabel(item))}</p>
        ${sensitivity === "restricted" ? `<p class="restricted-source-warning">Restricted personnel or sensitive safety record. Reconfirm business need before downloading.</p>` : ""}
        <dl class="import-trace-grid" aria-label="Source snapshot trace">
          <div><dt>Filename</dt><dd>${escapeHtml(item.displayName)}</dd></div>
          <div><dt>Folder hint</dt><dd>${escapeHtml(item.folderHint)}</dd></div>
          <div><dt>MIME</dt><dd>${escapeHtml(item.mimeType)}</dd></div>
          <div><dt>Bytes</dt><dd>${escapeHtml(formatFileSize(item.sizeBytes))}</dd></div>
          <div><dt>Content SHA-256</dt><dd><code class="full-trace-hash">${escapeHtml(contentSha)}</code></dd></div>
          <div><dt>Source path fingerprint</dt><dd><code class="full-trace-hash">${escapeHtml(sourcePathSha)}</code></dd></div>
          <div><dt>Language</dt><dd>${escapeHtml(item.language)}</dd></div>
          <div><dt>Proposed locations (unapproved)</dt><dd>${escapeHtml(proposedLocations)}</dd></div>
        </dl>
        ${canManageCompany() ? `
          <form class="candidate-review-form" data-candidate-review-form="${escapeHtml(item.id)}" aria-label="Access and review controls for ${escapeHtml(item.displayName)}">
            <input type="hidden" name="candidate_id" value="${escapeHtml(item.id)}">
            <div class="candidate-privacy-control">
              <input id="${escapeHtml(privacyControlId)}" name="safety_admin_private" type="checkbox" value="true" ${isCompanyAccess ? "" : "checked"} ${reviewEditable && !reviewSaving && !forcedPrivate ? "" : "disabled"} aria-describedby="${escapeHtml(reviewHelpId)}">
              <label for="${escapeHtml(privacyControlId)}">Safety/admin private</label>
            </div>
            <p id="${escapeHtml(reviewHelpId)}" class="candidate-access-help">${forcedPrivate
              ? "Sensitive or record material must remain Safety/admin private."
              : "Clear this checkbox to make the original available to authenticated company members. Original files are never public."}</p>
            <div class="candidate-review-field">
              <label for="${escapeHtml(reviewControlId)}">Review status</label>
              <select id="${escapeHtml(reviewControlId)}" name="review_status" ${reviewEditable && !reviewSaving ? "" : "disabled"} required>
                ${!reviewEditable ? `<option value="${escapeHtml(item.reviewStatus)}" selected>${escapeHtml(readableStatus(item.reviewStatus))} (terminal)</option>` : ""}
                ${importCandidateReviewStatuses.map((status) => `<option value="${status}" ${item.reviewStatus === status ? "selected" : ""}>${escapeHtml(readableStatus(status))}</option>`).join("")}
              </select>
            </div>
            <button class="button small candidate-review-save" type="submit" ${reviewEditable && !reviewSaving ? "" : "disabled"}>${reviewSaving ? "Saving..." : "Save review"}</button>
          </form>
        ` : `
          <p class="candidate-member-access-note"><strong>Company access.</strong> Available to authenticated company members; original files are never public.</p>
        `}
        <div class="program-card-footer">
          <span class="program-version">Review · ${escapeHtml(readableStatus(item.reviewStatus))}</span>
          <div class="program-card-actions">
            <button class="button small primary" type="button" data-action="download-import-candidate" data-candidate-id="${escapeHtml(item.id)}" ${downloadAvailable ? "" : "disabled"}>Download original</button>
          </div>
        </div>
        ${downloadAvailable ? "" : `<p class="candidate-download-unavailable" role="status">Original unavailable while review status is ${escapeHtml(readableStatus(item.reviewStatus))}.</p>`}
      </article>
    `;
  }

  function renderProgramCard(item) {
    if (state.programCategory === "forms" && state.formLibraryMode === "archive") {
      return renderImportCandidateCard(item);
    }
    if (state.programCategory === "forms" && state.formLibraryMode === "originals") {
      return renderOriginalFormCard(item);
    }
    if (state.programCategory === "forms" && state.formLibraryMode === "uploads") {
      return renderUploadedFormCard(item);
    }

    const isForm = item.type === "Form";
    const isFolder = item.type === "Folder";
    const icon = isForm ? "FORM" : isFolder ? "DIR" : item.number || "DOC";
    const itemTypeClass = isForm ? "form" : isFolder ? "" : "policy";
    const tags = item.topics || item.children?.slice(0, 3) || item.citations?.slice(0, 3) || [];
    const metadata = isFolder
      ? `${item.itemCount || 0} indexed item${item.itemCount === 1 ? "" : "s"}`
      : `${item.language || "English"} · ${item.version || item.category || item.type}`;
    const status = item.mappingStatus || item.contentStatus || item.importStatus || "Source linked";

    return `
      <article class="program-card private">
        <div class="program-card-top">
          <span class="program-type ${itemTypeClass}">${escapeHtml(icon)}</span>
          <span class="private-source-badge">${item.privacy === "Restricted personal records" ? "Restricted" : "Private source"}</span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <p class="program-card-description">${escapeHtml(item.description || (isFolder ? `Controlled folder containing ${item.children?.join(", ") || "company safety records"}.` : item.sourceName || ""))}</p>
        <div class="program-tags">
          ${tags.map((tag) => `<span class="program-tag">${escapeHtml(tag)}</span>`).join("")}
        </div>
        <div class="program-card-meta">
          <span>${escapeHtml(metadata)}</span>
          <span>${escapeHtml(status)}</span>
        </div>
        <div class="program-card-footer">
          <span class="program-version">Source ID · ${escapeHtml((item.sourceId || "").slice(0, 10))}…</span>
          <div class="program-card-actions">
            <button class="button small" type="button" data-action="open-program" data-program-id="${escapeHtml(item.id)}">Details</button>
            ${isForm
              ? `${item.originalFile ? `<button class="button small" type="button" data-action="download-form-original" data-form-id="${escapeHtml(item.id)}">Download original</button>` : ""}
                 <button class="button small primary" type="button" data-action="start-program-form" data-form-id="${escapeHtml(item.id)}" ${formAvailableForSubmission(item) ? "" : "disabled"}>Start form</button>`
              : item.sourceUrl ? `<a class="button small" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
          </div>
        </div>
      </article>
    `;
  }

  function renderFormLibraryControls() {
    if (state.programCategory !== "forms") return "";
    const archiveRows = importCandidateRows();
    const modes = [
      { id: "originals", label: "Original forms", count: originalFormTemplates().length },
      ...(isSignedInCompanyMember()
        ? [{ id: "archive", label: canManageCompany() ? "Drive archive review" : "Company originals", count: archiveRows.length }]
        : []),
      ...(localUploadStagingEnabled
        ? [{ id: "uploads", label: "Local staging", count: state.localFormUploads.length }]
        : []),
      { id: "templates", label: "Templates", count: allFormTemplates().length }
    ];
    const archivePdfRows = archiveRows.filter(isPdfImportCandidate);
    const archiveVerifiedPdfRows = archivePdfRows.filter(isVerifiedPdfImportCandidate);
    const archivePageCount = archiveVerifiedPdfRows.reduce((sum, item) => sum + item.pageCount, 0);
    const reviewStatuses = [...new Set(archiveRows.map((item) => item.reviewStatus).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    const archiveControls = state.formLibraryMode === "archive" ? `
      <section class="import-archive-review" aria-labelledby="drive-archive-review-title">
        <div class="import-archive-summary">
          <div>
            <p class="section-kicker">${canManageCompany() ? "Safety source access and review" : "Signed-in company source library"}</p>
            <h3 id="drive-archive-review-title">${canManageCompany() ? "Drive archive review" : "Company originals"}</h3>
            <p>${archiveRows.length} source item${archiveRows.length === 1 ? "" : "s"} · ${archiveVerifiedPdfRows.length} verified original PDF${archiveVerifiedPdfRows.length === 1 ? "" : "s"} · ${archivePageCount} verified PDF page${archivePageCount === 1 ? "" : "s"}</p>
            <p>Originals follow their Company access or Safety/admin private setting. Company access is limited to authenticated company members; original files are never public.</p>
          </div>
          <span class="private-source-badge">${canManageCompany() ? "Review controls available" : "Company access"}</span>
        </div>
        ${state.formArchiveError ? `<div class="import-archive-error" role="status">${escapeHtml(state.formArchiveError)}</div>` : ""}
        <div class="import-kind-filters" role="group" aria-label="Filter Drive archive by source type">
          ${[
            { id: "all", label: "All items" },
            ...importCandidateKinds
          ].map((definition) => {
            const count = definition.id === "all"
              ? archiveRows.length
              : archiveRows.filter((item) => item.archiveKind === definition.id).length;
            return `
              <button class="import-kind-filter ${state.formArchiveKind === definition.id ? "active" : ""}" type="button" data-action="form-archive-kind" data-kind="${escapeHtml(definition.id)}" aria-pressed="${state.formArchiveKind === definition.id}">
                <span>${escapeHtml(definition.label)}</span><strong>${count}</strong>
              </button>
            `;
          }).join("")}
        </div>
        <div class="import-archive-filter-row">
          <label for="form-archive-status">Filter by review status</label>
          <select id="form-archive-status" class="filter-select">
            <option value="all" ${state.formArchiveStatus === "all" ? "selected" : ""}>All review statuses</option>
            ${reviewStatuses.map((status) => `<option value="${escapeHtml(status)}" ${state.formArchiveStatus === status ? "selected" : ""}>${escapeHtml(readableStatus(status))}</option>`).join("")}
          </select>
          <span>Search filenames, folder hints, MIME types, full SHA-256 fingerprints, languages, or unapproved location proposals above.</span>
        </div>
      </section>
    ` : "";
    return `
      <div class="forms-library-toolbar">
        <div id="forms-library-tabs" class="tabs forms-library-tabs" role="tablist" aria-label="Form library sections">
          ${modes.map((mode) => `
            <button
              class="tab ${state.formLibraryMode === mode.id ? "active" : ""}"
              type="button"
              role="tab"
              aria-selected="${state.formLibraryMode === mode.id}"
              data-action="form-library-mode"
              data-mode="${mode.id}"
            >${escapeHtml(mode.label)} <span>${mode.count}</span></button>
          `).join("")}
        </div>
        <button class="button primary" type="button" data-action="open-modal" data-modal="form-upload" ${localUploadStagingEnabled ? "" : "disabled"} title="${localUploadStagingEnabled ? "Stage a development-only local copy" : "Deploy the private prepare/scan/commit upload service first"}>${localUploadStagingEnabled ? "Stage form locally" : "Upload service required"}</button>
      </div>
      <div class="form-storage-boundary">
        <strong>${state.formLibraryMode === "uploads"
          ? "Development-only local staging"
          : state.formLibraryMode === "archive"
            ? "Private Drive source snapshots"
            : "Controlled form library"}</strong>
        <span>${state.formLibraryMode === "uploads"
          ? "Uploads stay in this browser only. Production uses a private Supabase bucket, tenant RLS, malware scanning, and short-lived signed URLs."
          : state.formLibraryMode === "archive"
            ? "Originals are available according to Company access or Safety/admin private. Company access is for authenticated company members; originals are never public."
            : "Original files remain immutable; templates and completed submissions keep their source version and SHA-256 trace."}</span>
      </div>
      ${archiveControls}
      <div style="height:12px"></div>
    `;
  }

  function renderPrograms() {
    const archiveRows = importCandidateRows();
    const categories = [
      { id: "programs", label: "Programs", icon: "P", count: (programLibrary.programs || []).length },
      { id: "forms", label: "Forms", icon: "F", count: allFormTemplates().length + state.localFormUploads.length + archiveRows.length },
      { id: "folders", label: "Source folders", icon: "D", count: (programLibrary.folders || []).filter((item) => item.language !== "Spanish").length },
      { id: "translations", label: "Spanish", icon: "ES", count: (programLibrary.folders || []).filter((item) => item.language === "Spanish").length },
      { id: "resources", label: "Resources", icon: "R", count: (programLibrary.looseResources || []).length }
    ];
    const rows = filteredProgramRows();
    const submissions = data.programSubmissions || [];
    const indexedItems = (programLibrary.folders || []).reduce((sum, folder) => sum + Number(folder.itemCount || 0), 0);
    const extraction = programLibrary.meta.extraction || { extracted: 0, imageOnly: 0, ocrRequired: 0 };
    const hasTenantLibrary = programLibraryItems().length > 0 || archiveRows.length > 0;
    const formModeLabel = {
      originals: "Original forms",
      archive: canManageCompany() ? "Drive archive review" : "Company originals",
      uploads: "Local staging",
      templates: "Interactive templates"
    }[state.formLibraryMode] || "Forms";

    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Company programs</span><strong>${(programLibrary.programs || []).length}</strong></article>
        <article class="summary-card"><span>Original form PDFs</span><strong>${originalFormTemplates().length}</strong></article>
        <article class="summary-card"><span>Interactive templates</span><strong>${allFormTemplates().length}</strong></article>
        <article class="summary-card"><span>Submitted forms</span><strong>${submissions.filter((item) => item.status === "Submitted").length}</strong></article>
        ${isSignedInCompanyMember() ? `<article class="summary-card"><span>${canManageCompany() ? "Drive archive items" : "Company originals"}</span><strong>${archiveRows.length}</strong></article>` : ""}
      </section>
      <div style="height:14px"></div>
      ${hasTenantLibrary ? `<section class="import-status running" aria-label="Safety program ingestion status">
        <span class="import-status-icon">↻</span>
        <div>
          <strong>Private-source inventory connected</strong>
          <p>${extraction.extracted} of ${(programLibrary.programs || []).length} program sources have traceable text outlines; ${indexedItems + archiveRows.length} source items are indexed. ${escapeHtml(programLibrary.meta.ingestionMode || "Source metadata is indexed.")}</p>
        </div>
        <span class="status-pill ${programLibrary.programs.some((item) => item.programStatus === "published") ? "current" : "pending"}">${programLibrary.programs.some((item) => item.programStatus === "published") ? "Controlled records active" : "Publication review required"}</span>
      </section>` : `<section class="import-status" aria-label="Tenant library status">
        <span class="import-status-icon">RLS</span>
        <div>
          <strong>Public shell contains no company safety records</strong>
          <p>Create a company or sign in to load private programs, forms, memberships, and files through Supabase row-level security.</p>
        </div>
        <span class="status-pill neutral">Tenant sign-in required</span>
      </section>`}
      <div style="height:14px"></div>
      <section class="programs-layout">
        <aside class="program-sidebar">
          <div class="program-sidebar-header">
            <h2>Library</h2>
            <p>Source hierarchy preserved</p>
          </div>
          <div class="program-folder-list">
            ${categories.map((category) => `
              <button class="program-folder ${state.programCategory === category.id ? "active" : ""}" type="button" data-action="program-category" data-category="${category.id}" ${state.programCategory === category.id ? 'aria-current="page"' : ""}>
                <span class="program-folder-icon">${category.icon}</span>
                <span>${escapeHtml(category.label)}</span>
                <span class="program-folder-count">${category.count}</span>
              </button>
            `).join("")}
          </div>
        </aside>
        <div class="program-library-main">
          <form id="program-search-form" class="programs-toolbar">
            <input id="program-query" class="filter-input program-search" name="query" value="${escapeHtml(state.programQuery)}" placeholder="${state.programCategory === "forms" && state.formLibraryMode === "archive" ? "Search filenames, folders, SHA, language, or locations" : "Search programs, forms, folders, topics, or citations"}" aria-label="${state.programCategory === "forms" && state.formLibraryMode === "archive" ? "Search Drive archive" : "Search safety programs"}">
            <button class="button" type="submit">Search</button>
            ${state.programQuery ? `<button class="button" type="button" data-action="clear-program-search">Clear</button>` : ""}
          </form>
          ${renderFormLibraryControls()}
          <div style="height:12px"></div>
          <div class="program-library-header">
            <div>
              <h2>${escapeHtml(state.programCategory === "forms" ? formModeLabel : categories.find((item) => item.id === state.programCategory)?.label || "Programs")}</h2>
              <p>${state.programCategory === "forms" && state.formLibraryMode === "archive"
                ? canManageCompany()
                  ? `${rows.length} item${rows.length === 1 ? "" : "s"} in the company review queue · location tags are unapproved proposals`
                  : `${rows.length} original${rows.length === 1 ? "" : "s"} available to authenticated company members · originals are never public`
                : `${rows.length} item${rows.length === 1 ? "" : "s"} available for ${state.locationId === "all" ? escapeHtml(allLocationsLabel(true)) : escapeHtml(locationName(state.locationId))}`}</p>
            </div>
            <span class="private-source-badge">Access-controlled</span>
          </div>
          ${state.programCategory === "forms" && state.formLibraryMode === "archive"
            ? renderImportCandidateLibrary(rows)
            : `<div class="program-grid">
            ${rows.map(renderProgramCard).join("") || renderEmptyState("⌕", "No source items found", "Try another category, location, or search term.")}
              </div>`}
        </div>
      </section>
      <div style="height:14px"></div>
      <div class="prototype-note">
        <strong>Privacy boundary</strong>
        <span>Original programs, employee records, committee evidence, and completed forms remain private. The public client receives only metadata authorized by Supabase row-level security and time-limited file URLs.</span>
      </div>
    `;
  }

  function selectedProgramItem() {
    return programLibraryItems().find((item) => item.id === state.programDrawerId) || null;
  }

  function renderProgramDrawer() {
    const item = selectedProgramItem();
    if (!item) return "";
    const relatedForms = (item.relatedForms || [])
      .map((id) => (programLibrary.forms || []).find((form) => form.id === id))
      .filter(Boolean);
    const children = item.children || [];
    const citations = item.citations || [];
    const isForm = item.type === "Form";
    const extraction = item.extraction || null;

    return `
      <div class="program-drawer-backdrop" data-action="backdrop-close-program">
        <aside class="program-detail-drawer" role="dialog" aria-modal="true" aria-labelledby="program-drawer-title">
          <header class="program-drawer-header">
            <div>
              <span class="private-source-badge">${escapeHtml(item.privacy || "Internal")}</span>
              <h2 id="program-drawer-title">${escapeHtml(item.title)}</h2>
              <p>${escapeHtml(item.sourceName || `${item.itemCount || 0} indexed source items`)}</p>
            </div>
            <button class="icon-button" type="button" data-action="close-program" aria-label="Close program details">×</button>
          </header>
          <div class="program-drawer-body">
            <div class="program-source-summary source-summary">
              <span class="source-summary-icon">${isForm ? "FORM" : item.type === "Folder" ? "DIR" : "DOC"}</span>
              <div>
                <strong>${escapeHtml(item.description || "Controlled company safety source")}</strong>
                <p>Source captured ${escapeHtml(item.sourceCapturedOn || programLibrary.meta.sourceCapturedOn || "not recorded")} · ${escapeHtml(item.sourceSystem || "Google Drive")} · ${escapeHtml(item.language || "English")}</p>
              </div>
            </div>
            <div class="private-source-panel">
              <span class="private-source-badge">Private</span>
              <div>
                <strong>Binary source stays outside the public bundle</strong>
                <p>Production access is issued through Supabase after organization, role, location, and document permission checks.</p>
              </div>
            </div>
            ${extraction ? `
              <section class="import-status ${extraction.status === "text-extracted" ? "success" : "error"}">
                <span class="import-status-icon">${extraction.status === "text-extracted" ? "✓" : extraction.status === "image-only" ? "IMG" : "OCR"}</span>
                <div>
                  <strong>${extraction.status === "text-extracted"
                    ? `${extraction.pageCount} pages indexed from the source text layer`
                    : extraction.status === "image-only"
                      ? "Drive item is a cover image, not the program body"
                      : "Source needs OCR"}</strong>
                  <p>${escapeHtml(extraction.extractionMethod)}${extraction.characterCount ? ` · ${extraction.characterCount.toLocaleString()} characters` : ""}</p>
                </div>
                <span>${escapeHtml(extraction.extractedOn)}</span>
              </section>
              ${extraction.outline?.length ? `
                <section>
                  <p class="section-kicker">Extracted program outline</p>
                  <div class="source-file-list">
                    ${extraction.outline.map((heading, index) => `
                      <div class="source-file-row">
                        <span class="source-file-icon">${index + 1}</span>
                        <div><strong>${escapeHtml(heading)}</strong><span>Indexed from the authenticated source</span></div>
                        <span>Traceable</span>
                      </div>
                    `).join("")}
                  </div>
                </section>
              ` : ""}
              ${extraction.keyForms?.length ? `
                <section>
                  <p class="section-kicker">Forms and appendices detected in the program</p>
                  <div class="program-tags">${extraction.keyForms.map((name) => `<span class="program-tag">${escapeHtml(name)}</span>`).join("")}</div>
                </section>
              ` : ""}
            ` : ""}
            ${citations.length ? `
              <section>
                <p class="section-kicker">Regulatory trace</p>
                <div class="program-tags">${citations.map((citation) => `<span class="program-tag">${escapeHtml(citation)}</span>`).join("")}</div>
                <p class="field-hint">Each mapping must be reviewed against the applicable federal or state-plan source before publication.</p>
              </section>
            ` : ""}
            ${children.length ? `
              <section>
                <p class="section-kicker">Indexed contents</p>
                <div class="source-file-list">
                  ${children.map((child) => `
                    <div class="source-file-row">
                      <span class="source-file-icon">SRC</span>
                      <div><strong>${escapeHtml(child)}</strong><span>Inherited private-folder access</span></div>
                      <span>Indexed</span>
                    </div>
                  `).join("")}
                </div>
              </section>
            ` : ""}
            ${relatedForms.length ? `
              <section>
                <p class="section-kicker">Connected digital forms</p>
                <div class="source-file-list">
                  ${relatedForms.map((form) => `
                    <div class="source-file-row">
                      <span class="source-file-icon">FORM</span>
                      <div><strong>${escapeHtml(form.title)}</strong><span>${escapeHtml(form.mappingStatus)}</span></div>
                      <button class="button small" type="button" data-action="start-program-form" data-form-id="${escapeHtml(form.id)}" ${formAvailableForSubmission(form) ? "" : "disabled"}>Start</button>
                    </div>
                  `).join("")}
                </div>
              </section>
            ` : ""}
            <section>
              <p class="section-kicker">Source lineage</p>
              <ol class="version-timeline">
                <li class="version-item current">
                  <span class="version-dot">1</span>
                  <div><strong>${escapeHtml(item.sourceSystem || "Controlled source")} linked</strong><p>The source identity and exact controlled version are preserved for secure ingestion and review.</p></div>
                  <time>${escapeHtml(item.sourceCapturedOn || programLibrary.meta.sourceCapturedOn || "")}</time>
                </li>
                <li class="version-item">
                  <span class="version-dot">2</span>
                  <div><strong>Content extraction and owner review</strong><p>${extraction?.status === "text-extracted" ? (item.binary?.sha256 ? "Source outline and binary fingerprint captured; owner validation remains pending." : "Source outline extracted; owner validation and binary-file hashing remain pending.") : (item.binary?.sha256 ? "Binary fingerprint captured; OCR and authoritative owner approval remain pending." : "Pending OCR, version hash, and authoritative owner approval.")}</p></div>
                  <time>${extraction?.status === "text-extracted" ? escapeHtml(extraction.extractedOn) : "Pending"}</time>
                </li>
                <li class="version-item">
                  <span class="version-dot">3</span>
                  <div><strong>Controlled publication</strong><p>Approved version, assignments, acknowledgements, and supersession history.</p></div>
                  <time>Pending</time>
                </li>
              </ol>
            </section>
            <div class="source-version-fingerprint">
              <span>Controlled source identity — not a content hash</span>
              <code>${escapeHtml(item.sourceSystem === "Supabase controlled records" ? "supabase" : "external")}:${escapeHtml(item.sourceId || "unavailable")}</code>
            </div>
            ${item.binary?.sha256 ? `
              <div class="source-version-fingerprint">
                <span>Downloaded binary SHA-256 · ${escapeHtml(item.binary.format)} · ${Number(item.binary.byteSize || 0).toLocaleString()} bytes</span>
                <code>${escapeHtml(item.binary.sha256)}</code>
                <small>${escapeHtml(item.binary.verification)} · captured ${escapeHtml(item.binary.capturedOn)}</small>
              </div>
            ` : ""}
            ${extraction?.viewerTextSha256 ? `
              <div class="source-version-fingerprint">
                <span>Viewer text SHA-256 — not a binary-file hash</span>
                <code>${escapeHtml(extraction.viewerTextSha256)}</code>
                <small>${escapeHtml(extraction.hashScope)}</small>
              </div>
            ` : ""}
          </div>
          <footer class="program-drawer-footer">
            ${item.originalFile?.id ? `
              <button class="button" type="button" data-action="download-form-original" data-form-id="${escapeHtml(item.id)}">Download original</button>
            ` : item.originalFile?.path ? `
              <button class="button" type="button" data-action="view-form-original" data-form-id="${escapeHtml(item.id)}">View original PDF</button>
              <a class="button" href="${escapeHtml(item.originalFile.path)}" download="${escapeHtml(item.originalFile.filename)}">Download original</a>
            ` : item.sourceUrl ? `<a class="button" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
            ${isForm
              ? `<button class="button primary" type="button" data-action="start-program-form" data-form-id="${escapeHtml(item.id)}" ${formAvailableForSubmission(item) ? "" : "disabled"}>Start digital form</button>`
              : `<button class="button primary" type="button" data-action="assign-program" data-program-id="${escapeHtml(item.id)}" ${item.programStatus === "published" && (item.locations || []).some((locationId) => canWriteLocation(locationId)) ? "" : "disabled"}>Assign to me</button>`}
          </footer>
        </aside>
      </div>
    `;
  }

  function renderOriginalFormPreview() {
    const form = originalFormTemplates().find((item) => item.id === state.originalPreviewId);
    if (!form?.originalFile) return "";
    const original = form.originalFile;
    return `
      <div class="modal-backdrop" data-action="backdrop-close-original-preview">
        <section class="modal pdf-preview-modal" role="dialog" aria-modal="true" aria-labelledby="original-form-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Controlled original · ${Number(original.pageCount || 0)} page${Number(original.pageCount || 0) === 1 ? "" : "s"}</p>
              <h2 id="original-form-title">${escapeHtml(form.title)}</h2>
              <p>${escapeHtml(original.access || "Private original form")}</p>
            </div>
            <button class="icon-button" type="button" data-action="close-original-preview" aria-label="Close PDF preview">×</button>
          </header>
          <div class="pdf-preview-body">
            <iframe src="${escapeHtml(original.path)}#view=FitH" title="${escapeHtml(form.title)} PDF preview"></iframe>
          </div>
          <footer class="modal-footer pdf-preview-footer">
            <span class="file-fingerprint" title="${escapeHtml(original.sha256)}">SHA-256 · ${escapeHtml(String(original.sha256 || "").slice(0, 16))}…</span>
            <div class="program-card-actions">
              <a class="button" href="${escapeHtml(original.path)}" target="_blank" rel="noopener noreferrer">Open in new tab</a>
              <a class="button primary" href="${escapeHtml(original.path)}" download="${escapeHtml(original.filename)}">Download PDF</a>
            </div>
          </footer>
        </section>
      </div>
    `;
  }

  function renderProgramFormField(field, formId) {
    const fieldId = `${formId}-${field.id}`;
    const required = field.required ? "required" : "";
    const requiredLabel = field.required ? " <span aria-hidden=\"true\">*</span>" : "";
    const hint = field.helpText
      ? `<p class="field-hint">${escapeHtml(field.helpText)}</p>`
      : "";

    if (field.type === "instruction") {
      return `<div class="runner-field runner-instruction"><strong>${escapeHtml(field.label)}</strong>${hint}</div>`;
    }

    if (field.type === "textarea") {
      return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><textarea id="${fieldId}" name="${escapeHtml(field.id)}" placeholder="${escapeHtml(field.placeholder || "")}" ${required}></textarea>${hint}</div>`;
    }
    if (field.type === "location") {
      const form = allFormTemplates().find((item) => item.id === formId);
      const allowedLocations = data.locations.filter((location) =>
        (form?.locations || []).includes(location.id)
      );
      const selectedLocationId = state.locationId !== "all" && allowedLocations.some((location) =>
        location.id === state.locationId
      )
        ? state.locationId
        : allowedLocations[0]?.id;
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <select id="${fieldId}" name="${escapeHtml(field.id)}" ${required}>
            ${allowedLocations.map((location) => `<option value="${escapeHtml(location.id)}" ${location.id === selectedLocationId ? "selected" : ""}>${escapeHtml(location.name)}</option>`).join("")}
          </select>
          ${hint}
        </div>
      `;
    }
    if (field.type === "employee") {
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <select id="${fieldId}" name="${escapeHtml(field.id)}" ${required}>
            <option value="">Choose a team member</option>
            ${data.people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("")}
          </select>
          ${hint}
        </div>
      `;
    }
    if (field.type === "select") {
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <select id="${fieldId}" name="${escapeHtml(field.id)}" ${required}>
            <option value="">Choose an option</option>
            ${(field.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}
          </select>${hint}
        </div>
      `;
    }
    if (field.type === "multiselect") {
      return `
        <fieldset class="runner-field">
          <legend>${escapeHtml(field.label)}${requiredLabel}</legend>
          <div class="runner-choice-grid">
            ${(field.options || []).map((option, index) => `
              <div class="runner-option">
                <input id="${fieldId}-${index}" type="checkbox" name="${escapeHtml(field.id)}" value="${escapeHtml(option)}">
                <label for="${fieldId}-${index}">${escapeHtml(option)}</label>
              </div>
            `).join("")}
          </div>
          ${hint}
        </fieldset>
      `;
    }
    if (field.type === "yesno") {
      return `
        <fieldset class="runner-field">
          <legend>${escapeHtml(field.label)}${requiredLabel}</legend>
          <div class="runner-choice-grid">
            <div class="runner-option"><input id="${fieldId}-yes" type="radio" name="${escapeHtml(field.id)}" value="Yes" ${required}><label for="${fieldId}-yes">Yes</label></div>
            <div class="runner-option"><input id="${fieldId}-no" type="radio" name="${escapeHtml(field.id)}" value="No"><label for="${fieldId}-no">No</label></div>
          </div>${hint}
        </fieldset>
      `;
    }
    if (field.type === "file") {
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <div class="file-drop-zone">
            <strong>Add evidence</strong>
            <span>Development-only staging stores file metadata locally. Production requires private Supabase Storage after an authorized, quarantined, malware-scanned upload session.</span>
            <input id="${fieldId}" name="${escapeHtml(field.id)}" type="file" accept="image/*,.pdf" ${required}>
          </div>${hint}
        </div>
      `;
    }
    if (field.type === "acknowledgement") {
      return `
        <fieldset class="runner-field">
          <legend>${escapeHtml(field.label)}${requiredLabel}</legend>
          <div class="runner-option">
            <input id="${fieldId}" name="${escapeHtml(field.id)}" type="checkbox" value="Acknowledged" ${required}>
            <label for="${fieldId}">I acknowledge this statement</label>
          </div>
          ${hint}
        </fieldset>
      `;
    }
    if (field.type === "signature") {
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <div class="signature-field">
            <span>Type your full name to apply an electronic signature to this exact form payload.</span>
            <input id="${fieldId}" name="${escapeHtml(field.id)}" autocomplete="name" ${required}>
          </div>${hint}
        </div>
      `;
    }
    const inputType = ["date", "time", "datetime-local", "number"].includes(field.type)
      ? field.type
      : "text";
    return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><input id="${fieldId}" name="${escapeHtml(field.id)}" type="${inputType}" placeholder="${escapeHtml(field.placeholder || "")}" ${required}>${hint}</div>`;
  }

  function renderProgramFormRunner() {
    const form = allFormTemplates().find((item) => item.id === state.activeFormId);
    if (!form) return "";
    return `
      <div class="modal-backdrop" data-action="backdrop-close-program-form">
        <section class="modal wide form-runner" role="dialog" aria-modal="true" aria-labelledby="program-form-title">
          <header class="modal-header form-runner-header">
            <div>
              <p class="section-kicker">${escapeHtml(form.category)} · Controlled schema ${escapeHtml(form.version)}</p>
              <h2 id="program-form-title">${escapeHtml(form.title)}</h2>
              <p>A submitted response preserves the form wording, source identity, citations, signer, and timestamp.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-program-form" aria-label="Close digital form">×</button>
          </header>
          <form id="program-form-runner" data-form-id="${escapeHtml(form.id)}">
            <div class="modal-body">
              <div class="form-runner-progress">
                <div class="runner-progress-header"><strong>Complete required fields</strong><span>${form.fields.filter((field) => field.required).length} required · ${form.fields.length} total</span></div>
                <div class="runner-progress-steps" style="--step-count:3"><span class="runner-step complete"></span><span class="runner-step active"></span><span class="runner-step"></span></div>
              </div>
              <div class="trace-banner">
                <span class="trace-label">Source trace</span>
                <div>
                  <strong>${escapeHtml(form.sourceName)} · ${escapeHtml(form.version)}</strong>
                  <p>${escapeHtml(form.mappingStatus)} The original remains immutable and available through the controlled form library.</p>
                  <div class="program-tags">${(form.citations || []).map((citation) => `<span class="program-tag">${escapeHtml(citation)}</span>`).join("")}</div>
                </div>
              </div>
              <div style="height:14px"></div>
              <section class="form-section">
                <header class="form-section-header"><h3>Response</h3><p>Fields marked with an asterisk are required.</p></header>
                <div class="form-section-body">${form.fields.map((field) => renderProgramFormField(field, form.id)).join("")}</div>
              </section>
            </div>
            <footer class="modal-footer form-runner-footer">
              <div><span class="private-source-badge">Private submission</span></div>
              <div class="runner-footer-actions">
                <button class="button" type="button" data-action="save-program-form-draft">Save draft</button>
                <button class="button primary" type="submit">Sign & submit</button>
              </div>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderDocuments() {
    const awaitingAcknowledgement = data.documents.filter((documentRecord) =>
      documentRecord.acknowledgementRequired && documentRecord.acknowledgement !== 100
    ).length;
    const reviewWindowEnd = Date.now() + 90 * 86_400_000;
    const reviewsDue = data.documents.filter((documentRecord) => {
      const reviewDate = new Date(documentRecord.review).getTime();
      return Number.isFinite(reviewDate) && reviewDate <= reviewWindowEnd;
    }).length;
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Controlled documents</span><strong>${data.documents.length}</strong></article>
        <article class="summary-card"><span>My acknowledgements due</span><strong>${awaitingAcknowledgement}</strong></article>
        <article class="summary-card"><span>Reviews due · 90 days</span><strong>${reviewsDue}</strong></article>
      </section>
      <section class="table-card">
        <div class="table-header">
          <h2>Controlled document library</h2>
          <select class="filter-select" aria-label="Filter document type">
            <option>All document types</option>
            <option>Policy</option>
            <option>Program</option>
            <option>Procedure</option>
          </select>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Document</th><th>Type</th><th>Owner</th><th>Review date</th><th>Your acknowledgement</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${data.documents.map((documentRecord) => `
                <tr>
                  <td class="primary-cell">
                    ${escapeHtml(documentRecord.name)}
                    <span class="secondary-line">${documentRecord.id} · ${documentRecord.version} · Updated ${escapeHtml(documentRecord.updated)}</span>
                    ${renderCitationChips("document", documentRecord.id)}
                  </td>
                  <td>${escapeHtml(documentRecord.type)}</td>
                  <td>${escapeHtml(documentRecord.owner)}</td>
                  <td>${escapeHtml(documentRecord.review)}</td>
                  <td>
                    ${documentRecord.acknowledgement === null
                      ? `<span class="secondary-line">Not calculated</span>`
                      : `
                        <div class="training-progress">
                          <strong>${documentRecord.acknowledgement}%</strong>
                          <div class="progress"><span style="--progress:${documentRecord.acknowledgement}%;--progress-color:${documentRecord.acknowledgement < 90 ? "var(--amber)" : "var(--accent)"}"></span></div>
                        </div>
                      `}
                  </td>
                  <td>${statusPill(documentRecord.status)}</td>
                  <td><button class="button small" type="button" ${isReadOnlyAuditor() || documentRecord.acknowledgement === null || documentRecord.acknowledgement === 100 ? "disabled" : ""} data-action="acknowledge-document" data-document-id="${documentRecord.id}">${documentRecord.acknowledgement === 100 ? "Acknowledged" : "Acknowledge"}</button></td>
                </tr>
              `).join("") || `<tr><td colspan="7">${renderEmptyState("D", "No controlled documents", "Upload and publish the first company document to begin the controlled library.")}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
      <div style="height:14px"></div>
      <div class="prototype-note">
        <strong>Access design</strong>
        <span>Location classification and document permission are modeled separately. A document can belong to one site without automatically becoming visible to every worker at that site.</span>
      </div>
    `;
  }

  function renderPeople() {
    const people = filterLocation(data.people);
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Active workers</span><strong>${activeLocation() ? activeLocation().people : data.company.activeWorkers}</strong></article>
        <article class="summary-card"><span>Employee forms pending</span><strong>${people.reduce((sum, person) => sum + person.pendingDocuments, 0)}</strong></article>
        <article class="summary-card"><span>Training / credential attention</span><strong>${people.filter((person) => person.status !== "Current").length}</strong></article>
      </section>
      <section class="table-card">
        <div class="table-header">
          <h2>Worker directory</h2>
          <select class="filter-select" aria-label="Filter worker readiness">
            <option>All readiness states</option>
            <option>Current</option>
            <option>Training due</option>
            <option>Credential due soon</option>
            <option>Expired</option>
          </select>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Employee</th><th>Primary location</th><th>Training</th><th>Employee forms</th><th>Readiness</th><th></th></tr></thead>
            <tbody>
              ${people.map((person) => `
                <tr>
                  <td>
                    <div class="person-cell">
                      <span class="avatar">${person.initials}</span>
                      <span class="primary-cell">${escapeHtml(person.name)}<span class="secondary-line">${escapeHtml(person.role)}</span></span>
                    </div>
                  </td>
                  <td>${escapeHtml(locationName(person.locationId))}</td>
                  <td>
                    <div class="training-progress">
                      <strong>${person.training}%</strong>
                      <div class="progress"><span style="--progress:${person.training}%;--progress-color:${person.training < 85 ? "var(--amber)" : "var(--accent)"}"></span></div>
                    </div>
                  </td>
                  <td>${person.documentCount} record${person.documentCount === 1 ? "" : "s"}<span class="secondary-line">${person.pendingDocuments} awaiting completion</span></td>
                  <td>${statusPill(person.status)}</td>
                  <td><button class="button small" type="button" data-action="open-employee" data-employee-id="${person.id}">Open record</button></td>
                </tr>
              `).join("") || `<tr><td colspan="6">${renderEmptyState("P", "No employees", "Add the first employee to begin training, form, and retention tracking.")}</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderEmployeeDrawer() {
    if (!state.employeeDrawerId) return "";
    const person = data.people.find((item) => item.id === state.employeeDrawerId);
    if (!person) return "";
    const assignments = data.trainingAssignments.filter((assignment) =>
      assignment.employeeId === person.id
    );
    const employeeDocuments = data.employeeDocuments.filter((documentRecord) =>
      documentRecord.employeeId === person.id
    );
    const employeeForms = data.employeeFormAssignments.filter((assignment) =>
      assignment.employeeId === person.id
    );
    const pendingDocuments = employeeDocuments.filter((documentRecord) =>
      documentRecord.rawStatus === "awaiting_signature"
    );
    const pendingEmployeeForms = employeeForms.filter((assignment) =>
      ["assigned", "in_progress"].includes(assignment.rawStatus)
    );
    const retainedCompletions = assignments.filter((assignment) => assignment.completion).length;
    return `
      <div class="program-drawer-backdrop" data-action="backdrop-close-employee"></div>
      <aside class="employee-record-drawer" role="dialog" aria-modal="true" aria-labelledby="employee-record-title">
        <header class="program-drawer-header">
          <div class="person-cell">
            <span class="avatar">${escapeHtml(person.initials)}</span>
            <div>
              <p class="section-kicker">Employee safety record</p>
              <h2 id="employee-record-title">${escapeHtml(person.name)}</h2>
              <p>${escapeHtml(person.role)} · ${escapeHtml(locationName(person.locationId))}</p>
            </div>
          </div>
          <button class="icon-button" type="button" data-action="close-employee" aria-label="Close employee record">×</button>
        </header>
        <div class="program-drawer-body">
          <section class="workflow-status-grid">
            <article><span>Training assigned</span><strong>${assignments.length}</strong></article>
            <article><span>Completions retained</span><strong>${retainedCompletions}</strong></article>
            <article><span>Forms pending</span><strong>${pendingDocuments.length + pendingEmployeeForms.length}</strong></article>
            <article><span>Employee records</span><strong>${employeeDocuments.length + employeeForms.length}</strong></article>
          </section>
          <div class="row-actions">
            <button class="button small" type="button" ${canWriteLocation(person.locationId) ? "" : "disabled"} data-action="open-modal" data-modal="training" data-employee-id="${person.id}">Assign training</button>
            <button class="button small primary" type="button" ${canWriteLocation(person.locationId) ? "" : "disabled"} data-action="open-modal" data-modal="employee-form-assignment" data-employee-id="${person.id}">Assign employee form</button>
            <button class="button small" type="button" ${canWriteLocation(person.locationId) ? "" : "disabled"} data-action="open-modal" data-modal="employee-document" data-employee-id="${person.id}" data-document-kind="signature_request">Request PDF acknowledgement</button>
            <button class="button small" type="button" ${canWriteLocation(person.locationId) ? "" : "disabled"} data-action="open-modal" data-modal="employee-document" data-employee-id="${person.id}" data-document-kind="signed_upload">Upload signed PDF</button>
          </div>
          <section class="employee-record-section">
            <h3>Training &amp; retention</h3>
            <div class="employee-document-list">
              ${assignments.map((assignment) => `
                <div class="employee-document-row">
                  <div>
                    <strong>${escapeHtml(assignment.course)}</strong>
                    <span>${assignment.completedAt ? `Completed ${escapeHtml(formatShortDate(assignment.completedAt))}` : `Due ${escapeHtml(assignment.due)}`} · retain ${escapeHtml(assignment.retainThrough)}</span>
                  </div>
                  <div class="row-actions">
                    ${statusPill(assignment.status)}
                    <button class="button small" type="button" ${assignment.completedAt || !canWriteLocation(assignment.locationId) ? "disabled" : ""} data-action="open-modal" data-modal="training-completion" data-assignment-id="${assignment.id}">Record completion</button>
                  </div>
                </div>
              `).join("") || `<p>No training has been assigned.</p>`}
            </div>
          </section>
          <section class="employee-record-section">
            <h3>Employee forms</h3>
            <div class="employee-document-list">
              ${employeeForms.map((assignment) => `
                <div class="employee-document-row">
                  <div>
                    <strong>${escapeHtml(assignment.title)}</strong>
                    <span>${escapeHtml(assignment.formTitle)} Â· due ${escapeHtml(assignment.due)}</span>
                    ${assignment.submission ? `<span class="secondary-line">Submission SHA-256 Â· <code>${escapeHtml(assignment.submission.submissionSha256.slice(0, 16))}â€¦</code></span>` : ""}
                  </div>
                  <div class="row-actions">
                    ${statusPill(assignment.status)}
                    ${["assigned", "in_progress"].includes(assignment.rawStatus) ? `<button class="button small primary" type="button" data-action="start-employee-form-handoff" data-assignment-id="${assignment.id}">Start tablet form</button>` : ""}
                  </div>
                </div>
              `).join("") || `<p>No employee forms have been assigned.</p>`}
            </div>
          </section>
          <section class="employee-record-section">
            <h3>PDFs &amp; signatures</h3>
            <div class="employee-document-list">
              ${employeeDocuments.map((documentRecord) => `
                <div class="employee-document-row">
                  <div>
                    <strong>${escapeHtml(documentRecord.title)}</strong>
                    <span>${escapeHtml(documentRecord.filename)} · ${escapeHtml(documentRecord.retainThrough)}</span>
                    ${documentRecord.malwareScanStatus === "Unavailable" ? `<span class="scan-warning">Format verified; malware scanning is not configured</span>` : ""}
                    ${documentRecord.signature ? `<span class="secondary-line">Signature SHA-256 · <code>${escapeHtml(documentRecord.signature.signatureSha256.slice(0, 16))}…</code></span>` : ""}
                  </div>
                  <div class="row-actions">
                    ${statusPill(documentRecord.status)}
                    ${documentRecord.malwareScanStatus === "Unavailable" && canWriteLocation(documentRecord.locationId) ? `<button class="button small" type="button" data-action="retry-employee-document-scan" data-document-id="${documentRecord.id}">Retry security scan</button>` : ""}
                    ${documentRecord.rawStatus === "awaiting_signature" ? `<button class="button small primary" type="button" data-action="open-employee-sign" data-document-id="${documentRecord.id}">Review &amp; sign</button>` : ""}
                    ${["awaiting_signature", "signed", "signed_upload"].includes(documentRecord.rawStatus) ? `<button class="button small" type="button" data-action="download-employee-document" data-document-id="${documentRecord.id}">Download</button>` : ""}
                  </div>
                </div>
              `).join("") || `<p>No employee documents have been added.</p>`}
            </div>
          </section>
        </div>
      </aside>
    `;
  }

  function renderLocations() {
    return `
      ${renderPageHeading()}
      <section class="location-grid">
        ${data.locations.map((location) => {
          const readiness = locationReadinessScore(location);
          return `
            <article class="location-card">
              <div class="location-top">
                <span class="location-accent" style="--location-accent:${location.accent}"></span>
                <div>
                  <h3>${escapeHtml(location.name)}</h3>
                  <div class="location-jurisdiction">
                    <span class="binding-badge ${jurisdictionForLocation(location) === "US-FED" ? "regulation" : "state-plan"}">${escapeHtml(jurisdictionLabel(jurisdictionForLocation(location)))}</span>
                    ${statusPill(
                      location.regulatoryProfileStatus === "approved" ? "Jurisdiction approved" : "Jurisdiction review required",
                      location.regulatoryProfileStatus === "approved" ? "green" : "amber"
                    )}
                  </div>
                  <p>${escapeHtml(location.city)} · ${escapeHtml(location.type)}</p>
                </div>
              </div>
              <div class="location-score-grid">
                <div class="location-score"><strong>${location.hasTrainingData ? `${location.training}%` : "—"}</strong><span>Training</span></div>
                <div class="location-score"><strong>${location.hasInspectionData ? `${location.inspections}%` : "—"}</strong><span>Inspections</span></div>
                <div class="location-score"><strong>${location.openActions}</strong><span>Open actions</span></div>
              </div>
              <div class="course-progress">
                <div class="course-progress-header"><span>Readiness</span><strong>${readiness ? `${readiness}%` : "Not measured"}</strong></div>
                <div class="progress"><span style="--progress:${readiness}%;--progress-color:${readiness < 82 ? "var(--red)" : readiness < 90 ? "var(--amber)" : "var(--accent)"}"></span></div>
              </div>
              <div class="card-footer">
                <span class="avatar">${escapeHtml(location.manager.split(" ").map((part) => part[0]).join(""))}</span>
                <small>${escapeHtml(location.manager)} · ${location.people} workers</small>
                <button class="button small" type="button" data-action="select-location" data-location-id="${location.id}">Open</button>
              </div>
            </article>
          `;
        }).join("")}
      </section>
    `;
  }

  function applicableJurisdictions() {
    const jurisdictions = state.locationId === "all"
      ? [...new Set(data.locations.map(jurisdictionForLocation))]
      : [jurisdictionForLocation(activeLocation())];
    const statePlans = jurisdictions
      .filter((jurisdiction) => !["US-FED", "US-FED-OSHA"].includes(jurisdiction))
      .map(planForJurisdiction)
      .filter(Boolean);
    const federal = planForJurisdiction("US-FED");
    if (!statePlans.length) return federal ? [federal] : [];
    return [
      ...statePlans,
      ...(federal ? [{
        ...federal,
        coverage: "Federal baseline and retained-jurisdiction reference; the reviewed state profile remains primary for ordinary covered work.",
        note: "Use the federal layer for cross-reference and documented carve-outs. Do not replace the controlling state rule with federal text."
      }] : [])
    ];
  }

  function standardsForAuthority() {
    const crossJurisdictionSearch = state.locationId === "all"
      && state.standardAuthority === "combined"
      && Boolean(state.standardQuery.trim());
    const jurisdictions = state.locationId === "all"
      ? (crossJurisdictionSearch ? [...new Set(data.locations.map(jurisdictionForLocation))] : [])
      : [jurisdictionForLocation(activeLocation())];
    const stateJurisdictions = jurisdictions.filter((jurisdiction) =>
      !["US-FED", "US-FED-OSHA"].includes(jurisdiction)
    );
    const stateStandards = stateRegulatory.standards
      .filter((standard) => stateJurisdictions.includes(standard.jurisdiction))
      .map((standard) => ({
        ...standard,
        catalogType: "state",
        bindingLevel: standard.bindingLevel || "state-plan"
      }));
    const federalStandards = regulatory.standards.map((standard) => ({
      ...standard,
      catalogType: "federal",
      jurisdiction: standard.jurisdiction || "US-FED"
    }));

    if (state.standardAuthority === "federal") return federalStandards;
    if (state.standardAuthority === "combined") return [...stateStandards, ...federalStandards];
    if (!jurisdictions.length) return [];
    if (jurisdictions.some((jurisdiction) => ["US-FED", "US-FED-OSHA"].includes(jurisdiction))) {
      return [...stateStandards, ...federalStandards];
    }
    return stateStandards.length ? stateStandards : federalStandards;
  }

  const federalManufacturingPriorities = new Map([
    ["1910.212", 10], ["1910.147", 20], ["1910.178", 30], ["1910.242", 35],
    ["1910.243", 36], ["1910.179", 40], ["1910.184", 41], ["1910.95", 50],
    ["1910.252", 60], ["1910.254", 61], ["1910.255", 62], ["1910.94", 65],
    ["1910.1000", 66], ["1910.134", 70], ["1910.1200", 90], ["1910.303", 100],
    ["1910.304", 101], ["1910.305", 102], ["1910.332", 103], ["1910.333", 104],
    ["1910.22", 110], ["1910.28", 111], ["1910.29", 112], ["1910.30", 113],
    ["1910.38", 120], ["1910.39", 121], ["1910.176", 130], ["1910.106", 165],
    ["1910.215", 11], ["1910.217", 12], ["1910.218", 13], ["1910.219", 14],
    ["1904.29", 140], ["1904.32", 141], ["1904.33", 142], ["1904.39", 143],
    ["1904.41", 144], ["osh-act-5-a-1", 170]
  ]);

  function standardScopeCategory(standard) {
    return standard.scopeCategory || standard.scope || "Other";
  }

  function isManufacturingReference(standard) {
    if (standard.catalogType === "state") {
      return (standard.focusTags || []).includes("manufacturing");
    }
    return federalManufacturingPriorities.has(standard.identifier);
  }

  function isPriorityReference(standard) {
    if (isManufacturingReference(standard)) return true;
    return standard.catalogType === "state" && standard.jurisdiction !== "US-OR" && standard.featured;
  }

  function manufacturingPriorityFor(standard) {
    if (Number.isFinite(standard.focusPriority)) return standard.focusPriority;
    return federalManufacturingPriorities.get(standard.identifier) ?? 9999;
  }

  function manufacturingProfileConfirmed(location) {
    if (!location || location.regulatoryProfileStatus !== "approved") return false;
    const naicsConfirmed = location.regulatoryOperationFacts?.industry_and_naics_confirmed === true;
    const manufacturingNaics = (location.regulatoryNaicsCodes || []).some((code) =>
      /^(31|32|33)/.test(String(code).replace(/\D/g, ""))
    );
    return naicsConfirmed && manufacturingNaics;
  }

  function standardGroupOptions(standards) {
    const groups = new Map();
    standards.forEach((standard) => {
      const id = standard.groupCode || standard.part;
      if (!id || groups.has(id)) return;
      groups.set(id, {
        id,
        title: standard.groupTitle || standard.partTitle || "",
        catalogType: standard.catalogType
      });
    });
    return [...groups.values()].sort((a, b) =>
      a.catalogType.localeCompare(b.catalogType) || a.id.localeCompare(b.id, undefined, { numeric: true })
    );
  }

  function filteredStandards() {
    const query = state.standardQuery.trim().toLowerCase();
    return standardsForAuthority().filter((standard) => {
      if (state.standardMode === "manufacturing" && !query && !isPriorityReference(standard)) return false;
      if (state.standardPart !== "all" && (standard.groupCode || standard.part) !== state.standardPart) return false;
      if (state.standardScope !== "all" && standardScopeCategory(standard) !== state.standardScope) return false;
      if (!query) return true;
      const haystack = [
        standard.citation,
        standard.identifier,
        standard.title,
        standard.partTitle,
        standard.subpart,
        standard.subpartTitle,
        standard.groupCode,
        standard.groupTitle,
        standard.authority,
        standard.jurisdiction,
        standard.scope,
        standard.scopeCategory,
        standard.summary,
        standard.authorityType,
        standard.changeNote,
        ...(standard.topics || []),
        ...(standard.focusTags || []),
        ...(standard.workAreas || []),
        ...(standard.equipment || [])
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    }).sort((left, right) => {
      const catalogOrder = (left.catalogType === "state" ? 0 : 1) - (right.catalogType === "state" ? 0 : 1);
      if (catalogOrder) return catalogOrder;
      const priorityOrder = manufacturingPriorityFor(left) - manufacturingPriorityFor(right);
      if (priorityOrder) return priorityOrder;
      return String(left.citation).localeCompare(String(right.citation), undefined, { numeric: true });
    });
  }

  function renderStandards() {
    const results = filteredStandards();
    const visibleResults = results.slice(0, 80);
    const authorityStandards = standardsForAuthority();
    const scopes = [...new Set(authorityStandards.map(standardScopeCategory).filter(Boolean))].sort();
    const groups = standardGroupOptions(authorityStandards);
    const plans = applicableJurisdictions();
    const selectedLocation = activeLocation();
    const selectedJurisdiction = selectedLocation ? jurisdictionForLocation(selectedLocation) : "MULTI";
    const locationLabel = selectedLocation?.name || allLocationsLabel();
    const context = locationRegulatoryContext();
    const stateResultCount = authorityStandards.filter((standard) => standard.catalogType === "state").length;
    const federalResultCount = authorityStandards.filter((standard) => standard.catalogType === "federal").length;
    const stateCheckedOn = selectedJurisdiction === "MULTI"
      ? "see each result"
      : authorityStandards.find((standard) => standard.catalogType === "state")?.checkedOn
        || stateRegulatory.meta.jurisdictionCheckedOn?.[selectedJurisdiction]
        || stateRegulatory.meta.checkedOn;
    const manufacturingResultCount = authorityStandards.filter(isManufacturingReference).length;
    const priorityResultCount = authorityStandards.filter(isPriorityReference).length;
    const profileConfirmed = manufacturingProfileConfirmed(selectedLocation);
    const isOregonContext = selectedJurisdiction === "US-OR";
    const selectedAuthorityLabel = selectedJurisdiction === "MULTI"
      ? "Location-specific state plans"
      : jurisdictionLabel(selectedJurisdiction);
    const requiresLocation = selectedJurisdiction === "MULTI" && state.standardAuthority === "location";
    const crossJurisdictionSearch = selectedJurisdiction === "MULTI"
      && state.standardAuthority === "combined"
      && Boolean(state.standardQuery.trim());
    const priorityModeStem = isOregonContext || state.standardAuthority === "federal"
      ? "manufacturing priorit"
      : "curated priorit";
    const statusTitle = crossJurisdictionSearch
      ? "Cross-jurisdiction research results"
      : requiresLocation
      ? "Choose a location before using state rules"
      : state.standardAuthority === "federal"
        ? "Federal OSHA baseline indexed for comparison"
        : state.standardAuthority === "combined"
          ? `${selectedAuthorityLabel} and federal baseline shown together`
          : `${selectedAuthorityLabel} is primary for this location`;
    const statusDetail = crossJurisdictionSearch
      ? "Results retain their Oregon, Washington, California, or federal label. Select a location before treating any state rule as primary."
      : requiresLocation
      ? "The company spans Oregon, Washington, and California; a blended list cannot identify a controlling state authority."
      : state.standardAuthority === "federal"
        ? `eCFR Title 29, Chapter XVII is current through ${regulatory.meta.currentThrough || "unavailable"}.`
        : `${stateResultCount} curated ${selectedAuthorityLabel} reference records link to official sources checked ${stateCheckedOn || "not recorded"}; the catalog is not complete.`;
    const priorityTopics = [
      ["Machine guarding", "machine guarding"],
      ["Lockout/tagout", "lockout tagout"],
      ["Forklifts", "forklift"],
      ["Cranes & slings", "crane"],
      ["Noise", "noise"],
      ["Welding & hot work", "welding"],
      ["Respiratory", "respiratory"],
      ["PPE", "PPE"],
      ["HazCom & SDS", "hazard communication"],
      ["Electrical", "electrical"],
      ["Walking surfaces", "walking-working surfaces"],
      ["Emergency & fire", "emergency action plan"]
    ];

    return `
      ${renderPageHeading()}

      <section class="standards-status" aria-label="OSHA source status">
        <div>
          <span class="status-dot" aria-hidden="true"></span>
          <div>
            <strong>${escapeHtml(statusTitle)}</strong>
            <span>${escapeHtml(statusDetail)}</span>
          </div>
        </div>
        <span class="binding-badge ${state.standardAuthority === "federal" ? "regulation" : "state-plan"}">${requiresLocation ? "Location required" : `${state.standardMode === "manufacturing" ? priorityResultCount : authorityStandards.length.toLocaleString()} indexed`}</span>
      </section>

      <div class="trace-banner">
        <span class="trace-label">Reference guide</span>
        <div>
          <strong>${escapeHtml(stateRegulatory.meta.completenessNotice || "Use this library to research and trace controls—not to make an automatic compliance determination.")}</strong>
          <p>${isOregonContext ? "Oregon OSHA Division 2 is the primary general-industry source for this Oregon location. Federal citations are shown as adopted-source context, not as a substitute for the current Oregon rule." : "For Oregon, Washington, and California locations, the selected state program is primary. Federal OSHA remains a baseline and retained-jurisdiction reference."}</p>
        </div>
      </div>

      ${isOregonContext ? `
        <section class="manufacturing-focus-card" aria-labelledby="oregon-manufacturing-title">
          <div class="manufacturing-focus-header">
            <div>
              <p class="section-kicker">Manufacturing priorities</p>
              <h2 id="oregon-manufacturing-title">Oregon OSHA · Division 2 general industry</h2>
              <p>Ordered for metal-manufacturing work such as forming, shearing, press braking, welding, finishing, material handling, and machine servicing. Ordering is a research aid—not an applicability decision.</p>
            </div>
            ${statusPill(profileConfirmed ? "Manufacturing profile reviewed" : "Industry profile review required", profileConfirmed ? "green" : "amber")}
          </div>
          <div class="context-chip-row" aria-label="Oregon guide context">
            <span>Oregon OSHA primary</span>
            <span>General industry · Division 2</span>
            <span>Manufacturing focus</span>
            <span>Official links checked ${escapeHtml(stateRegulatory.meta.checkedOn || "2026-08-06")}</span>
          </div>
          <div class="manufacturing-topic-grid" aria-label="Priority manufacturing topics">
            ${priorityTopics.map(([label, query]) => `<button type="button" data-action="standards-topic" data-query="${escapeHtml(query)}">${escapeHtml(label)}</button>`).join("")}
          </div>
          <a href="https://osha.oregon.gov/rules/final/pages/division-2.aspx" target="_blank" rel="noopener noreferrer">Open the complete official Oregon OSHA Division 2 rulebook</a>
          <a href="https://osha.oregon.gov/OSHARules/pd/pd-278.pdf" target="_blank" rel="noopener noreferrer">Open Oregon's metal-fabrication hazard profile (official guidance)</a>
        </section>
      ` : requiresLocation ? `
        <section class="manufacturing-focus-card location-required-card">
          <div>
            <p class="section-kicker">Location required</p>
            <h2>Choose an Oregon location for the Oregon manufacturing guide</h2>
            <p>The all-location view is a jurisdiction rollup. Select a specific location before treating any state plan as primary.</p>
          </div>
        </section>
      ` : ""}

      <section class="split-summary" aria-label="Regulatory library metrics">
        <article class="summary-card"><span>Curated state references</span><strong>${stateResultCount.toLocaleString()}</strong></article>
        <article class="summary-card"><span>${isOregonContext || state.standardAuthority === "federal" ? "Manufacturing priorities" : "Curated priority references"}</span><strong>${(isOregonContext || state.standardAuthority === "federal" ? manufacturingResultCount : priorityResultCount).toLocaleString()}</strong></article>
        <article class="summary-card"><span>Federal baseline in this view</span><strong>${federalResultCount.toLocaleString()}</strong></article>
        <article class="summary-card"><span>Reviewed control links</span><strong>${regulatory.regulatoryLinks.length}</strong></article>
      </section>

      <section class="jurisdiction-banner">
        <div class="card-header">
          <div>
            <p class="section-kicker">Location-aware authority</p>
            <h2>${escapeHtml(locationLabel)}</h2>
            <p>State-plan rules can be stricter or materially different from the federal baseline. Applicability requires a reviewed location profile.</p>
          </div>
          ${statusPill(
            context.profileStatus === "approved" ? "Jurisdiction approved" : "Jurisdiction review required",
            context.profileStatus === "approved" ? "green" : "amber"
          )}
        </div>
        <div class="jurisdiction-grid">
          ${plans.map((plan) => `
            <article class="jurisdiction-card">
              <div>
                <span class="binding-badge ${["US-FED", "US-FED-OSHA"].includes(plan.jurisdiction) ? "regulation" : "state-plan"}">${escapeHtml(plan.jurisdiction)}</span>
                <h3>${escapeHtml(plan.name)}</h3>
                <p>${escapeHtml(plan.coverage)}</p>
              </div>
              <p>${escapeHtml(plan.note)}</p>
              <div class="jurisdiction-links">
                <a href="${escapeHtml(plan.officialUrl)}" target="_blank" rel="noopener noreferrer">Official rules</a>
                ${plan.legalCodeUrl ? `<a href="${escapeHtml(plan.legalCodeUrl)}" target="_blank" rel="noopener noreferrer">Legal code</a>` : ""}
                ${plan.statePlanUrl ? `<a href="${escapeHtml(plan.statePlanUrl)}" target="_blank" rel="noopener noreferrer">Coverage</a>` : ""}
                ${plan.changeWatchUrl ? `<a href="${escapeHtml(plan.changeWatchUrl)}" target="_blank" rel="noopener noreferrer">Rule changes</a>` : ""}
              </div>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="standards-filter-card">
        <div class="authority-switch">
          <div>
            <strong>Authority shown</strong>
            <span>Location rules are primary; use the other views for federal research and cross-reference.</span>
          </div>
          <div class="tabs" role="tablist" aria-label="Regulatory authority view">
            <button class="tab ${state.standardAuthority === "location" ? "active" : ""}" type="button" role="tab" aria-selected="${state.standardAuthority === "location"}" data-action="standards-authority" data-authority="location" ${selectedJurisdiction === "MULTI" ? "disabled" : ""}>${isOregonContext ? "Oregon rules" : "Location rules"}</button>
            <button class="tab ${state.standardAuthority === "federal" ? "active" : ""}" type="button" role="tab" aria-selected="${state.standardAuthority === "federal"}" data-action="standards-authority" data-authority="federal">Federal baseline</button>
            <button class="tab ${state.standardAuthority === "combined" ? "active" : ""}" type="button" role="tab" aria-selected="${state.standardAuthority === "combined"}" data-action="standards-authority" data-authority="combined" ${selectedJurisdiction === "MULTI" ? "disabled" : ""}>Combined</button>
          </div>
        </div>
        <form id="standards-filter-form">
          <div class="standards-filters">
            <div class="field standards-search-field">
              <label for="standards-query">Search citations, titles, topics, and summaries</label>
              <input id="standards-query" name="query" type="search" value="${escapeHtml(state.standardQuery)}" placeholder="Try press brake, shear, roll former, forklift, manganese…">
            </div>
            <div class="field">
              <label for="standards-part">Rule group</label>
              <select id="standards-part" name="part">
                <option value="all">All rule groups</option>
                ${groups.map((group) => `
                  <option value="${escapeHtml(group.id)}" ${state.standardPart === group.id ? "selected" : ""}>${group.catalogType === "federal" ? "Federal" : "State"} · ${escapeHtml(group.id)}${group.title ? ` · ${escapeHtml(group.title)}` : ""}</option>
                `).join("")}
              </select>
            </div>
            <div class="field">
              <label for="standards-scope">Scope</label>
              <select id="standards-scope" name="scope">
                <option value="all">All scopes</option>
                ${scopes.map((scope) => `<option value="${escapeHtml(scope)}" ${state.standardScope === scope ? "selected" : ""}>${escapeHtml(scope)}</option>`).join("")}
              </select>
            </div>
            <button class="button primary standards-search-button" type="submit">Search guide</button>
          </div>
          <div class="tabs" role="tablist" aria-label="Reference result mode">
            <button class="tab ${state.standardMode === "manufacturing" ? "active" : ""}" type="button" role="tab" aria-selected="${state.standardMode === "manufacturing"}" data-action="standards-mode" data-mode="manufacturing">${isOregonContext || state.standardAuthority === "federal" ? "Manufacturing priorities" : "Curated priorities"}</button>
            <button class="tab ${state.standardMode === "all" ? "active" : ""}" type="button" role="tab" aria-selected="${state.standardMode === "all"}" data-action="standards-mode" data-mode="all">${state.standardAuthority === "federal" ? "Entire federal chapter" : isOregonContext ? "All indexed Oregon sources" : "All indexed state sources"}</button>
          </div>
        </form>
      </section>

      <section class="standards-layout">
        <div class="standards-results">
          <div class="table-header">
            <div>
              <h2>${results.length.toLocaleString()} ${state.standardMode === "manufacturing" && !state.standardQuery.trim() ? priorityModeStem : "matching provision"}${results.length === 1 ? (state.standardMode === "manufacturing" && !state.standardQuery.trim() ? "y" : "") : (state.standardMode === "manufacturing" && !state.standardQuery.trim() ? "ies" : "s")}</h2>
              <p>${results.length > visibleResults.length ? `Showing the first ${visibleResults.length.toLocaleString()}; refine the search to narrow the corpus.` : results.length ? "Every result links back to an official source; manufacturing order does not establish applicability." : "Choose a location or broaden the filters."}</p>
            </div>
          </div>
          <div class="standard-result-list">
            ${visibleResults.length ? visibleResults.map((standard) => `
              <article class="standard-result-card">
                <div class="standard-result-top">
                  <div>
                    <div class="standard-meta">
                      <span class="binding-badge ${escapeHtml(standard.bindingLevel)}">${escapeHtml(standard.bindingLevel)}</span>
                      <span class="binding-badge ${standard.catalogType === "state" ? "state-plan" : "regulation"}">${escapeHtml(standard.jurisdiction || "US-FED")}</span>
                      <span>${escapeHtml(standardScopeCategory(standard))}</span>
                      ${standard.subpart ? `<span>Subpart ${escapeHtml(standard.subpart)}</span>` : ""}
                    </div>
                    <h3>${escapeHtml(standard.citation)}</h3>
                    <p class="standard-title">${escapeHtml(standard.title)}</p>
                  </div>
                  ${isManufacturingReference(standard)
                    ? `<span class="status-pill purple">Manufacturing priority</span>`
                    : isPriorityReference(standard)
                      ? `<span class="status-pill blue">Curated priority</span>`
                      : ""}
                </div>
                <p>${escapeHtml(standard.summary || standard.partTitle || "Official provision indexed from the eCFR structure.")}</p>
                ${standard.catalogType === "state" ? `
                  <div class="standard-context-row">
                    <span>${escapeHtml(standard.authorityType || "State-plan reference")}</span>
                    <span>Candidate · applicability review required</span>
                    ${(standard.workAreas || []).slice(0, 3).map((area) => `<span>${escapeHtml(area)}</span>`).join("")}
                  </div>
                ` : ""}
                <div class="standard-card-footer">
                  <span>${standard.catalogType === "state"
                    ? `Official state source checked ${escapeHtml(standard.checkedOn || stateRegulatory.meta.checkedOn || "not recorded")} · source snapshot pending`
                    : `Federal baseline current through ${escapeHtml(standard.currentThrough || regulatory.meta.currentThrough)}`}</span>
                  <div>
                    <a class="button small" href="${escapeHtml(standard.officialUrl)}" target="_blank" rel="noopener noreferrer">Official text</a>
                    <button class="button small primary" type="button" data-action="open-reference" data-reference-id="${standard.id}">View trace</button>
                  </div>
                </div>
              </article>
            `).join("") : renderEmptyState("§", requiresLocation ? "Choose a location" : "No standards found", requiresLocation ? "State-plan authority is location-specific. Use the location control above to open the Oregon, Washington, or California guide." : "Try a broader citation, topic, part, or scope.")}
          </div>
        </div>

        <aside class="standard-detail-card">
          <p class="section-kicker">Provenance model</p>
          <h2>What the trace preserves</h2>
          <ol class="trace-chain">
            <li>Submitted answer or completion record</li>
            <li>Immutable form, course, or document version</li>
            <li>Reviewed control-to-requirement mapping</li>
            <li>Exact paragraph version and jurisdiction</li>
            <li>Raw official source snapshot and SHA-256</li>
            <li>Retrieval, effective, review, and change history</li>
          </ol>
          ${stateResultCount ? `
            <div class="source-fingerprint compact pending">
              <strong>State source snapshots</strong>
              <code>Pending server-side ingestion</code>
              <span>Official links checked ${escapeHtml(stateCheckedOn || "not recorded")} · human crosswalk required</span>
            </div>
          ` : ""}
          <div class="source-fingerprint compact">
            <strong>Federal structure fingerprint</strong>
            <code>${escapeHtml(regulatory.meta.structureSha256 || "Pending")}</code>
            <span>Generated ${escapeHtml(regulatory.meta.generatedAt || "Not recorded")}</span>
          </div>
          <p>State changes enter a human impact-review queue before any form, training, or applicability rule changes. Published versions and historical evidence are never silently rewritten.</p>
          <a href="https://www.ecfr.gov/reader-aids/understanding-the-ecfr" target="_blank" rel="noopener noreferrer">How the eCFR works</a>
        </aside>
      </section>
    `;
  }

  function renderSettings() {
    return `
      ${renderPageHeading()}
      <section class="settings-grid">
        <article class="settings-card">
          <p class="section-kicker">Data & identity</p>
          <h3>Supabase connection</h3>
          <p>The production app will use Supabase Auth, Postgres, Row Level Security, private Storage, and Edge Functions for privileged jobs.</p>
          <div class="setting-row">
            <div><strong>Browser client</strong><span>${supabaseClient ? "Configured with a publishable key" : "Connection required · add project URL and publishable key"}</span></div>
            ${statusPill(supabaseClient ? "Ready" : "Not configured", supabaseClient ? "green" : "amber")}
          </div>
          <div class="setting-row">
            <div><strong>Service-role secret</strong><span>Server-side only; never available to GitHub Pages</span></div>
            ${statusPill("Protected", "green")}
          </div>
          <div class="setting-row">
            <div><strong>Company isolation</strong><span>Enforced by company_id and database policies</span></div>
            ${statusPill("Designed", "blue")}
          </div>
        </article>
        <article class="settings-card">
          <p class="section-kicker">Preferences</p>
          <h3>Workspace behavior</h3>
          <p>These planned per-user controls are not persisted yet. Durable business data never uses browser storage as its source of truth.</p>
          <div class="setting-row">
            <div><strong>Dark theme</strong><span>Device-local display preference</span></div>
            <button class="switch ${state.theme === "dark" ? "on" : ""}" type="button" data-action="toggle-theme" aria-label="Toggle dark theme"></button>
          </div>
          <div class="setting-row">
            <div><strong>Daily digest</strong><span>Overdue work and expiring credentials</span></div>
            <button class="switch on" type="button" data-action="prototype-action" data-message="Notification preferences will be saved per user in Supabase."></button>
          </div>
          <div class="setting-row">
            <div><strong>Require photo on failed inspection</strong><span>Company-wide inspection rule</span></div>
            <button class="switch on" type="button" data-action="prototype-action" data-message="This will become a versioned organization policy."></button>
          </div>
        </article>
        <article class="settings-card">
          <p class="section-kicker">Roles</p>
          <h3>Permission model</h3>
          <p>Corporate administrators can work across all locations. Location managers and supervisors are limited to assigned sites. Workers can complete assigned work and access explicitly shared resources.</p>
          <div class="setting-row"><div><strong>Corporate admin</strong><span>Organization configuration and all locations</span></div>${statusPill("Full", "purple")}</div>
          <div class="setting-row"><div><strong>Safety manager</strong><span>Programs, reporting, incidents, and all locations</span></div>${statusPill("Manage", "blue")}</div>
          <div class="setting-row"><div><strong>Location manager</strong><span>Assigned locations and local workforce</span></div>${statusPill("Scoped", "amber")}</div>
          <div class="setting-row"><div><strong>Worker</strong><span>Own assignments, reports, and shared resources</span></div>${statusPill("Limited", "green")}</div>
        </article>
        <article class="settings-card">
          <p class="section-kicker">Delivery</p>
          <h3>GitHub Pages deployment</h3>
          <p>The application shell remains portable and static. GitHub hosts only public assets; Supabase owns authenticated records, authorization, private files, and server-side secrets.</p>
          <div class="setting-row"><div><strong>Static application</strong><span>HTML, CSS, and modular browser JavaScript</span></div>${statusPill("Ready", "green")}</div>
          <div class="setting-row"><div><strong>Release gate</strong><span>Smoke, accessibility, and security checks before publish</span></div>${statusPill("Prepared", "blue")}</div>
          <div class="setting-row"><div><strong>Offline queue</strong><span>Planned as a first-class field requirement</span></div>${statusPill("Next", "amber")}</div>
        </article>
      </section>
    `;
  }

  function buildSearchResults(query) {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const results = [];
    const sources = [
      { type: "Location", rows: data.locations, fields: ["name", "city", "type"], view: "locations" },
      { type: "Person", rows: data.people, fields: ["name", "role", "status"], view: "people" },
      { type: "Inspection template", rows: data.inspectionTemplates, fields: ["name", "category"], view: "inspections" },
      { type: "Training", rows: data.courses, fields: ["name", "category", "format"], view: "training" },
      { type: "Incident", rows: data.incidents, fields: ["title", "type", "severity", "status"], view: "incidents" },
      { type: "Corrective action", rows: data.actions, fields: ["title", "source", "owner", "status"], view: "actions" },
      { type: "Document", rows: data.documents, fields: ["name", "type", "owner", "status"], view: "documents" },
      { type: "Safety program", rows: programLibrary.programs || [], fields: ["title", "sourceName", "description", "topics", "citations"], view: "programs" },
      { type: "Digital form", rows: programLibrary.forms || [], fields: ["title", "sourceName", "category", "citations"], view: "programs" },
      { type: "Source folder", rows: programLibrary.folders || [], fields: ["title", "category", "children", "language"], view: "programs" },
      { type: "OSHA standard", rows: allStandards(), fields: ["citation", "identifier", "title", "partTitle", "groupCode", "authority", "jurisdiction", "scope", "summary", "topics"], view: "standards" }
    ];
    sources.forEach((sourceGroup) => {
      sourceGroup.rows.forEach((record) => {
        const haystack = sourceGroup.fields
          .flatMap((field) => Array.isArray(record[field]) ? record[field] : [record[field]])
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (haystack.includes(term)) {
          results.push({
            type: sourceGroup.type,
            title: record.name || record.title,
            meta: record.citation || record.city || record.role || record.category || record.type || record.owner || record.status || record.sourceName,
            view: sourceGroup.view
          });
        }
      });
    });
    return results.slice(0, 120);
  }

  function renderSearch() {
    const results = buildSearchResults(state.searchQuery);
    return `
      ${renderPageHeading("search")}
      <article class="card">
        <div class="card-header">
          <div>
            <h2>${results.length} result${results.length === 1 ? "" : "s"} for “${escapeHtml(state.searchQuery)}”</h2>
            <p>Results are grouped across operations records, company safety sources, and the OSHA reference corpus</p>
          </div>
        </div>
        ${results.length ? `
          <div class="task-list">
            ${results.map((result) => `
              <button class="task-row" style="width:100%;text-align:left" type="button" data-action="navigate" data-view="${result.view}">
                <span class="type-icon">${escapeHtml(result.type.slice(0, 1))}</span>
                <span>
                  <span class="task-title">${escapeHtml(result.title)}</span>
                  <span class="task-meta"><span>${escapeHtml(result.type)}</span><span>${escapeHtml(result.meta)}</span></span>
                </span>
                <span class="task-side"><span class="task-due">Open →</span></span>
              </button>
            `).join("")}
          </div>
        ` : renderEmptyState("⌕", "No results found", "Try a location, person, form, course, document, OSHA citation, or safety topic.")}
      </article>
    `;
  }

  function renderEmptyState(icon, title, text) {
    return `
      <div class="empty-state">
        <span class="empty-state-icon" aria-hidden="true">${icon}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
      </div>
    `;
  }

  function renderCurrentView() {
    const views = {
      dashboard: renderDashboard,
      "my-work": renderMyWork,
      inspections: renderInspections,
      committee: renderCommittee,
      training: renderTraining,
      incidents: renderIncidents,
      actions: renderActions,
      programs: renderPrograms,
      standards: renderStandards,
      documents: renderDocuments,
      people: renderPeople,
      locations: renderLocations,
      settings: renderSettings,
      search: renderSearch
    };
    return (views[state.view] || renderDashboard)();
  }

  function renderLocationAccessNotice() {
    if (data.locations.length) return "";
    const administrator = canManageCompany();
    return `
      <section class="trace-banner" aria-live="polite">
        <span class="trace-label">${administrator ? "Setup required" : "Access required"}</span>
        <div>
          <strong>${administrator ? "Create an active company location" : "No active location is assigned to your account"}</strong>
          <p>${administrator
            ? "Operational records require a location so jurisdiction, access, and evidence can be pinned correctly."
            : "A company administrator must assign you to an active location before you can report incidents, run inspections, or complete location-scoped work."}</p>
          ${administrator ? `<button class="button small primary" type="button" data-action="navigate" data-view="locations">Open locations</button>` : ""}
        </div>
      </section>
    `;
  }

  function inspectionQuestionsFor(templateId) {
    const template = data.inspectionTemplates.find((item) => item.id === templateId);
    return (template?.questionDefinitions || [])
      .map((question, index) => ({
        key: String(question.key || question.id || question.name || `q${index}`),
        prompt: question.prompt || question.label || question.title || "",
        requirementIds: question.requirementIds || question.regulatoryRequirementIds || []
      }))
      .filter((question) => question.key && question.prompt);
  }

  function renderInspectionModal() {
    const selectedTemplate = data.inspectionTemplates.find((template) => template.id === state.selectedTemplateId) || data.inspectionTemplates[0];
    const selectedLocationId = state.locationId === "all" ? data.locations[0].id : state.locationId;
    const selectedContext = locationRegulatoryContext(selectedLocationId);
    const questions = inspectionQuestionsFor(selectedTemplate.id);
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="inspection-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Field form</p>
              <h2 id="inspection-title">Start an inspection</h2>
              <p>Responses create a signed, versioned submission snapshot.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button>
          </header>
          <form id="inspection-form">
            <div class="modal-body">
              <div class="form-grid">
                <div class="field">
                  <label for="inspection-template-name">Pinned template version</label>
                  <input type="hidden" name="template_id" value="${escapeHtml(selectedTemplate.id)}">
                  <input id="inspection-template-name" value="${escapeHtml(selectedTemplate.name)} · version ${escapeHtml(selectedTemplate.currentVersion)}" readonly>
                </div>
                <div class="field">
                  <label for="inspection-location">Location</label>
                  <select id="inspection-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select>
                </div>
                <div class="field full">
                  <label for="inspection-area">Area or equipment</label>
                  <input id="inspection-area" name="area" placeholder="Example: Shipping dock / Forklift 07" required>
                </div>
              </div>
              <div style="height:18px"></div>
              <div class="trace-banner">
                <span class="trace-label">Template trace</span>
                <div>
                  <strong>Version ${escapeHtml(selectedTemplate.currentVersion || 1)} · ${escapeHtml(selectedContext.jurisdictionName)} primary · federal baseline ${escapeHtml(regulatory.meta.currentThrough || "not recorded")}</strong>
                  <p>The signed submission will preserve the location profile, jurisdiction, question wording, mapping version, citation, and available source fingerprints used at submission time. ${selectedContext.profileStatus === "approved" ? "" : "Jurisdiction review is still required."}</p>
                  ${renderStateInspectionChips(selectedTemplate.id, selectedContext.jurisdiction)}
                  ${renderCitationChips("inspection_template", selectedTemplate.id, 3)}
                  ${selectedTemplate.id === "tpl-eyewash" ? `<small>The weekly schedule is a company control; 29 CFR 1910.151(c) addresses suitable flushing facilities and does not itself set that weekly activation frequency.</small>` : ""}
                </div>
              </div>
              <div style="height:18px"></div>
              <div class="checklist">
                ${questions.map((question, index) => `
                  <fieldset class="check-item field">
                    <legend class="check-item-title">${index + 1}. ${escapeHtml(question.prompt)}</legend>
                    ${renderRequirementChips(question.requirementIds, "Question basis")}
                    <div class="choice-grid">
                      <div class="choice"><input id="q${index}-pass" type="radio" name="q${index}" value="pass" required><label for="q${index}-pass">Pass</label></div>
                      <div class="choice fail"><input id="q${index}-fail" type="radio" name="q${index}" value="fail"><label for="q${index}-fail">Fail</label></div>
                      <div class="choice"><input id="q${index}-na" type="radio" name="q${index}" value="na"><label for="q${index}-na">N/A</label></div>
                    </div>
                  </fieldset>
                `).join("")}
              </div>
              <div style="height:14px"></div>
              <div class="field">
                <label for="inspection-notes">Notes</label>
                <textarea id="inspection-notes" name="notes" placeholder="Add context, corrective steps, or evidence notes"></textarea>
              </div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit">Sign & submit</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderIncidentModal() {
    const selectedLocationId = state.locationId === "all" ? data.locations[0].id : state.locationId;
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="incident-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Fast report</p>
              <h2 id="incident-title">Report an incident or near miss</h2>
              <p>Capture the first report now; investigation details can follow.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button>
          </header>
          <form id="incident-form">
            <div class="modal-body">
              <div class="form-grid">
                <div class="field">
                  <label for="incident-location">Location</label>
                  <select id="incident-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select>
                </div>
                <div class="field">
                  <label for="incident-type">Report type</label>
                  <select id="incident-type" name="type" required>
                    <option>Near miss</option>
                    <option>First aid</option>
                    <option>Injury / illness</option>
                    <option>Property damage</option>
                    <option>Environmental</option>
                  </select>
                </div>
                <div class="field">
                  <label for="incident-severity">Potential severity</label>
                  <select id="incident-severity" name="severity" required>
                    <option>Low</option>
                    <option selected>Medium</option>
                    <option>High</option>
                    <option>Critical</option>
                  </select>
                </div>
                <div class="field">
                  <label for="incident-date">Date</label>
                  <input id="incident-date" type="date" name="date" value="${isoDateOffset()}" required>
                </div>
                <div class="field full">
                  <label for="incident-title-input">What happened?</label>
                  <input id="incident-title-input" name="title" minlength="3" maxlength="240" placeholder="Short, factual title" required>
                </div>
                <div class="field full">
                  <label for="incident-description">Initial description</label>
                  <textarea id="incident-description" name="description" placeholder="Describe what was observed, immediate controls, and people involved" required></textarea>
                </div>
              </div>
              <div style="height:14px"></div>
              <div class="prototype-note"><strong>Next</strong><span>After submission, the assigned manager receives an investigation task. High-potential events trigger immediate notification and evidence preservation.</span></div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit">Submit report</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderTrainingModal() {
    const selectedCourseId = state.modalContext.courseId || state.selectedTemplateId;
    const selectedCourse = data.courses.find((course) => course.id === selectedCourseId) || data.courses[0];
    const selectedPerson = data.people.find((person) => person.id === state.modalContext.employeeId);
    const selectedLocationId = selectedPerson?.locationId
      || (state.locationId === "all" ? data.locations[0]?.id : state.locationId);
    const eligiblePeople = data.people.filter((person) =>
      person.locationIds?.includes(selectedLocationId) && person.employmentStatus !== "Separated"
    );
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="training-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Training assignment</p>
              <h2 id="training-title">Assign required training</h2>
              <p>Assign one employee or the authorized roster at a location, with renewal and retention rules.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button>
          </header>
          <form id="training-form">
            <div class="modal-body">
              <div class="form-grid">
                <div class="field full">
                  <label for="course-select">Course</label>
                  <select id="course-select" name="course_id" required>
                    ${data.courses.map((course) => `<option value="${course.id}" ${course.id === selectedCourse.id ? "selected" : ""}>${escapeHtml(course.name)} · ${escapeHtml(course.duration)}</option>`).join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="training-location">Location</label>
                  <select id="training-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select>
                </div>
                <div class="field">
                  <label for="training-employee">Employee(s)</label>
                  <select id="training-employee" name="employee_id" required>
                    <option value="all" ${selectedPerson ? "" : "selected"}>All employees at this location</option>
                    ${eligiblePeople.map((person) => `<option value="${person.id}" ${person.id === selectedPerson?.id ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="training-due">Due date</label>
                  <input id="training-due" type="date" name="due_date" value="${isoDateOffset(16)}" required>
                </div>
                <div class="field">
                  <label for="training-cadence">Renewal cadence (months)</label>
                  <input id="training-cadence" type="number" min="1" max="240" name="cadence_months" value="${escapeHtml(selectedCourse.validityMonths || "")}" placeholder="Leave blank if no renewal">
                </div>
                <div class="field">
                  <label for="training-retention">Retention (months)</label>
                  <input id="training-retention" type="number" min="1" max="1200" name="retention_months" value="${escapeHtml(selectedCourse.retentionMonths || "")}" placeholder="Leave blank for policy review">
                </div>
                <div class="field full">
                  <label for="training-reason">Requirement reason</label>
                  <input id="training-reason" name="reason" value="Company safety requirement" maxlength="500" required>
                </div>
                <div class="field full">
                  <label for="training-regulatory-basis">Regulatory / policy basis (one source per line)</label>
                  <textarea id="training-regulatory-basis" name="regulatory_basis" maxlength="8000" placeholder="Oregon OSHA 437-002-0227&#10;Company Powered Industrial Truck Program § 4.2"></textarea>
                  <span class="field-hint">Manual citations are retained as traceable inputs and marked for review until a safety administrator verifies the source.</span>
                </div>
              </div>
              <div style="height:14px"></div>
              <div class="prototype-note"><strong>Retention trace</strong><span>Leave retention blank when the governing company or regulatory policy has not been reviewed. SafetyOps will display Policy review required instead of inventing a universal OSHA period.</span></div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit">Assign training</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderActionModal() {
    const sourceMeeting = data.committeeMeetings.find((meeting) =>
      meeting.id === state.modalContext.meetingId
    );
    const selectedLocationId = sourceMeeting?.locationId
      || (state.locationId === "all" ? data.locations[0].id : state.locationId);
    const eligibleOwners = data.people.filter((person) =>
      person.locationIds?.includes(selectedLocationId)
    );
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="action-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Follow-up</p>
              <h2 id="action-title">Create a corrective action</h2>
              <p>Assign an owner, due date, priority, and required closeout evidence.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button>
          </header>
          <form id="action-form">
            <div class="modal-body">
              <div class="form-grid">
                <input type="hidden" name="committee_meeting_id" value="${escapeHtml(sourceMeeting?.id || "")}">
                ${sourceMeeting ? `<div class="field full"><label>Source meeting</label><input value="${escapeHtml(sourceMeeting.title)} · ${escapeHtml(sourceMeeting.date)}" readonly></div>` : ""}
                <div class="field full"><label for="action-name">Action</label><input id="action-name" name="title" minlength="3" maxlength="240" required placeholder="Describe the required correction"></div>
                <div class="field full"><label for="action-description">Details</label><textarea id="action-description" name="description" placeholder="Record the committee decision, expected outcome, or completion criteria"></textarea></div>
                <div class="field"><label for="action-location">Location</label><select id="action-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select></div>
                <div class="field"><label for="action-owner">Owner</label><select id="action-owner" name="owner_id" ${eligibleOwners.length ? "" : "disabled"} required>${eligibleOwners.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("")}</select></div>
                <div class="field"><label for="action-priority">Priority</label><select id="action-priority" name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Critical</option></select></div>
                <div class="field"><label for="action-due">Due date</label><input id="action-due" type="date" name="due_date" value="${isoDateOffset(7)}" required></div>
                <div class="field full"><label for="action-evidence">Closeout evidence</label><select id="action-evidence" name="evidence"><option>Photo and note</option><option>Manager verification</option><option>Document upload</option><option>No evidence required</option></select></div>
              </div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit" ${eligibleOwners.length ? "" : "disabled"}>Create action</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderCommitteeModal() {
    const selectedLocationId = state.locationId === "all" ? data.locations[0]?.id : state.locationId;
    const eligiblePeople = data.people.filter((person) =>
      person.locationIds?.includes(selectedLocationId) && person.employmentStatus !== "Separated"
    );
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="committee-modal-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Safety committee record</p>
              <h2 id="committee-modal-title">Record committee meeting</h2>
              <p>Capture attendance, notes, decisions, and then assign accountable follow-up work.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button>
          </header>
          <form id="committee-form">
            <div class="modal-body">
              <div class="form-grid">
                <div class="field full"><label for="committee-title">Meeting title</label><input id="committee-title" name="title" minlength="3" maxlength="220" required placeholder="Monthly safety committee meeting"></div>
                <div class="field"><label for="committee-date">Meeting date</label><input id="committee-date" type="date" name="meeting_date" value="${isoDateOffset()}" required></div>
                <div class="field"><label for="committee-location">Location</label><select id="committee-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select></div>
                <div class="field"><label for="committee-chair">Chair</label><select id="committee-chair" name="chair_employee_id" required>${eligiblePeople.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")}</select></div>
                <div class="field"><label for="committee-attendees">Attendees</label><select id="committee-attendees" name="attendee_ids" multiple size="5" required>${eligiblePeople.map((person) => `<option value="${person.id}" selected>${escapeHtml(person.name)}</option>`).join("")}</select></div>
                <div class="field full"><label for="committee-agenda">Agenda</label><textarea id="committee-agenda" name="agenda" placeholder="Topics reviewed"></textarea></div>
                <div class="field full"><label for="committee-notes">Meeting notes</label><textarea id="committee-notes" name="notes" minlength="3" required placeholder="Discussion, observations, and employee input"></textarea></div>
                <div class="field full"><label for="committee-decisions">Decisions</label><textarea id="committee-decisions" name="decisions" placeholder="Decisions made and controls approved"></textarea></div>
              </div>
              <div class="prototype-note"><strong>Traceable follow-up</strong><span>Save the minutes first, add action items with an employee owner and due date, then finalize the meeting to freeze a SHA-256 minutes manifest.</span></div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit" ${eligiblePeople.length ? "" : "disabled"}>Save meeting notes</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderEmployeeModal() {
    const selectedLocationId = state.locationId === "all" ? data.locations[0]?.id : state.locationId;
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="employee-modal-title">
          <header class="modal-header">
            <div><p class="section-kicker">Workforce record</p><h2 id="employee-modal-title">Add employee</h2><p>Create a safety record now; a login account is optional.</p></div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button>
          </header>
          <form id="employee-form">
            <div class="modal-body">
              <div class="form-grid">
                <div class="field full"><label for="employee-full-name">Employee name</label><input id="employee-full-name" name="full_name" minlength="2" maxlength="160" autocomplete="name" required></div>
                <div class="field"><label for="employee-number">Employee number</label><input id="employee-number" name="employee_number" maxlength="80"></div>
                <div class="field"><label for="employee-email">Work email</label><input id="employee-email" name="work_email" type="email" autocomplete="email"></div>
                <div class="field"><label for="employee-title">Job title</label><input id="employee-title" name="job_title" maxlength="160"></div>
                <div class="field"><label for="employee-department">Department</label><input id="employee-department" name="department" maxlength="160"></div>
                <div class="field full"><label for="employee-location">Primary location</label><select id="employee-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select></div>
              </div>
              <div class="prototype-note"><strong>No employee account required</strong><span>The safety user can assign training, upload signed records, and facilitate an in-person tablet acknowledgement for this employee.</span></div>
            </div>
            <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Add employee</button></footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderTrainingCompletionModal() {
    const assignment = data.trainingAssignments.find((item) =>
      item.id === state.modalContext.assignmentId
    );
    if (!assignment) return "";
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="training-completion-title">
          <header class="modal-header"><div><p class="section-kicker">Retention evidence</p><h2 id="training-completion-title">Record training completion</h2><p>${escapeHtml(assignment.employee)} · ${escapeHtml(assignment.course)}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button></header>
          <form id="training-completion-form">
            <input type="hidden" name="assignment_id" value="${assignment.id}">
            <div class="modal-body"><div class="form-grid">
              <div class="field"><label for="training-completed-date">Completed date</label><input id="training-completed-date" name="completed_date" type="date" value="${isoDateOffset()}" required></div>
              <div class="field"><label for="training-completion-method">Completion method</label><select id="training-completion-method" name="completion_method" required><option value="instructor_led">Instructor led</option><option value="practical_evaluation">Practical evaluation</option><option value="external_record">External record</option><option value="in_app">In app</option></select></div>
              <div class="field"><label for="training-quiz-score">Quiz score</label><input id="training-quiz-score" name="quiz_score" type="number" min="0" max="100" step="0.01" placeholder="Optional"></div>
              <div class="field"><label for="training-instructor">Instructor / evaluator</label><input id="training-instructor" name="instructor_name" maxlength="160" placeholder="Optional"></div>
            </div><div class="prototype-note"><strong>Immutable completion receipt</strong><span>SafetyOps will pin the employee, course version, verifier, completion time, renewal date, retention policy, and a server-derived SHA-256 manifest.</span></div></div>
            <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Record completion</button></footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderEmployeeFormAssignmentModal() {
    const selectedPerson = data.people.find((person) => person.id === state.modalContext.employeeId);
    const selectedLocationId = selectedPerson?.locationId
      || (state.locationId === "all" ? data.locations[0]?.id : state.locationId);
    const eligiblePeople = data.people.filter((person) =>
      person.locationIds?.includes(selectedLocationId) && person.employmentStatus !== "Separated"
    );
    const eligibleForms = allFormTemplates().filter((template) => (
      formAvailableForSubmission(template)
      && template.locations?.includes(selectedLocationId)
      && !(template.fields || []).some((field) => field.databaseType === "file")
    ));
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="employee-form-assignment-title">
          <header class="modal-header">
            <div><p class="section-kicker">Facilitated tablet workflow</p><h2 id="employee-form-assignment-title">Assign employee form</h2><p>Create a dashboard item, then launch a one-time employee-only handoff when the tablet is ready.</p></div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">Ã—</button>
          </header>
          <form id="employee-form-assignment-form">
            <div class="modal-body">
              <div class="form-grid">
                <div class="field"><label for="employee-form-location">Location</label><select id="employee-form-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select></div>
                <div class="field"><label for="employee-form-employee">Employee</label><select id="employee-form-employee" name="employee_id" required>${eligiblePeople.map((person) => `<option value="${person.id}" ${person.id === selectedPerson?.id ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("")}</select></div>
                <div class="field full"><label for="employee-form-template">Form template</label><select id="employee-form-template" name="form_template_version_id" required>${eligibleForms.map((template) => `<option value="${template.formTemplateVersionId}">${escapeHtml(template.title)} Â· ${escapeHtml(template.version)}</option>`).join("") || `<option value="">No eligible published forms at this location</option>`}</select></div>
                <div class="field"><label for="employee-form-due">Due date</label><input id="employee-form-due" name="due_date" type="date" value="${isoDateOffset(7)}"></div>
                <div class="field"><label for="employee-form-title-input">Assignment title</label><input id="employee-form-title-input" name="title" maxlength="220" placeholder="Defaults to the form title"></div>
                <div class="field full"><label for="employee-form-instructions">Instructions</label><textarea id="employee-form-instructions" name="instructions" maxlength="2000" placeholder="Optional employee instructions"></textarea></div>
              </div>
              <div class="prototype-note"><strong>Employee account not required</strong><span>Starting the form creates a 15-minute, one-time capability in a separate no-opener tab. The employee tab cannot access your dashboard or company data.</span></div>
            </div>
            <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit" ${eligiblePeople.length && eligibleForms.length ? "" : "disabled"}>Assign form</button></footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderEmployeeDocumentModal() {
    const selectedPerson = data.people.find((person) => person.id === state.modalContext.employeeId);
    const selectedLocationId = selectedPerson?.locationId
      || (state.locationId === "all" ? data.locations[0]?.id : state.locationId);
    const eligiblePeople = data.people.filter((person) =>
      person.locationIds?.includes(selectedLocationId) && person.employmentStatus !== "Separated"
    );
    const selectedKind = state.modalContext.documentKind === "signed_upload" ? "signed_upload" : "signature_request";
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="employee-document-title">
          <header class="modal-header"><div><p class="section-kicker">Private employee record</p><h2 id="employee-document-title">Employee document</h2><p>Request an in-person tablet acknowledgement or attach an already-signed PDF.</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close dialog">×</button></header>
          <form id="employee-document-form">
            <div class="modal-body"><div class="form-grid">
              <div class="field"><label for="employee-document-location">Location</label><select id="employee-document-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select></div>
              <div class="field"><label for="employee-document-employee">Employee</label><select id="employee-document-employee" name="employee_id" required>${eligiblePeople.map((person) => `<option value="${person.id}" ${person.id === selectedPerson?.id ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("")}</select></div>
              <div class="field"><label for="employee-document-workflow">Workflow</label><select id="employee-document-workflow" name="document_kind" required><option value="signature_request" ${selectedKind === "signature_request" ? "selected" : ""}>Request e-signature</option><option value="signed_upload" ${selectedKind === "signed_upload" ? "selected" : ""}>Upload signed PDF</option></select></div>
              <div class="field"><label for="employee-document-date">Document date</label><input id="employee-document-date" type="date" name="document_date" value="${isoDateOffset()}" required></div>
              <div class="field full"><label for="employee-document-file">PDF</label><input id="employee-document-file" name="file" type="file" accept=".pdf,application/pdf" required><span class="field-hint">PDF only · maximum 10 MB</span></div>
              <div class="field full"><label for="employee-document-name">Document title</label><input id="employee-document-name" name="title" minlength="3" maxlength="220" required></div>
              <div class="field"><label for="employee-document-due">Signature due date</label><input id="employee-document-due" type="date" name="signature_due_date" value="${isoDateOffset(7)}"></div>
              <div class="field"><label for="employee-document-retention">Retention (months)</label><input id="employee-document-retention" type="number" min="1" max="1200" name="retention_months" placeholder="Leave blank for policy review"></div>
              <div class="field full"><label for="employee-document-intent">Signature intent</label><textarea id="employee-document-intent" name="signature_intent">I acknowledge that I reviewed this document and understand the requirements that apply to my work.</textarea></div>
            </div>
            <div class="scan-warning"><strong>Current file-control stage</strong><span>The Edge authority verifies exact PDF bytes, size, SHA-256, and blocks common active content. Malware scanning is not configured yet and will remain visibly marked unavailable.</span></div></div>
            <footer class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Prepare secure upload</button></footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderEmployeeSignModal() {
    const documentRecord = data.employeeDocuments.find((item) =>
      item.id === state.modalContext.documentId
    );
    if (!documentRecord) return "";
    const person = data.people.find((item) => item.id === documentRecord.employeeId);
    const selfSigning = person?.userId === state.authUser?.id;
    return `
      <div class="signing-handoff" role="dialog" aria-modal="true" aria-labelledby="employee-sign-title">
        <section class="signing-handoff-shell">
          <header><div><p class="section-kicker">Focused tablet handoff</p><h2 id="employee-sign-title">Employee acknowledgement</h2><p>Hand the tablet to ${escapeHtml(person?.name || documentRecord.employee)}. Other company records stay behind this focused screen.</p></div><button class="button" type="button" data-action="close-modal">Cancel handoff</button></header>
          <form id="employee-sign-form" class="signing-handoff-body">
            <input type="hidden" name="employee_document_id" value="${documentRecord.id}">
            <section class="signing-document-summary">
              <span>${statusPill("Awaiting signature", "amber")}</span>
              <h3>${escapeHtml(documentRecord.title)}</h3>
              <p>${escapeHtml(documentRecord.filename)} · ${escapeHtml(documentRecord.sizeBytes ? `${Math.ceil(documentRecord.sizeBytes / 1024)} KB` : "PDF")}</p>
              <dl><div><dt>Employee</dt><dd>${escapeHtml(person?.name || documentRecord.employee)}</dd></div><div><dt>Due</dt><dd>${escapeHtml(documentRecord.signatureDue)}</dd></div><div><dt>Document SHA-256</dt><dd><code>${escapeHtml(documentRecord.contentSha256 || "Pending")}</code></dd></div></dl>
              <button class="button" type="button" data-action="download-employee-document" data-document-id="${documentRecord.id}">Open exact PDF</button>
            </section>
            <section class="signing-consent">
              <h3>Signature intent</h3><p>${escapeHtml(documentRecord.signatureIntent)}</p>
              <label><input type="checkbox" name="consent_confirmed" required> I have reviewed the document and intend my typed name to be my electronic acknowledgement.</label>
              ${selfSigning ? "" : `<label><input type="checkbox" name="facilitator_confirmed" required> Facilitator attestation: I confirm the named employee is present and is completing this acknowledgement on this device.</label>`}
              <label for="employee-typed-name">Typed employee name</label>
              <input id="employee-typed-name" name="typed_name" autocomplete="off" required placeholder="${escapeHtml(person?.name || documentRecord.employee)}">
            </section>
            <section class="signing-evidence"><strong>Evidence captured by SafetyOps</strong><span>The employee, exact PDF hash, intent, typed name, time, authenticated facilitator, and signature hash are derived and stored by PostgreSQL. This creates traceable electronic acknowledgement evidence; it does not alter the source PDF.</span></section>
            <footer><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Complete acknowledgement</button></footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderFormUploadModal() {
    const selectedLocationId = state.locationId === "all" ? "all" : state.locationId;
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section id="form-upload-dialog" class="modal wide" role="dialog" aria-modal="true" aria-labelledby="form-upload-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Private company library</p>
              <h2 id="form-upload-title">Upload a company form</h2>
              <p>Add a PDF, DOCX, or XLSX source for development testing. SafetyOps fingerprints and stages it locally without putting it in GitHub.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close upload dialog">×</button>
          </header>
          <form id="form-upload-form">
            <div class="modal-body">
              <div class="upload-security-note">
                <span class="private-source-badge">Development only</span>
                <div>
                  <strong>Stored only on this device</strong>
                  <p>Production will upload to a private Supabase bucket after tenant authorization, MIME validation, malware scanning, and SHA-256 verification.</p>
                </div>
              </div>
              <div style="height:14px"></div>
              <div class="form-grid">
                <div class="field full">
                  <label for="form-upload-file">Source file</label>
                  <div class="file-drop-zone form-upload-drop">
                    <strong>Select a blank form or reusable source</strong>
                    <span>PDF, DOCX, or XLSX · maximum 25 MB</span>
                    <input
                      id="form-upload-file"
                      name="file"
                      type="file"
                      accept=".pdf,.docx,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      required
                    >
                  </div>
                </div>
                <div class="field full">
                  <label for="form-upload-title-input">Display title</label>
                  <input id="form-upload-title-input" name="title" required maxlength="160" placeholder="Example: Weekly machine guarding checklist">
                </div>
                <div class="field">
                  <label for="form-upload-category">Category</label>
                  <select id="form-upload-category" name="category" required>
                    <option>Inspection</option>
                    <option>Acknowledgment</option>
                    <option>Hazard report</option>
                    <option>Onboarding</option>
                    <option>Training</option>
                    <option>Permit</option>
                    <option>Other company form</option>
                  </select>
                </div>
                <div class="field">
                  <label for="form-upload-location">Location scope</label>
                  <select id="form-upload-location" name="location_id" required>${renderLocationOptions(true, selectedLocationId)}</select>
                </div>
              </div>
              <div class="template-next-step">
                <strong>Template section</strong>
                <span>The source will appear under My uploads. After review, an admin can map its fields into an interactive, versioned template without altering the original.</span>
              </div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit">Fingerprint & save locally</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderLocationModal() {
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="location-create-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Company workspace · ${data.locations.length} current location${data.locations.length === 1 ? "" : "s"}</p>
              <h2 id="location-create-title">Add a company location</h2>
              <p>Create the location and its state-specific regulatory review record in one tenant-scoped transaction.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close location dialog">×</button>
          </header>
          <form id="location-create-form">
            <div class="modal-body">
              <div class="form-grid">
                <div class="field">
                  <label for="location-create-name">Location name</label>
                  <input id="location-create-name" name="name" minlength="2" maxlength="160" autocomplete="organization" required placeholder="Main facility">
                </div>
                <div class="field">
                  <label for="location-create-code">Location code</label>
                  <input id="location-create-code" name="code" minlength="2" maxlength="32" pattern="[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*" required placeholder="MAIN">
                </div>
                <div class="field full">
                  <label for="location-create-address">Address or city</label>
                  <input id="location-create-address" name="address" maxlength="300" autocomplete="street-address" placeholder="Street, city, ZIP">
                </div>
                <div class="field">
                  <label for="location-create-state">State-plan starting point</label>
                  <select id="location-create-state" name="state_code" required>
                    <option value="OR">Oregon · Oregon OSHA</option>
                    <option value="WA">Washington · DOSH</option>
                    <option value="CA">California · Cal/OSHA</option>
                  </select>
                </div>
                <div class="field">
                  <label for="location-create-timezone">Timezone</label>
                  <select id="location-create-timezone" name="timezone" required>
                    <option value="America/Los_Angeles">Pacific time</option>
                    <option value="America/Boise">Mountain time (Oregon only)</option>
                  </select>
                </div>
              </div>
              <div class="prototype-note">
                <strong>Coverage review required</strong>
                <span>The state creates a candidate jurisdiction only. Employer type, industry, work activity, federal enclaves, tribal coverage, maritime work, and other exceptions must be reviewed before approval.</span>
              </div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit">Create location</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  function renderModal() {
    if (!state.modal) return "";
    if (state.modal === "inspection") return renderInspectionModal();
    if (state.modal === "incident") return renderIncidentModal();
    if (state.modal === "committee") return renderCommitteeModal();
    if (state.modal === "training") return renderTrainingModal();
    if (state.modal === "training-completion") return renderTrainingCompletionModal();
    if (state.modal === "action") return renderActionModal();
    if (state.modal === "employee") return renderEmployeeModal();
    if (state.modal === "employee-form-assignment") return renderEmployeeFormAssignmentModal();
    if (state.modal === "employee-document") return renderEmployeeDocumentModal();
    if (state.modal === "employee-sign") return renderEmployeeSignModal();
    if (state.modal === "form-upload") return renderFormUploadModal();
    if (state.modal === "location") return renderLocationModal();
    return "";
  }

  function renderEmployeeHandoffField(field) {
    const fieldId = `handoff-field-${field.id}`;
    const required = field.required ? "required" : "";
    const requiredLabel = field.required ? ` <span aria-hidden="true">*</span>` : "";
    const hint = field.helpText ? `<p class="field-hint">${escapeHtml(field.helpText)}</p>` : "";
    if (field.type === "instruction") {
      return `<div class="runner-field runner-instruction"><strong>${escapeHtml(field.label)}</strong>${hint}</div>`;
    }
    if (field.type === "employee" || field.type === "location") {
      const value = field.type === "employee"
        ? state.employeeHandoff.data.employeeName
        : state.employeeHandoff.data.locationName;
      return `<div class="runner-field"><span class="field-label">${escapeHtml(field.label)}</span><div class="handoff-pinned-value">${escapeHtml(value)}</div>${hint}</div>`;
    }
    if (field.type === "signature") return "";
    if (field.type === "long_text") {
      return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><textarea id="${fieldId}" name="${escapeHtml(field.key)}" placeholder="${escapeHtml(field.placeholder || "")}" ${required}></textarea>${hint}</div>`;
    }
    if (field.type === "single_choice") {
      return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><select id="${fieldId}" name="${escapeHtml(field.key)}" ${required}><option value="">Choose an option</option>${(field.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}</select>${hint}</div>`;
    }
    if (field.type === "multi_choice") {
      return `<fieldset class="runner-field"><legend>${escapeHtml(field.label)}${requiredLabel}</legend><div class="runner-choice-grid">${(field.options || []).map((option, index) => `<div class="runner-option"><input id="${fieldId}-${index}" type="checkbox" name="${escapeHtml(field.key)}" value="${escapeHtml(option)}"><label for="${fieldId}-${index}">${escapeHtml(option)}</label></div>`).join("")}</div>${hint}</fieldset>`;
    }
    if (field.type === "boolean") {
      return `<fieldset class="runner-field"><legend>${escapeHtml(field.label)}${requiredLabel}</legend><div class="runner-choice-grid"><div class="runner-option"><input id="${fieldId}-yes" type="radio" name="${escapeHtml(field.key)}" value="true" ${required}><label for="${fieldId}-yes">Yes</label></div><div class="runner-option"><input id="${fieldId}-no" type="radio" name="${escapeHtml(field.key)}" value="false"><label for="${fieldId}-no">No</label></div></div>${hint}</fieldset>`;
    }
    if (field.type === "acknowledgement") {
      return `<fieldset class="runner-field"><legend>${escapeHtml(field.label)}${requiredLabel}</legend><div class="runner-option"><input id="${fieldId}" name="${escapeHtml(field.key)}" type="checkbox" value="true" ${required}><label for="${fieldId}">I acknowledge this statement</label></div>${hint}</fieldset>`;
    }
    const inputType = ({ number: "number", date: "date", time: "time", datetime: "datetime-local" })[field.type] || "text";
    return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><input id="${fieldId}" name="${escapeHtml(field.key)}" type="${inputType}" placeholder="${escapeHtml(field.placeholder || "")}" ${required}>${hint}</div>`;
  }

  function renderEmployeeHandoffScreen() {
    const handoff = state.employeeHandoff;
    if (!supabaseClient) {
      return `<main class="handoff-standalone"><section class="auth-card"><h1>Employee form unavailable</h1><p>The secure data service is not configured on this deployment.</p></section></main>`;
    }
    if (handoff.status === "loading") {
      return `<main class="handoff-standalone"><section class="auth-card"><p class="section-kicker">SafetyOps secure handoff</p><h1>Loading employee formâ€¦</h1><p>Verifying this one-time session without opening the company dashboard.</p></section></main>`;
    }
    if (handoff.status === "error") {
      return `<main class="handoff-standalone"><section class="auth-card"><p class="section-kicker">SafetyOps secure handoff</p><h1>This employee form cannot be opened</h1><p>${escapeHtml(handoff.error || "The link expired, was revoked, or has already been used.")}</p><p>Ask the safety facilitator to start a new tablet session from the dashboard.</p><button class="button" type="button" data-action="close-handoff-window">Close this tab</button></section></main>`;
    }
    if (handoff.status === "complete") {
      return `<main class="handoff-standalone"><section class="handoff-complete-card"><span class="success-mark" aria-hidden="true">âœ“</span><p class="section-kicker">Submission retained</p><h1>Employee form complete</h1><p>Your answers and typed signature were bound to the exact controlled form schema. The safety dashboard will show this item as completed.</p><dl><div><dt>Submitted</dt><dd>${escapeHtml(formatShortDate(handoff.receipt?.submitted_at, "Just now"))}</dd></div><div><dt>Evidence SHA-256</dt><dd><code>${escapeHtml(handoff.receipt?.submission_sha256 || "")}</code></dd></div></dl><button class="button primary" type="button" data-action="close-handoff-window">Close this tab</button></section></main>`;
    }
    const item = handoff.data;
    return `
      <main class="signing-handoff handoff-standalone" role="main">
        <section class="signing-handoff-shell employee-form-handoff-shell">
          <header>
            <div><p class="section-kicker">${escapeHtml(item.companyName)} Â· secure employee form</p><h1>${escapeHtml(item.title)}</h1><p>${escapeHtml(item.employeeName)} Â· ${escapeHtml(item.locationName)}</p></div>
            <span class="private-source-badge">One-time session</span>
          </header>
          <form id="employee-handoff-form" class="signing-handoff-body">
            <section class="signing-document-summary">
              <span>${statusPill("Employee form", "blue")}</span>
              <h2>Before you begin</h2>
              <p>${escapeHtml(item.instructions || "Complete every required field, review your answers, and sign with your full name.")}</p>
              <dl><div><dt>Form version</dt><dd>v${escapeHtml(item.formVersion)}</dd></div><div><dt>Due</dt><dd>${escapeHtml(formatShortDate(item.dueAt, "No due date"))}</dd></div><div><dt>Schema SHA-256</dt><dd><code>${escapeHtml(item.formSchemaSha256)}</code></dd></div></dl>
            </section>
            <section class="form-section handoff-response-section">
              <header class="form-section-header"><h2>Employee response</h2><p>Fields marked with an asterisk are required.</p></header>
              <div class="form-section-body">${(item.fields || []).map(renderEmployeeHandoffField).join("")}</div>
            </section>
            <section class="signing-consent">
              <h2>Review and sign</h2>
              <label><input type="checkbox" name="employee_attestation" required> I confirm these answers are mine and complete.</label>
              <label><input type="checkbox" name="consent_confirmed" required> I intend my typed name to be my electronic signature for this completed form.</label>
              <label for="handoff-typed-name">Typed employee name</label>
              <input id="handoff-typed-name" name="typed_name" autocomplete="name" required placeholder="${escapeHtml(item.employeeName)}">
              <p class="field-hint">Your typed name must match the assigned employee name shown above.</p>
            </section>
            <section class="signing-evidence"><strong>What SafetyOps records</strong><span>The exact form version and field hashes, answers, employee name, authenticated facilitator identity, consent, timestamp, overdue state, and canonical evidence SHA-256. Some regulated records may still require additional identity checks or a wet signature.</span></section>
            <footer><span>This one-time link expires at ${escapeHtml(new Date(item.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}.</span><button class="button primary" type="submit">Submit completed form</button></footer>
          </form>
        </section>
      </main>
    `;
  }

  async function loadEmployeeHandoff() {
    if (!supabaseClient || !isEmployeeHandoffMode) return;
    state.employeeHandoff.status = "loading";
    render();
    const result = await supabaseClient.rpc("get_employee_form_handoff", {
      target_token: employeeHandoffToken
    });
    if (result.error) {
      state.employeeHandoff.status = "error";
      state.employeeHandoff.error = result.error.message || "The one-time employee form link is unavailable.";
      render();
      return;
    }
    state.employeeHandoff.data = result.data;
    state.employeeHandoff.status = "ready";
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}#employee-form`);
    render();
    requestAnimationFrame(() => document.querySelector("#employee-handoff-form input, #employee-handoff-form select, #employee-handoff-form textarea")?.focus());
  }

  function collectEmployeeHandoffAnswers(form) {
    const formData = new FormData(form);
    return Object.fromEntries((state.employeeHandoff.data?.fields || [])
      .filter((field) => !["instruction", "employee", "location", "signature"].includes(field.type))
      .map((field) => {
        if (field.type === "multi_choice") return [field.key, formData.getAll(field.key).map(String)];
        if (field.type === "boolean") {
          const value = formData.get(field.key);
          return [field.key, value === null ? null : value === "true"];
        }
        if (field.type === "acknowledgement") return [field.key, formData.get(field.key) === "true"];
        const value = String(formData.get(field.key) || "").trim();
        if (field.type === "number") return [field.key, value === "" ? null : Number(value)];
        return [field.key, value === "" ? null : value];
      }));
  }

  async function handleEmployeeHandoffSubmit(form) {
    const submitButton = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Submittingâ€¦";
    }
    const result = await supabaseClient.rpc("submit_employee_form_handoff", {
      target_token: employeeHandoffToken,
      target_answers: collectEmployeeHandoffAnswers(form),
      target_typed_name: String(formData.get("typed_name") || ""),
      target_consent_confirmed: formData.get("consent_confirmed") === "on",
      target_employee_attestation: formData.get("employee_attestation") === "on"
    });
    if (result.error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Submit completed form";
      }
      showToast("Form was not submitted", result.error.message || "The secure form session rejected this response.");
      return;
    }
    state.employeeHandoff.receipt = Array.isArray(result.data) ? result.data[0] : result.data;
    state.employeeHandoff.status = "complete";
    render();
  }

  function render() {
    if (isEmployeeHandoffMode) {
      app.innerHTML = renderEmployeeHandoffScreen();
      referencePanelRegion.innerHTML = "";
      return;
    }
    localStorage.setItem(`${uiStoragePrefix}view`, state.view === "search" ? "dashboard" : state.view);
    localStorage.setItem(`${uiStoragePrefix}location`, state.locationId);
    if (state.authStatus !== "ready") {
      app.innerHTML = renderAuthScreen();
      referencePanelRegion.innerHTML = "";
      return;
    }
    app.innerHTML = `
      <div class="app-shell">
        ${renderSidebar()}
        <main class="main">
          ${renderTopbar()}
          <div class="page">${renderLocationAccessNotice()}${renderCurrentView()}</div>
        </main>
        ${renderMobileNav()}
      </div>
      ${renderModal()}
      ${renderProgramDrawer()}
      ${renderEmployeeDrawer()}
      ${renderProgramFormRunner()}
      ${renderOriginalFormPreview()}
    `;
    renderReferencePanel();
  }

  function navigate(view) {
    if (view === "standards" && state.view === "search" && state.searchQuery) {
      state.standardQuery = state.searchQuery;
      state.standardMode = "all";
      state.standardAuthority = "combined";
      state.standardPart = "all";
      state.standardScope = "all";
    } else if (view === "standards") {
      state.standardQuery = "";
      state.standardMode = "manufacturing";
      state.standardAuthority = "location";
      state.standardPart = "all";
      state.standardScope = "all";
    }
    state.view = view;
    state.sidebarOpen = false;
    state.modal = null;
    state.modalContext = {};
    state.referenceId = null;
    state.programDrawerId = null;
    state.employeeDrawerId = null;
    state.originalPreviewId = null;
    state.activeFormId = null;
    render();
    requestAnimationFrame(() => {
      document.querySelector(".page-heading h1")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function openModal(type, relatedId, context = {}) {
    if (type === "form-upload" && !localUploadStagingEnabled) {
      showToast("Upload service required", "Deploy the private prepare, malware-scan, and commit service before accepting production uploads.");
      return;
    }
    if (["inspection", "incident", "committee", "training", "training-completion", "action", "employee-form-assignment", "employee-document"].includes(type) && !data.locations.length) {
      showToast("Location access required", "An active authorized location is required for this workflow.");
      return;
    }
    if (["inspection", "incident"].includes(type) && isReadOnlyAuditor()) {
      showToast("Read-only auditor role", "Auditors can review authorized records but cannot create operational records.");
      return;
    }
    if (["committee", "training", "training-completion", "action", "employee-form-assignment", "employee-document"].includes(type) && !canWriteLocation()) {
      showToast("Manager access required", "Your role cannot create this record for the selected location.");
      return;
    }
    if (type === "location" && !canManageCompany()) {
      showToast("Company administrator required", "Only corporate administrators and safety managers can create locations.");
      return;
    }
    if (type === "inspection" && !data.inspectionTemplates.some((template) => (
      template.published && template.currentVersionId && template.questions > 0
    ))) {
      showToast("Inspection unavailable", "A published current template version with questions is required.");
      return;
    }
    if (type === "training" && !data.courses.some((course) => (
      course.published && course.currentVersionId
    ))) {
      showToast("Training unavailable", "A published current course version is required.");
      return;
    }
    if (type === "employee-form-assignment" && !allFormTemplates().some((template) => (
      formAvailableForSubmission(template)
      && !(template.fields || []).some((field) => field.databaseType === "file")
    ))) {
      showToast("Employee form unavailable", "A published, location-applicable form without file fields is required.");
      return;
    }
    state.modal = type;
    state.selectedTemplateId = relatedId || null;
    state.modalContext = context;
    state.referenceId = null;
    state.originalPreviewId = null;
    render();
    requestAnimationFrame(() => {
      document.querySelector(".modal input, .modal select, .modal button")?.focus();
    });
  }

  function closeModal() {
    state.modal = null;
    state.selectedTemplateId = null;
    state.modalContext = {};
    render();
  }

  function showToast(title, message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true">✓</span>
      <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>
    `;
    toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  async function handleInspectionSubmit(form) {
    if (isReadOnlyAuditor()) {
      showToast("Inspection not submitted", "The auditor role is read-only.");
      return;
    }
    const formData = new FormData(form);
    const locationId = String(formData.get("location_id") || "");
    if (!hasAccessibleLocation(locationId)) {
      showToast("Inspection not submitted", "Choose an active location assigned to your account.");
      return;
    }
    const template = data.inspectionTemplates.find((item) => item.id === formData.get("template_id"));
    if (!template?.currentVersionId || !template.published) {
      showToast("Inspection not submitted", "Publish a current template version before using it.");
      return;
    }
    const questions = inspectionQuestionsFor(template.id);
    const answers = Object.fromEntries(
      questions.map((question, index) => [
        question.key,
        String(formData.get(`q${index}`) || "")
      ])
    );
    if (Object.values(answers).some((answer) => !["pass", "fail", "na"].includes(answer))) {
      showToast("Inspection not submitted", "Answer every published question before signing.");
      return;
    }
    const failed = Object.values(answers).filter((answer) => answer === "fail").length;
    const submitButton = form.querySelector('button[type="submit"]');
    const clientSubmissionKey = form.dataset.submissionKey
      || (window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `inspection-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    form.dataset.submissionKey = clientSubmissionKey;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Signing and submitting...";
    }
    const result = await supabaseClient.rpc("submit_inspection_with_regulatory_evidence", {
      target_company_id: data.company.id,
      target_location_id: locationId,
      target_template_version_id: template.currentVersionId,
      target_area_or_asset: String(formData.get("area") || "").trim(),
      target_answers: answers,
      target_client_submission_key: clientSubmissionKey,
      target_notes: String(formData.get("notes") || "").trim() || null
    });
    if (result.error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Sign & submit";
      }
      showToast("Inspection not submitted", result.error.message || "Supabase rejected the inspection.");
      return;
    }
    const submissionResult = Array.isArray(result.data) ? result.data[0] : result.data;
    const evidenceCount = Number(submissionResult?.evidence_count || 0);
    state.modal = null;
    state.selectedTemplateId = null;
    state.view = "inspections";
    await loadAuthenticatedWorkspace(state.authUser);
    showToast(
      "Inspection submitted",
      evidenceCount
        ? `${failed} finding${failed === 1 ? "" : "s"} and ${evidenceCount} database-verified regulatory evidence link${evidenceCount === 1 ? "" : "s"} were recorded.`
        : `${failed} finding${failed === 1 ? "" : "s"} recorded with an immutable regulatory context; no mapping is represented as verified evidence until review is complete.`
    );
  }

  async function handleIncidentSubmit(form) {
    if (isReadOnlyAuditor()) {
      showToast("Incident not created", "The auditor role is read-only.");
      return;
    }
    const formData = new FormData(form);
    const locationId = String(formData.get("location_id") || "");
    if (!hasAccessibleLocation(locationId)) {
      showToast("Incident not created", "Choose an active location assigned to your account.");
      return;
    }
    const occurredAt = new Date(`${formData.get("date")}T12:00:00`).toISOString();
    const result = await supabaseClient.from("incidents").insert({
      company_id: data.company.id,
      location_id: locationId,
      title: String(formData.get("title") || "").trim(),
      incident_type: formData.get("type"),
      potential_severity: String(formData.get("severity") || "medium").toLowerCase(),
      occurred_at: occurredAt,
      description: String(formData.get("description") || "").trim(),
      reported_by: state.authUser.id
    });
    if (result.error) {
      showToast("Incident not created", result.error.message || "Supabase rejected the report.");
      return;
    }
    state.modal = null;
    state.view = "incidents";
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Incident report created", "The report is stored in the private company workspace.");
  }

  async function handleTrainingSubmit(form) {
    const formData = new FormData(form);
    const course = data.courses.find((item) => item.id === formData.get("course_id"));
    if (!course?.published || !course.currentVersionId) {
      showToast("Training not assigned", "Publish the current course version first.");
      return;
    }
    const requestedLocationId = String(formData.get("location_id") || "");
    if (!canWriteLocation(requestedLocationId)) {
      showToast("Training not assigned", "Your role cannot assign training for that location.");
      return;
    }
    const requestedEmployeeId = String(formData.get("employee_id") || "all");
    const people = data.people.filter((person) => (
      person.locationIds?.includes(requestedLocationId)
      && (requestedEmployeeId === "all" || person.id === requestedEmployeeId)
    ));
    if (!people.length) {
      showToast("Training not assigned", "No authorized workers match that location.");
      return;
    }
    const retentionMonths = Number(formData.get("retention_months") || 0) || null;
    const regulatoryBasis = String(formData.get("regulatory_basis") || "")
      .split(/\r?\n/)
      .map((citation) => citation.trim())
      .filter(Boolean)
      .slice(0, 100)
      .map((citation) => ({
        citation,
        traceStatus: "review_required",
        capturedBy: "manual_assignment_entry"
      }));
    const result = await supabaseClient.rpc("assign_training_requirements", {
      target_employee_ids: people.map((person) => person.id),
      target_course_id: course.id,
      target_location_id: requestedLocationId,
      target_due_at: new Date(`${formData.get("due_date")}T23:59:59`).toISOString(),
      target_reason: String(formData.get("reason") || "Company safety requirement").trim(),
      target_cadence_months: Number(formData.get("cadence_months") || 0) || null,
      target_retention_months: retentionMonths,
      target_retention_basis: retentionMonths
        ? { status: "calculated", source: "assignment_policy", months: retentionMonths }
        : { status: "review_required" },
      target_regulatory_basis: regulatoryBasis
    });
    if (result.error) {
      showToast("Training not assigned", result.error.message || "Supabase rejected the assignments.");
      return;
    }
    state.modal = null;
    state.view = "training";
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Training assigned", `${course.name} was assigned to ${people.length} worker${people.length === 1 ? "" : "s"}.`);
  }

  async function handleActionSubmit(form) {
    const formData = new FormData(form);
    const locationId = String(formData.get("location_id") || "");
    if (!canWriteLocation(locationId)) {
      showToast("Action not created", "Your role cannot create a corrective action for that location.");
      return;
    }
    const ownerId = String(formData.get("owner_id") || "");
    const eligibleOwner = data.people.find((person) => (
      person.id === ownerId && person.locationIds?.includes(locationId)
    ));
    if (!eligibleOwner) {
      showToast("Action not created", "Choose an owner who is assigned to that location.");
      return;
    }
    const result = await supabaseClient.rpc("create_employee_corrective_action", {
      target_location_id: locationId,
      target_employee_id: ownerId,
      target_title: String(formData.get("title") || "").trim(),
      target_description: String(formData.get("description") || "").trim() || null,
      target_priority: String(formData.get("priority") || "medium").toLowerCase(),
      target_due_at: new Date(`${formData.get("due_date")}T23:59:59`).toISOString(),
      target_required_evidence: String(formData.get("evidence") || "").trim() || null,
      target_committee_meeting_id: String(formData.get("committee_meeting_id") || "") || null
    });
    if (result.error) {
      showToast("Action not created", result.error.message || "Supabase rejected the corrective action.");
      return;
    }
    state.modal = null;
    state.view = "actions";
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Corrective action created", "The owner will see the private Supabase record in their work queue.");
  }

  async function handleEmployeeFormAssignmentSubmit(form) {
    const formData = new FormData(form);
    const employeeId = String(formData.get("employee_id") || "");
    const locationId = String(formData.get("location_id") || "");
    const formTemplateVersionId = String(formData.get("form_template_version_id") || "");
    const person = data.people.find((item) => item.id === employeeId);
    const template = allFormTemplates().find((item) =>
      item.formTemplateVersionId === formTemplateVersionId
    );
    if (!person?.locationIds?.includes(locationId) || !canWriteLocation(locationId)) {
      showToast("Employee form not assigned", "Choose an employee and location you are authorized to manage.");
      return;
    }
    if (!template || !formAvailableForSubmission(template) || !template.locations?.includes(locationId)) {
      showToast("Employee form not assigned", "Choose a published form with reviewed applicability at this location.");
      return;
    }
    const dueDate = String(formData.get("due_date") || "");
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Assigningâ€¦";
    }
    const result = await supabaseClient.rpc("assign_employee_form", {
      target_employee_id: employeeId,
      target_location_id: locationId,
      target_form_template_version_id: formTemplateVersionId,
      target_due_at: dueDate ? new Date(`${dueDate}T23:59:59`).toISOString() : null,
      target_title: String(formData.get("title") || "").trim() || null,
      target_instructions: String(formData.get("instructions") || "").trim() || null
    });
    if (result.error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Assign form";
      }
      showToast("Employee form not assigned", result.error.message || "Supabase rejected the assignment.");
      return;
    }
    state.modal = null;
    state.modalContext = {};
    state.employeeDrawerId = employeeId;
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Employee form assigned", `${template.title} now appears as not done for ${person.name}.`);
  }

  async function startEmployeeFormHandoff(assignmentId) {
    const assignment = data.employeeFormAssignments.find((item) => item.id === assignmentId);
    if (!assignment || !["assigned", "in_progress"].includes(assignment.rawStatus)) {
      showToast("Tablet form unavailable", "This employee form is no longer open.");
      return;
    }
    const handoffWindow = window.open("about:blank", "_blank");
    if (handoffWindow) {
      handoffWindow.opener = null;
      handoffWindow.document.title = "Opening secure employee form";
      handoffWindow.document.body.textContent = "Opening the secure SafetyOps employee formâ€¦";
    }
    const result = await supabaseClient.rpc("begin_employee_form_handoff", {
      target_assignment_id: assignment.id
    });
    if (result.error) {
      handoffWindow?.close();
      showToast("Tablet form not started", result.error.message || "Supabase could not create the one-time handoff.");
      return;
    }
    const ceremony = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!/^[0-9a-f]{64}$/.test(ceremony?.handoff_token || "")) {
      handoffWindow?.close();
      showToast("Tablet form not started", "The secure handoff service returned an invalid capability.");
      return;
    }
    if (!handoffWindow) {
      showToast("Pop-up blocked", "Allow pop-ups for SafetyOps, then select Start tablet form again. The unused session will be revoked automatically.");
      return;
    }
    const handoffUrl = new URL(window.location.href);
    handoffUrl.hash = `handoff=${ceremony.handoff_token}`;
    handoffWindow.location.replace(handoffUrl.href);
    showToast("Tablet form opened", `${assignment.employee}'s one-time form is isolated in a new tab and expires in 15 minutes.`);
  }

  async function handleCommitteeSubmit(form) {
    const formData = new FormData(form);
    const locationId = String(formData.get("location_id") || "");
    if (!canWriteLocation(locationId)) {
      showToast("Meeting notes not saved", "Your role cannot manage this location.");
      return;
    }
    const attendeeIds = formData.getAll("attendee_ids").map(String).filter(Boolean);
    const result = await supabaseClient.rpc("create_safety_committee_meeting", {
      target_location_id: locationId,
      target_title: String(formData.get("title") || "").trim(),
      target_meeting_date: String(formData.get("meeting_date") || ""),
      target_chair_employee_id: String(formData.get("chair_employee_id") || ""),
      target_attendee_ids: attendeeIds,
      target_agenda: String(formData.get("agenda") || "").trim() || null,
      target_notes: String(formData.get("notes") || "").trim(),
      target_decisions: String(formData.get("decisions") || "").trim() || null,
      target_next_meeting_at: null
    });
    if (result.error) {
      showToast("Meeting notes not saved", result.error.message || "Supabase rejected the meeting record.");
      return;
    }
    state.modal = null;
    state.modalContext = {};
    state.view = "committee";
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Committee notes saved", "Attendance, notes, and decisions are now in the draft meeting record.");
  }

  async function finalizeCommitteeMeeting(meetingId) {
    const result = await supabaseClient.rpc("finalize_safety_committee_meeting", {
      target_meeting_id: meetingId
    });
    if (result.error) {
      showToast("Minutes not finalized", result.error.message || "Supabase could not freeze these minutes.");
      return;
    }
    await loadAuthenticatedWorkspace(state.authUser);
    const receipt = Array.isArray(result.data) ? result.data[0] : result.data;
    showToast("Committee minutes finalized", `Immutable minutes SHA-256: ${String(receipt?.minutes_sha256 || "").slice(0, 16)}â€¦`);
  }

  async function handleEmployeeSubmit(form) {
    const formData = new FormData(form);
    const locationId = String(formData.get("location_id") || "");
    const result = await supabaseClient.rpc("create_employee", {
      employee_full_name: String(formData.get("full_name") || "").trim(),
      employee_location_id: locationId,
      employee_number: String(formData.get("employee_number") || "").trim() || null,
      employee_work_email: String(formData.get("work_email") || "").trim().toLowerCase() || null,
      employee_job_title: String(formData.get("job_title") || "").trim() || null,
      employee_department: String(formData.get("department") || "").trim() || null
    });
    if (result.error) {
      showToast("Employee not added", result.error.message || "Supabase rejected the employee record.");
      return;
    }
    state.modal = null;
    state.modalContext = {};
    state.employeeDrawerId = result.data;
    state.view = "people";
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Employee added", "The employee can now receive training, tablet forms, and signed records without a login account.");
  }

  async function handleTrainingCompletionSubmit(form) {
    const formData = new FormData(form);
    const completedDate = String(formData.get("completed_date") || "");
    const result = await supabaseClient.rpc("record_training_completion", {
      target_assignment_id: String(formData.get("assignment_id") || ""),
      target_completed_at: new Date(`${completedDate}T12:00:00`).toISOString(),
      target_completion_method: String(formData.get("completion_method") || ""),
      target_quiz_score: String(formData.get("quiz_score") || "").trim() === ""
        ? null
        : Number(formData.get("quiz_score")),
      target_instructor_name: String(formData.get("instructor_name") || "").trim() || null
    });
    if (result.error) {
      showToast("Completion not recorded", result.error.message || "Supabase rejected the completion evidence.");
      return;
    }
    state.modal = null;
    state.modalContext = {};
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Training completion retained", "The employee, pinned course version, verifier, renewal, retention, and evidence hash were recorded.");
  }

  async function handleEmployeeDocumentSubmit(form) {
    const formData = new FormData(form);
    const file = formData.get("file");
    const submitButton = form.querySelector('button[type="submit"]');
    if (!(file instanceof File) || !file.name || !file.size || file.size > 10 * 1024 * 1024) {
      showToast("PDF not uploaded", "Choose a non-empty PDF no larger than 10 MB.");
      return;
    }
    const prefix = new TextDecoder("ascii").decode(new Uint8Array(await file.slice(0, 5).arrayBuffer()));
    if (!file.name.toLowerCase().endsWith(".pdf") || prefix !== "%PDF-") {
      showToast("PDF not uploaded", "The selected file does not have a valid PDF header and filename.");
      return;
    }
    if (!supabaseClient.functions?.invoke) {
      showToast("PDF not uploaded", "The private employee document authority is not deployed.");
      return;
    }
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Preparing secure uploadâ€¦";
    }
    try {
      const retentionMonths = Number(formData.get("retention_months") || 0) || null;
      const dueDate = String(formData.get("signature_due_date") || "");
      const prepareResult = await supabaseClient.functions.invoke("employee-document-file", {
        body: {
          action: "prepare",
          employee_id: String(formData.get("employee_id") || ""),
          location_id: String(formData.get("location_id") || ""),
          document_kind: String(formData.get("document_kind") || ""),
          title: String(formData.get("title") || "").trim(),
          filename: file.name,
          size_bytes: file.size,
          document_date: String(formData.get("document_date") || ""),
          signature_due_at: dueDate ? new Date(`${dueDate}T23:59:59`).toISOString() : null,
          signature_intent: String(formData.get("signature_intent") || "").trim() || null,
          retention_months: retentionMonths,
          retention_basis: retentionMonths
            ? { status: "calculated", source: "document_policy", months: retentionMonths }
            : { status: "review_required" },
          employee_can_view: true,
          manager_visibility: "safety_admin_only",
          idempotency_key: window.crypto.randomUUID()
        }
      });
      if (prepareResult.error || !prepareResult.data?.upload_token) {
        throw prepareResult.error || new Error("The upload could not be authorized.");
      }
      if (submitButton) submitButton.textContent = "Uploading exact PDFâ€¦";
      const prepared = prepareResult.data;
      const uploadResult = await supabaseClient.storage
        .from(prepared.bucket_id)
        .uploadToSignedUrl(prepared.object_path, prepared.upload_token, file, {
          contentType: "application/pdf"
        });
      if (uploadResult.error) throw uploadResult.error;
      if (submitButton) submitButton.textContent = "Verifying SHA-256â€¦";
      const completeResult = await supabaseClient.functions.invoke("employee-document-file", {
        body: { action: "complete", upload_session_id: prepared.upload_session_id }
      });
      if (completeResult.error || !completeResult.data?.employee_document_id) {
        throw completeResult.error || new Error("The uploaded PDF could not be verified.");
      }
      state.modal = null;
      state.modalContext = {};
      state.employeeDrawerId = String(formData.get("employee_id") || "");
      await loadAuthenticatedWorkspace(state.authUser);
      if (completeResult.data.malware_scan_status === "clean") {
        showToast(
          "PDF verified and released",
          "The exact bytes passed format, SHA-256, and configured malware-scan verification."
        );
      } else {
        showToast(
          "PDF quarantined for security review",
          "The exact bytes, size, and SHA-256 were verified. Download and signing stay blocked until a malware scanner attests these bytes as clean."
        );
      }
    } catch (error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Prepare secure upload";
      }
      showToast("PDF not uploaded", error?.message || "The secure upload workflow failed.");
    }
  }

  async function handleEmployeeSignSubmit(form) {
    const formData = new FormData(form);
    const result = await supabaseClient.rpc("sign_employee_document", {
      target_employee_document_id: String(formData.get("employee_document_id") || ""),
      typed_name: String(formData.get("typed_name") || ""),
      consent_confirmed: formData.get("consent_confirmed") === "on",
      facilitator_confirmed: formData.get("facilitator_confirmed") === "on"
    });
    if (result.error) {
      showToast("Acknowledgement not completed", result.error.message || "Supabase rejected the signature evidence.");
      return;
    }
    state.modal = null;
    state.modalContext = {};
    await loadAuthenticatedWorkspace(state.authUser);
    const receipt = Array.isArray(result.data) ? result.data[0] : result.data;
    showToast("Employee acknowledgement retained", `Signature SHA-256: ${String(receipt?.signature_sha256 || "").slice(0, 16)}â€¦`);
  }

  async function downloadEmployeeDocument(documentId) {
    try {
      const result = await supabaseClient.functions.invoke("employee-document-file", {
        body: { action: "download", employee_document_id: documentId }
      });
      if (result.error || !result.data?.signed_url) throw result.error || new Error("Download authorization failed.");
      const url = new URL(result.data.signed_url);
      if (url.protocol !== "https:" || url.hostname !== new URL(window.SAFETYOPS_SUPABASE_URL).hostname) {
        throw new Error("The download authority returned an invalid URL.");
      }
      const link = document.createElement("a");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.click();
      showToast("Private PDF opened", "A five-minute, audited download URL was issued.");
    } catch (error) {
      showToast("PDF unavailable", error?.message || "The private file could not be opened.");
    }
  }

  async function retryEmployeeDocumentScan(documentId) {
    const documentRecord = data.employeeDocuments.find((item) => item.id === documentId);
    if (!documentRecord || !canWriteLocation(documentRecord.locationId)) {
      showToast("Security scan unavailable", "Your role cannot rescan this employee document.");
      return;
    }
    try {
      const result = await supabaseClient.functions.invoke("employee-document-file", {
        body: { action: "scan", employee_document_id: documentId }
      });
      if (result.error || !result.data?.employee_document_id) {
        throw result.error || new Error(result.data?.error || "The malware scanner is not configured.");
      }
      await loadAuthenticatedWorkspace(state.authUser);
      showToast(
        result.data.malware_scan_status === "clean" ? "PDF security scan passed" : "PDF security scan rejected",
        result.data.malware_scan_status === "clean"
          ? "The exact stored SHA-256 is now available for the authorized signing or download workflow."
          : "The document remains blocked and cannot be signed or downloaded."
      );
    } catch (error) {
      showToast("Security scan unavailable", error?.message || "The configured malware scanner could not complete the scan.");
    }
  }

  async function handleDocumentAcknowledgement(documentId) {
    if (isReadOnlyAuditor()) {
      showToast("Acknowledgement unavailable", "The auditor role is read-only.");
      return;
    }
    const documentRecord = data.documents.find((item) => item.id === documentId);
    if (
      !documentRecord?.acknowledgementRequired
      || !documentRecord.currentVersionId
      || !documentRecord.versionPublished
    ) {
      showToast("Acknowledgement unavailable", "A published current document version is required.");
      return;
    }
    if (documentRecord.acknowledgement === 100) {
      showToast("Already acknowledged", `${documentRecord.name} is already acknowledged for this version.`);
      return;
    }
    const acknowledgedAt = new Date().toISOString();
    const result = await supabaseClient.from("document_acknowledgements").insert({
      company_id: data.company.id,
      document_id: documentRecord.id,
      document_version_id: documentRecord.currentVersionId,
      user_id: state.authUser.id,
      acknowledged_at: acknowledgedAt,
      acknowledgement_record: {
        documentVersion: documentRecord.versionNumber,
        documentVersionChecksumSha256: documentRecord.versionChecksumSha256,
        acknowledgedBy: state.authUser.id,
        acknowledgedAt
      }
    });
    if (result.error) {
      showToast("Acknowledgement not recorded", result.error.message || "Supabase rejected the acknowledgement.");
      return;
    }
    await loadAuthenticatedWorkspace(state.authUser);
    showToast("Acknowledgement recorded", "Supabase stored the user, exact document version, checksum reference, and timestamp.");
  }

  async function handleFormUploadSubmit(form) {
    if (!localUploadStagingEnabled) {
      showToast(
        "Upload service required",
        "Deploy the private prepare, malware-scan, and commit workflow before adding company originals."
      );
      return;
    }
    const formData = new FormData(form);
    const file = formData.get("file");
    const submitButton = form.querySelector('button[type="submit"]');
    if (!file?.name) {
      showToast("Choose a source file", "Select a PDF, DOCX, or XLSX file before saving.");
      return;
    }

    const extension = String(file.name).split(".").pop().toLowerCase();
    if (!allowedFormUploadExtensions.has(extension) || (file.type && !allowedFormUploadTypes.has(file.type))) {
      showToast("Unsupported form file", "Use a PDF, DOCX, or XLSX source with a matching file type.");
      return;
    }
    if (!file.size || file.size > maxFormUploadBytes) {
      showToast("File size not allowed", "The source must contain data and be no larger than 25 MB.");
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Calculating SHA-256…";
    }

    try {
      const sha256 = await sha256Hex(file);
      if (state.localFormUploads.some((item) => item.sha256 === sha256)) {
        throw new Error("That exact file is already in My uploads.");
      }
      const createdAt = new Date().toISOString();
      const locationId = String(formData.get("location_id") || "all");
      const record = {
        id: window.crypto.randomUUID ? `upload-${window.crypto.randomUUID()}` : `upload-${Date.now()}`,
        recordKind: "upload",
        type: "Uploaded form",
        companyId: data.company.id,
        userId: localFormUploadOwnerId(),
        title: String(formData.get("title") || file.name).trim(),
        category: String(formData.get("category") || "Other company form"),
        locationIds: [locationId],
        locations: [locationId],
        filename: file.name,
        extension,
        mimeType: file.type || {
          pdf: "application/pdf",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }[extension],
        sizeBytes: file.size,
        sha256,
        blob: file,
        privacy: "Private tenant file",
        sourceSystem: "Manual upload",
        storageMode: "indexeddb",
        syncStatus: "local_only",
        createdBy: data.currentUser.name,
        createdAt
      };
      await putLocalFormUpload(record);
      state.localFormUploads = await listLocalFormUploads();
      state.modal = null;
      state.selectedTemplateId = null;
      state.view = "programs";
      state.programCategory = "forms";
      state.formLibraryMode = "uploads";
      localStorage.setItem(`${uiStoragePrefix}formsMode`, state.formLibraryMode);
      render();
      showToast("Company form saved locally", `${file.name} was fingerprinted and added to My uploads on this device.`);
    } catch (error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Fingerprint & save locally";
      }
      showToast("Form was not saved", error?.message || "The private local store is unavailable.");
    }
  }

  async function downloadLocalFormUpload(id) {
    try {
      const record = await getLocalFormUpload(id);
      const ownerId = localFormUploadOwnerId();
      const correctOwner = record?.userId === ownerId;
      if (
        !record
        || record.companyId !== data.company.id
        || !correctOwner
        || !(record.blob instanceof Blob)
      ) {
        throw new Error("The private local copy is not available.");
      }
      const url = URL.createObjectURL(record.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = record.filename;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      showToast("Download unavailable", error?.message || "The form could not be read from this device.");
    }
  }

  async function requestOriginalFormDownload(formId) {
    const template = allFormTemplates().find((item) => item.id === formId);
    const formFileId = template?.originalFile?.id;
    if (!formFileId) {
      showToast("Original unavailable", "No controlled original is linked to this template version.");
      return;
    }
    try {
      const metadataResult = await supabaseClient.rpc("get_safety_program_form_file_metadata", {
        target_form_file_id: formFileId
      });
      if (metadataResult.error) throw metadataResult.error;
      const metadata = Array.isArray(metadataResult.data)
        ? metadataResult.data[0]
        : metadataResult.data;
      if (!metadata) throw new Error("Access to this original was not authorized.");
      if (!supabaseClient.functions?.invoke) {
        throw new Error("The short-lived download service is not deployed yet.");
      }
      const signedResult = await supabaseClient.functions.invoke("sign-form-file", {
        body: { form_file_id: formFileId }
      });
      if (signedResult.error) throw signedResult.error;
      const signedUrl = signedResult.data?.signed_url;
      const parsedUrl = new URL(signedUrl);
      if (parsedUrl.protocol !== "https:") throw new Error("The download service returned an invalid URL.");
      const link = document.createElement("a");
      link.href = parsedUrl.href;
      link.download = metadata.filename || "company-form";
      link.rel = "noopener noreferrer";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      showToast("Original download started", `${metadata.filename} is downloading.`);
    } catch (error) {
      showToast("Original unavailable", error?.message || "The original could not be downloaded.");
    }
  }

  async function handleImportCandidateReview(form) {
    if (!canManageCompany() || !supabaseClient) {
      showToast("Review not saved", "Corporate administrator or safety manager access is required.");
      return;
    }
    const formData = new FormData(form);
    const candidateId = String(formData.get("candidate_id") || "");
    const candidate = (programLibrary.importCandidates || []).find((item) => item.id === candidateId);
    const reviewStatus = String(formData.get("review_status") || "");
    if (!candidate || !importCandidateReviewStatuses.includes(reviewStatus)) {
      showToast("Review not saved", "Choose a valid archive candidate and review status.");
      return;
    }
    if (["duplicate", "imported", "superseded"].includes(candidate.reviewStatus)) {
      showToast("Review not saved", "This candidate is in a terminal review state.");
      return;
    }
    const accessScope = forcesPrivateCandidateAccess(candidate)
      ? "safety_admin_private"
      : formData.get("safety_admin_private") === "true"
        ? "safety_admin_private"
        : "company";

    state.candidateReviewSavingId = candidate.id;
    render();
    try {
      const result = await supabaseClient.rpc("update_safety_program_import_candidate_review", {
        target_candidate_id: candidate.id,
        target_access_scope: accessScope,
        target_review_status: reviewStatus
      });
      if (result.error) throw result.error;
      const saved = Array.isArray(result.data) ? result.data[0] : result.data;
      candidate.reviewStatus = importCandidateReviewStatuses.includes(saved?.review_status)
        ? saved.review_status
        : reviewStatus;
      candidate.accessScope = saved?.access_scope === "company"
        && !forcesPrivateCandidateAccess(candidate)
        ? "company"
        : accessScope;
      state.candidateReviewSavingId = null;
      render();
      showToast(
        "Review saved",
        `${candidate.displayName} is ${candidate.accessScope === "company" ? "available to authenticated company members" : "Safety/admin private"}.`
      );
    } catch (error) {
      state.candidateReviewSavingId = null;
      render();
      showToast("Review not saved", error?.message || "The candidate review could not be updated.");
    }
  }

  async function requestImportCandidateDownload(candidateId) {
    const candidate = importCandidateRows().find((item) => item.id === candidateId);
    if (!isSignedInCompanyMember() || !candidate) {
      showToast("Original unavailable", "This original is not available with your signed-in company access.");
      return;
    }
    if (!downloadableImportCandidateStatuses.has(candidate.reviewStatus)) {
      showToast("Original unavailable", `Downloads are unavailable while review status is ${readableStatus(candidate.reviewStatus)}.`);
      return;
    }
    if (
      candidate.classification === "restricted"
      && !window.confirm("This is a restricted personnel or sensitive safety record. Confirm that you have a business need to download it.")
    ) {
      showToast("Download cancelled", "The restricted original was not opened.");
      return;
    }
    try {
      if (!supabaseClient?.functions?.invoke) {
        throw new Error("The short-lived download service is not deployed yet.");
      }
      const signedResult = await supabaseClient.functions.invoke("sign-form-file", {
        body: { candidate_id: candidate.id }
      });
      if (signedResult.error) throw signedResult.error;
      const metadata = signedResult.data || {};
      const metadataMatches = (
        metadata.filename === candidate.displayName
        && metadata.mime_type === candidate.mimeType
        && Number(metadata.size_bytes) === candidate.sizeBytes
        && metadata.content_sha256 === candidate.contentSha256
        && Number(metadata.page_count || 0) === candidate.pageCount
        && Boolean(metadata.render_verified) === candidate.renderVerified
      );
      if (!metadataMatches) {
        throw new Error("The authorized file metadata does not match the reviewed archive record.");
      }
      const expiresAt = Date.parse(metadata.expires_at || "");
      if (
        !Number.isFinite(expiresAt)
        || expiresAt <= Date.now()
        || expiresAt > Date.now() + 10 * 60 * 1000
      ) {
        throw new Error("The download authorization has an invalid expiration.");
      }
      const signedUrl = metadata.signed_url;
      const parsedUrl = new URL(signedUrl);
      const projectHost = new URL(window.SAFETYOPS_SUPABASE_URL).hostname;
      if (
        parsedUrl.protocol !== "https:"
        || parsedUrl.hostname !== projectHost
        || !parsedUrl.pathname.startsWith("/storage/v1/object/sign/")
      ) {
        throw new Error("The download service returned an invalid URL.");
      }
      const link = document.createElement("a");
      link.href = parsedUrl.href;
      link.download = metadata.filename || "company-safety-original";
      link.rel = "noopener noreferrer";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      showToast("Original download started", `${candidate.displayName} is downloading according to its company access setting.`);
    } catch (error) {
      showToast("Original unavailable", error?.message || "The original could not be downloaded.");
    }
  }

  function formAnswerValues(form, template) {
    const formData = new FormData(form);
    const answers = {};
    template.fields.forEach((field) => {
      if (field.type === "instruction") return;
      if (field.type === "file") {
        const input = form.elements.namedItem(field.id);
        answers[field.id] = Array.from(input?.files || []);
        return;
      }
      const values = formData.getAll(field.id).map((value) => String(value));
      answers[field.id] = values.length === 1 ? values[0] : values;
    });
    return answers;
  }

  function typedProgramAnswerRow(field, rawValue, submissionId, template) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const hasValue = values.some((value) => String(value ?? "").trim() !== "");
    if (!hasValue || ["instruction", "signature", "acknowledgement", "file"].includes(field.type)) {
      return null;
    }
    const row = {
      company_id: data.company.id,
      form_template_version_id: template.formTemplateVersionId,
      submission_id: submissionId,
      field_id: field.databaseId,
      field_snapshot: {},
      answered_by: state.authUser.id
    };
    if (["text", "textarea", "employee", "location", "select"].includes(field.type)) {
      row.value_text = String(values[0]);
    } else if (field.type === "number") {
      row.value_number = Number(values[0]);
    } else if (field.type === "yesno") {
      row.value_boolean = String(values[0]).toLowerCase() === "yes";
    } else if (field.type === "date") {
      row.value_date = String(values[0]);
    } else if (field.type === "time") {
      row.value_time = String(values[0]);
    } else if (field.type === "datetime-local") {
      row.value_timestamptz = new Date(String(values[0])).toISOString();
    } else if (field.type === "multiselect") {
      row.value_json = values;
    } else {
      row.value_text = String(values[0]);
    }
    return row;
  }

  async function saveProgramFormRecord(form, status) {
    const template = allFormTemplates().find((item) => item.id === form.dataset.formId);
    if (!formAvailableForSubmission(template)) {
      showToast("Form unavailable", "This form needs a published schema and reviewed location applicability before it can be used.");
      return;
    }
    const submitButton = form.querySelector('button[type="submit"]');
    const draftButton = form.querySelector('[data-action="save-program-form-draft"]');
    if (submitButton) submitButton.disabled = true;
    if (draftButton) draftButton.disabled = true;
    try {
      const answers = formAnswerValues(form, template);
      const hasFiles = template.fields.some((field) =>
        field.type === "file" && (answers[field.id] || []).length
      );
      if (hasFiles) {
        throw new Error("Answer attachments require the private scan-and-commit service, which is not deployed yet.");
      }
      const locationField = template.fields.find((field) => field.type === "location");
      const requestedLocationId = locationField
        ? String(answers[locationField.id] || "")
        : state.locationId !== "all"
          ? state.locationId
          : template.locations[0];
      if (!template.locations.includes(requestedLocationId)) {
        throw new Error("Choose a location with reviewed applicability for this program version.");
      }
      const matchingAssignment = (data.programAssignments || []).find((assignment) => (
        assignment.formTemplateVersionId === template.formTemplateVersionId
        && assignment.locationId === requestedLocationId
        && assignment.assigneeUserId === state.authUser.id
        && !["Completed", "Waived", "Cancelled"].includes(assignment.status)
      ));
      const clientKey = window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `submission-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const draftResult = await supabaseClient
        .from("safety_program_form_submissions")
        .insert({
          company_id: data.company.id,
          program_version_id: template.programVersionId,
          location_id: requestedLocationId,
          form_template_version_id: template.formTemplateVersionId,
          assignment_id: matchingAssignment?.id || null,
          submitted_by: state.authUser.id,
          status: "draft",
          client_submission_key: clientKey,
          form_schema_sha256: template.schemaSha256
        })
        .select("id")
        .single();
      if (draftResult.error) throw draftResult.error;

      const answerRows = template.fields
        .map((field) => typedProgramAnswerRow(
          field,
          answers[field.id],
          draftResult.data.id,
          template
        ))
        .filter(Boolean);
      if (answerRows.length) {
        const answerResult = await supabaseClient
          .from("safety_program_form_answers")
          .insert(answerRows);
        if (answerResult.error) throw answerResult.error;
      }

      if (status === "Submitted") {
        const signatureFields = template.fields.filter((field) =>
          ["signature", "acknowledgement"].includes(field.type)
        );
        const signatureRows = [];
        for (const field of signatureFields) {
          const rawValue = answers[field.id];
          const hasIntent = Array.isArray(rawValue) ? rawValue.length > 0 : Boolean(rawValue);
          if (!hasIntent) continue;
          signatureRows.push({
            company_id: data.company.id,
            form_template_version_id: template.formTemplateVersionId,
            submission_id: draftResult.data.id,
            field_id: field.databaseId,
            signer_user_id: state.authUser.id
          });
        }
        if (signatureRows.length) {
          const signatureResult = await supabaseClient
            .from("safety_program_form_signatures")
            .insert(signatureRows);
          if (signatureResult.error) throw signatureResult.error;
        }
        const submitResult = await supabaseClient.rpc("submit_safety_program_form", {
          target_submission_id: draftResult.data.id
        });
        if (submitResult.error) throw submitResult.error;
      }

      state.activeFormId = null;
      state.programCategory = "forms";
      state.formLibraryMode = "templates";
      localStorage.setItem(`${uiStoragePrefix}formsMode`, state.formLibraryMode);
      state.view = "programs";
      await loadAuthenticatedWorkspace(state.authUser);
      showToast(
        status === "Submitted" ? "Digital form submitted" : "Draft saved",
        `${template.title} is stored in Supabase with its pinned program, schema, location, and regulatory context.`
      );
    } catch (error) {
      if (submitButton) submitButton.disabled = false;
      if (draftButton) draftButton.disabled = false;
      showToast("Form was not saved", error?.message || "Supabase rejected the form record.");
    }
  }

  async function recordProgramAssignment(programId) {
    const item = (programLibrary.programs || []).find((record) => record.id === programId);
    if (!item?.programVersionId || item.programStatus !== "published") {
      showToast("Assignment unavailable", "Publish the controlled program version before assigning it.");
      return;
    }
    if (!canWriteLocation()) {
      showToast("Assignment unavailable", "Your role cannot assign safety programs for the selected location.");
      return;
    }
    const locationIds = (state.locationId === "all"
      ? item.locations || []
      : (item.locations || []).filter((locationId) => locationId === state.locationId))
      .filter((locationId) => canWriteLocation(locationId));
    if (!locationIds.length) {
      showToast("Assignment unavailable", "Select a location where this program has reviewed applicability.");
      return;
    }
    const dueAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const rows = locationIds.map((locationId) => ({
      company_id: data.company.id,
      program_version_id: item.programVersionId,
      location_id: locationId,
      assignee_user_id: state.authUser.id,
      assignment_type: "read_and_acknowledge",
      title: `Acknowledge ${item.title}`,
      instructions: "Read the published program and complete the acknowledgement.",
      status: "assigned",
      due_at: dueAt,
      assigned_by: state.authUser.id
    }));
    const result = await supabaseClient.from("safety_program_assignments").insert(rows);
    if (result.error) {
      showToast("Assignment not created", result.error.message || "Supabase rejected the assignment.");
      return;
    }
    await loadAuthenticatedWorkspace(state.authUser);
    showToast(
      "Acknowledgement assigned",
      `${item.title} was assigned to you at ${locationIds.length} applicable location${locationIds.length === 1 ? "" : "s"}.`
    );
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "close-handoff-window") {
      window.close();
      return;
    }

    if (action === "auth-mode") {
      const requestedMode = target.dataset.mode;
      state.authMode = requestedMode === "recovery"
        ? "recovery"
        : requestedMode === "sign-up" && publicSignupEnabled
          ? "sign-up"
          : "sign-in";
      state.authMessage = "";
      render();
      return;
    }

    if (action === "auth-sign-out") {
      handleAuthSignOut();
      return;
    }

    if (action === "navigate") {
      navigate(target.dataset.view);
      return;
    }

    if (action === "toggle-sidebar") {
      state.sidebarOpen = !state.sidebarOpen;
      render();
      return;
    }

    if (action === "toggle-theme") {
      state.theme = state.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = state.theme;
      localStorage.setItem(`${uiStoragePrefix}theme`, state.theme);
      render();
      return;
    }

    if (action === "open-reference") {
      openReference(target.dataset.referenceId, target);
      return;
    }

    if (action === "close-reference") {
      closeReference();
      return;
    }

    if (action === "backdrop-close-reference" && event.target === target) {
      closeReference();
      return;
    }

    if (action === "standards-mode") {
      state.standardMode = target.dataset.mode === "all" ? "all" : "manufacturing";
      render();
      return;
    }

    if (action === "standards-topic") {
      state.standardQuery = target.dataset.query || "";
      state.standardMode = "all";
      state.standardPart = "all";
      state.standardScope = "all";
      render();
      requestAnimationFrame(() => document.querySelector("#standards-query")?.focus());
      return;
    }

    if (action === "standards-authority") {
      const authority = target.dataset.authority;
      state.standardAuthority = ["location", "federal", "combined"].includes(authority)
        ? authority
        : "location";
      state.standardPart = "all";
      state.standardScope = "all";
      render();
      return;
    }

    if (action === "program-category") {
      state.programCategory = target.dataset.category || "programs";
      render();
      return;
    }

    if (action === "form-library-mode") {
      const allowedModes = new Set([
        "originals",
        "templates",
        ...(isSignedInCompanyMember() ? ["archive"] : []),
        ...(localUploadStagingEnabled ? ["uploads"] : [])
      ]);
      state.formLibraryMode = allowedModes.has(target.dataset.mode) ? target.dataset.mode : "originals";
      localStorage.setItem(`${uiStoragePrefix}formsMode`, state.formLibraryMode);
      render();
      return;
    }

    if (action === "form-archive-kind") {
      const requestedKind = target.dataset.kind || "all";
      state.formArchiveKind = requestedKind === "all"
        || importCandidateKinds.some((definition) => definition.id === requestedKind)
        ? requestedKind
        : "all";
      localStorage.setItem(`${uiStoragePrefix}formArchiveKind`, state.formArchiveKind);
      render();
      return;
    }

    if (action === "view-form-original") {
      state.originalPreviewId = target.dataset.formId;
      state.programDrawerId = null;
      state.activeFormId = null;
      render();
      requestAnimationFrame(() => document.querySelector(".pdf-preview-modal .icon-button")?.focus());
      return;
    }

    if (action === "download-form-original") {
      requestOriginalFormDownload(target.dataset.formId);
      return;
    }

    if (action === "download-import-candidate") {
      requestImportCandidateDownload(target.dataset.candidateId);
      return;
    }

    if (action === "close-original-preview") {
      state.originalPreviewId = null;
      render();
      return;
    }

    if (action === "backdrop-close-original-preview" && event.target === target) {
      state.originalPreviewId = null;
      render();
      return;
    }

    if (action === "download-form-upload") {
      downloadLocalFormUpload(target.dataset.uploadId);
      return;
    }

    if (action === "clear-program-search") {
      state.programQuery = "";
      render();
      requestAnimationFrame(() => document.querySelector("#program-query")?.focus());
      return;
    }

    if (action === "open-program") {
      state.programDrawerId = target.dataset.programId;
      state.referenceId = null;
      render();
      requestAnimationFrame(() => document.querySelector(".program-detail-drawer .icon-button")?.focus());
      return;
    }

    if (action === "close-program") {
      state.programDrawerId = null;
      render();
      return;
    }

    if (action === "backdrop-close-program" && event.target === target) {
      state.programDrawerId = null;
      render();
      return;
    }

    if (action === "start-program-form") {
      const template = allFormTemplates().find((item) => item.id === target.dataset.formId);
      if (!formAvailableForSubmission(template)) {
        showToast(
          isReadOnlyAuditor() ? "Read-only auditor role" : "Form unavailable",
          isReadOnlyAuditor()
            ? "Auditors can review authorized records but cannot create or sign form submissions."
            : "This form requires a published schema and reviewed, effective location applicability."
        );
        return;
      }
      state.activeFormId = target.dataset.formId;
      state.programDrawerId = null;
      state.originalPreviewId = null;
      state.modal = null;
      render();
      requestAnimationFrame(() => document.querySelector("#program-form-runner input, #program-form-runner select, #program-form-runner textarea")?.focus());
      return;
    }

    if (action === "close-program-form") {
      state.activeFormId = null;
      render();
      return;
    }

    if (action === "backdrop-close-program-form" && event.target === target) {
      state.activeFormId = null;
      render();
      return;
    }

    if (action === "save-program-form-draft") {
      const form = document.querySelector("#program-form-runner");
      if (form) saveProgramFormRecord(form, "Draft");
      return;
    }

    if (action === "assign-program") {
      recordProgramAssignment(target.dataset.programId);
      return;
    }

    if (action === "program-import-status") {
      showToast(
        programLibraryItems().length ? "Secure ingestion staged" : "Tenant library is empty",
        programLibraryItems().length
          ? "The source hierarchy and identities are indexed. Private binary sync, review, and publication use the configured Supabase tenant."
          : "The public GitHub shell has no company files. Create a company or sign in before connecting a private source library."
      );
      return;
    }

    if (action === "check-osha-update") {
      showToast(
        "Official source status",
        `Title 29 is indexed through ${regulatory.meta.currentThrough || "an unavailable date"}; automated production sync will create review tasks when source hashes change.`
      );
      return;
    }

    if (action === "open-modal") {
      state.employeeDrawerId = null;
      openModal(
        target.dataset.modal,
        target.dataset.templateId || target.dataset.courseId,
        { ...target.dataset }
      );
      return;
    }

    if (action === "open-employee") {
      state.employeeDrawerId = target.dataset.employeeId;
      render();
      requestAnimationFrame(() => document.querySelector(".employee-record-drawer .icon-button")?.focus());
      return;
    }

    if (action === "close-employee") {
      state.employeeDrawerId = null;
      render();
      return;
    }

    if (action === "backdrop-close-employee" && event.target === target) {
      state.employeeDrawerId = null;
      render();
      return;
    }

    if (action === "start-employee-form-handoff") {
      startEmployeeFormHandoff(target.dataset.assignmentId);
      return;
    }

    if (action === "open-employee-sign") {
      state.modal = "employee-sign";
      state.modalContext = { documentId: target.dataset.documentId };
      state.employeeDrawerId = null;
      render();
      requestAnimationFrame(() => document.querySelector("#employee-sign-form input")?.focus());
      return;
    }

    if (action === "download-employee-document") {
      downloadEmployeeDocument(target.dataset.documentId);
      return;
    }

    if (action === "retry-employee-document-scan") {
      retryEmployeeDocumentScan(target.dataset.documentId);
      return;
    }

    if (action === "finalize-committee") {
      finalizeCommitteeMeeting(target.dataset.meetingId);
      return;
    }

    if (action === "close-modal") {
      closeModal();
      return;
    }

    if (action === "backdrop-close" && event.target === target) {
      closeModal();
      return;
    }

    if (action === "prototype-action") {
      showToast("Workflow not enabled", target.dataset.message || "This workflow still requires its server-side authority.");
      return;
    }

    if (action === "select-location") {
      state.locationId = target.dataset.locationId;
      navigate("dashboard");
      return;
    }

    if (action === "acknowledge-document") {
      handleDocumentAcknowledgement(target.dataset.documentId);
      return;
    }

    if (action === "retry-workspace" && state.authUser) {
      state.authStatus = "loading";
      state.authMessage = "";
      render();
      loadAuthenticatedWorkspace(state.authUser);
      return;
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "employee-form-location") {
      const locationId = event.target.value;
      const people = data.people.filter((person) =>
        person.locationIds?.includes(locationId) && person.employmentStatus !== "Separated"
      );
      const templates = allFormTemplates().filter((template) => (
        formAvailableForSubmission(template)
        && template.locations?.includes(locationId)
        && !(template.fields || []).some((field) => field.databaseType === "file")
      ));
      const employeeSelect = document.querySelector("#employee-form-employee");
      const templateSelect = document.querySelector("#employee-form-template");
      const submitButton = document.querySelector('#employee-form-assignment-form button[type="submit"]');
      if (employeeSelect) employeeSelect.innerHTML = people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("") || `<option value="">No employees at this location</option>`;
      if (templateSelect) templateSelect.innerHTML = templates.map((template) => `<option value="${template.formTemplateVersionId}">${escapeHtml(template.title)} Â· ${escapeHtml(template.version)}</option>`).join("") || `<option value="">No eligible published forms</option>`;
      if (submitButton) submitButton.disabled = !people.length || !templates.length;
      return;
    }
    if (event.target.id === "training-location") {
      const people = data.people.filter((person) =>
        person.locationIds?.includes(event.target.value) && person.employmentStatus !== "Separated"
      );
      const employeeSelect = document.querySelector("#training-employee");
      if (employeeSelect) employeeSelect.innerHTML = `<option value="all">All employees at this location</option>${people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")}`;
      return;
    }
    if (event.target.id === "employee-document-location") {
      const people = data.people.filter((person) =>
        person.locationIds?.includes(event.target.value) && person.employmentStatus !== "Separated"
      );
      const employeeSelect = document.querySelector("#employee-document-employee");
      const submitButton = document.querySelector('#employee-document-form button[type="submit"]');
      if (employeeSelect) employeeSelect.innerHTML = people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("") || `<option value="">No employees at this location</option>`;
      if (submitButton) submitButton.disabled = !people.length;
      return;
    }
    if (event.target.id === "location-create-state") {
      const timezoneSelect = document.querySelector("#location-create-timezone");
      const boiseOption = timezoneSelect?.querySelector('option[value="America/Boise"]');
      const allowsOregonMountainTime = event.target.value === "OR";
      if (boiseOption) boiseOption.disabled = !allowsOregonMountainTime;
      if (!allowsOregonMountainTime && timezoneSelect?.value === "America/Boise") {
        timezoneSelect.value = "America/Los_Angeles";
      }
      return;
    }
    if (event.target.id === "form-upload-file") {
      const titleInput = document.querySelector("#form-upload-title-input");
      const selectedFile = event.target.files?.[0];
      if (titleInput && selectedFile && !titleInput.value.trim()) {
        titleInput.value = selectedFile.name.replace(/\.[^.]+$/, "").replaceAll(/[_-]+/g, " ");
      }
      return;
    }
    if (event.target.id === "action-location") {
      const eligibleOwners = data.people.filter((person) =>
        person.locationIds?.includes(event.target.value)
      );
      const ownerSelect = document.querySelector("#action-owner");
      const submitButton = document.querySelector("#action-form button[type='submit']");
      if (ownerSelect) {
        ownerSelect.innerHTML = eligibleOwners.length
          ? eligibleOwners.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("")
          : `<option value="">No authorized owner at this location</option>`;
        ownerSelect.disabled = !eligibleOwners.length;
      }
      if (submitButton) submitButton.disabled = !eligibleOwners.length;
      return;
    }
    if (event.target.id === "location-select") {
      state.locationId = event.target.value;
      if (state.view === "standards") {
        state.standardAuthority = "location";
        state.standardMode = "manufacturing";
        state.standardPart = "all";
        state.standardScope = "all";
      }
      render();
      return;
    }
    if (event.target.id === "standards-part") {
      state.standardPart = event.target.value;
      render();
      return;
    }
    if (event.target.id === "standards-scope") {
      state.standardScope = event.target.value;
      render();
      return;
    }
    if (event.target.id === "form-archive-status") {
      state.formArchiveStatus = event.target.value || "all";
      localStorage.setItem(`${uiStoragePrefix}formArchiveStatus`, state.formArchiveStatus);
      render();
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "employee-handoff-form") {
      event.preventDefault();
      handleEmployeeHandoffSubmit(event.target);
      return;
    }
    if (event.target.id === "auth-signin-form" || event.target.id === "auth-signup-form") {
      event.preventDefault();
      handleAuthSubmit(event.target);
      return;
    }

    if (event.target.id === "auth-recovery-form") {
      event.preventDefault();
      handleRecoveryRequest(event.target);
      return;
    }

    if (event.target.id === "auth-password-setup-form") {
      event.preventDefault();
      handlePasswordSetup(event.target);
      return;
    }

    if (event.target.id === "location-create-form") {
      event.preventDefault();
      handleLocationCreate(event.target);
      return;
    }

    if (event.target.matches("[data-candidate-review-form]")) {
      event.preventDefault();
      handleImportCandidateReview(event.target);
      return;
    }

    if (event.target.id === "form-upload-form") {
      event.preventDefault();
      handleFormUploadSubmit(event.target);
      return;
    }

    if (event.target.id === "program-search-form") {
      event.preventDefault();
      const formData = new FormData(event.target);
      state.programQuery = String(formData.get("query") || "").trim();
      render();
      requestAnimationFrame(() => document.querySelector("#program-query")?.focus());
      return;
    }

    if (event.target.id === "program-form-runner") {
      event.preventDefault();
      saveProgramFormRecord(event.target, "Submitted");
      return;
    }

    if (event.target.id === "standards-filter-form") {
      event.preventDefault();
      const formData = new FormData(event.target);
      state.standardQuery = String(formData.get("query") || "").trim();
      state.standardPart = String(formData.get("part") || "all");
      state.standardScope = String(formData.get("scope") || "all");
      state.standardMode = "all";
      render();
      requestAnimationFrame(() => document.querySelector("#standards-query")?.focus());
      return;
    }

    if (event.target.id === "search-form") {
      event.preventDefault();
      const formData = new FormData(event.target);
      state.searchQuery = String(formData.get("query") || "").trim();
      if (state.searchQuery) navigate("search");
      return;
    }

    if (event.target.id === "inspection-form") {
      event.preventDefault();
      handleInspectionSubmit(event.target);
      return;
    }

    if (event.target.id === "incident-form") {
      event.preventDefault();
      handleIncidentSubmit(event.target);
      return;
    }

    if (event.target.id === "training-form") {
      event.preventDefault();
      handleTrainingSubmit(event.target);
      return;
    }

    if (event.target.id === "committee-form") {
      event.preventDefault();
      handleCommitteeSubmit(event.target);
      return;
    }

    if (event.target.id === "employee-form") {
      event.preventDefault();
      handleEmployeeSubmit(event.target);
      return;
    }

    if (event.target.id === "training-completion-form") {
      event.preventDefault();
      handleTrainingCompletionSubmit(event.target);
      return;
    }

    if (event.target.id === "employee-form-assignment-form") {
      event.preventDefault();
      handleEmployeeFormAssignmentSubmit(event.target);
      return;
    }

    if (event.target.id === "employee-document-form") {
      event.preventDefault();
      handleEmployeeDocumentSubmit(event.target);
      return;
    }

    if (event.target.id === "employee-sign-form") {
      event.preventDefault();
      handleEmployeeSignSubmit(event.target);
      return;
    }

    if (event.target.id === "action-form") {
      event.preventDefault();
      handleActionSubmit(event.target);
      return;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.referenceId) {
      closeReference();
      return;
    }
    if (event.key === "Escape" && state.originalPreviewId) {
      state.originalPreviewId = null;
      render();
      return;
    }
    if (event.key === "Escape" && state.activeFormId) {
      state.activeFormId = null;
      render();
      return;
    }
    if (event.key === "Escape" && state.programDrawerId) {
      state.programDrawerId = null;
      render();
      return;
    }
    if (event.key === "Escape" && state.employeeDrawerId) {
      state.employeeDrawerId = null;
      render();
      return;
    }
    if (event.key === "Escape" && state.modal) closeModal();
    if (event.key === "/" && !state.modal && !state.referenceId && !state.originalPreviewId && !state.activeFormId && !state.programDrawerId && !state.employeeDrawerId && document.activeElement?.tagName !== "INPUT") {
      event.preventDefault();
      document.querySelector("#global-search")?.focus();
    }
  });

  window.addEventListener("focus", () => {
    if (!isEmployeeHandoffMode && state.authStatus === "ready" && state.authUser) {
      loadAuthenticatedWorkspace(state.authUser);
    }
  });

  render();
  if (supabaseClient && isEmployeeHandoffMode) {
    loadEmployeeHandoff();
  } else if (supabaseClient) {
    initializeAuth();
  } else if (localUploadStagingEnabled) {
    hydrateLocalFormUploads();
  }
})();
