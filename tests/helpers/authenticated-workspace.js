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
    incidents: [],
    corrective_actions: [],
    documents: [],
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
      folder_hint: "Synthetic source / Operations",
      review_status: "pending_review",
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
    if (options.mislabeledCandidate) {
      tables.safety_program_import_candidates.push({
        ...candidateBase,
        id: "70000000-0000-4000-8000-000000000008",
        display_name: "Mislabeled Photo.pdf",
        candidate_kind: "evidence",
        classification: "internal",
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
      var incidentSequence = 1000;
      var archiveQueryError = ${options.archiveQueryError ? "true" : "false"};

      function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      }

      function compareValues(left, right) {
        if (left === right) return 0;
        if (left === null || left === undefined) return -1;
        if (right === null || right === undefined) return 1;
        return String(left).localeCompare(String(right), undefined, { numeric: true });
      }

      function executeQuery(tableName, filters, ordering, maximum) {
        var rows = (tables[tableName] || []).filter(function (row) {
          return filters.every(function (filter) {
            return row[filter.column] === filter.value;
          });
        });
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

      var client = {
        auth: {
          getSession: function () {
            return Promise.resolve({ data: { session: clone(session) }, error: null });
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
          calls.push({ method: "rpc", name: name, payload: clone(payload) });
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
            if (name === "sign-form-file" && invokeOptions?.body?.candidate_id) {
              var candidate = (tables.safety_program_import_candidates || []).find(function (row) {
                return row.id === invokeOptions.body.candidate_id;
              });
              var responseMetadata = candidate ? {
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
                error: responseMetadata ? null : { message: "Candidate not found." }
              });
            }
            return Promise.resolve({ data: null, error: { message: "Function fixture rejected the request." } });
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
  await page.route("**/vendor/supabase.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: fakeSupabaseScript(options)
  }));
  await page.route("**/supabase-config.js", (route) => route.fulfill({
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
