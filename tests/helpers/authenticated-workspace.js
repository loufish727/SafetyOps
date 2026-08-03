const AUTH_USER = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  user_metadata: { full_name: "Morgan Reed" }
});

const WORKSPACE_FIXTURE = Object.freeze({
  company: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Cascade Safety Fixtures",
    slug: "cascade-safety-fixtures",
    timezone: "America/Los_Angeles"
  },
  user: AUTH_USER,
  template: {
    id: "20000000-0000-4000-8000-000000000001",
    versionId: "20000000-0000-4000-8000-000000000003",
    version: 3,
    name: "Powered industrial truck pre-use"
  },
  course: {
    id: "30000000-0000-4000-8000-000000000001",
    versionId: "30000000-0000-4000-8000-000000000002",
    version: 2,
    name: "Powered industrial truck operator fundamentals"
  },
  program: {
    id: "60000000-0000-4000-8000-000000000001",
    versionId: "60000000-0000-4000-8000-000000000002",
    formId: "60000000-0000-4000-8000-000000000003",
    formVersionId: "60000000-0000-4000-8000-000000000004"
  },
  employeeDocument: {
    id: "90000000-0000-4000-8000-000000000001",
    title: "Scanned-clean lockout acknowledgement",
    filename: "scanned-clean-lockout-acknowledgement.pdf",
    sha256: "e".repeat(64)
  },
  employees: {
    owner: {
      id: "80000000-0000-4000-8000-000000000001",
      fullName: "Morgan Reed",
      employeeNumber: "E-001"
    },
    unlinked: {
      id: "80000000-0000-4000-8000-000000000002",
      fullName: "Avery Chen",
      employeeNumber: "E-204"
    }
  },
  locations: [
    {
      id: "40000000-0000-4000-8000-000000000001",
      name: "Oregon Test Site",
      code: "OR-TEST",
      stateCode: "OR",
      jurisdiction: "US-OR"
    },
    {
      id: "40000000-0000-4000-8000-000000000002",
      name: "Tacoma Distribution",
      code: "TACOMA",
      stateCode: "WA",
      jurisdiction: "US-WA"
    },
    {
      id: "40000000-0000-4000-8000-000000000003",
      name: "Fresno Service",
      code: "FRESNO",
      stateCode: "CA",
      jurisdiction: "US-CA"
    }
  ]
});

function seedTables() {
  const createdAt = "2026-07-30T16:00:00.000Z";
  const jurisdictionNames = {
    OR: "Oregon OSHA State Plan",
    WA: "Washington DOSH State Plan",
    CA: "Cal/OSHA State Plan"
  };

  return {
    companies: [
      {
        ...WORKSPACE_FIXTURE.company,
        created_at: createdAt,
        updated_at: createdAt
      }
    ],
    profiles: [
      {
        id: AUTH_USER.id,
        full_name: AUTH_USER.user_metadata.full_name,
        created_at: createdAt,
        updated_at: createdAt
      }
    ],
    company_memberships: [
      {
        company_id: WORKSPACE_FIXTURE.company.id,
        user_id: AUTH_USER.id,
        role: "corporate_admin",
        active: true,
        default_location_id: WORKSPACE_FIXTURE.locations[0].id,
        created_at: createdAt,
        updated_at: createdAt,
        profiles: { full_name: AUTH_USER.user_metadata.full_name },
        location_memberships: [
          { location_id: WORKSPACE_FIXTURE.locations[0].id }
        ]
      }
    ],
    locations: WORKSPACE_FIXTURE.locations.map((location, index) => ({
      id: location.id,
      company_id: WORKSPACE_FIXTURE.company.id,
      name: location.name,
      code: location.code,
      address: `${location.name}, ${location.stateCode}`,
      timezone: "America/Los_Angeles",
      active: true,
      created_by: AUTH_USER.id,
      created_at: new Date(Date.parse(createdAt) + index * 1_000).toISOString(),
      updated_at: createdAt
    })),
    location_regulatory_profiles: WORKSPACE_FIXTURE.locations.map((location, index) => ({
      id: `50000000-0000-4000-8000-00000000000${index + 1}`,
      company_id: WORKSPACE_FIXTURE.company.id,
      location_id: location.id,
      version: 1,
      state_code: location.stateCode,
      employer_type: "other",
      status: "draft",
      prepared_by: AUTH_USER.id,
      created_at: createdAt,
      updated_at: createdAt,
      location_jurisdiction_assignments: [
        {
          coverage_status: "requires_review",
          jurisdiction: {
            code: location.jurisdiction,
            name: jurisdictionNames[location.stateCode]
          }
        }
      ]
    })),
    form_templates: [
      {
        id: WORKSPACE_FIXTURE.template.id,
        company_id: WORKSPACE_FIXTURE.company.id,
        name: WORKSPACE_FIXTURE.template.name,
        category: "Equipment",
        current_version: WORKSPACE_FIXTURE.template.version,
        active: true,
        created_at: createdAt,
        updated_at: createdAt,
        form_template_versions: [
          {
            id: WORKSPACE_FIXTURE.template.versionId,
            version: WORKSPACE_FIXTURE.template.version,
            published: true,
            schema_json: {
              schemaVersion: 1,
              questions: [
                {
                  id: "fork-condition",
                  type: "pass_fail_na",
                  prompt: "Forks and mast are free of visible damage",
                  required: true,
                  requirementIds: ["req-1910-178-q-7"]
                },
                {
                  id: "operator-controls",
                  type: "pass_fail_na",
                  prompt: "Brakes, steering, horn, and warning devices operate correctly",
                  required: true,
                  requirementIds: ["req-1910-178-l"]
                },
                {
                  id: "leaks",
                  type: "pass_fail_na",
                  prompt: "No fuel, hydraulic, or battery leaks are visible",
                  required: true,
                  requirementIds: []
                }
              ]
            }
          }
        ]
      }
    ],
    form_template_versions: [
      {
        id: WORKSPACE_FIXTURE.template.versionId,
        company_id: WORKSPACE_FIXTURE.company.id,
        template_id: WORKSPACE_FIXTURE.template.id,
        version: WORKSPACE_FIXTURE.template.version,
        published: true
      }
    ],
    training_courses: [
      {
        id: WORKSPACE_FIXTURE.course.id,
        company_id: WORKSPACE_FIXTURE.company.id,
        title: WORKSPACE_FIXTURE.course.name,
        category: "Equipment",
        description: "Authorization fundamentals for powered industrial truck operators.",
        estimated_minutes: 24,
        validity_months: 12,
        default_retention_months: 60,
        retention_basis: {
          status: "reviewed",
          authority: "Company policy",
          durationMonths: 60
        },
        active: true,
        current_version: WORKSPACE_FIXTURE.course.version,
        created_at: createdAt,
        updated_at: createdAt,
        training_course_versions: [
          {
            id: WORKSPACE_FIXTURE.course.versionId,
            version: WORKSPACE_FIXTURE.course.version,
            published: true
          }
        ]
      }
    ],
    employees: [
      {
        id: WORKSPACE_FIXTURE.employees.owner.id,
        company_id: WORKSPACE_FIXTURE.company.id,
        user_id: AUTH_USER.id,
        employee_number: WORKSPACE_FIXTURE.employees.owner.employeeNumber,
        full_name: WORKSPACE_FIXTURE.employees.owner.fullName,
        work_email: AUTH_USER.email,
        job_title: "Safety Manager",
        department: "Safety",
        employment_status: "active",
        hired_on: "2020-01-06",
        separated_on: null,
        primary_location_id: WORKSPACE_FIXTURE.locations[0].id,
        created_by: AUTH_USER.id,
        created_at: createdAt,
        updated_at: createdAt,
        employee_location_assignments: [
          {
            id: "81000000-0000-4000-8000-000000000001",
            location_id: WORKSPACE_FIXTURE.locations[0].id,
            is_primary: true
          }
        ]
      },
      {
        id: WORKSPACE_FIXTURE.employees.unlinked.id,
        company_id: WORKSPACE_FIXTURE.company.id,
        user_id: null,
        employee_number: WORKSPACE_FIXTURE.employees.unlinked.employeeNumber,
        full_name: WORKSPACE_FIXTURE.employees.unlinked.fullName,
        work_email: "avery.chen@example.test",
        job_title: "Machine Operator",
        department: "Operations",
        employment_status: "active",
        hired_on: "2024-03-18",
        separated_on: null,
        primary_location_id: WORKSPACE_FIXTURE.locations[0].id,
        created_by: AUTH_USER.id,
        created_at: createdAt,
        updated_at: createdAt,
        employee_location_assignments: [
          {
            id: "81000000-0000-4000-8000-000000000002",
            location_id: WORKSPACE_FIXTURE.locations[0].id,
            is_primary: true
          }
        ]
      }
    ],
    employee_location_assignments: [
      {
        id: "81000000-0000-4000-8000-000000000001",
        company_id: WORKSPACE_FIXTURE.company.id,
        employee_id: WORKSPACE_FIXTURE.employees.owner.id,
        location_id: WORKSPACE_FIXTURE.locations[0].id,
        is_primary: true,
        assigned_at: createdAt,
        created_by: AUTH_USER.id
      },
      {
        id: "81000000-0000-4000-8000-000000000002",
        company_id: WORKSPACE_FIXTURE.company.id,
        employee_id: WORKSPACE_FIXTURE.employees.unlinked.id,
        location_id: WORKSPACE_FIXTURE.locations[0].id,
        is_primary: true,
        assigned_at: createdAt,
        created_by: AUTH_USER.id
      }
    ],
    training_course_versions: [
      {
        id: WORKSPACE_FIXTURE.course.versionId,
        company_id: WORKSPACE_FIXTURE.company.id,
        course_id: WORKSPACE_FIXTURE.course.id,
        version: WORKSPACE_FIXTURE.course.version,
        published: true
      }
    ],
    inspections: [],
    training_assignments: [],
    training_requirements: [],
    training_completions: [],
    incidents: [],
    corrective_actions: [],
    safety_committee_meetings: [],
    safety_committee_attendees: [],
    documents: [],
    employee_documents: [],
    employee_document_signatures: [],
    employee_form_assignments: [],
    employee_form_submissions: [],
    employee_form_handoff_sessions: [],
    employee_document_upload_sessions: [],
    employee_document_file_access_events: [],
    inspection_regulatory_contexts: [],
    certifications: [],
    audit_events: [],
    safety_programs: [],
    safety_program_versions: [],
    safety_program_location_applicability: [],
    safety_program_form_templates: [],
    safety_program_form_template_versions: [],
    safety_program_form_fields: [],
    safety_program_assignments: [],
    safety_program_form_submissions: [],
    safety_program_form_answers: [],
    safety_program_form_signatures: [],
    safety_program_regulatory_links: [],
    safety_program_form_template_files: [],
    safety_program_import_candidates: [],
    regulatory_jurisdictions: WORKSPACE_FIXTURE.locations.map((location) => ({
      code: location.jurisdiction,
      subdivision_code: location.stateCode,
      active: true
    }))
  };
}

function fakeSupabaseScript(options = {}) {
  const tables = seedTables();
  if (options.role) {
    tables.company_memberships[0].role = options.role;
  }
  if (options.singleLocation) {
    const locationId = WORKSPACE_FIXTURE.locations[0].id;
    tables.locations = tables.locations.filter((row) => row.id === locationId);
    tables.location_regulatory_profiles = tables.location_regulatory_profiles.filter((row) =>
      row.location_id === locationId
    );
  }
  if (options.noLocations) {
    tables.locations = [];
    tables.location_regulatory_profiles = [];
    tables.company_memberships[0].default_location_id = null;
    tables.company_memberships[0].location_memberships = [];
  }
  if (options.importCandidates) {
    const candidateBase = {
      company_id: WORKSPACE_FIXTURE.company.id,
      source_collection: "Forms & Appendices",
      folder_hint: "Synthetic source / Operations",
      review_status: "pending_review",
      access_scope: "company",
      language: "en",
      proposed_location_codes: ["LOC-01"],
      page_count: null,
      render_verified: false,
      created_at: "2026-07-30T17:00:00.000Z",
      provider_file_id: "drive-provider-secret-must-not-render",
      storage_object_path: "private-object-path-must-not-render"
    };
    tables.safety_program_import_candidates = [
      {
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000001",
        display_name: "Hazard Assessment Checklist.pdf",
        candidate_kind: "form_template",
        classification: "internal",
        proposed_location_codes: ["LOC-01", "LOC-02"],
        page_count: 12,
        render_verified: true,
        mime_type: "application/pdf",
        size_bytes: 348160,
        content_sha256: "1".repeat(64),
        source_path_sha256: "a".repeat(64)
      },
      {
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000002",
        display_name: "Signed JHA - July.pdf",
        candidate_kind: "completed_record",
        classification: "restricted",
        review_status: "reviewed",
        access_scope: "safety_admin_private",
        page_count: 4,
        render_verified: true,
        mime_type: "application/pdf",
        size_bytes: 122880,
        content_sha256: "2".repeat(64),
        source_path_sha256: "b".repeat(64)
      },
      {
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000003",
        display_name: "Hearing Conservation Program.docx",
        candidate_kind: "program_document",
        classification: "internal",
        access_scope: "safety_admin_private",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size_bytes: 225280,
        content_sha256: "3".repeat(64),
        source_path_sha256: "c".repeat(64)
      },
      {
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000004",
        display_name: "Forklift Operator Training.pptx",
        candidate_kind: "training_material",
        classification: "internal",
        mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size_bytes: 532480,
        content_sha256: "4".repeat(64),
        source_path_sha256: "d".repeat(64)
      },
      {
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000005",
        display_name: "Oregon OSHA Quick Reference.pdf",
        candidate_kind: "reference",
        classification: "internal",
        page_count: 8,
        render_verified: true,
        mime_type: "application/pdf",
        size_bytes: 184320,
        content_sha256: "5".repeat(64),
        source_path_sha256: "e".repeat(64)
      },
      {
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000006",
        display_name: "Guarding Evidence Photo.jpg",
        candidate_kind: "evidence",
        classification: "internal",
        access_scope: "safety_admin_private",
        mime_type: "image/jpeg",
        size_bytes: 94208,
        content_sha256: "6".repeat(64),
        source_path_sha256: "f".repeat(64)
      },
      {
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000007",
        display_name: "Unsorted Scan.pdf",
        candidate_kind: "unknown",
        classification: "internal",
        access_scope: "safety_admin_private",
        language: "en",
        proposed_location_codes: [],
        page_count: 2,
        render_verified: true,
        mime_type: "application/pdf",
        size_bytes: 71680,
        content_sha256: "7".repeat(64),
        source_path_sha256: "0".repeat(64)
      }
    ];
    if (options.archiveFolderHierarchy) {
      const sourceCollections = {
        "70000000-0000-4000-8000-000000000001": "Forms & Appendices",
        "70000000-0000-4000-8000-000000000002": "Forms & Appendices",
        "70000000-0000-4000-8000-000000000003": "Forms & Appendices",
        "70000000-0000-4000-8000-000000000004": "Forms & Appendices",
        "70000000-0000-4000-8000-000000000005": "Forms & Appendices",
        "70000000-0000-4000-8000-000000000006": "Spanish Translations",
        "70000000-0000-4000-8000-000000000007": "Forms & Appendices"
      };
      const folderHints = {
        "70000000-0000-4000-8000-000000000001": "Job Hazard Analysis / North Plant / Department A",
        "70000000-0000-4000-8000-000000000002": "Safety Committee / North Plant Committee Docs / 2019",
        "70000000-0000-4000-8000-000000000003": "Safety Programs / Hearing Conservation",
        "70000000-0000-4000-8000-000000000004": "Training / Powered Industrial Trucks",
        "70000000-0000-4000-8000-000000000005": "Job Hazard Analysis / North Plant / Department A",
        "70000000-0000-4000-8000-000000000006": "Job Hazard Analysis / North Plant / Machine Shop",
        "70000000-0000-4000-8000-000000000007": null
      };
      tables.safety_program_import_candidates.forEach((candidate) => {
        candidate.source_collection = sourceCollections[candidate.id];
        candidate.folder_hint = folderHints[candidate.id];
      });
      tables.safety_program_import_candidates.push({
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000009",
        display_name: "Loose Safety Policy.pdf",
        source_collection: "Spanish Translations",
        folder_hint: "Drive root",
        candidate_kind: "reference",
        classification: "internal",
        proposed_location_codes: [],
        page_count: 1,
        render_verified: true,
        mime_type: "application/pdf",
        size_bytes: 40960,
        content_sha256: "9".repeat(64),
        source_path_sha256: "9".repeat(64)
      });
    }
    if (options.mislabeledCandidate) {
      tables.safety_program_import_candidates.push({
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000008",
        display_name: "Mislabeled Photo.pdf",
        candidate_kind: "evidence",
        classification: "internal",
        access_scope: "safety_admin_private",
        proposed_location_codes: [],
        mime_type: "image/jpeg",
        size_bytes: 8192,
        content_sha256: "8".repeat(64),
        source_path_sha256: "8".repeat(64)
      });
    }
  }
  if (options.programFixture && tables.locations.length) {
    const program = WORKSPACE_FIXTURE.program;
    const location = tables.locations[0];
    const profile = tables.location_regulatory_profiles[0];
    profile.status = "approved";
    profile.reviewed_by = AUTH_USER.id;
    profile.reviewed_at = "2026-07-30T16:00:00.000Z";
    profile.location_jurisdiction_assignments = [{
      coverage_status: "applies",
      valid_from: "2026-01-01",
      reviewed_by: AUTH_USER.id,
      reviewed_at: "2026-07-30T16:00:00.000Z",
      jurisdiction: {
        code: WORKSPACE_FIXTURE.locations[0].jurisdiction,
        name: "Oregon OSHA State Plan"
      }
    }];
    tables.safety_programs = [{
      id: program.id,
      company_id: WORKSPACE_FIXTURE.company.id,
      program_code: "TEST-ACK",
      title: "Test safety acknowledgement program",
      description: "Synthetic browser-test program; never shipped as tenant data.",
      category: "Test",
      lifecycle_status: "active",
      review_interval_months: 12,
      created_at: "2026-07-30T16:00:00.000Z",
      updated_at: "2026-07-30T16:00:00.000Z"
    }];
    tables.safety_program_versions = [{
      id: program.versionId,
      company_id: WORKSPACE_FIXTURE.company.id,
      program_id: program.id,
      version: 1,
      status: "published",
      change_summary: "Initial test version",
      effective_from: "2026-01-01",
      effective_to: null,
      source_manifest_sha256: "1".repeat(64),
      content_manifest_sha256: "2".repeat(64),
      published_at: "2026-07-30T16:00:00.000Z",
      created_at: "2026-07-30T16:00:00.000Z",
      updated_at: "2026-07-30T16:00:00.000Z"
    }];
    tables.safety_program_location_applicability = [{
      id: "60000000-0000-4000-8000-000000000005",
      company_id: WORKSPACE_FIXTURE.company.id,
      program_version_id: program.versionId,
      location_id: location.id,
      regulatory_profile_id: profile.id,
      applicability_status: "applies",
      rationale: "Synthetic test applicability",
      conditions: [],
      local_addenda: [],
      review_status: "reviewed",
      effective_from: "2026-01-01",
      effective_to: null,
      applicability_sha256: "3".repeat(64),
      reviewed_at: "2026-07-30T16:00:00.000Z"
    }];
    tables.safety_program_form_templates = [{
      id: program.formId,
      company_id: WORKSPACE_FIXTURE.company.id,
      program_id: program.id,
      template_key: "test.acknowledgement",
      name: "Test safety acknowledgement",
      purpose: "Exercise server-owned form evidence fields.",
      created_at: "2026-07-30T16:00:00.000Z"
    }];
    tables.safety_program_form_template_versions = [{
      id: program.formVersionId,
      company_id: WORKSPACE_FIXTURE.company.id,
      program_id: program.id,
      program_version_id: program.versionId,
      template_id: program.formId,
      version: 1,
      title: "Test safety acknowledgement",
      instructions_markdown: "Complete and sign the test record.",
      status: "published",
      completion_policy: {},
      signature_policy: {},
      schema_sha256: "4".repeat(64),
      origin_kind: "source_derived",
      source_manifest_sha256: "1".repeat(64),
      published_at: "2026-07-30T16:00:00.000Z",
      created_at: "2026-07-30T16:00:00.000Z",
      updated_at: "2026-07-30T16:00:00.000Z"
    }];
    tables.safety_program_form_fields = [
      {
        id: "60000000-0000-4000-8000-000000000006",
        company_id: WORKSPACE_FIXTURE.company.id,
        program_version_id: program.versionId,
        form_template_version_id: program.formVersionId,
        parent_field_id: null,
        field_key: "employee_name",
        field_type: "short_text",
        label: "Employee name",
        help_text: null,
        placeholder: "Full name",
        required: true,
        sort_order: 1,
        options: [],
        default_value: null,
        validation_rules: {},
        display_logic: {},
        data_classification: "internal",
        field_sha256: "5".repeat(64)
      },
      {
        id: "60000000-0000-4000-8000-000000000007",
        company_id: WORKSPACE_FIXTURE.company.id,
        program_version_id: program.versionId,
        form_template_version_id: program.formVersionId,
        parent_field_id: null,
        field_key: "worker_acknowledgement",
        field_type: "acknowledgement",
        label: "Worker acknowledgement",
        help_text: null,
        placeholder: null,
        required: true,
        sort_order: 2,
        options: [],
        default_value: null,
        validation_rules: {},
        display_logic: {},
        data_classification: "internal",
        field_sha256: "6".repeat(64)
      },
      {
        id: "60000000-0000-4000-8000-000000000008",
        company_id: WORKSPACE_FIXTURE.company.id,
        program_version_id: program.versionId,
        form_template_version_id: program.formVersionId,
        parent_field_id: null,
        field_key: "worker_signature",
        field_type: "signature",
        label: "Worker signature",
        help_text: null,
        placeholder: null,
        required: true,
        sort_order: 3,
        options: [],
        default_value: null,
        validation_rules: {},
        display_logic: {},
        data_classification: "confidential",
        field_sha256: "7".repeat(64)
      }
    ];
  }
  if (options.cleanEmployeeDocument && tables.locations.length) {
    const documentFixture = WORKSPACE_FIXTURE.employeeDocument;
    const createdAt = "2026-08-01T16:00:00.000Z";
    tables.employee_documents = [{
      id: documentFixture.id,
      company_id: WORKSPACE_FIXTURE.company.id,
      location_id: tables.locations[0].id,
      employee_id: WORKSPACE_FIXTURE.employees.unlinked.id,
      document_kind: "signature_request",
      title: documentFixture.title,
      document_date: "2026-08-01",
      status: "awaiting_signature",
      original_filename: documentFixture.filename,
      mime_type: "application/pdf",
      size_bytes: 32768,
      storage_path: `${WORKSPACE_FIXTURE.company.id}/employee-documents/${documentFixture.id}/${documentFixture.sha256}.pdf`,
      document_sha256: documentFixture.sha256,
      validation_status: "format_verified",
      malware_scan_status: "clean",
      validation_record: {
        validationVersion: "safetyops-employee-pdf-format-v1",
        pdfMagic: true,
        eofMarker: true,
        exactBytesPreserved: true,
        malwareScanStatus: "clean"
      },
      signature_intent: "I acknowledge that I received and reviewed this lockout tagout instruction.",
      consent_version: "safetyops-electronic-ack-v1",
      signature_due_at: "2026-08-12T23:59:59.000Z",
      retention_basis: { status: "calculated", source: "document_policy", months: 60 },
      retain_until: "2031-08-01",
      legal_hold: false,
      employee_can_view: true,
      manager_visibility: "safety_admin_only",
      audit_visible: true,
      uploaded_by: AUTH_USER.id,
      created_by: AUTH_USER.id,
      signed_at: null,
      created_at: createdAt,
      updated_at: createdAt
    }];
  }
  const seed = {
    session: { user: AUTH_USER },
    companyId: WORKSPACE_FIXTURE.company.id,
    tables
  };

  return `
    (function installSafetyOpsFakeSupabase() {
      "use strict";

      var seed = ${JSON.stringify(seed)};
      var session = seed.session;
      var tables = seed.tables;
      var calls = [];
      var sharedWorkflowKey = "safetyops.fake.employee-form-workflow.v1";
      var isolatedHandoffClient = /handoff/i.test(window.location.search + window.location.hash);
      var incidentSequence = 1000;
      var archiveQueryError = ${options.archiveQueryError ? "true" : "false"};

      function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      }

      function syncSharedWorkflowState() {
        try {
          var shared = JSON.parse(localStorage.getItem(sharedWorkflowKey) || "null");
          if (!shared || !shared.tables || !Array.isArray(shared.calls)) return;
          tables = shared.tables;
          calls = shared.calls;
          if (window.__safetyOpsFakeDb) {
            window.__safetyOpsFakeDb.tables = tables;
            window.__safetyOpsFakeDb.calls = calls;
          }
        } catch (_error) {}
      }

      function persistSharedWorkflowState() {
        try {
          localStorage.setItem(sharedWorkflowKey, JSON.stringify({ tables: tables, calls: calls }));
        } catch (_error) {}
      }

      function compareValues(left, right) {
        if (left === right) return 0;
        if (left === null || left === undefined) return -1;
        if (right === null || right === undefined) return 1;
        return String(left).localeCompare(String(right), undefined, { numeric: true });
      }

      function candidateRequiresPrivateAccess(candidate) {
        return ["confidential", "restricted"].includes(candidate?.classification)
          || ["completed_record", "evidence", "unknown"].includes(candidate?.candidate_kind);
      }

      function executeQuery(tableName, filters, ordering, maximum) {
        syncSharedWorkflowState();
        var rows = (tables[tableName] || []).filter(function (row) {
          return filters.every(function (filter) {
            return row[filter.column] === filter.value;
          });
        });
        if (
          tableName === "safety_program_import_candidates"
          && !["corporate_admin", "safety_manager"].includes(tables.company_memberships[0]?.role)
        ) {
          rows = rows.filter(function (row) {
            return row.access_scope === "company" && !candidateRequiresPrivateAccess(row);
          });
        }
        ordering.slice().reverse().forEach(function (rule) {
          rows.sort(function (left, right) {
            var result = compareValues(left[rule.column], right[rule.column]);
            return rule.ascending === false ? -result : result;
          });
        });
        if (typeof maximum === "number") rows = rows.slice(0, maximum);
        return clone(rows);
      }

      function decorateInsertedRow(tableName, input) {
        var now = new Date().toISOString();
        var row = Object.assign({}, clone(input));
        row.id = row.id || crypto.randomUUID();
        row.created_at = row.created_at || now;

        if (tableName === "inspections") {
          var template = tables.form_templates.find(function (item) {
            return item.id === row.template_id;
          });
          row.form_templates = { name: template ? template.name : row.title };
        } else if (tableName === "incidents") {
          incidentSequence += 1;
          row.incident_number = row.incident_number || incidentSequence;
          row.status = row.status || "submitted";
        } else if (tableName === "training_assignments") {
          row.status = row.status || "assigned";
          row.assigned_at = row.assigned_at || now;
          row.completed_at = row.completed_at || null;
          row.quiz_score = row.quiz_score || null;
        } else if (tableName === "corrective_actions") {
          row.status = row.status || "open";
        } else if (tableName === "safety_program_form_submissions") {
          row.status = "draft";
          row.started_at = now;
          row.submission_context = {
            contextVersion: "safetyops-form-submission-context-v1",
            companyId: row.company_id,
            location: { locationId: row.location_id },
            programVersion: { programVersionId: row.program_version_id },
            formTemplateVersion: {
              formTemplateVersionId: row.form_template_version_id,
              schemaSha256: row.form_schema_sha256
            }
          };
        } else if (tableName === "safety_program_form_signatures") {
          var signerProfile = tables.profiles.find(function (profile) {
            return profile.id === row.signer_user_id;
          });
          var signerField = tables.safety_program_form_fields.find(function (field) {
            return field.id === row.field_id;
          });
          row.signer_name_snapshot =
            (signerProfile && signerProfile.full_name) || row.signer_user_id;
          row.signer_role_snapshot = tables.company_memberships[0]?.role || "worker";
          row.signature_method =
            signerField?.field_type === "acknowledgement" ? "electronic_ack" : "typed";
          row.signature_intent = signerField?.label || "I acknowledge and sign this record";
          row.signed_payload_sha256 = "a".repeat(64);
          row.signature_sha256 = "b".repeat(64);
          row.signature_record = {
            recordVersion: "safetyops-signature-v1",
            submissionId: row.submission_id,
            formTemplateVersionId: row.form_template_version_id,
            fieldId: row.field_id,
            signerUserId: row.signer_user_id,
            signerNameSnapshot: row.signer_name_snapshot,
            signerRoleSnapshot: row.signer_role_snapshot,
            signatureMethod: row.signature_method,
            signatureIntent: row.signature_intent,
            signedPayloadSha256: row.signed_payload_sha256
          };
          row.signed_at = now;
        }
        return row;
      }

      function insertRows(tableName, input) {
        var requested = Array.isArray(input) ? input : [input];
        var allowedLocations = new Set(tables.locations.map(function (row) { return row.id; }));
        var rejected = requested.find(function (row) {
          return row.company_id !== seed.companyId
            || (row.location_id && !allowedLocations.has(row.location_id));
        });
        calls.push({ method: "insert", table: tableName, rows: clone(requested) });
        var result;
        if (rejected) {
          result = {
            data: null,
            error: { message: "RLS fixture rejected a cross-company or unauthorized-location insert." }
          };
        } else {
          if (!tables[tableName]) tables[tableName] = [];
          var inserted = requested.map(function (row) {
            return decorateInsertedRow(tableName, row);
          });
          tables[tableName].push.apply(tables[tableName], inserted);
          result = { data: clone(inserted), error: null };
        }
        var mutation = {
          select: function () { return mutation; },
          single: function () {
            return Promise.resolve(result.error
              ? result
              : { data: result.data[0] || null, error: null });
          },
          then: function (resolve, reject) {
            return Promise.resolve(result).then(resolve, reject);
          }
        };
        return mutation;
      }

      function queryFor(tableName) {
        var filters = [];
        var ordering = [];
        var maximum;
        var query = {
          select: function () { return query; },
          eq: function (column, value) {
            filters.push({ column: column, value: value });
            return query;
          },
          order: function (column, options) {
            ordering.push({
              column: column,
              ascending: !options || options.ascending !== false
            });
            return query;
          },
          limit: function (value) {
            maximum = value;
            return query;
          },
          maybeSingle: function () {
            var rows = executeQuery(tableName, filters, ordering, maximum);
            return Promise.resolve({ data: rows[0] || null, error: null });
          },
          single: function () {
            var rows = executeQuery(tableName, filters, ordering, maximum);
            return Promise.resolve(rows.length
              ? { data: rows[0], error: null }
              : { data: null, error: { message: "RLS fixture returned no row." } });
          },
          insert: function (input) {
            return insertRows(tableName, input);
          },
          then: function (resolve, reject) {
            if (archiveQueryError && tableName === "safety_program_import_candidates") {
              return Promise.resolve({
                data: null,
                error: { message: "Temporary archive query failure." }
              }).then(resolve, reject);
            }
            return Promise.resolve({
              data: executeQuery(tableName, filters, ordering, maximum),
              error: null
            }).then(resolve, reject);
          }
        };
        return query;
      }

      function employeeById(employeeId) {
        return (tables.employees || []).find(function (row) {
          return row.id === employeeId;
        }) || null;
      }

      function addMonthsIso(value, months, dateOnly) {
        if (!months) return null;
        var result = new Date(value);
        result.setUTCMonth(result.getUTCMonth() + Number(months));
        return dateOnly ? result.toISOString().slice(0, 10) : result.toISOString();
      }

      function fixtureTokenSha256(token) {
        return String(token || "").split("").reverse().join("");
      }

      function rpcUpdateImportCandidateReview(payload) {
        var role = tables.company_memberships[0]?.role;
        if (!["corporate_admin", "safety_manager"].includes(role)) {
          return { data: null, error: { message: "Only a safety administrator may update archive review controls." } };
        }
        var candidate = (tables.safety_program_import_candidates || []).find(function (row) {
          return row.id === payload.target_candidate_id;
        });
        if (!candidate) {
          return { data: null, error: { message: "Import candidate not found." } };
        }
        var accessScope = String(payload.target_access_scope || "");
        var reviewStatus = String(payload.target_review_status || "");
        var allowedStatuses = [
          "pending_review",
          "needs_information",
          "approved",
          "rejected",
          "duplicate",
          "imported",
          "superseded"
        ];
        if (!["company", "safety_admin_private"].includes(accessScope)) {
          return { data: null, error: { message: "Import candidate access scope is invalid." } };
        }
        if (!allowedStatuses.includes(reviewStatus)) {
          return { data: null, error: { message: "Import candidate review status is invalid." } };
        }
        if (candidateRequiresPrivateAccess(candidate) && accessScope === "company") {
          return { data: null, error: { message: "Restricted or sensitive candidates must remain safety/admin private." } };
        }
        candidate.access_scope = accessScope;
        candidate.review_status = reviewStatus;
        return {
          data: [{
            candidate_id: candidate.id,
            access_scope: candidate.access_scope,
            review_status: candidate.review_status
          }],
          error: null
        };
      }

      function rpcCreateEmployee(payload) {
        var now = new Date().toISOString();
        var employeeId = crypto.randomUUID();
        var assignmentId = crypto.randomUUID();
        var employee = {
          id: employeeId,
          company_id: seed.companyId,
          user_id: null,
          employee_number: payload.employee_number || null,
          full_name: String(payload.employee_full_name || "").trim(),
          work_email: payload.employee_work_email || null,
          job_title: payload.employee_job_title || null,
          department: payload.employee_department || null,
          employment_status: "active",
          hired_on: null,
          separated_on: null,
          primary_location_id: payload.employee_location_id,
          created_by: seed.session.user.id,
          created_at: now,
          updated_at: now,
          employee_location_assignments: [{
            id: assignmentId,
            location_id: payload.employee_location_id,
            is_primary: true
          }]
        };
        tables.employees.push(employee);
        tables.employee_location_assignments.push({
          id: assignmentId,
          company_id: seed.companyId,
          employee_id: employeeId,
          location_id: payload.employee_location_id,
          is_primary: true,
          assigned_at: now,
          created_by: seed.session.user.id
        });
        return { data: employeeId, error: null };
      }

      function rpcCreateCommitteeMeeting(payload) {
        var now = new Date().toISOString();
        var meetingId = crypto.randomUUID();
        var attendeeIds = Array.from(new Set(
          (payload.target_attendee_ids || []).concat([payload.target_chair_employee_id])
        ));
        var attendees = attendeeIds.map(function (employeeId) {
          return {
            id: crypto.randomUUID(),
            company_id: seed.companyId,
            meeting_id: meetingId,
            employee_id: employeeId,
            committee_role: employeeId === payload.target_chair_employee_id ? "chair" : "member",
            attendance_status: "attended",
            attendance_method: "in_person",
            created_at: now
          };
        });
        tables.safety_committee_attendees.push.apply(
          tables.safety_committee_attendees,
          attendees
        );
        tables.safety_committee_meetings.push({
          id: meetingId,
          company_id: seed.companyId,
          location_id: payload.target_location_id,
          scope: "location",
          title: String(payload.target_title || "").trim(),
          meeting_date: payload.target_meeting_date,
          status: "draft",
          chair_employee_id: payload.target_chair_employee_id,
          agenda: payload.target_agenda || null,
          notes: payload.target_notes || "",
          decisions: payload.target_decisions || null,
          next_meeting_at: payload.target_next_meeting_at || null,
          prepared_by: seed.session.user.id,
          finalized_by: null,
          finalized_at: null,
          minutes_manifest: null,
          minutes_sha256: null,
          created_at: now,
          updated_at: now,
          safety_committee_attendees: attendees.map(function (row) {
            return {
              id: row.id,
              employee_id: row.employee_id,
              committee_role: row.committee_role,
              attendance_status: row.attendance_status,
              attendance_method: row.attendance_method
            };
          })
        });
        return { data: meetingId, error: null };
      }

      function rpcFinalizeCommitteeMeeting(payload) {
        var meeting = tables.safety_committee_meetings.find(function (row) {
          return row.id === payload.target_meeting_id;
        });
        if (!meeting) return { data: null, error: { message: "Committee meeting not found." } };
        var finalizedAt = new Date().toISOString();
        var minutesSha256 = "c".repeat(64);
        meeting.status = "finalized";
        meeting.finalized_by = seed.session.user.id;
        meeting.finalized_at = finalizedAt;
        meeting.updated_at = finalizedAt;
        meeting.minutes_sha256 = minutesSha256;
        meeting.minutes_manifest = {
          manifestVersion: "safetyops-committee-minutes-v1",
          meetingId: meeting.id,
          actionItems: tables.corrective_actions
            .filter(function (row) { return row.committee_meeting_id === meeting.id; })
            .map(function (row) {
              return {
                actionId: row.id,
                title: row.title,
                assignedEmployeeId: row.assigned_employee_id,
                dueAt: row.due_at,
                status: row.status
              };
            })
        };
        return {
          data: [{ meeting_id: meeting.id, minutes_sha256: minutesSha256 }],
          error: null
        };
      }

      function rpcCreateEmployeeCorrectiveAction(payload) {
        var employee = employeeById(payload.target_employee_id);
        if (!employee) return { data: null, error: { message: "Employee not found." } };
        var actionId = crypto.randomUUID();
        var now = new Date().toISOString();
        tables.corrective_actions.push({
          id: actionId,
          company_id: seed.companyId,
          location_id: payload.target_location_id,
          source_type: payload.target_committee_meeting_id ? "committee_meeting" : "direct",
          source_id: payload.target_committee_meeting_id || null,
          committee_meeting_id: payload.target_committee_meeting_id || null,
          title: String(payload.target_title || "").trim(),
          description: payload.target_description || null,
          priority: payload.target_priority || "medium",
          status: "open",
          assigned_employee_id: employee.id,
          assigned_to: employee.user_id,
          due_at: payload.target_due_at || null,
          required_evidence: payload.target_required_evidence || null,
          closeout_note: null,
          created_by: seed.session.user.id,
          created_at: now
        });
        return { data: actionId, error: null };
      }

      function rpcAssignTrainingRequirements(payload) {
        var now = new Date().toISOString();
        var insertedCount = 0;
        (payload.target_employee_ids || []).forEach(function (employeeId) {
          var employee = employeeById(employeeId);
          if (!employee) return;
          var requirement = tables.training_requirements.find(function (row) {
            return row.employee_id === employeeId
              && row.course_id === payload.target_course_id
              && row.location_id === payload.target_location_id
              && row.active;
          });
          if (!requirement) {
            requirement = {
              id: crypto.randomUUID(),
              company_id: seed.companyId,
              location_id: payload.target_location_id,
              employee_id: employeeId,
              course_id: payload.target_course_id,
              requirement_reason: payload.target_reason || "Company safety requirement",
              cadence_months: payload.target_cadence_months || null,
              retention_months: payload.target_retention_months || null,
              retention_basis: payload.target_retention_basis || { status: "review_required" },
              regulatory_basis: clone(payload.target_regulatory_basis || []),
              active: true,
              created_by: seed.session.user.id,
              created_at: now,
              updated_at: now
            };
            if (requirement.retention_months) {
              requirement.retention_basis = Object.assign({}, requirement.retention_basis, {
                status: "reviewed",
                durationMonths: requirement.retention_months
              });
            }
            tables.training_requirements.push(requirement);
          } else {
            requirement.requirement_reason = payload.target_reason || requirement.requirement_reason;
            requirement.cadence_months = payload.target_cadence_months || null;
            requirement.retention_months = payload.target_retention_months || null;
            requirement.regulatory_basis = clone(payload.target_regulatory_basis || []);
            requirement.updated_at = now;
          }
          var activeAssignment = tables.training_assignments.find(function (row) {
            return row.requirement_id === requirement.id
              && ["assigned", "in_progress"].includes(row.status);
          });
          if (!activeAssignment) {
            tables.training_assignments.push({
              id: crypto.randomUUID(),
              company_id: seed.companyId,
              location_id: payload.target_location_id,
              course_id: payload.target_course_id,
              course_version: ${WORKSPACE_FIXTURE.course.version},
              employee_id: employeeId,
              worker_profile_id: employee.user_id,
              requirement_id: requirement.id,
              status: "assigned",
              assigned_at: now,
              due_at: payload.target_due_at,
              completed_at: null,
              quiz_score: null,
              valid_until: null,
              retain_until: null,
              retention_status: "review_required",
              completion_record: null,
              assigned_by: seed.session.user.id
            });
            insertedCount += 1;
          }
        });
        return { data: insertedCount, error: null };
      }

      function rpcRecordTrainingCompletion(payload) {
        var assignment = tables.training_assignments.find(function (row) {
          return row.id === payload.target_assignment_id;
        });
        if (!assignment) return { data: null, error: { message: "Training assignment not found." } };
        var requirement = tables.training_requirements.find(function (row) {
          return row.id === assignment.requirement_id;
        }) || {};
        var course = tables.training_courses.find(function (row) {
          return row.id === assignment.course_id;
        }) || {};
        var employee = employeeById(assignment.employee_id);
        var completedAt = payload.target_completed_at || new Date().toISOString();
        var validUntil = addMonthsIso(
          completedAt,
          requirement.cadence_months || course.validity_months,
          false
        );
        var retainUntil = addMonthsIso(
          completedAt,
          requirement.retention_months || course.default_retention_months,
          true
        );
        var completionId = crypto.randomUUID();
        var completionSha256 = "e".repeat(64);
        var requirementSnapshot = {
          requirementId: requirement.id || null,
          reason: requirement.requirement_reason || "Company safety requirement",
          cadenceMonths: requirement.cadence_months || course.validity_months || null,
          retentionMonths: requirement.retention_months || course.default_retention_months || null,
          retentionBasis: requirement.retention_basis || course.retention_basis || { status: "review_required" },
          regulatoryBasis: requirement.regulatory_basis || []
        };
        tables.training_completions.push({
          id: completionId,
          company_id: seed.companyId,
          location_id: assignment.location_id,
          assignment_id: assignment.id,
          employee_id: assignment.employee_id,
          course_id: assignment.course_id,
          course_version: assignment.course_version,
          requirement_id: assignment.requirement_id,
          completed_at: completedAt,
          valid_until: validUntil,
          retain_until: retainUntil,
          retention_status: retainUntil ? "calculated" : "review_required",
          completion_method: payload.target_completion_method,
          quiz_score: payload.target_quiz_score === undefined ? null : payload.target_quiz_score,
          instructor_name: payload.target_instructor_name || null,
          verified_by: seed.session.user.id,
          requirement_snapshot: requirementSnapshot,
          completion_manifest: {
            manifestVersion: "safetyops-training-completion-v1",
            completionId: completionId,
            employeeId: assignment.employee_id,
            employeeNameSnapshot: employee ? employee.full_name : "Employee",
            retainUntil: retainUntil
          },
          completion_sha256: completionSha256,
          created_at: new Date().toISOString()
        });
        assignment.status = "complete";
        assignment.completed_at = completedAt;
        assignment.quiz_score = payload.target_quiz_score === undefined ? null : payload.target_quiz_score;
        assignment.valid_until = validUntil;
        assignment.retain_until = retainUntil;
        assignment.retention_status = retainUntil ? "calculated" : "review_required";
        assignment.completion_record = {
          completionId: completionId,
          completionSha256: completionSha256
        };
        return { data: completionId, error: null };
      }

      function rpcSignEmployeeDocument(payload) {
        var documentRecord = tables.employee_documents.find(function (row) {
          return row.id === payload.target_employee_document_id;
        });
        if (
          !documentRecord
          || documentRecord.status !== "awaiting_signature"
          || documentRecord.malware_scan_status !== "clean"
          || !/^[a-f0-9]{64}$/.test(documentRecord.document_sha256 || "")
        ) {
          return { data: null, error: { message: "Electronic acknowledgement request is not available." } };
        }
        var employee = employeeById(documentRecord.employee_id);
        var typedName = String(payload.typed_name || "").trim().replace(/\\s+/g, " ");
        if (!employee || typedName.toLowerCase() !== employee.full_name.toLowerCase()) {
          return { data: null, error: { message: "Typed name must match the linked employee record." } };
        }
        var facilitated = employee.user_id !== seed.session.user.id;
        if (!payload.consent_confirmed || (facilitated && !payload.facilitator_confirmed)) {
          return { data: null, error: { message: "Electronic acknowledgement consent is required." } };
        }
        var signedAt = new Date().toISOString();
        var signatureId = crypto.randomUUID();
        var signatureSha256 = "f".repeat(64);
        var signature = {
          id: signatureId,
          company_id: seed.companyId,
          employee_document_id: documentRecord.id,
          employee_id: documentRecord.employee_id,
          authenticated_actor_user_id: seed.session.user.id,
          facilitator_user_id: facilitated ? seed.session.user.id : null,
          signer_name_snapshot: employee.full_name,
          authenticated_actor_role_snapshot: tables.company_memberships[0].role,
          signature_method: facilitated
            ? "facilitated_in_person_typed_ack"
            : "self_authenticated_typed_ack",
          identity_verification_method: facilitated
            ? "in_person_facilitator_attestation"
            : "linked_authenticated_account",
          facilitator_attestation: facilitated
            ? "Authenticated facilitator confirms the named employee was present and entered the acknowledgement on this device."
            : null,
          signature_intent: documentRecord.signature_intent,
          consent_version: documentRecord.consent_version,
          typed_name_confirmation: typedName,
          signed_source_sha256: documentRecord.document_sha256,
          auth_assurance: { aal: "aal1", amr: [] },
          signature_record: {
            recordVersion: "safetyops-employee-electronic-ack-v1",
            employeeDocumentId: documentRecord.id,
            employeeId: employee.id,
            facilitatorUserId: facilitated ? seed.session.user.id : null,
            signedSourceSha256: documentRecord.document_sha256
          },
          signature_sha256: signatureSha256,
          signed_at: signedAt
        };
        tables.employee_document_signatures.push(signature);
        documentRecord.status = "signed";
        documentRecord.signed_at = signedAt;
        documentRecord.updated_at = signedAt;
        return {
          data: [{ signature_id: signatureId, signature_sha256: signatureSha256 }],
          error: null
        };
      }

      function rpcAssignEmployeeForm(payload) {
        syncSharedWorkflowState();
        var employeeId = payload.target_employee_id || payload.employee_id;
        var employee = employeeById(employeeId);
        var formVersionId = payload.target_form_template_version_id
          || payload.form_template_version_id;
        var formVersion = tables.safety_program_form_template_versions.find(function (row) {
          return row.id === formVersionId;
        });
        if (!employee || !formVersion) {
          return { data: null, error: { message: "Employee form assignment is not available." } };
        }
        var now = new Date().toISOString();
        var assignmentId = crypto.randomUUID();
        tables.employee_form_assignments.push({
          id: assignmentId,
          company_id: seed.companyId,
          location_id: payload.target_location_id || payload.location_id,
          employee_id: employee.id,
          program_version_id: formVersion.program_version_id,
          form_template_version_id: formVersion.id,
          form_schema_sha256: formVersion.schema_sha256,
          title: payload.target_title || payload.title || formVersion.title,
          instructions: payload.target_instructions || payload.instructions || null,
          status: "assigned",
          assigned_at: now,
          due_at: payload.target_due_at || payload.due_at || null,
          started_at: null,
          completed_at: null,
          assigned_by: seed.session.user.id,
          created_at: now,
          updated_at: now
        });
        persistSharedWorkflowState();
        return { data: assignmentId, error: null };
      }

      function rpcBeginEmployeeFormHandoff(payload) {
        syncSharedWorkflowState();
        var assignmentId = payload.target_assignment_id || payload.assignment_id;
        var assignment = tables.employee_form_assignments.find(function (row) {
          return row.id === assignmentId;
        });
        if (!assignment || !["assigned", "in_progress"].includes(assignment.status)) {
          return { data: null, error: { message: "Employee form assignment is not available." } };
        }
        var now = new Date().toISOString();
        var token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
        window.__safetyOpsLastHandoffToken = token;
        tables.employee_form_handoff_sessions.push({
          id: crypto.randomUUID(),
          assignment_id: assignment.id,
          company_id: seed.companyId,
          token_sha256: fixtureTokenSha256(token),
          status: "active",
          facilitator_user_id: seed.session.user.id,
          facilitator_name_snapshot: seed.session.user.user_metadata.full_name,
          facilitator_role_snapshot: tables.company_memberships[0].role,
          created_at: now,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          consumed_at: null
        });
        assignment.status = "in_progress";
        assignment.started_at = assignment.started_at || now;
        assignment.updated_at = now;
        persistSharedWorkflowState();
        return {
          data: [{ handoff_token: token, expires_at: tables.employee_form_handoff_sessions.at(-1).expires_at }],
          error: null
        };
      }

      function rpcGetEmployeeFormHandoff(payload) {
        syncSharedWorkflowState();
        var token = payload.target_token || payload.token;
        var handoff = tables.employee_form_handoff_sessions.find(function (row) {
          return row.token_sha256 === fixtureTokenSha256(token) && row.status === "active";
        });
        if (!handoff || Date.parse(handoff.expires_at) <= Date.now()) {
          return { data: null, error: { message: "This employee form handoff is invalid, expired, or already used." } };
        }
        var assignment = tables.employee_form_assignments.find(function (row) {
          return row.id === handoff.assignment_id;
        });
        var employee = employeeById(assignment.employee_id);
        var fields = tables.safety_program_form_fields
          .filter(function (row) {
            return row.form_template_version_id === assignment.form_template_version_id;
          })
          .sort(function (left, right) { return left.sort_order - right.sort_order; })
          .map(function (row) {
            return {
              id: row.id,
              key: row.field_key,
              type: row.field_type,
              label: row.label,
              helpText: row.help_text,
              placeholder: row.placeholder,
              required: row.required,
              sortOrder: row.sort_order,
              options: row.options || [],
              validationRules: row.validation_rules || {},
              fieldSha256: row.field_sha256
            };
          });
        return {
          data: {
            handoffVersion: "safetyops-employee-handoff-v1",
            assignmentId: assignment.id,
            title: assignment.title,
            instructions: assignment.instructions,
            dueAt: assignment.due_at,
            expiresAt: handoff.expires_at,
            companyName: tables.companies[0].name,
            locationName: tables.locations.find(function (row) { return row.id === assignment.location_id; })?.name,
            employeeName: employee.full_name,
            formTemplateVersionId: assignment.form_template_version_id,
            formVersion: 1,
            formSchemaSha256: assignment.form_schema_sha256,
            programVersionId: assignment.program_version_id,
            fields: fields
          },
          error: null
        };
      }

      function rpcSubmitEmployeeFormHandoff(payload) {
        syncSharedWorkflowState();
        var token = payload.target_token || payload.token;
        var handoff = tables.employee_form_handoff_sessions.find(function (row) {
          return row.token_sha256 === fixtureTokenSha256(token) && row.status === "active";
        });
        if (!handoff || Date.parse(handoff.expires_at) <= Date.now()) {
          return { data: null, error: { message: "This employee form handoff is invalid, expired, or already used." } };
        }
        var assignment = tables.employee_form_assignments.find(function (row) {
          return row.id === handoff.assignment_id;
        });
        var employee = employeeById(assignment.employee_id);
        var answers = payload.target_answers || payload.answers || {};
        var typedName = String(payload.target_typed_name || payload.typed_name || "")
          .trim()
          .replace(/\\s+/g, " ");
        var consentConfirmed = payload.target_consent_confirmed !== undefined
          ? payload.target_consent_confirmed
          : payload.consent_confirmed;
        var employeeAttestation = payload.target_employee_attestation !== undefined
          ? payload.target_employee_attestation
          : payload.employee_attestation;
        var requiredFields = tables.safety_program_form_fields.filter(function (row) {
          return row.form_template_version_id === assignment.form_template_version_id
            && row.required
            && row.field_type !== "signature";
        });
        var missingRequired = requiredFields.find(function (field) {
          var value = answers[field.field_key];
          if (field.field_type === "acknowledgement") return value !== true && value !== "true";
          return value === null || value === undefined || String(value).trim() === "";
        });
        if (missingRequired) {
          return { data: null, error: { message: "Complete every required employee form field." } };
        }
        if (!employee || typedName.toLowerCase() !== employee.full_name.toLowerCase()) {
          return { data: null, error: { message: "Typed name must match the assigned employee." } };
        }
        if (!consentConfirmed || !employeeAttestation) {
          return { data: null, error: { message: "Employee consent and attestation are required." } };
        }
        var submittedAt = new Date().toISOString();
        var submissionId = crypto.randomUUID();
        var submissionSha256 = "8".repeat(64);
        answers = Object.assign({}, answers);
        tables.safety_program_form_fields
          .filter(function (row) {
            return row.form_template_version_id === assignment.form_template_version_id
              && row.field_type === "signature";
          })
          .forEach(function (row) { answers[row.field_key] = typedName; });
        tables.employee_form_submissions.push({
          id: submissionId,
          company_id: seed.companyId,
          location_id: assignment.location_id,
          assignment_id: assignment.id,
          employee_id: assignment.employee_id,
          program_version_id: assignment.program_version_id,
          form_template_version_id: assignment.form_template_version_id,
          form_schema_sha256: assignment.form_schema_sha256,
          status: "submitted",
          answers: clone(answers),
          signer_name_snapshot: employee.full_name,
          handoff_session_id: handoff.id,
          facilitator_user_id: handoff.facilitator_user_id,
          employee_name_snapshot: employee.full_name,
          employee_number_snapshot: employee.employee_number,
          facilitator_name_snapshot: handoff.facilitator_name_snapshot,
          facilitator_role_snapshot: handoff.facilitator_role_snapshot,
          identity_verification_method: "in_person_one_time_handoff",
          field_evidence: tables.safety_program_form_fields
            .filter(function (row) { return row.form_template_version_id === assignment.form_template_version_id; })
            .map(function (row) {
              return {
                fieldId: row.id,
                fieldKey: row.field_key,
                fieldType: row.field_type,
                label: row.label,
                required: row.required,
                options: row.options || [],
                fieldSha256: row.field_sha256,
                answer: row.field_type === "signature"
                  ? typedName
                  : answers[row.field_key] ?? null
              };
            }),
          signature_intent: "I intend my typed name to be my electronic signature for this completed form.",
          consent_version: "safetyops-employee-form-consent-v1",
          employee_attestation: "I confirm these answers are mine and complete.",
          typed_name_confirmation: typedName,
          was_overdue: Boolean(assignment.due_at && Date.parse(assignment.due_at) < Date.parse(submittedAt)),
          submission_manifest: {
            manifestVersion: "safetyops-facilitated-employee-form-v1",
            assignment: {
              assignmentId: assignment.id,
              companyId: seed.companyId,
              locationId: assignment.location_id,
              title: assignment.title,
              assignedAtUtc: assignment.assigned_at,
              dueAtUtc: assignment.due_at,
              wasOverdue: Boolean(assignment.due_at && Date.parse(assignment.due_at) < Date.parse(submittedAt))
            },
            employee: {
              employeeId: employee.id,
              employeeNameSnapshot: employee.full_name,
              employeeNumberSnapshot: employee.employee_number
            },
            facilitator: {
              userId: handoff.facilitator_user_id,
              nameSnapshot: handoff.facilitator_name_snapshot,
              roleSnapshot: handoff.facilitator_role_snapshot
            },
            form: {
              programVersionId: assignment.program_version_id,
              formTemplateVersionId: assignment.form_template_version_id,
              formVersion: 1,
              schemaSha256: assignment.form_schema_sha256
            },
            signature: {
              method: "facilitated_in_person_one_time_handoff",
              identityVerificationMethod: "in_person_one_time_handoff",
              typedName: typedName,
              intent: "I intend my typed name to be my electronic signature for this completed form.",
              consentVersion: "safetyops-employee-form-consent-v1",
              employeeAttestation: "I confirm these answers are mine and complete."
            },
            submittedAtUtc: submittedAt
          },
          submission_sha256: submissionSha256,
          submitted_at: submittedAt,
          created_at: submittedAt
        });
        assignment.status = "completed";
        assignment.completed_at = submittedAt;
        assignment.updated_at = submittedAt;
        handoff.status = "consumed";
        handoff.consumed_at = submittedAt;
        persistSharedWorkflowState();
        return {
          data: [{
            submission_id: submissionId,
            submission_sha256: submissionSha256,
            submitted_at: submittedAt
          }],
          error: null
        };
      }

      function rpcSubmitEmployeeForm(payload) {
        var assignmentId = payload.target_assignment_id || payload.assignment_id;
        var assignment = tables.employee_form_assignments.find(function (row) {
          return row.id === assignmentId;
        });
        if (!assignment || assignment.status === "complete") {
          return { data: null, error: { message: "Employee form assignment is not available." } };
        }
        var employee = employeeById(assignment.employee_id);
        var answers = payload.target_answers || payload.target_answer_values || payload.answers || {};
        var typedName = String(payload.target_typed_name || payload.typed_name || "")
          .trim()
          .replace(/\\s+/g, " ");
        var consentConfirmed = payload.target_consent_confirmed !== undefined
          ? payload.target_consent_confirmed
          : payload.consent_confirmed;
        var facilitatorConfirmed = payload.target_facilitator_confirmed !== undefined
          ? payload.target_facilitator_confirmed
          : payload.facilitator_confirmed;
        var requiredFields = tables.safety_program_form_fields.filter(function (row) {
          return row.form_template_version_id === assignment.form_template_version_id
            && row.required
            && row.field_type !== "signature";
        });
        var missingRequired = requiredFields.find(function (field) {
          var value = answers[field.field_key];
          if (field.field_type === "acknowledgement") return value !== true && value !== "true";
          return value === null || value === undefined || String(value).trim() === "";
        });
        if (missingRequired) {
          return { data: null, error: { message: "Complete every required employee form field." } };
        }
        if (!employee || typedName.toLowerCase() !== employee.full_name.toLowerCase()) {
          return { data: null, error: { message: "Typed name must match the assigned employee." } };
        }
        if (!consentConfirmed || !facilitatorConfirmed) {
          return { data: null, error: { message: "Employee consent and facilitator attestation are required." } };
        }
        var submittedAt = new Date().toISOString();
        var submissionId = crypto.randomUUID();
        var submissionSha256 = "8".repeat(64);
        var signatureSha256 = "9".repeat(64);
        tables.employee_form_submissions.push({
          id: submissionId,
          company_id: seed.companyId,
          location_id: assignment.location_id,
          assignment_id: assignment.id,
          employee_id: assignment.employee_id,
          program_version_id: assignment.program_version_id,
          form_template_version_id: assignment.form_template_version_id,
          form_schema_sha256: assignment.form_schema_sha256,
          status: "submitted",
          answers: clone(answers),
          signer_name_snapshot: employee.full_name,
          authenticated_actor_user_id: seed.session.user.id,
          facilitator_user_id: seed.session.user.id,
          signature_method: "facilitated_in_person_typed_ack",
          identity_verification_method: "in_person_facilitator_attestation",
          facilitator_attestation: "Authenticated facilitator confirms the assigned employee was present and completed this form on this device.",
          typed_name_confirmation: typedName,
          consent_confirmed: true,
          signature_sha256: signatureSha256,
          submission_manifest: {
            manifestVersion: "safetyops-employee-form-submission-v1",
            assignmentId: assignment.id,
            employeeId: employee.id,
            formTemplateVersionId: assignment.form_template_version_id,
            formSchemaSha256: assignment.form_schema_sha256,
            answers: clone(answers),
            facilitatorUserId: seed.session.user.id,
            submittedAt: submittedAt
          },
          submission_sha256: submissionSha256,
          submitted_at: submittedAt,
          created_at: submittedAt
        });
        assignment.status = "complete";
        assignment.started_at = assignment.started_at || submittedAt;
        assignment.completed_at = submittedAt;
        assignment.updated_at = submittedAt;
        return {
          data: [{
            submission_id: submissionId,
            submission_sha256: submissionSha256,
            signature_sha256: signatureSha256
          }],
          error: null
        };
      }

      function invokeEmployeeDocumentFile(body) {
        var action = body && body.action;
        if (action === "prepare") {
          var now = new Date().toISOString();
          var uploadSessionId = crypto.randomUUID();
          var documentId = crypto.randomUUID();
          var expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          var quarantinePath = seed.companyId
            + "/quarantine/employee-documents/"
            + uploadSessionId
            + "/"
            + crypto.randomUUID()
            + ".pdf";
          var retentionBasis = body.retention_basis || { status: "review_required" };
          if (body.retention_months) {
            retentionBasis = Object.assign({}, retentionBasis, {
              status: "reviewed",
              durationMonths: Number(body.retention_months)
            });
          }
          tables.employee_documents.push({
            id: documentId,
            company_id: seed.companyId,
            location_id: body.location_id,
            employee_id: body.employee_id,
            document_kind: body.document_kind,
            title: String(body.title || "").trim(),
            document_date: body.document_date || now.slice(0, 10),
            status: "upload_pending",
            original_filename: body.filename,
            mime_type: "application/pdf",
            size_bytes: Number(body.size_bytes),
            storage_path: null,
            document_sha256: null,
            validation_status: "pending",
            malware_scan_status: "not_scanned",
            validation_record: {},
            signature_intent: body.document_kind === "signature_request"
              ? body.signature_intent
              : null,
            consent_version: body.document_kind === "signature_request"
              ? "safetyops-electronic-ack-v1"
              : null,
            signature_due_at: body.signature_due_at || null,
            retention_basis: retentionBasis,
            retain_until: body.retention_months
              ? addMonthsIso(body.document_date || now, Number(body.retention_months), true)
              : null,
            legal_hold: false,
            employee_can_view: body.employee_can_view !== false,
            manager_visibility: body.manager_visibility || "safety_admin_only",
            audit_visible: false,
            uploaded_by: seed.session.user.id,
            created_by: seed.session.user.id,
            signed_at: null,
            created_at: now,
            updated_at: now
          });
          tables.employee_document_upload_sessions.push({
            id: uploadSessionId,
            company_id: seed.companyId,
            employee_document_id: documentId,
            requested_by: seed.session.user.id,
            idempotency_key: body.idempotency_key,
            state: "prepared",
            quarantine_path: quarantinePath,
            final_path: null,
            declared_size_bytes: Number(body.size_bytes),
            observed_size_bytes: null,
            observed_sha256: null,
            expires_at: expiresAt,
            committed_at: null,
            rejection_code: null,
            created_at: now
          });
          return {
            data: {
              upload_session_id: uploadSessionId,
              employee_document_id: documentId,
              bucket_id: "employee-records-private",
              object_path: quarantinePath,
              upload_token: "fixture-signed-upload-token",
              expires_at: expiresAt
            },
            error: null
          };
        }

        if (action === "complete") {
          var sessionRecord = tables.employee_document_upload_sessions.find(function (row) {
            return row.id === body.upload_session_id;
          });
          if (!sessionRecord) {
            return { data: null, error: { message: "Upload session not found." } };
          }
          var documentRecord = tables.employee_documents.find(function (row) {
            return row.id === sessionRecord.employee_document_id;
          });
          var completedAt = new Date().toISOString();
          var contentSha256 = "d".repeat(64);
          var finalPath = seed.companyId
            + "/employee-documents/"
            + documentRecord.id
            + "/"
            + contentSha256
            + ".pdf";
          documentRecord.status = "upload_pending";
          documentRecord.storage_path = finalPath;
          documentRecord.document_sha256 = contentSha256;
          documentRecord.validation_status = "format_verified";
          documentRecord.malware_scan_status = "unavailable";
          documentRecord.validation_record = {
            validationVersion: "safetyops-employee-pdf-format-v1",
            pdfMagic: true,
            eofMarker: true,
            exactBytesPreserved: true,
            malwareScanStatus: "unavailable"
          };
          documentRecord.updated_at = completedAt;
          sessionRecord.state = "committed";
          sessionRecord.final_path = finalPath;
          sessionRecord.observed_size_bytes = sessionRecord.declared_size_bytes;
          sessionRecord.observed_sha256 = contentSha256;
          sessionRecord.committed_at = completedAt;
          return {
            data: {
              employee_document_id: documentRecord.id,
              status: documentRecord.status,
              content_sha256: contentSha256,
              size_bytes: documentRecord.size_bytes,
              malware_scan_status: "unavailable"
            },
            error: null
          };
        }

        if (action === "download") {
          var downloadable = tables.employee_documents.find(function (row) {
            return row.id === body.employee_document_id;
          });
          if (!downloadable || downloadable.validation_status !== "format_verified") {
            return { data: null, error: { message: "File access denied." } };
          }
          var requestId = crypto.randomUUID();
          var downloadExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          tables.employee_document_file_access_events.push({
            id: crypto.randomUUID(),
            company_id: seed.companyId,
            employee_document_id: downloadable.id,
            actor_user_id: seed.session.user.id,
            decision: "allowed",
            reason_code: "authorized_download",
            request_id: requestId,
            signed_url_expires_at: downloadExpiry,
            occurred_at: new Date().toISOString()
          });
          return {
            data: {
              signed_url: "https://safetyops-test.supabase.co/storage/v1/object/sign/employee-records-private/authorized-employee-document",
              expires_at: downloadExpiry,
              filename: downloadable.original_filename,
              mime_type: downloadable.mime_type,
              size_bytes: downloadable.size_bytes,
              content_sha256: downloadable.document_sha256,
              request_id: requestId
            },
            error: null
          };
        }

        return { data: null, error: { message: "Employee document action is invalid." } };
      }

      var client = {
        auth: {
          getSession: function () {
            return Promise.resolve({
              data: { session: isolatedHandoffClient ? null : clone(session) },
              error: null
            });
          },
          onAuthStateChange: function () {
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
          signOut: function () {
            session = null;
            calls.push({ method: "signOut" });
            return Promise.resolve({ error: null });
          },
          signInWithPassword: function (payload) {
            calls.push({ method: "signIn", payload: clone(payload) });
            return Promise.resolve({ data: { session: clone(session) }, error: null });
          },
          signUp: function (payload) {
            calls.push({ method: "signUp", payload: clone(payload) });
            return Promise.resolve({ data: { session: clone(session), user: clone(seed.session.user) }, error: null });
          }
        },
        from: function (tableName) {
          calls.push({ method: "from", table: tableName });
          return queryFor(tableName);
        },
        rpc: function (name, payload) {
          if ([
            "assign_employee_form",
            "begin_employee_form_handoff",
            "get_employee_form_handoff",
            "submit_employee_form_handoff"
          ].includes(name)) {
            syncSharedWorkflowState();
          }
          var recordedPayload = clone(payload);
          if (["get_employee_form_handoff", "submit_employee_form_handoff"].includes(name)) {
            if (recordedPayload?.target_token) recordedPayload.target_token = "[redacted]";
            if (recordedPayload?.token) recordedPayload.token = "[redacted]";
          }
          calls.push({ method: "rpc", name: name, payload: recordedPayload });
          if ([
            "assign_employee_form",
            "begin_employee_form_handoff",
            "get_employee_form_handoff",
            "submit_employee_form_handoff"
          ].includes(name)) {
            persistSharedWorkflowState();
          }
          if (name === "create_employee") {
            return Promise.resolve(rpcCreateEmployee(payload));
          }
          if (name === "create_safety_committee_meeting") {
            return Promise.resolve(rpcCreateCommitteeMeeting(payload));
          }
          if (name === "finalize_safety_committee_meeting") {
            return Promise.resolve(rpcFinalizeCommitteeMeeting(payload));
          }
          if (name === "create_employee_corrective_action") {
            return Promise.resolve(rpcCreateEmployeeCorrectiveAction(payload));
          }
          if (name === "assign_training_requirements") {
            return Promise.resolve(rpcAssignTrainingRequirements(payload));
          }
          if (name === "record_training_completion") {
            return Promise.resolve(rpcRecordTrainingCompletion(payload));
          }
          if (name === "sign_employee_document") {
            return Promise.resolve(rpcSignEmployeeDocument(payload));
          }
          if (name === "update_safety_program_import_candidate_review") {
            return Promise.resolve(rpcUpdateImportCandidateReview(payload));
          }
          if (name === "assign_employee_form") {
            return Promise.resolve(rpcAssignEmployeeForm(payload));
          }
          if (name === "begin_employee_form_handoff") {
            return Promise.resolve(rpcBeginEmployeeFormHandoff(payload));
          }
          if (name === "get_employee_form_handoff") {
            return Promise.resolve(rpcGetEmployeeFormHandoff(payload));
          }
          if (name === "submit_employee_form_handoff") {
            return Promise.resolve(rpcSubmitEmployeeFormHandoff(payload));
          }
          if (name === "submit_employee_form") {
            return Promise.resolve({
              data: null,
              error: { message: "Direct employee form submission is disabled; use a one-time handoff." }
            });
          }
          if (name === "submit_inspection_with_regulatory_evidence") {
            var templateVersion = tables.form_template_versions.find(function (row) {
              return row.id === payload.target_template_version_id;
            });
            var template = tables.form_templates.find(function (row) {
              return row.id === templateVersion.template_id;
            });
            var answerValues = Object.values(payload.target_answers || {});
            var passing = answerValues.filter(function (value) { return value === "pass"; }).length;
            var failing = answerValues.filter(function (value) { return value === "fail"; }).length;
            var now = new Date().toISOString();
            var inspectionId = crypto.randomUUID();
            tables.inspections.push({
              id: inspectionId,
              company_id: seed.companyId,
              location_id: payload.target_location_id,
              template_id: template.id,
              template_version_id: templateVersion.id,
              title: template.name,
              area_or_asset: payload.target_area_or_asset,
              status: "submitted",
              score: passing + failing
                ? Math.round((passing / (passing + failing)) * 100)
                : null,
              submitted_at: now,
              created_at: now,
              responses: {
                answers: clone(payload.target_answers),
                notes: payload.target_notes || ""
              },
              form_templates: { name: template.name }
            });
            tables.inspection_regulatory_contexts.push({
              inspection_id: inspectionId,
              company_id: seed.companyId,
              regulatory_profile_id: tables.location_regulatory_profiles[0]?.id || null,
              trace_status: "review_required",
              mapping_count: 0,
              evidence_count: 0,
              excluded_count: 0,
              unresolved_count: 0,
              context_manifest: {},
              context_sha256: "0".repeat(64),
              captured_at: now
            });
            return Promise.resolve({
              data: [{ inspection_id: inspectionId, evidence_count: 0 }],
              error: null
            });
          }
          if (name === "submit_safety_program_form") {
            var submission = (tables.safety_program_form_submissions || []).find(function (row) {
              return row.id === payload.target_submission_id;
            });
            if (submission) {
              submission.status = "submitted";
              submission.submitted_payload_sha256 = "c".repeat(64);
              submission.submitted_at = new Date().toISOString();
            }
            return Promise.resolve({ data: clone(submission || null), error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        functions: {
          invoke: function (name, invokeOptions) {
            calls.push({ method: "function", name: name, options: clone(invokeOptions) });
            if (name === "employee-document-file") {
              return Promise.resolve(invokeEmployeeDocumentFile(invokeOptions?.body || {}));
            }
            if (name === "sign-form-file" && invokeOptions?.body?.candidate_id) {
              var candidate = (tables.safety_program_import_candidates || []).find(function (row) {
                return row.id === invokeOptions.body.candidate_id;
              });
              var role = tables.company_memberships[0]?.role;
              var candidateAuthorized = candidate && (
                ["corporate_admin", "safety_manager"].includes(role)
                || (candidate.access_scope === "company" && !candidateRequiresPrivateAccess(candidate))
              );
              var responseMetadata = candidateAuthorized ? {
                signed_url: "https://safetyops-test.supabase.co/storage/v1/object/sign/safety-program-private/authorized-original",
                expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                filename: candidate.display_name,
                mime_type: candidate.mime_type,
                size_bytes: candidate.size_bytes,
                content_sha256: candidate.content_sha256,
                page_count: candidate.page_count,
                render_verified: candidate.render_verified
              } : null;
              if (${options.functionCandidateMetadataMismatch ? "true" : "false"} && responseMetadata) {
                responseMetadata.content_sha256 = "9".repeat(64);
              }
              return Promise.resolve({
                data: responseMetadata,
                error: responseMetadata ? null : { message: "Candidate file access denied." }
              });
            }
            return Promise.resolve({ data: null, error: { message: "Function fixture rejected the request." } });
          }
        },
        storage: {
          from: function (bucketName) {
            calls.push({ method: "storageFrom", bucket: bucketName });
            return {
              uploadToSignedUrl: function (objectPath, uploadToken, file, uploadOptions) {
                calls.push({
                  method: "uploadToSignedUrl",
                  bucket: bucketName,
                  objectPath: objectPath,
                  uploadToken: uploadToken,
                  file: {
                    name: file?.name || null,
                    size: file?.size || 0,
                    type: file?.type || null
                  },
                  options: clone(uploadOptions || {})
                });
                var sessionRecord = tables.employee_document_upload_sessions.find(function (row) {
                  return row.quarantine_path === objectPath;
                });
                if (sessionRecord) sessionRecord.state = "uploaded";
                return Promise.resolve({ data: { path: objectPath }, error: null });
              }
            };
          }
        }
      };

      window.__safetyOpsFakeDb = { tables: tables, calls: calls };
      window.supabase = {
        createClient: function () {
          return client;
        }
      };
    })();
  `;
}

async function configureAuthenticatedWorkspace(page, options = {}) {
  const routeTarget = page.context();
  await routeTarget.route("**/vendor/supabase.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: fakeSupabaseScript(options)
  }));
  await routeTarget.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.SAFETYOPS_SUPABASE_URL = "https://safetyops-test.supabase.co";
      window.SAFETYOPS_SUPABASE_ANON_KEY = "test-publishable-key";
      window.SAFETYOPS_ENABLE_LOCAL_PRIVATE_OVERLAY = false;
      window.SAFETYOPS_ENABLE_LOCAL_COMPANY_FIXTURE = false;
      window.SAFETYOPS_ENABLE_LOCAL_UPLOAD_STAGING = true;
    `
  }));
}

module.exports = {
  AUTH_USER,
  WORKSPACE_FIXTURE,
  configureAuthenticatedWorkspace
};
