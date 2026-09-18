const { test, expect } = require("@playwright/test");
const {
  WORKSPACE_FIXTURE,
  configureAuthenticatedWorkspace
} = require("./helpers/authenticated-workspace");

async function openStoredView(page, view, heading) {
  // Startup renders persist the current view; let authenticated loading finish
  // before setting the next view so it cannot be overwritten before reload.
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.evaluate((targetView) => {
    localStorage.setItem("safetyops.ui.view", targetView);
  }, view);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

test("key workspace views expose no prototype-only controls", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { importCandidates: true });
  await page.goto("/");

  const views = [
    ["dashboard", "Today"],
    ["inspections", "Inspections"],
    ["training", "Training"],
    ["programs", "Company forms & programs"],
    ["documents", "Policies & controlled documents"],
    ["settings", "Settings"]
  ];

  for (const [view, heading] of views) {
    await openStoredView(page, view, heading);
    await expect(page.locator('[data-action="prototype-action"]')).toHaveCount(0);
  }
});

test("Open company forms lands directly in source review with source rows", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { importCandidates: true });
  await page.goto("/");

  await page.getByRole("button", { name: /Open company forms/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Company forms & programs" })).toBeVisible();
  await expect(page.locator('[data-action="program-category"][data-category="forms"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: /Source review/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".import-candidate-card")).toHaveCount(7);
});

test("global search opens a matching company source file in source review", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Global workspace search is not shown at the mobile breakpoint.");
  await configureAuthenticatedWorkspace(page, { importCandidates: true });
  await page.goto("/");

  await page.getByLabel("Search the safety workspace").fill("Hazard Assessment Checklist");
  await page.getByLabel("Search the safety workspace").press("Enter");
  const sourceResult = page.getByRole("button", { name: /Hazard Assessment Checklist\.pdf.*Company source file/ });
  await expect(sourceResult).toBeVisible();
  await sourceResult.click();

  await expect(page.getByRole("tab", { name: /Source review/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Search Drive archive")).toHaveValue("Hazard Assessment Checklist.pdf");
  await expect(page.locator(".import-candidate-card")).toHaveCount(1);
  await expect(page.locator(".import-candidate-card")).toContainText("Hazard Assessment Checklist.pdf");
});

test("window focus preserves typed modal input and the selected location", async ({ page }) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");

  const selectedLocation = WORKSPACE_FIXTURE.locations[1];
  await page.getByLabel("Filter by location").selectOption(selectedLocation.id);
  await page.getByRole("button", { name: /Report incident/ }).click();
  await page.getByLabel("What happened?").fill("Typed report must survive app switching");
  const queryCountBeforeFocus = await page.evaluate(() => (
    window.__safetyOpsFakeDb.calls.filter((call) => call.method === "from").length
  ));

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(100);

  await expect(page.getByRole("dialog", { name: "Report an incident or near miss" })).toBeVisible();
  await expect(page.getByLabel("What happened?")).toHaveValue("Typed report must survive app switching");
  await expect(page.getByLabel("Filter by location")).toHaveValue(selectedLocation.id);
  const queryCountAfterFocus = await page.evaluate(() => (
    window.__safetyOpsFakeDb.calls.filter((call) => call.method === "from").length
  ));
  expect(queryCountAfterFocus).toBe(queryCountBeforeFocus);
});

test("an empty course catalog offers source review without an enabled assignment path", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { noCourses: true, importCandidates: true });
  await page.goto("/");
  await openStoredView(page, "training", "Training");

  await expect(page.getByRole("button", { name: "Review training source files" })).toBeVisible();
  const enabledAssignmentButtons = await page
    .getByRole("button", { name: "Assign training", exact: true })
    .evaluateAll((buttons) => buttons.filter((button) => !button.disabled).length);
  expect(enabledAssignmentButtons).toBe(0);
});

test("workspace filters change the visible records and sort order", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { filterFixtures: true });
  await page.goto("/");

  await openStoredView(page, "inspections", "Inspections");
  await page.getByLabel("Filter inspection category").selectOption("Environmental");
  await expect(page.getByLabel("Filter inspection category")).toHaveValue("Environmental");
  await expect(page.locator(".template-card")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Spill response inspection" })).toBeVisible();
  await expect(page.getByRole("heading", { name: WORKSPACE_FIXTURE.template.name })).toBeHidden();

  await openStoredView(page, "incidents", "Incidents & near misses");
  await page.getByLabel("Filter incident status").selectOption("Closed");
  await expect(page.getByLabel("Filter incident status")).toHaveValue("Closed");
  await expect(page.getByRole("cell", { name: /Closed first-aid case/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Guarding near miss/ })).toBeHidden();

  await openStoredView(page, "actions", "Action items");
  const actionRows = page.locator("section.table-card tbody tr");
  await expect(actionRows.first()).toContainText("Critical guarding repair");
  await page.getByLabel("Sort corrective actions").selectOption("owner");
  await expect(page.getByLabel("Sort corrective actions")).toHaveValue("owner");
  await expect(actionRows.first()).toContainText("Low-priority label update");

  await openStoredView(page, "documents", "Policies & controlled documents");
  await page.getByLabel("Filter document type").selectOption("Policy");
  await expect(page.getByLabel("Filter document type")).toHaveValue("Policy");
  await expect(page.getByRole("cell", { name: /Machine guarding policy/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Incident reporting procedure/ })).toBeHidden();

  await openStoredView(page, "people", "Employees & credentials");
  await page.getByLabel("Filter worker readiness").selectOption("Training due");
  await expect(page.getByLabel("Filter worker readiness")).toHaveValue("Training due");
  await expect(page.getByRole("cell", { name: /Morgan Reed/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Avery Chen/ })).toBeHidden();
});
