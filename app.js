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
  const programLibrary = window.SafetyOpsProgramLibrary || {
    meta: { counts: {} },
    programs: [],
    forms: [],
    folders: [],
    looseResources: []
  };
  const uiStoragePrefix = "safetyops.ui.";

  const state = {
    view: localStorage.getItem(`${uiStoragePrefix}view`) || "dashboard",
    locationId: localStorage.getItem(`${uiStoragePrefix}location`) || "all",
    theme: localStorage.getItem(`${uiStoragePrefix}theme`) || "light",
    sidebarOpen: false,
    searchQuery: "",
    standardQuery: "",
    standardPart: "all",
    standardScope: "all",
    standardMode: "featured",
    referenceId: null,
    programCategory: "programs",
    programQuery: "",
    formLibraryMode: localStorage.getItem(`${uiStoragePrefix}formsMode`) || "originals",
    localFormUploads: [],
    programDrawerId: null,
    originalPreviewId: null,
    activeFormId: null,
    modal: null,
    selectedTemplateId: null,
    authStatus: "demo",
    authMode: "sign-in",
    authUser: null,
    authMessage: "",
    authBusy: false
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
  if (!["originals", "uploads", "templates"].includes(state.formLibraryMode)) {
    state.formLibraryMode = "originals";
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
  if (hasSupabaseConfig) {
    try {
      supabaseClient = window.supabase.createClient(
        window.SAFETYOPS_SUPABASE_URL,
        window.SAFETYOPS_SUPABASE_ANON_KEY
      );
    } catch (_error) {
      supabaseClient = null;
    }
  }
  state.authStatus = supabaseClient ? "loading" : "demo";

  document.documentElement.dataset.theme = state.theme;

  const navGroups = [
    {
      label: "Overview",
      items: [
        { id: "dashboard", label: "Command center", icon: "01" },
        { id: "my-work", label: "My work", icon: "✓", count: 5 }
      ]
    },
    {
      label: "Safety operations",
      items: [
        { id: "inspections", label: "Forms & inspections", icon: "F" },
        { id: "training", label: "Training", icon: "T", count: 12 },
        { id: "incidents", label: "Incidents", icon: "!", count: 2, danger: true },
        { id: "actions", label: "Corrective actions", icon: "A", count: 5 }
      ]
    },
    {
      label: "Compliance",
      items: [
        { id: "programs", label: "Safety programs", icon: "P" },
        { id: "standards", label: "OSHA reference", icon: "§" },
        { id: "documents", label: "Controlled documents", icon: "D" },
        { id: "people", label: "People & credentials", icon: "P" },
        { id: "locations", label: "Locations", icon: "L" }
      ]
    },
    {
      label: "Workspace",
      items: [
        { id: "settings", label: "Settings", icon: "S" }
      ]
    }
  ];

  const pageMeta = {
    dashboard: {
      eyebrow: "All-location overview",
      title: "Safety command center",
      description: "See what needs attention across training, inspections, incidents, and controlled documents."
    },
    "my-work": {
      eyebrow: "Personal queue",
      title: "My work",
      description: "One ordered list of the assignments, reviews, and follow-ups that need your attention."
    },
    inspections: {
      eyebrow: "Field assurance",
      title: "Forms & inspections",
      description: "Schedule repeatable work, capture evidence in the field, and turn findings into accountable actions."
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
      title: "Corrective actions",
      description: "Keep findings from inspections, hazards, and incidents visible until evidence is reviewed and accepted."
    },
    documents: {
      eyebrow: "Controlled library",
      title: "Documents",
      description: "Publish the right version, target the right locations, and prove that required workers acknowledged it."
    },
    programs: {
      eyebrow: "Private source library",
      title: "Safety programs & forms",
      description: "Use the company program library, complete digital forms, assign acknowledgements, and trace every record back to its source."
    },
    standards: {
      eyebrow: "Regulatory library",
      title: "OSHA standards reference",
      description: "Search verified federal standards and state-plan overlays, then trace them to company controls and records."
    },
    people: {
      eyebrow: "Workforce compliance",
      title: "People & credentials",
      description: "Connect each worker’s location access, training, certifications, and role in one readiness record."
    },
    locations: {
      eyebrow: "Company workspace",
      title: "Locations",
      description: "Standardize the company program while preserving local owners, schedules, risks, and performance."
    },
    settings: {
      eyebrow: "Prototype administration",
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
    return records.filter((record) => record.locationId === state.locationId);
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

  function standardById(id) {
    return regulatory.standards.find((standard) => standard.id === id);
  }

  function standardByIdentifier(identifier) {
    return regulatory.standards.find((standard) => standard.identifier === identifier);
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
    const currentThrough = requirement?.currentThrough || standard.currentThrough || regulatory.meta.currentThrough;
    const sourceHash = requirement?.sourceSha256 || standard.sourceSha256 || regulatory.meta.structureSha256;
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
            ${statusPill("Official source", "green")}
          </div>

          <section class="reference-section">
            <h3>Plain-language summary</h3>
            <p>${escapeHtml(summary)}</p>
            <p class="reference-caution">Summary only. Read the full provision, definitions, exceptions, and jurisdiction-specific rules before making an applicability or compliance decision.</p>
          </section>

          <section class="source-fingerprint">
            <h3>Source fingerprint</h3>
            <dl>
              <div><dt>Authority</dt><dd>${escapeHtml(standard?.authority || regulatory.meta.authority)}</dd></div>
              <div><dt>Current through</dt><dd>${escapeHtml(currentThrough || "Not recorded")}</dd></div>
              <div><dt>Retrieved</dt><dd>${escapeHtml(regulatory.meta.generatedAt || "Not recorded")}</dd></div>
              <div><dt>SHA-256</dt><dd><code>${escapeHtml(sourceHash || "Pending source snapshot")}</code></dd></div>
            </dl>
            <a class="button small primary" href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">Open official source</a>
          </section>

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

  function renderAuthScreen() {
    const message = state.authMessage
      ? `<div class="auth-message" role="status">${escapeHtml(state.authMessage)}</div>`
      : "";
    let content = "";

    if (state.authStatus === "loading") {
      content = `
        <div class="auth-loading" role="status">
          <span class="auth-spinner" aria-hidden="true"></span>
          <h2>Securing your workspace</h2>
          <p>Checking your Supabase session and company membership.</p>
        </div>
      `;
    } else if (state.authStatus === "needs-company") {
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Company setup</span>
          <h2>Create your SafetyOps company</h2>
          <p>This creates an isolated tenant, makes you its corporate administrator, and adds a private Main location.</p>
        </div>
        ${message}
        <form id="company-onboarding-form" class="auth-form">
          <label for="onboarding-company-name">Company name</label>
          <input id="onboarding-company-name" name="company_name" autocomplete="organization" minlength="2" maxlength="160" required placeholder="Example Manufacturing">
          <div class="auth-boundary-note">
            <strong>Private by default</strong>
            <span>Every company row and file is scoped by company membership and Supabase RLS. GitHub receives no tenant data.</span>
          </div>
          <button class="button primary auth-submit" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Creating company…" : "Create company"}</button>
          <button class="button auth-submit" type="button" data-action="auth-sign-out">Sign out</button>
        </form>
      `;
    } else {
      const signingUp = state.authMode === "sign-up";
      content = `
        <div class="auth-card-heading">
          <span class="auth-step">Secure company access</span>
          <h2>${signingUp ? "Create your account" : "Welcome back"}</h2>
          <p>${signingUp ? "Start a new company workspace or join one by invitation." : "Sign in to your private company safety workspace."}</p>
        </div>
        <div class="tabs auth-tabs" role="tablist" aria-label="Account access">
          <button class="tab ${!signingUp ? "active" : ""}" type="button" role="tab" aria-selected="${!signingUp}" data-action="auth-mode" data-mode="sign-in">Sign in</button>
          <button class="tab ${signingUp ? "active" : ""}" type="button" role="tab" aria-selected="${signingUp}" data-action="auth-mode" data-mode="sign-up">Create account</button>
        </div>
        ${message}
        <form id="${signingUp ? "auth-signup-form" : "auth-signin-form"}" class="auth-form">
          ${signingUp ? `
            <label for="auth-full-name">Full name</label>
            <input id="auth-full-name" name="full_name" autocomplete="name" minlength="2" maxlength="120" required>
          ` : ""}
          <label for="auth-email">Email</label>
          <input id="auth-email" name="email" type="email" autocomplete="email" required>
          <label for="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" autocomplete="${signingUp ? "new-password" : "current-password"}" minlength="8" required>
          <button class="button primary auth-submit" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Please wait…" : signingUp ? "Create secure account" : "Sign in"}</button>
        </form>
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
      "inspections",
      "courses",
      "people",
      "incidents",
      "actions",
      "documents",
      "activity"
    ].forEach((key) => {
      data[key] = [];
    });
  }

  async function loadAuthenticatedWorkspace(user) {
    try {
      const membershipResult = await supabaseClient
        .from("company_memberships")
        .select("company_id, role, default_location_id, created_at")
        .eq("user_id", user.id)
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (membershipResult.error) throw membershipResult.error;

      if (!membershipResult.data) {
        state.authUser = user;
        state.authStatus = "needs-company";
        state.authBusy = false;
        render();
        return;
      }

      const membership = membershipResult.data;
      const [companyResult, locationsResult, profileResult] = await Promise.all([
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
          .order("created_at", { ascending: true }),
        supabaseClient
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle()
      ]);
      if (companyResult.error) throw companyResult.error;
      if (locationsResult.error) throw locationsResult.error;
      if (profileResult.error) throw profileResult.error;

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

      data.company = {
        id: companyResult.data.id,
        name: companyResult.data.name,
        slug: companyResult.data.slug,
        timezone: companyResult.data.timezone,
        plan: "Private Supabase workspace",
        activeWorkers: 0,
        daysWithoutRecordable: 0
      };
      data.currentUser = {
        name: fullName,
        initials,
        role: readableRole(membership.role)
      };
      data.locations = (locationsResult.data || []).map((location, index) => ({
        id: location.id,
        name: location.name,
        short: location.code,
        city: location.address || "Address not set",
        type: index === 0 ? "Primary location" : "Company location",
        manager: fullName,
        people: 0,
        training: 0,
        inspections: 0,
        openActions: 0,
        risk: "New",
        accent: ["#24a37a", "#3c8ce7", "#e0a12b", "#8b6bd6", "#df655d"][index % 5]
      }));
      resetTenantOperationalData();
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
        state.localFormUploads = await listLocalFormUploads();
      } catch (_error) {
        state.localFormUploads = [];
      }
      render();
    } catch (error) {
      state.authStatus = "signed-out";
      state.authMessage = error?.message || "The private workspace could not be loaded.";
      state.authBusy = false;
      render();
    }
  }

  async function applyAuthSession(session) {
    if (!session?.user) {
      state.authUser = null;
      state.localFormUploads = [];
      state.authStatus = "signed-out";
      state.authBusy = false;
      render();
      return;
    }
    state.authUser = session.user;
    state.authStatus = "loading";
    state.authBusy = false;
    render();
    await loadAuthenticatedWorkspace(session.user);
  }

  async function initializeAuth() {
    const sessionResult = await supabaseClient.auth.getSession();
    if (sessionResult.error) {
      state.authStatus = "signed-out";
      state.authMessage = sessionResult.error.message;
      render();
    } else {
      await applyAuthSession(sessionResult.data.session);
    }
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => applyAuthSession(session), 0);
    });
  }

  async function handleAuthSubmit(form) {
    const formData = new FormData(form);
    state.authBusy = true;
    state.authMessage = "";
    render();
    try {
      if (form.id === "auth-signin-form") {
        const result = await supabaseClient.auth.signInWithPassword({
          email: String(formData.get("email") || "").trim(),
          password: String(formData.get("password") || "")
        });
        if (result.error) throw result.error;
        await applyAuthSession(result.data.session);
        return;
      }

      const result = await supabaseClient.auth.signUp({
        email: String(formData.get("email") || "").trim(),
        password: String(formData.get("password") || ""),
        options: {
          data: { full_name: String(formData.get("full_name") || "").trim() }
        }
      });
      if (result.error) throw result.error;
      if (result.data.session) {
        await applyAuthSession(result.data.session);
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

  async function handleCompanyOnboarding(form) {
    const companyName = String(new FormData(form).get("company_name") || "").trim();
    const slugBase = companyName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42) || "company";
    const suffix = window.crypto.randomUUID
      ? window.crypto.randomUUID().slice(0, 8)
      : Date.now().toString(36);
    state.authBusy = true;
    state.authMessage = "";
    render();
    try {
      const result = await supabaseClient.rpc("create_company_with_owner", {
        company_name: companyName,
        company_slug: `${slugBase}-${suffix}`
      });
      if (result.error) throw result.error;
      await loadAuthenticatedWorkspace(state.authUser);
    } catch (error) {
      state.authStatus = "needs-company";
      state.authMessage = error?.message || "The company workspace could not be created.";
      state.authBusy = false;
      render();
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
    await applyAuthSession(null);
  }

  function navItem(item) {
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
        ${item.count ? `<span class="nav-count ${item.danger ? "danger" : ""}">${item.count}</span>` : ""}
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
            <p class="brand-subtitle">Safety command</p>
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
          <div class="connection-banner ${supabaseClient ? "" : "demo"}" title="${supabaseClient ? "Supabase client configured" : "Using fictional prototype data"}">
            <span class="status-dot" aria-hidden="true"></span>
            <span>${supabaseClient ? "Supabase ready" : "Demo workspace"}</span>
          </div>
          <button class="icon-button" type="button" data-action="navigate" data-view="settings" aria-label="Open settings">⚙</button>
        </div>
      </header>
    `;
  }

  function renderMobileNav() {
    const items = [
      { id: "dashboard", label: "Today", icon: "⌂" },
      { id: "inspections", label: "Inspect", icon: "F" },
      { id: "training", label: "Train", icon: "T" },
      { id: "standards", label: "Guide", icon: "§" },
      { id: "my-work", label: "My work", icon: "✓" }
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
    if (view === "dashboard" || view === "my-work") {
      return `
        <button class="button" type="button" data-action="open-modal" data-modal="incident">Report incident</button>
        <button class="button primary" type="button" data-action="open-modal" data-modal="inspection">Start inspection</button>
      `;
    }
    if (view === "inspections") {
      return `
        <button class="button" type="button" data-action="prototype-action" data-message="The template builder is planned for the next prototype iteration.">Create template</button>
        <button class="button primary" type="button" data-action="open-modal" data-modal="inspection">Start inspection</button>
      `;
    }
    if (view === "training") {
      return `
        <button class="button" type="button" data-action="prototype-action" data-message="Course authoring will support video, PDF, quiz, and practical verification blocks.">Create course</button>
        <button class="button primary" type="button" data-action="open-modal" data-modal="training">Assign training</button>
      `;
    }
    if (view === "incidents") {
      return `<button class="button primary" type="button" data-action="open-modal" data-modal="incident">Report incident</button>`;
    }
    if (view === "actions") {
      return `<button class="button primary" type="button" data-action="open-modal" data-modal="action">New action</button>`;
    }
    if (view === "programs") {
      return `
        ${programLibrary.meta.sourceUrl ? `<a class="button" href="${escapeHtml(programLibrary.meta.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open private source</a>` : ""}
        <button class="button" type="button" data-action="program-import-status">Review ingestion status</button>
        <button class="button primary" type="button" data-action="open-modal" data-modal="form-upload">Upload form</button>
      `;
    }
    if (view === "documents") {
      return `<button class="button primary" type="button" data-action="prototype-action" data-message="The upload workflow will create an immutable document version in private Supabase Storage.">Upload document</button>`;
    }
    if (view === "standards") {
      return `
        <button class="button" type="button" data-action="check-osha-update">Check source status</button>
        <a class="button primary" href="https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XVII" target="_blank" rel="noopener noreferrer">Open official eCFR</a>
      `;
    }
    if (view === "people") {
      return `<button class="button primary" type="button" data-action="prototype-action" data-message="Invitations will be email-based and scoped to a company role and one or more locations.">Invite worker</button>`;
    }
    if (view === "locations") {
      return `<button class="button primary" type="button" data-action="prototype-action" data-message="Location creation will use a tenant-scoped Supabase workflow.">Add location</button>`;
    }
    return "";
  }

  function renderPageHeading(view = state.view) {
    const meta = pageMeta[view] || pageMeta.dashboard;
    const place = activeLocation();
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
    return { training, inspections, urgent, openIncidents };
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
    if (type === "Document") return "document";
    return "";
  }

  function taskIcon(type) {
    const map = { Inspection: "F", Training: "T", "Corrective action": "A", Document: "D" };
    return map[type] || "•";
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
    const tasks = filterLocation(data.tasks);
    const selectedLocations = activeLocation() ? [activeLocation()] : data.locations;
    const attentionCount = filterLocation(data.actions).filter((action) => action.status === "Overdue").length +
      filterLocation(data.tasks).filter((task) => task.status === "Overdue").length;
    const readiness = Math.round((metrics.training + metrics.inspections + (100 - metrics.urgent * 4)) / 3);

    return `
      ${renderPageHeading()}
      <section class="alert-strip" aria-label="Items needing attention">
        <span class="alert-icon" aria-hidden="true">!</span>
        <div>
          <strong>${attentionCount || 1} item${attentionCount === 1 ? "" : "s"} need${attentionCount === 1 ? "s" : ""} action</strong>
          <p>A critical guardrail repair is overdue at one facility. Evidence is still missing.</p>
        </div>
        <button class="button small" type="button" data-action="navigate" data-view="actions">Review actions</button>
      </section>
      <section class="metric-grid" aria-label="Safety performance metrics">
        ${renderMetricCard("Training current", `${metrics.training}%`, "of required assignments", "T", "var(--purple)", "↑ 3%")}
        ${renderMetricCard("Inspections complete", `${metrics.inspections}%`, "on schedule this month", "F", "var(--blue)", "↑ 6%")}
        ${renderMetricCard("High-priority actions", metrics.urgent, "open across selected sites", "A", "var(--red)", metrics.urgent ? "Needs review" : "On track", Boolean(metrics.urgent))}
        ${renderMetricCard("Days without recordable", data.company.daysWithoutRecordable, `${metrics.openIncidents} open incident${metrics.openIncidents === 1 ? "" : "s"}`, "✓", "var(--accent)", "↑ 11 days")}
      </section>
      <section class="dashboard-grid">
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h2>Today’s fieldwork</h2>
                <p>Prioritized across forms, training, actions, and acknowledgements</p>
              </div>
              <button class="link-button" type="button" data-action="navigate" data-view="my-work">View full queue →</button>
            </div>
            ${renderTaskRows(tasks.slice(0, 4))}
          </article>
          <article class="card">
            <div class="card-header">
              <div>
                <h2>Recent activity</h2>
                <p>Audit-ready events from across the company</p>
              </div>
            </div>
            <div class="activity-list">
              ${data.activity.map((item) => `
                <div class="activity-item">
                  <span class="activity-icon ${item.tone}" aria-hidden="true">${item.icon}</span>
                  <p class="activity-text">${escapeHtml(item.text)}</p>
                  <span class="activity-time">${escapeHtml(item.time)}</span>
                </div>
              `).join("")}
            </div>
          </article>
        </div>
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
                const score = Math.round((location.training + location.inspections + (100 - location.openActions * 2)) / 3);
                const color = score < 82 ? "var(--red)" : score < 90 ? "var(--amber)" : "var(--accent)";
                return `
                  <div class="risk-row">
                    <span class="risk-name">${escapeHtml(location.name)}</span>
                    <span class="risk-score">${score}%</span>
                    <div class="progress"><span style="--progress:${score}%;--progress-color:${color}"></span></div>
                  </div>
                `;
              }).join("")}
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
              <div class="donut" style="--value:${readiness}">
                <strong>${readiness}%</strong>
                <small>ready</small>
              </div>
              <div class="readiness-list">
                <div class="readiness-item"><span>Training records</span><strong>${metrics.training}%</strong></div>
                <div class="readiness-item"><span>Inspection records</span><strong>${metrics.inspections}%</strong></div>
                <div class="readiness-item"><span>Document acknowledgements</span><strong>93%</strong></div>
                <div class="readiness-item"><span>Credentials current</span><strong>89%</strong></div>
              </div>
            </div>
          </article>
        </div>
      </section>
    `;
  }

  function renderMyWork() {
    const tasks = filterLocation(data.tasks);
    const overdue = tasks.filter((task) => task.status === "Overdue").length;
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Due today</span><strong>${tasks.filter((task) => task.due.includes("Today")).length}</strong></article>
        <article class="summary-card"><span>Overdue</span><strong>${overdue}</strong></article>
        <article class="summary-card"><span>Upcoming</span><strong>${tasks.filter((task) => !task.due.includes("Today") && task.status !== "Overdue").length}</strong></article>
      </section>
      <article class="card">
        <div class="toolbar">
          <div class="tabs" aria-label="Work filters">
            <button class="tab active" type="button">All work</button>
            <button class="tab" type="button" data-action="prototype-action" data-message="Saved queue filters will be backed by user preferences.">Assigned to me</button>
            <button class="tab" type="button" data-action="prototype-action" data-message="The team queue will be available to managers and safety administrators.">My team</button>
          </div>
          <select class="filter-select" aria-label="Sort work queue">
            <option>Priority first</option>
            <option>Due date</option>
            <option>Location</option>
          </select>
        </div>
        ${renderTaskRows(tasks)}
      </article>
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
              <small>Version 1.${(template.questions % 5) + 2}</small>
              <button class="button small primary" type="button" data-action="open-modal" data-modal="inspection" data-template-id="${template.id}">Start</button>
            </div>
          </article>
        `).join("")}
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
                      ${inspection.regulatorySnapshot ? `<span class="secondary-line">Template ${escapeHtml(inspection.regulatorySnapshot.templateVersion)} · OSHA snapshot ${escapeHtml(inspection.regulatorySnapshot.currentThrough)}</span>` : ""}
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

  function renderTraining() {
    const people = filterLocation(data.people);
    const avg = average(people.map((person) => person.training));
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Training current</span><strong>${avg || 92}%</strong></article>
        <article class="summary-card"><span>Assignments due</span><strong>12</strong></article>
        <article class="summary-card"><span>Credentials expiring</span><strong>4</strong></article>
      </section>
      <section class="course-grid" aria-label="Active training campaigns">
        ${data.courses.map((course) => `
          <article class="course-card">
            <div class="course-top">
              <span class="category-badge">${escapeHtml(course.category)}</span>
              <span class="status-pill purple">${course.languages} lang</span>
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
              <button class="button small" type="button" data-action="open-modal" data-modal="training" data-course-id="${course.id}">Assign</button>
            </div>
          </article>
        `).join("")}
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
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderIncidents() {
    const incidents = filterLocation(data.incidents);
    const open = incidents.filter((incident) => incident.status !== "Closed");
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Open investigations</span><strong>${open.length}</strong></article>
        <article class="summary-card"><span>Near misses · 30 days</span><strong>${incidents.filter((incident) => incident.type === "Near miss").length}</strong></article>
        <article class="summary-card"><span>Median days to close</span><strong>4.2</strong></article>
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

  function storedProgramRecords(key) {
    try {
      const value = JSON.parse(localStorage.getItem(`safetyops.${key}`) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_error) {
      return [];
    }
  }

  function allFormTemplates() {
    return programLibrary.forms || [];
  }

  function originalFormTemplates() {
    return allFormTemplates().filter((item) => item.originalFile?.path);
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
    if (state.authUser?.id) return state.authUser.id;
    return supabaseClient ? null : "demo-user";
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
          && (
            record.userId === ownerId
            || (ownerId === "demo-user" && !record.userId)
          )
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

  async function hydrateLocalFormUploads() {
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

  function renderOriginalFormCard(item) {
    const original = item.originalFile;
    const tags = item.citations || [];
    return `
      <article class="program-card private form-file-card">
        <div class="program-card-top">
          <span class="program-type form">PDF</span>
          <span class="private-source-badge">Controlled original</span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <p class="program-card-description">The verified blank source form is stored with its immutable fingerprint and linked interactive template.</p>
        <div class="program-tags">
          ${tags.map((tag) => `<span class="program-tag">${escapeHtml(tag)}</span>`).join("")}
        </div>
        <div class="program-card-meta">
          <span>${Number(original.pageCount || 0)} page${Number(original.pageCount || 0) === 1 ? "" : "s"}</span>
          <span>${escapeHtml(formatFileSize(original.byteSize))}</span>
          <span>${original.fillablePdf ? "Fillable PDF" : "Print-ready PDF"}</span>
        </div>
        <div class="program-card-footer">
          <span class="program-version" title="${escapeHtml(original.sha256)}">SHA-256 · ${escapeHtml(String(original.sha256 || "").slice(0, 12))}…</span>
          <div class="program-card-actions">
            <button class="button small" type="button" data-action="view-form-original" data-form-id="${escapeHtml(item.id)}">View PDF</button>
            <a class="button small" href="${escapeHtml(original.path)}" download="${escapeHtml(original.filename)}">Download</a>
            <button class="button small primary" type="button" data-action="start-program-form" data-form-id="${escapeHtml(item.id)}">Use template</button>
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
        <p class="program-card-description">${escapeHtml(item.filename)} is stored in this browser's private IndexedDB prototype store. It is not included in the public GitHub build.</p>
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

  function renderProgramCard(item) {
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
              ? `${item.originalFile ? `<button class="button small" type="button" data-action="view-form-original" data-form-id="${escapeHtml(item.id)}">View original</button>` : ""}
                 <button class="button small primary" type="button" data-action="start-program-form" data-form-id="${escapeHtml(item.id)}">Start form</button>`
              : item.sourceUrl ? `<a class="button small" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
          </div>
        </div>
      </article>
    `;
  }

  function renderFormLibraryControls() {
    if (state.programCategory !== "forms") return "";
    const modes = [
      { id: "originals", label: "Original forms", count: originalFormTemplates().length },
      { id: "uploads", label: "My uploads", count: state.localFormUploads.length },
      { id: "templates", label: "Templates", count: allFormTemplates().length }
    ];
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
        <button class="button primary" type="button" data-action="open-modal" data-modal="form-upload">Upload company form</button>
      </div>
      <div class="form-storage-boundary">
        <strong>${state.formLibraryMode === "uploads" ? "Prototype storage" : "Controlled form library"}</strong>
        <span>${state.formLibraryMode === "uploads"
          ? "Uploads stay in this browser only. Production uses a private Supabase bucket, tenant RLS, malware scanning, and short-lived signed URLs."
          : "Original files remain immutable; templates and completed submissions keep their source version and SHA-256 trace."}</span>
      </div>
      <div style="height:12px"></div>
    `;
  }

  function renderPrograms() {
    const categories = [
      { id: "programs", label: "Programs", icon: "P", count: (programLibrary.programs || []).length },
      { id: "forms", label: "Forms", icon: "F", count: allFormTemplates().length + state.localFormUploads.length },
      { id: "folders", label: "Source folders", icon: "D", count: (programLibrary.folders || []).filter((item) => item.language !== "Spanish").length },
      { id: "translations", label: "Spanish", icon: "ES", count: (programLibrary.folders || []).filter((item) => item.language === "Spanish").length },
      { id: "resources", label: "Resources", icon: "R", count: (programLibrary.looseResources || []).length }
    ];
    const rows = filteredProgramRows();
    const submissions = storedProgramRecords("formSubmissions");
    const indexedItems = (programLibrary.folders || []).reduce((sum, folder) => sum + Number(folder.itemCount || 0), 0);
    const extraction = programLibrary.meta.extraction || { extracted: 0, imageOnly: 0, ocrRequired: 0 };
    const hasTenantLibrary = programLibraryItems().length > 0;
    const formModeLabel = {
      originals: "Original forms",
      uploads: "My uploads",
      templates: "Interactive templates"
    }[state.formLibraryMode] || "Forms";

    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Company programs</span><strong>${(programLibrary.programs || []).length}</strong></article>
        <article class="summary-card"><span>Original form PDFs</span><strong>${originalFormTemplates().length}</strong></article>
        <article class="summary-card"><span>Interactive templates</span><strong>${allFormTemplates().length}</strong></article>
        <article class="summary-card"><span>Prototype submissions</span><strong>${submissions.filter((item) => item.status === "Submitted").length}</strong></article>
      </section>
      <div style="height:14px"></div>
      ${hasTenantLibrary ? `<section class="import-status running" aria-label="Safety program ingestion status">
        <span class="import-status-icon">↻</span>
        <div>
          <strong>Private-source inventory connected</strong>
          <p>${extraction.extracted} of ${(programLibrary.programs || []).length} program sources have traceable text outlines; ${indexedItems} source items are indexed. ${escapeHtml(programLibrary.meta.ingestionMode || "Source metadata is indexed.")}</p>
        </div>
        <span class="status-pill pending">Supabase binary sync pending</span>
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
            <input id="program-query" class="filter-input program-search" name="query" value="${escapeHtml(state.programQuery)}" placeholder="Search programs, forms, folders, topics, or citations" aria-label="Search safety programs">
            <button class="button" type="submit">Search</button>
            ${state.programQuery ? `<button class="button" type="button" data-action="clear-program-search">Clear</button>` : ""}
          </form>
          ${renderFormLibraryControls()}
          <div style="height:12px"></div>
          <div class="program-library-header">
            <div>
              <h2>${escapeHtml(state.programCategory === "forms" ? formModeLabel : categories.find((item) => item.id === state.programCategory)?.label || "Programs")}</h2>
              <p>${rows.length} item${rows.length === 1 ? "" : "s"} available for ${state.locationId === "all" ? escapeHtml(allLocationsLabel(true)) : escapeHtml(locationName(state.locationId))}</p>
            </div>
            <span class="private-source-badge">Access-controlled</span>
          </div>
          <div class="program-grid">
            ${rows.map(renderProgramCard).join("") || renderEmptyState("⌕", "No source items found", "Try another category, location, or search term.")}
          </div>
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
                      <button class="button small" type="button" data-action="start-program-form" data-form-id="${escapeHtml(form.id)}">Start</button>
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
                  <div><strong>Google Drive source linked</strong><p>External identity and source path preserved for secure ingestion.</p></div>
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
              <span>External source identity — not a content hash</span>
              <code>google-drive:${escapeHtml(item.sourceId || "unavailable")}</code>
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
            ${item.originalFile ? `
              <button class="button" type="button" data-action="view-form-original" data-form-id="${escapeHtml(item.id)}">View original PDF</button>
              <a class="button" href="${escapeHtml(item.originalFile.path)}" download="${escapeHtml(item.originalFile.filename)}">Download original</a>
            ` : item.sourceUrl ? `<a class="button" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
            ${isForm
              ? `<button class="button primary" type="button" data-action="start-program-form" data-form-id="${escapeHtml(item.id)}">Start digital form</button>`
              : `<button class="button primary" type="button" data-action="assign-program" data-program-id="${escapeHtml(item.id)}">Assign acknowledgement</button>`}
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

    if (field.type === "textarea") {
      return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><textarea id="${fieldId}" name="${escapeHtml(field.id)}" ${required}></textarea></div>`;
    }
    if (field.type === "location") {
      return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><select id="${fieldId}" name="${escapeHtml(field.id)}" ${required}>${renderLocationOptions(false, state.locationId === "all" ? data.locations[0]?.id : state.locationId)}</select></div>`;
    }
    if (field.type === "select") {
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <select id="${fieldId}" name="${escapeHtml(field.id)}" ${required}>
            <option value="">Choose an option</option>
            ${(field.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}
          </select>
        </div>
      `;
    }
    if (field.type === "yesno") {
      return `
        <fieldset class="runner-field">
          <legend>${escapeHtml(field.label)}${requiredLabel}</legend>
          <div class="runner-choice-grid">
            <div class="runner-option"><input id="${fieldId}-yes" type="radio" name="${escapeHtml(field.id)}" value="Yes" ${required}><label for="${fieldId}-yes">Yes</label></div>
            <div class="runner-option"><input id="${fieldId}-no" type="radio" name="${escapeHtml(field.id)}" value="No"><label for="${fieldId}-no">No</label></div>
          </div>
        </fieldset>
      `;
    }
    if (field.type === "file") {
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <div class="file-drop-zone">
            <strong>Add evidence</strong>
            <span>This prototype stores file metadata locally. Production sends the file to private Supabase Storage after a secure upload session.</span>
            <input id="${fieldId}" name="${escapeHtml(field.id)}" type="file" accept="image/*,.pdf" ${required}>
          </div>
        </div>
      `;
    }
    if (field.type === "signature") {
      return `
        <div class="runner-field">
          <label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label>
          <div class="signature-field">
            <span>Type your full name to apply a prototype electronic signature.</span>
            <input id="${fieldId}" name="${escapeHtml(field.id)}" autocomplete="name" ${required}>
          </div>
        </div>
      `;
    }
    const inputType = field.type === "date" || field.type === "datetime-local" ? field.type : "text";
    return `<div class="runner-field"><label for="${fieldId}">${escapeHtml(field.label)}${requiredLabel}</label><input id="${fieldId}" name="${escapeHtml(field.id)}" type="${inputType}" ${required}></div>`;
  }

  function renderProgramFormRunner() {
    const form = allFormTemplates().find((item) => item.id === state.activeFormId);
    if (!form) return "";
    return `
      <div class="modal-backdrop" data-action="backdrop-close-program-form">
        <section class="modal wide form-runner" role="dialog" aria-modal="true" aria-labelledby="program-form-title">
          <header class="modal-header form-runner-header">
            <div>
              <p class="section-kicker">${escapeHtml(form.category)} · Draft digital mapping</p>
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
    return `
      ${renderPageHeading()}
      <section class="split-summary">
        <article class="summary-card"><span>Controlled documents</span><strong>${data.documents.length}</strong></article>
        <article class="summary-card"><span>Awaiting acknowledgement</span><strong>30</strong></article>
        <article class="summary-card"><span>Reviews due · 90 days</span><strong>2</strong></article>
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
            <thead><tr><th>Document</th><th>Type</th><th>Owner</th><th>Review date</th><th>Acknowledged</th><th>Status</th><th></th></tr></thead>
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
                    <div class="training-progress">
                      <strong>${documentRecord.acknowledgement}%</strong>
                      <div class="progress"><span style="--progress:${documentRecord.acknowledgement}%;--progress-color:${documentRecord.acknowledgement < 90 ? "var(--amber)" : "var(--accent)"}"></span></div>
                    </div>
                  </td>
                  <td>${statusPill(documentRecord.status)}</td>
                  <td><button class="button small" type="button" data-action="acknowledge-document" data-document-id="${documentRecord.id}">Acknowledge</button></td>
                </tr>
              `).join("")}
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
        <article class="summary-card"><span>Active workers</span><strong>${activeLocation()?.people || data.company.activeWorkers}</strong></article>
        <article class="summary-card"><span>Credentials due soon</span><strong>${people.filter((person) => person.status === "Due soon").length}</strong></article>
        <article class="summary-card"><span>Expired credentials</span><strong>${people.filter((person) => person.status === "Expired").length}</strong></article>
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
            <thead><tr><th>Worker</th><th>Primary location</th><th>Training</th><th>Credentials</th><th>Readiness</th></tr></thead>
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
                  <td>${escapeHtml(person.credentials)}</td>
                  <td>${statusPill(person.status)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderLocations() {
    return `
      ${renderPageHeading()}
      <section class="location-grid">
        ${data.locations.map((location) => {
          const readiness = Math.round((location.training + location.inspections + (100 - location.openActions * 2)) / 3);
          return `
            <article class="location-card">
              <div class="location-top">
                <span class="location-accent" style="--location-accent:${location.accent}"></span>
                <div>
                  <h3>${escapeHtml(location.name)}</h3>
                  <p>${escapeHtml(location.city)} · ${escapeHtml(location.type)}</p>
                </div>
              </div>
              <div class="location-score-grid">
                <div class="location-score"><strong>${location.training}%</strong><span>Training</span></div>
                <div class="location-score"><strong>${location.inspections}%</strong><span>Inspections</span></div>
                <div class="location-score"><strong>${location.openActions}</strong><span>Open actions</span></div>
              </div>
              <div class="course-progress">
                <div class="course-progress-header"><span>Readiness</span><strong>${readiness}%</strong></div>
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
    const federal = regulatory.statePlans.find((plan) => plan.jurisdiction === "US-FED");
    if (state.locationId === "all") {
      return [
        ...(federal ? [federal] : []),
        ...regulatory.statePlans.filter((plan) => plan.jurisdiction !== "US-FED")
      ];
    }
    const direct = regulatory.statePlans.filter((plan) => plan.locationIds.includes(state.locationId));
    if (direct.some((plan) => plan.jurisdiction === "US-FED")) return direct;
    return [...direct, ...(federal ? [{ ...federal, coverage: "Federal baseline reference; verify state-plan adoption and carve-outs" }] : [])];
  }

  function filteredStandards() {
    const query = state.standardQuery.trim().toLowerCase();
    return regulatory.standards.filter((standard) => {
      if (state.standardMode === "featured" && !query && !standard.featured) return false;
      if (state.standardPart !== "all" && standard.part !== state.standardPart) return false;
      if (state.standardScope !== "all" && standard.scope !== state.standardScope) return false;
      if (!query) return true;
      const haystack = [
        standard.citation,
        standard.identifier,
        standard.title,
        standard.partTitle,
        standard.subpart,
        standard.subpartTitle,
        standard.scope,
        standard.summary,
        ...(standard.topics || [])
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderStandards() {
    const results = filteredStandards();
    const visibleResults = results.slice(0, 80);
    const scopes = [...new Set(regulatory.standards.map((standard) => standard.scope).filter(Boolean))].sort();
    const plans = applicableJurisdictions();
    const locationLabel = activeLocation()?.name || allLocationsLabel();
    const coreSnapshots = regulatory.partSnapshots?.length || 0;

    return `
      ${renderPageHeading()}

      <section class="standards-status" aria-label="OSHA source status">
        <div>
          <span class="status-dot" aria-hidden="true"></span>
          <div>
            <strong>Federal corpus indexed · source import complete</strong>
            <span>eCFR Title 29, Chapter XVII is current through ${escapeHtml(regulatory.meta.currentThrough || "unavailable")} · last amended ${escapeHtml(regulatory.meta.latestAmendedOn || "unavailable")}</span>
          </div>
        </div>
        <span class="binding-badge regulation">${regulatory.standards.length.toLocaleString()} provisions</span>
      </section>

      <div class="trace-banner">
        <span class="trace-label">Reference guide</span>
        <div>
          <strong>Use this library to research and trace controls—not to make an automatic compliance determination.</strong>
          <p>The eCFR is the continuously updated operational source, but it is not the official legal edition. Legal review should also verify the annual CFR, Federal Register history, and applicable state-plan rules.</p>
        </div>
      </div>

      <section class="split-summary" aria-label="Regulatory library metrics">
        <article class="summary-card"><span>Indexed sections & appendices</span><strong>${regulatory.standards.length.toLocaleString()}</strong></article>
        <article class="summary-card"><span>Chapter XVII parts</span><strong>${regulatory.parts.length}</strong></article>
        <article class="summary-card"><span>Reviewed control links</span><strong>${regulatory.regulatoryLinks.length}</strong></article>
        <article class="summary-card"><span>Raw core-part fingerprints</span><strong>${coreSnapshots}</strong></article>
      </section>

      <section class="jurisdiction-banner">
        <div class="card-header">
          <div>
            <p class="section-kicker">Location-aware authority</p>
            <h2>${escapeHtml(locationLabel)}</h2>
            <p>State-plan rules can be stricter or materially different from the federal baseline. Applicability requires a reviewed location profile.</p>
          </div>
        </div>
        <div class="jurisdiction-grid">
          ${plans.map((plan) => `
            <article class="jurisdiction-card">
              <div>
                <span class="binding-badge ${plan.jurisdiction === "US-FED" ? "regulation" : "state-plan"}">${escapeHtml(plan.jurisdiction)}</span>
                <h3>${escapeHtml(plan.name)}</h3>
                <p>${escapeHtml(plan.coverage)}</p>
              </div>
              <p>${escapeHtml(plan.note)}</p>
              <div class="jurisdiction-links">
                <a href="${escapeHtml(plan.officialUrl)}" target="_blank" rel="noopener noreferrer">Official rules</a>
                ${plan.legalCodeUrl ? `<a href="${escapeHtml(plan.legalCodeUrl)}" target="_blank" rel="noopener noreferrer">Legal code</a>` : ""}
              </div>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="standards-filter-card">
        <form id="standards-filter-form">
          <div class="standards-filters">
            <div class="field standards-search-field">
              <label for="standards-query">Search citations, titles, topics, and summaries</label>
              <input id="standards-query" name="query" type="search" value="${escapeHtml(state.standardQuery)}" placeholder="Try 1910.178, forklift, fall protection…">
            </div>
            <div class="field">
              <label for="standards-part">CFR part</label>
              <select id="standards-part" name="part">
                <option value="all">All parts</option>
                <option value="OSH-ACT" ${state.standardPart === "OSH-ACT" ? "selected" : ""}>OSH Act</option>
                ${regulatory.parts.filter((part) => !part.reserved).map((part) => `
                  <option value="${escapeHtml(part.id)}" ${state.standardPart === part.id ? "selected" : ""}>Part ${escapeHtml(part.id)} · ${escapeHtml(part.title)}</option>
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
          <div class="tabs" aria-label="Reference result mode">
            <button class="tab ${state.standardMode === "featured" ? "active" : ""}" type="button" data-action="standards-mode" data-mode="featured">High-use standards</button>
            <button class="tab ${state.standardMode === "all" ? "active" : ""}" type="button" data-action="standards-mode" data-mode="all">Entire OSHA chapter</button>
          </div>
        </form>
      </section>

      <section class="standards-layout">
        <div class="standards-results">
          <div class="table-header">
            <div>
              <h2>${results.length.toLocaleString()} matching provision${results.length === 1 ? "" : "s"}</h2>
              <p>${results.length > visibleResults.length ? `Showing the first ${visibleResults.length.toLocaleString()}; refine the search to narrow the corpus.` : "Every result links back to its official source."}</p>
            </div>
          </div>
          <div class="standard-result-list">
            ${visibleResults.length ? visibleResults.map((standard) => `
              <article class="standard-result-card">
                <div class="standard-result-top">
                  <div>
                    <div class="standard-meta">
                      <span class="binding-badge ${escapeHtml(standard.bindingLevel)}">${escapeHtml(standard.bindingLevel)}</span>
                      <span>${escapeHtml(standard.scope)}</span>
                      ${standard.subpart ? `<span>Subpart ${escapeHtml(standard.subpart)}</span>` : ""}
                    </div>
                    <h3>${escapeHtml(standard.citation)}</h3>
                    <p class="standard-title">${escapeHtml(standard.title)}</p>
                  </div>
                  ${standard.featured ? `<span class="status-pill purple">High use</span>` : ""}
                </div>
                <p>${escapeHtml(standard.summary || standard.partTitle || "Official provision indexed from the eCFR structure.")}</p>
                <div class="standard-card-footer">
                  <span>Current through ${escapeHtml(standard.currentThrough || regulatory.meta.currentThrough)}</span>
                  <div>
                    <a class="button small" href="${escapeHtml(standard.officialUrl)}" target="_blank" rel="noopener noreferrer">Official text</a>
                    <button class="button small primary" type="button" data-action="open-reference" data-reference-id="${standard.id}">View trace</button>
                  </div>
                </div>
              </article>
            `).join("") : renderEmptyState("§", "No standards found", "Try a broader citation, topic, part, or scope.")}
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
          <div class="source-fingerprint compact">
            <strong>Structure fingerprint</strong>
            <code>${escapeHtml(regulatory.meta.structureSha256 || "Pending")}</code>
            <span>Generated ${escapeHtml(regulatory.meta.generatedAt || "Not recorded")}</span>
          </div>
          <p>When a source changes, SafetyOps creates an impact review. Published forms, courses, documents, and historical evidence are never silently rewritten.</p>
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
            <div><strong>Browser client</strong><span>${supabaseClient ? "Configured with a publishable key" : "Demo mode · add project URL and publishable key"}</span></div>
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
          <p>These prototype controls demonstrate future per-user settings. Durable business data will never use browser storage as its source of truth.</p>
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
          <p>The prototype remains a portable static application. GitHub hosts only public assets; Supabase owns authenticated records, authorization, private files, and server-side secrets.</p>
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
      { type: "OSHA standard", rows: regulatory.standards, fields: ["citation", "identifier", "title", "partTitle", "scope", "summary", "topics"], view: "standards" }
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

  function inspectionQuestionsFor(templateId) {
    const questionsByTemplate = {
      "tpl-daily": [
        { prompt: "Walking-working surfaces are clean, orderly, sanitary, and free of unresolved hazards.", requirementIds: ["req-1910-22-a-1"] },
        { prompt: "Machine guards and safety devices observed in the area are in place and effective.", requirementIds: ["req-1910-212-a-1"] },
        { prompt: "Aisles, passageways, and work areas are maintained for safe use.", requirementIds: ["req-1910-22-a-1"] },
        { prompt: "Any unsafe condition is documented and routed for correction.", requirementIds: ["req-1910-22-a-1", "req-1910-212-a-1"] }
      ],
      "tpl-jha": [
        { prompt: "The task, steps, equipment, and foreseeable hazards are identified.", requirementIds: ["req-1910-132-d"] },
        { prompt: "The assessment determines whether personal protective equipment is necessary.", requirementIds: ["req-1910-132-d"] },
        { prompt: "Selected protective equipment matches the identified exposure.", requirementIds: ["req-1910-132-d"] },
        { prompt: "The assessment and resulting controls are documented for review.", requirementIds: ["req-1910-132-d"] }
      ],
      "tpl-forklift": [
        { prompt: "The powered industrial truck is in safe operating condition before use.", requirementIds: ["req-1910-178-q-7"] },
        { prompt: "Observed defects have been reported and evaluated.", requirementIds: ["req-1910-178-q-7"] },
        { prompt: "An unsafe truck has been removed from service.", requirementIds: ["req-1910-178-q-7"] },
        { prompt: "The truck will remain out of service until restored to safe condition.", requirementIds: ["req-1910-178-q-7"] }
      ],
      "tpl-eyewash": [
        { prompt: "Suitable quick-drenching or flushing facilities are present where corrosive exposure is possible.", requirementIds: ["req-1910-151-c"] },
        { prompt: "The flushing facility is available for immediate emergency use.", requirementIds: ["req-1910-151-c"] },
        { prompt: "Access to the flushing facility is clear.", requirementIds: ["req-1910-151-c"] },
        { prompt: "Any condition that could prevent suitable flushing is documented for correction.", requirementIds: ["req-1910-151-c"] }
      ],
      "tpl-incident": [
        { prompt: "The initial facts needed to assess OSHA recordkeeping are captured.", requirementIds: ["req-1904-29"] },
        { prompt: "Potential fatality, hospitalization, amputation, or eye-loss criteria are escalated immediately.", requirementIds: ["req-1904-39"] },
        { prompt: "The establishment, event date, and affected worker information are recorded.", requirementIds: ["req-1904-29"] },
        { prompt: "The report preserves enough detail for a recordability and reporting review.", requirementIds: ["req-1904-29", "req-1904-39"] }
      ]
    };
    return questionsByTemplate[templateId] || [
      { prompt: "The assigned work was completed as described.", requirementIds: [] },
      { prompt: "Participants, location, and completion time are recorded.", requirementIds: [] },
      { prompt: "Questions or hazards raised during the activity are documented.", requirementIds: [] },
      { prompt: "Follow-up work has an owner and due date.", requirementIds: [] }
    ];
  }

  function renderInspectionModal() {
    const selectedTemplate = data.inspectionTemplates.find((template) => template.id === state.selectedTemplateId) || data.inspectionTemplates[0];
    const selectedLocationId = state.locationId === "all" ? data.locations[0].id : state.locationId;
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
                  <label for="inspection-template">Template</label>
                  <select id="inspection-template" name="template_id" required>
                    ${data.inspectionTemplates.map((template) => `<option value="${template.id}" ${template.id === selectedTemplate.id ? "selected" : ""}>${escapeHtml(template.name)}</option>`).join("")}
                  </select>
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
                  <strong>Version 1.${(selectedTemplate.questions % 5) + 2} · OSHA snapshot current through ${escapeHtml(regulatory.meta.currentThrough || "not recorded")}</strong>
                  <p>The signed submission will preserve the question wording, mapping version, citation, jurisdiction, and source fingerprint used at submission time.</p>
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
              <button class="button" type="button" data-action="close-modal">Save draft</button>
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
                  <input id="incident-date" type="date" name="date" value="2026-07-30" required>
                </div>
                <div class="field full">
                  <label for="incident-title-input">What happened?</label>
                  <input id="incident-title-input" name="title" placeholder="Short, factual title" required>
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
    const selectedCourse = data.courses.find((course) => course.id === state.selectedTemplateId) || data.courses[0];
    const selectedLocationId = state.locationId === "all" ? "all" : state.locationId;
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="training-title">
          <header class="modal-header">
            <div>
              <p class="section-kicker">Training assignment</p>
              <h2 id="training-title">Assign required training</h2>
              <p>Target by company, location, role, team, or individual.</p>
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
                  <label for="training-audience">Audience</label>
                  <select id="training-audience" name="audience" required>
                    <option>All required workers</option>
                    <option>Operators</option>
                    <option>Supervisors</option>
                    <option>New hires</option>
                    <option>Selected people</option>
                  </select>
                </div>
                <div class="field">
                  <label for="training-location">Location</label>
                  <select id="training-location" name="location_id" required>${renderLocationOptions(true, selectedLocationId)}</select>
                </div>
                <div class="field">
                  <label for="training-due">Due date</label>
                  <input id="training-due" type="date" name="due_date" value="2026-08-15" required>
                </div>
                <div class="field">
                  <label for="training-language">Default language</label>
                  <select id="training-language" name="language"><option>Worker preference</option><option>English</option><option>Spanish</option></select>
                </div>
              </div>
              <div style="height:14px"></div>
              <div class="prototype-note"><strong>Readiness rule</strong><span>Future assignments can block a permit, equipment authorization, or site-access workflow until required training and practical verification are complete.</span></div>
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
    const selectedLocationId = state.locationId === "all" ? data.locations[0].id : state.locationId;
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
                <div class="field full"><label for="action-name">Action</label><input id="action-name" name="title" required placeholder="Describe the required correction"></div>
                <div class="field"><label for="action-location">Location</label><select id="action-location" name="location_id" required>${renderLocationOptions(false, selectedLocationId)}</select></div>
                <div class="field"><label for="action-owner">Owner</label><select id="action-owner" name="owner" required>${data.people.map((person) => `<option>${escapeHtml(person.name)}</option>`).join("")}</select></div>
                <div class="field"><label for="action-priority">Priority</label><select id="action-priority" name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Critical</option></select></div>
                <div class="field"><label for="action-due">Due date</label><input id="action-due" type="date" name="due_date" value="2026-08-06" required></div>
                <div class="field full"><label for="action-evidence">Closeout evidence</label><select id="action-evidence" name="evidence"><option>Photo and note</option><option>Manager verification</option><option>Document upload</option><option>No evidence required</option></select></div>
              </div>
            </div>
            <footer class="modal-footer">
              <button class="button" type="button" data-action="close-modal">Cancel</button>
              <button class="button primary" type="submit">Create action</button>
            </footer>
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
              <p>Add a PDF, DOCX, or XLSX source. The prototype fingerprints and stores the file locally without putting it in GitHub.</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="Close upload dialog">×</button>
          </header>
          <form id="form-upload-form">
            <div class="modal-body">
              <div class="upload-security-note">
                <span class="private-source-badge">Local prototype</span>
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

  function renderModal() {
    if (!state.modal) return "";
    if (state.modal === "inspection") return renderInspectionModal();
    if (state.modal === "incident") return renderIncidentModal();
    if (state.modal === "training") return renderTrainingModal();
    if (state.modal === "action") return renderActionModal();
    if (state.modal === "form-upload") return renderFormUploadModal();
    return "";
  }

  function render() {
    localStorage.setItem(`${uiStoragePrefix}view`, state.view === "search" ? "dashboard" : state.view);
    localStorage.setItem(`${uiStoragePrefix}location`, state.locationId);
    if (supabaseClient && state.authStatus !== "ready") {
      app.innerHTML = renderAuthScreen();
      referencePanelRegion.innerHTML = "";
      return;
    }
    app.innerHTML = `
      <div class="app-shell">
        ${renderSidebar()}
        <main class="main">
          ${renderTopbar()}
          <div class="page">${renderCurrentView()}</div>
        </main>
        ${renderMobileNav()}
      </div>
      ${renderModal()}
      ${renderProgramDrawer()}
      ${renderProgramFormRunner()}
      ${renderOriginalFormPreview()}
    `;
    renderReferencePanel();
  }

  function navigate(view) {
    if (view === "standards" && state.view === "search" && state.searchQuery) {
      state.standardQuery = state.searchQuery;
      state.standardMode = "all";
    }
    state.view = view;
    state.sidebarOpen = false;
    state.modal = null;
    state.referenceId = null;
    state.programDrawerId = null;
    state.originalPreviewId = null;
    state.activeFormId = null;
    render();
    requestAnimationFrame(() => {
      document.querySelector(".page-heading h1")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function openModal(type, relatedId) {
    state.modal = type;
    state.selectedTemplateId = relatedId || null;
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

  function handleInspectionSubmit(form) {
    const formData = new FormData(form);
    const locationId = formData.get("location_id");
    const template = data.inspectionTemplates.find((item) => item.id === formData.get("template_id"));
    const failed = [...formData.entries()].filter(([key, value]) => key.startsWith("q") && value === "fail").length;
    data.inspections.unshift({
      id: `INSP-${1043 + data.inspections.length}`,
      template: template?.name || "Inspection",
      locationId,
      assignee: data.currentUser.name,
      score: Math.max(0, 100 - failed * 25),
      status: failed ? "Action needed" : "Complete",
      due: "Jul 30",
      findings: failed,
      regulatorySnapshot: {
        templateVersion: `1.${((template?.questions || 0) % 5) + 2}`,
        requirementIds: regulatoryLinksFor("inspection_template", template?.id)
          .map((link) => link.requirementId),
        currentThrough: regulatory.meta.currentThrough,
        sourceStructureSha256: regulatory.meta.structureSha256
      }
    });
    data.activity.unshift({
      id: `ev-${Date.now()}`,
      icon: failed ? "!" : "✓",
      tone: failed ? "amber" : "green",
      text: `${data.currentUser.name} submitted ${template?.name || "an inspection"} at ${locationName(locationId)}${failed ? ` with ${failed} finding${failed === 1 ? "" : "s"}` : " with no findings"}.`,
      time: "Just now"
    });
    closeModal();
    showToast("Inspection submitted", failed ? `${failed} finding${failed === 1 ? "" : "s"} added to the review queue.` : "The signed record is ready for review.");
  }

  function handleIncidentSubmit(form) {
    const formData = new FormData(form);
    const nextNumber = String(27 + data.incidents.length).padStart(3, "0");
    data.incidents.unshift({
      id: `INC-${nextNumber}`,
      title: formData.get("title"),
      type: formData.get("type"),
      severity: formData.get("severity"),
      locationId: formData.get("location_id"),
      reportedBy: data.currentUser.name,
      date: "Jul 30, 2026",
      status: "Investigation",
      daysOpen: 0
    });
    closeModal();
    state.view = "incidents";
    render();
    showToast("Incident report created", "An investigation task was assigned to the location manager.");
  }

  function handleTrainingSubmit(form) {
    const formData = new FormData(form);
    const course = data.courses.find((item) => item.id === formData.get("course_id"));
    const location = formData.get("location_id") === "all" ? allLocationsLabel(true) : locationName(formData.get("location_id"));
    closeModal();
    showToast("Training assigned", `${course?.name || "Course"} was assigned to ${location}.`);
  }

  function handleActionSubmit(form) {
    const formData = new FormData(form);
    data.actions.unshift({
      id: `ACT-${90 + data.actions.length}`,
      title: formData.get("title"),
      source: "Direct",
      owner: formData.get("owner"),
      locationId: formData.get("location_id"),
      due: formData.get("due_date"),
      priority: formData.get("priority"),
      status: "Open"
    });
    closeModal();
    state.view = "actions";
    render();
    showToast("Corrective action created", "The owner will see it in their work queue.");
  }

  async function handleFormUploadSubmit(form) {
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
      const correctOwner = record?.userId === ownerId
        || (ownerId === "demo-user" && !record?.userId);
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

  function saveProgramFormRecord(form, status) {
    const template = allFormTemplates().find((item) => item.id === form.dataset.formId);
    if (!template) return;
    const formData = new FormData(form);
    const answers = {};

    template.fields.forEach((field) => {
      if (field.type === "file") {
        const input = form.elements.namedItem(field.id);
        answers[field.id] = Array.from(input?.files || []).map((file) => ({
          name: file.name,
          size: file.size,
          type: file.type
        }));
        return;
      }
      answers[field.id] = formData.getAll(field.id).map((value) => String(value));
      if (answers[field.id].length === 1) answers[field.id] = answers[field.id][0];
    });

    const records = storedProgramRecords("formSubmissions");
    const timestamp = new Date().toISOString();
    records.unshift({
      id: `SUB-${Date.now()}`,
      organizationId: data.company.id,
      formId: template.id,
      formTitle: template.title,
      sourceSystem: template.sourceSystem,
      sourceId: template.sourceId,
      sourceCapturedOn: template.sourceCapturedOn,
      templateVersion: template.version,
      citations: template.citations || [],
      submittedBy: data.currentUser.name,
      submittedAt: timestamp,
      status,
      locationId: answers.location || null,
      answers
    });
    localStorage.setItem("safetyops.formSubmissions", JSON.stringify(records.slice(0, 100)));
    state.activeFormId = null;
    state.programCategory = "forms";
    state.formLibraryMode = "templates";
    localStorage.setItem(`${uiStoragePrefix}formsMode`, state.formLibraryMode);
    state.view = "programs";
    render();
    showToast(
      status === "Submitted" ? "Digital form submitted" : "Draft saved",
      `${template.title} was saved with its source version, signer, timestamp, and regulatory trace snapshot.`
    );
  }

  function recordProgramAssignment(programId) {
    const item = programLibraryItems().find((record) => record.id === programId);
    if (!item) return;
    const assignments = storedProgramRecords("programAssignments");
    assignments.unshift({
      id: `ASN-${Date.now()}`,
      programId: item.id,
      title: item.title,
      sourceId: item.sourceId,
      sourceCapturedOn: item.sourceCapturedOn,
      assignedBy: data.currentUser.name,
      assignedAt: new Date().toISOString(),
      locationId: state.locationId,
      status: "Open"
    });
    localStorage.setItem("safetyops.programAssignments", JSON.stringify(assignments.slice(0, 100)));
    showToast(
      "Acknowledgement assigned",
      `${item.title} was assigned to ${state.locationId === "all" ? allLocationsLabel(true) : locationName(state.locationId)} with the source version frozen.`
    );
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "auth-mode") {
      state.authMode = target.dataset.mode === "sign-up" ? "sign-up" : "sign-in";
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
      state.standardMode = target.dataset.mode === "all" ? "all" : "featured";
      render();
      return;
    }

    if (action === "program-category") {
      state.programCategory = target.dataset.category || "programs";
      render();
      return;
    }

    if (action === "form-library-mode") {
      const allowedModes = new Set(["originals", "uploads", "templates"]);
      state.formLibraryMode = allowedModes.has(target.dataset.mode) ? target.dataset.mode : "originals";
      localStorage.setItem(`${uiStoragePrefix}formsMode`, state.formLibraryMode);
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
      openModal(target.dataset.modal, target.dataset.templateId || target.dataset.courseId);
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
      showToast("Prototype preview", target.dataset.message || "This workflow is planned for the next iteration.");
      return;
    }

    if (action === "select-location") {
      state.locationId = target.dataset.locationId;
      navigate("dashboard");
      return;
    }

    if (action === "acknowledge-document") {
      const record = data.documents.find((item) => item.id === target.dataset.documentId);
      if (record) {
        record.acknowledgement = Math.min(100, record.acknowledgement + 1);
        if (record.acknowledgement === 100) record.status = "Current";
      }
      render();
      showToast("Acknowledgement recorded", "The audit event includes the user, version, and timestamp.");
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "form-upload-file") {
      const titleInput = document.querySelector("#form-upload-title-input");
      const selectedFile = event.target.files?.[0];
      if (titleInput && selectedFile && !titleInput.value.trim()) {
        titleInput.value = selectedFile.name.replace(/\.[^.]+$/, "").replaceAll(/[_-]+/g, " ");
      }
      return;
    }
    if (event.target.id === "location-select") {
      state.locationId = event.target.value;
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
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "auth-signin-form" || event.target.id === "auth-signup-form") {
      event.preventDefault();
      handleAuthSubmit(event.target);
      return;
    }

    if (event.target.id === "company-onboarding-form") {
      event.preventDefault();
      handleCompanyOnboarding(event.target);
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

    if (event.target.id === "action-form") {
      event.preventDefault();
      handleActionSubmit(event.target);
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
    if (event.key === "Escape" && state.modal) closeModal();
    if (event.key === "/" && !state.modal && !state.referenceId && !state.originalPreviewId && !state.activeFormId && !state.programDrawerId && document.activeElement?.tagName !== "INPUT") {
      event.preventDefault();
      document.querySelector("#global-search")?.focus();
    }
  });

  render();
  if (supabaseClient) {
    initializeAuth();
  } else {
    hydrateLocalFormUploads();
  }
})();
