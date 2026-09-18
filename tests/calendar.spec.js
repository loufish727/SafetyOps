const { test, expect } = require("@playwright/test");
const {
  AUTH_USER,
  WORKSPACE_FIXTURE,
  configureAuthenticatedWorkspace
} = require("./helpers/authenticated-workspace");

test.use({ timezoneId: "America/Los_Angeles" });

const OR = WORKSPACE_FIXTURE.locations[0].id;
const WA = WORKSPACE_FIXTURE.locations[1].id;
const OWNER = WORKSPACE_FIXTURE.employees.owner.id;
const AVERY = WORKSPACE_FIXTURE.employees.unlinked.id;
const CREATED_AT = "2026-09-01T17:00:00.000Z";
const IDS = {
  training: "d1000000-0000-4000-8000-000000000001",
  committee: "d1000000-0000-4000-8000-000000000002",
  action: "d1000000-0000-4000-8000-000000000003",
  completed: "d1000000-0000-4000-8000-000000000004",
  overdue: "d1000000-0000-4000-8000-000000000005",
  form: "d1000000-0000-4000-8000-000000000006",
  inspection: "d1000000-0000-4000-8000-000000000007",
  signature: "d1000000-0000-4000-8000-000000000008"
};

function calendarTables() {
  const base = {
    company_id: WORKSPACE_FIXTURE.company.id,
    location_id: OR,
    created_at: CREATED_AT,
    updated_at: CREATED_AT
  };
  const action = {
    ...base,
    source_type: "direct",
    assigned_employee_id: OWNER,
    assigned_to: AUTH_USER.id,
    due_at: "2026-09-18T06:59:59.000Z",
    priority: "medium",
    status: "open"
  };
  return {
    training_assignments: [{
      ...base,
      id: IDS.training,
      course_id: WORKSPACE_FIXTURE.course.id,
      course_version: WORKSPACE_FIXTURE.course.version,
      employee_id: OWNER,
      worker_profile_id: AUTH_USER.id,
      status: "assigned",
      assigned_at: CREATED_AT,
      due_at: "2026-09-18T06:59:59.000Z",
      retention_status: "review_required"
    }],
    safety_committee_meetings: [{
      ...base,
      id: IDS.committee,
      scope: "location",
      title: "September safety committee",
      meeting_date: "2026-09-17",
      status: "draft",
      chair_employee_id: OWNER,
      notes: "Review machine guarding and assign follow-up work.",
      safety_committee_attendees: [{
        id: "d1000000-0000-4000-8000-000000000009",
        employee_id: AVERY,
        committee_role: "member",
        attendance_status: "attended",
        attendance_method: "in_person"
      }]
    }],
    corrective_actions: [
      { ...action, id: IDS.action, title: "Tacoma guarding follow-up", location_id: WA, assigned_employee_id: AVERY, assigned_to: null },
      { ...action, id: IDS.completed, title: "Completed label replacement", status: "closed" },
      { ...action, id: IDS.overdue, title: "Overdue Oregon eyewash repair", due_at: "2026-09-17T06:59:59.000Z" },
      { ...action, id: "d1000000-0000-4000-8000-000000000010", title: "Undated action stays off calendar", due_at: null },
      { ...action, id: "d1000000-0000-4000-8000-000000000011", title: "Previous-year action", due_at: "2025-09-18T06:59:59.000Z" },
      ...[1, 2, 3, 4].map((index) => ({
        ...action,
        id: `d2000000-0000-4000-8000-00000000000${index}`,
        title: `Same-day follow-up ${index}`
      }))
    ],
    employee_form_assignments: [{
      ...base,
      id: IDS.form,
      employee_id: AVERY,
      program_version_id: WORKSPACE_FIXTURE.program.versionId,
      form_template_version_id: WORKSPACE_FIXTURE.program.formVersionId,
      title: "Avery equipment acknowledgement",
      status: "assigned",
      due_at: "2026-09-19T06:59:59.000Z",
      assigned_at: CREATED_AT,
      assigned_by: AUTH_USER.id
    }],
    inspections: [{
      ...base,
      id: IDS.inspection,
      template_id: WORKSPACE_FIXTURE.template.id,
      template_version_id: WORKSPACE_FIXTURE.template.versionId,
      title: "Scheduled press inspection",
      form_templates: { name: "Scheduled press inspection" },
      status: "draft",
      scheduled_for: "2026-09-17T18:00:00.000Z",
      score: null,
      responses: {}
    }],
    employee_documents: [{
      ...base,
      id: IDS.signature,
      employee_id: AVERY,
      document_kind: "signature_request",
      title: "Lockout instructions signature",
      document_date: "2026-09-01",
      status: "awaiting_signature",
      original_filename: "lockout-instructions.pdf",
      mime_type: "application/pdf",
      size_bytes: 32768,
      document_sha256: "f".repeat(64),
      validation_status: "format_verified",
      malware_scan_status: "clean",
      signature_due_at: "2026-09-18T06:59:59.000Z",
      signature_intent: "I received and reviewed these instructions.",
      consent_version: "safetyops-electronic-ack-v1"
    }]
  };
}

async function openCalendar(page) {
  await page.clock.setFixedTime(new Date("2026-09-17T19:00:00.000Z"));
  await configureAuthenticatedWorkspace(page, {
    programFixture: true,
    tableOverrides: calendarTables()
  });
  await page.addInitScript(() => {
    localStorage.setItem("safetyops.ui.view", "calendar");
    localStorage.setItem("safetyops.ui.location", "all");
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar", exact: true })).toBeVisible();
}

function eventFor(page, id) {
  return page.locator(`.calendar-event[data-calendar-event$=":${id}"]`);
}

async function showAgenda(page) {
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "Agenda", exact: true })).toHaveAttribute("aria-pressed", "true");
}

test.beforeEach(async ({ page }) => openCalendar(page));

test("calendar combines real dated safety records without undated or previous-year records", async ({ page }) => {
  await showAgenda(page);
  for (const id of Object.values(IDS)) {
    await expect(eventFor(page, id)).toHaveCount(1);
  }
  await expect(page.locator(".calendar-event")).toHaveCount(12);
  await expect(page.getByRole("button", { name: /Undated action stays off calendar/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Previous-year action/ })).toHaveCount(0);

  await page.getByLabel("Go to date").fill("2025-09-17");
  await expect(page.locator(".calendar-event")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Previous-year action/ })).toBeVisible();

  const writes = await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) => (
    ["insert", "rpc", "function", "uploadToSignedUrl"].includes(call.method)
  )));
  expect(writes).toEqual([]);
});

test("location, employee, status and activity filters combine without mixing records", async ({ page }) => {
  await showAgenda(page);
  await page.getByLabel("Filter by location", { exact: true }).selectOption(WA);
  await expect(page.locator(".calendar-event")).toHaveCount(1);
  await expect(eventFor(page, IDS.action)).toBeVisible();

  await page.getByLabel("Filter by location", { exact: true }).selectOption("all");
  await page.getByLabel("Filter calendar by employee").selectOption(AVERY);
  await expect(eventFor(page, IDS.action)).toBeVisible();
  await expect(eventFor(page, IDS.committee)).toBeVisible();
  await expect(eventFor(page, IDS.form)).toBeVisible();
  await expect(eventFor(page, IDS.signature)).toBeVisible();
  await expect(eventFor(page, IDS.training)).toHaveCount(0);

  await page.getByLabel("Filter calendar by employee").selectOption("all");
  await page.getByLabel("Filter calendar by status").selectOption("complete");
  await expect(page.locator(".calendar-event")).toHaveCount(1);
  await expect(eventFor(page, IDS.completed)).toBeVisible();

  await page.getByLabel("Filter calendar by status").selectOption("overdue");
  await expect(eventFor(page, IDS.overdue)).toBeVisible();
  await expect(eventFor(page, IDS.completed)).toHaveCount(0);
  await expect(eventFor(page, IDS.action)).toHaveCount(0);

  await page.getByLabel("Filter calendar by status").selectOption("all");
  await page.getByRole("checkbox", { name: "Action items", exact: true }).uncheck();
  await expect(eventFor(page, IDS.action)).toHaveCount(0);
  await expect(eventFor(page, IDS.overdue)).toHaveCount(0);
  await expect(eventFor(page, IDS.training)).toBeVisible();
});

test("month navigation handles month ends, year changes and Today", async ({ page }) => {
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page.getByLabel("Go to date").fill("2026-01-31");
  await page.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(page.getByLabel("Go to date")).toHaveValue(/^2026-02-/);
  await page.getByRole("button", { name: "Next period", exact: true }).click();
  await expect(page.getByLabel("Go to date")).toHaveValue(/^2026-03-/);

  await page.getByLabel("Go to date").fill("2026-01-01");
  await page.getByRole("button", { name: "Previous period", exact: true }).click();
  await expect(page.getByLabel("Go to date")).toHaveValue(/^2025-12-/);
  await page.locator(".calendar-toolbar").getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByLabel("Go to date")).toHaveValue("2026-09-17");
});

test("a crowded day exposes every record through its day panel", async ({ page }) => {
  await page.getByRole("button", { name: "Month", exact: true }).click();
  const more = page.getByRole("button", { name: /\+\d+ more/ }).first();
  await expect(more).toBeVisible();
  await more.click();
  for (let index = 1; index <= 4; index += 1) {
    await expect(eventFor(page, `d2000000-0000-4000-8000-00000000000${index}`).last()).toBeVisible();
  }
  await expect(eventFor(page, IDS.training).last()).toBeVisible();
  await expect(eventFor(page, IDS.committee).last()).toBeVisible();
  await expect(eventFor(page, IDS.inspection).last()).toBeVisible();
  await expect(eventFor(page, IDS.signature).last()).toBeVisible();
});

test("keyboard users can inspect event facts and close the detail dialog", async ({ page }) => {
  await showAgenda(page);
  // Changing views restores focus on the next frame; finish that transition
  // before targeting an event with the keyboard.
  await expect(page.getByRole("button", { name: "Agenda", exact: true })).toBeFocused();
  const event = eventFor(page, IDS.action);
  await event.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Tacoma guarding follow-up" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Tacoma Distribution");
  await expect(dialog).toContainText("Avery Chen");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(eventFor(page, IDS.action)).toBeFocused();
});

test("event record links open the matching operational record and employee", async ({ page }) => {
  await showAgenda(page);
  await eventFor(page, IDS.action).click();
  await page.getByRole("dialog", { name: "Tacoma guarding follow-up" })
    .getByRole("button", { name: "Open record", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Action items", exact: true })).toBeVisible();
  await expect(page.locator(`[data-calendar-record="action:${IDS.action}"]`)).toBeVisible();

  await page.reload();
  await showAgenda(page);
  await eventFor(page, IDS.signature).click();
  await page.getByRole("dialog", { name: "Lockout instructions signature" })
    .getByRole("button", { name: "Open employee record", exact: true }).click();
  const employee = page.getByRole("dialog", { name: "Avery Chen", exact: true });
  await expect(employee).toBeVisible();
  await expect(employee).toContainText("Lockout instructions signature");
});

test("adding an activity carries the selected date into the existing workflow without saving prematurely", async ({ page }) => {
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page.locator(".calendar-main").getByRole("button", { name: "View Friday, September 25, 2026", exact: true }).click();
  await page.locator('[data-action="calendar-create"]').first().click();
  const choices = page.getByRole("dialog", { name: "Add safety activity", exact: true });
  await expect(choices).toBeVisible();
  await choices.getByRole("button", { name: "Record committee meeting", exact: true }).click();
  const meeting = page.getByRole("dialog", { name: "Record committee meeting", exact: true });
  await expect(meeting).toBeVisible();
  await expect(meeting.getByLabel("Meeting date")).toHaveValue("2026-09-25");
  await meeting.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.locator('[data-action="calendar-create"]').first().click();
  await page.getByRole("dialog", { name: "Add safety activity", exact: true })
    .getByRole("button", { name: "Create action item", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Due date")).toHaveValue("2026-09-25");
  const writes = await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) => (
    ["insert", "rpc", "function", "uploadToSignedUrl"].includes(call.method)
  )));
  expect(writes).toEqual([]);
});

test("week and agenda remain usable without page-wide horizontal overflow", async ({ page }) => {
  for (const mode of ["Week", "Agenda", "Month"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    const dimensions = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test("auditors can review the calendar without activity creation controls", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, {
    role: "auditor",
    programFixture: true,
    tableOverrides: calendarTables()
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Calendar", exact: true })).toBeVisible();
  await expect(page.locator('[data-action="calendar-create"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page.locator(".calendar-main").getByRole("button", { name: "View Thursday, September 17, 2026", exact: true }).click();
  const dayPanel = page.locator(".calendar-day-panel");
  await expect(dayPanel).toBeVisible();
  await expect(dayPanel.locator(`[data-calendar-event$=":${IDS.training}"]`)).toBeVisible();
  await expect(dayPanel.locator('[data-action="calendar-create"]')).toHaveCount(0);
  await expect(page.locator('[data-action="calendar-create-type"]')).toHaveCount(0);
});

test("company-wide committee meetings remain visible for a location and open their exact record", async ({ page }) => {
  const tables = calendarTables();
  tables.safety_committee_meetings[0] = {
    ...tables.safety_committee_meetings[0],
    location_id: null,
    scope: "company",
    title: "Company-wide safety committee"
  };
  await configureAuthenticatedWorkspace(page, { programFixture: true, tableOverrides: tables });
  await page.reload();
  await showAgenda(page);
  await page.getByLabel("Filter by location", { exact: true }).selectOption(WA);
  await expect(eventFor(page, IDS.committee)).toBeVisible();
  await expect(eventFor(page, IDS.committee)).toContainText("Company-wide");
  await eventFor(page, IDS.committee).click();
  const dialog = page.getByRole("dialog", { name: "Company-wide safety committee", exact: true });
  await expect(dialog).toContainText("Company-wide");
  await dialog.getByRole("button", { name: "Open record", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Safety committee", exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter by location", { exact: true })).toHaveValue("all");
  const record = page.locator(`[data-calendar-record="committee:${IDS.committee}"]`);
  await expect(record).toBeVisible();
  await expect(record).toContainText("Company-wide safety committee");
});

test("scheduled inspections show facility times in chronological order without assigning their creator", async ({ page }) => {
  const tables = calendarTables();
  const inspection = tables.inspections[0];
  tables.inspections = [
    { ...inspection, title: "A late press inspection", form_templates: { name: "A late press inspection" }, scheduled_for: "2026-09-17T21:00:00.000Z", created_by: AUTH_USER.id },
    { ...inspection, id: "d1000000-0000-4000-8000-000000000012", title: "Z early press inspection", form_templates: { name: "Z early press inspection" }, scheduled_for: "2026-09-17T17:00:00.000Z", created_by: AUTH_USER.id }
  ];
  await configureAuthenticatedWorkspace(page, { programFixture: true, tableOverrides: tables });
  await page.reload();
  await showAgenda(page);
  const inspections = page.locator('.calendar-event[data-calendar-event^="inspection:"]');
  await expect(inspections).toHaveCount(2);
  await expect(inspections.nth(0)).toContainText("10:00 AM PDT");
  await expect(inspections.nth(0)).toContainText("Z early press inspection");
  await expect(inspections.nth(1)).toContainText("2:00 PM PDT");
  await expect(inspections.nth(1)).toContainText("A late press inspection");
  const day = page.locator(".calendar-agenda-day").filter({ has: eventFor(page, IDS.committee) });
  const dayKeys = await day.locator(".calendar-event").evaluateAll((events) => events.map((event) => event.dataset.calendarEvent));
  expect(dayKeys.slice(-2)).toEqual([
    "inspection:d1000000-0000-4000-8000-000000000012",
    `inspection:${IDS.inspection}`
  ]);
  await page.getByLabel("Filter calendar by employee").selectOption(OWNER);
  await expect(inspections).toHaveCount(0);
  await expect(eventFor(page, IDS.training)).toBeVisible();
});

test("calendar form and signature requests require the selected deadline and return focus on Cancel", async ({ page }) => {
  await page.getByLabel("Filter by location", { exact: true }).selectOption(OR);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page.locator(".calendar-main").getByRole("button", { name: "View Friday, September 25, 2026", exact: true }).click();
  const origin = page.locator('.calendar-day-panel [data-action="calendar-create"]');
  await origin.click();
  await page.getByRole("dialog", { name: "Add safety activity", exact: true })
    .getByRole("button", { name: "Assign employee form", exact: true }).click();
  const formDialog = page.getByRole("dialog", { name: "Assign employee form", exact: true });
  const formDeadline = formDialog.getByLabel("Due date", { exact: true });
  await expect(formDeadline).toHaveValue("2026-09-25");
  await formDeadline.fill("");
  expect(await formDeadline.evaluate((input) => input.validity.valueMissing)).toBe(true);
  await formDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(origin).toBeFocused();

  await origin.click();
  await page.getByRole("dialog", { name: "Add safety activity", exact: true })
    .getByRole("button", { name: "Request document signature", exact: true }).click();
  const documentDialog = page.getByRole("dialog", { name: "Employee document", exact: true });
  const signatureDeadline = documentDialog.getByLabel("Signature due date", { exact: true });
  await expect(signatureDeadline).toHaveValue("2026-09-25");
  await expect(documentDialog.getByLabel("Workflow", { exact: true })).toHaveValue("signature_request");
  await expect(documentDialog.locator('option[value="signed_upload"]')).toHaveCount(0);
  await signatureDeadline.fill("");
  expect(await signatureDeadline.evaluate((input) => input.validity.valueMissing)).toBe(true);
  await documentDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(origin).toBeFocused();
});

test.describe("browser in a different timezone", () => {
  test.use({ timezoneId: "UTC" });

  for (const fixture of [
    { date: "2026-09-25", label: "Friday, September 25, 2026", endOfDay: "2026-09-26T06:59:59.000Z" },
    { date: "2026-11-01", label: "Sunday, November 1, 2026", endOfDay: "2026-11-02T07:59:59.000Z" }
  ]) {
    test(`due dates keep the facility date ${fixture.date} when a UTC browser creates an action`, async ({ page }) => {
      await page.getByRole("button", { name: "Month", exact: true }).click();
      await page.getByLabel("Go to date").fill(fixture.date);
      await page.locator(".calendar-main").getByRole("button", { name: `View ${fixture.label}`, exact: true }).click();
      await page.locator('[data-action="calendar-create"]').first().click();
      await page.getByRole("dialog", { name: "Add safety activity", exact: true })
        .getByRole("button", { name: "Create action item", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Location", { exact: true }).selectOption(OR);
      await dialog.getByLabel("Action", { exact: true }).fill("Facility-timezone action");
      await dialog.getByLabel("Owner", { exact: true }).selectOption(OWNER);
      await expect(dialog.getByLabel("Due date")).toHaveValue(fixture.date);
      await dialog.getByRole("button", { name: "Create action", exact: true }).click();
      await expect(page.getByText("Corrective action created", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Calendar", exact: true })).toBeVisible();
      await expect(page.locator(".calendar-day-panel")).toContainText("Facility-timezone action");

      const actionCall = await page.evaluate(() => window.__safetyOpsFakeDb.calls.find((call) => (
        call.method === "rpc" && call.name === "create_employee_corrective_action"
      )));
      expect(actionCall.payload.target_due_at).toBe(fixture.endOfDay);
      expect(actionCall.payload.target_location_id).toBe(OR);
    });
  }
});
