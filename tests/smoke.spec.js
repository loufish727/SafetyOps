const { test, expect } = require("@playwright/test");
const {
  WORKSPACE_FIXTURE,
  configureAuthenticatedWorkspace
} = require("./helpers/authenticated-workspace");

test("unconfigured public build requires Supabase and contains no demo company", async ({ page }) => {
  await page.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.SAFETYOPS_SUPABASE_URL = "";
      window.SAFETYOPS_SUPABASE_ANON_KEY = "";
      window.SAFETYOPS_ALLOW_PUBLIC_SIGNUP = false;
    `
  }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Connect SafetyOps to Supabase" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeHidden();
  await expect(page.getByText(WORKSPACE_FIXTURE.company.name, { exact: true })).toBeHidden();

  const publicData = await page.evaluate(() => ({
    company: window.SafetyOpsData.company,
    currentUser: window.SafetyOpsData.currentUser,
    locationCount: window.SafetyOpsData.locations.length
  }));
  expect(publicData).toEqual({
    company: null,
    currentUser: null,
    locationCount: 0
  });
});

test("dashboard and location context work", async ({ page }) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  const primaryLocation = WORKSPACE_FIXTURE.locations[0];
  await expect(page.getByText(WORKSPACE_FIXTURE.company.name, { exact: true })).toBeVisible();
  await expect(page.getByText("Completed records", { exact: true }).first()).toBeVisible();

  await page.getByLabel("Filter by location").selectOption(primaryLocation.id);
  await expect(page.locator(".page-heading")).toContainText(primaryLocation.name);
  await expect(
    page.locator(".metric-card").filter({ hasText: "Completed records" }).getByText("0", { exact: true })
  ).toBeVisible();
});

test("task-first home exposes setup, quick actions, the safety inbox, and the monitor", async ({ page }) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Turn the source library into daily safety work" })
  ).toBeVisible();
  await expect(page.getByLabel(/% setup complete$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Safety inbox" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quick start" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start a form/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Report incident/ })).toBeVisible();

  await page.getByRole("button", { name: /Open monitor/ }).click();
  await expect(page.getByRole("heading", { name: "Safety monitor", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open work" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent completed records" })).toBeVisible();
});

test("inspection workflow creates a submitted record", async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("button", { name: "Forms", exact: true })
      .click();
  } else {
    await page.getByLabel("Primary navigation")
      .getByRole("button", { name: "Forms", exact: true })
      .click();
  }
  await expect(page.getByRole("heading", { name: "Forms & inspections" })).toBeVisible();

  const startButtons = page.getByRole("button", { name: "Start", exact: true });
  await expect(startButtons.first()).toBeVisible();
  await startButtons.first().click();

  await expect(page.getByRole("heading", { name: "Start an inspection" })).toBeVisible();
  await page.getByLabel("Area or equipment").fill("Shipping dock / Forklift 07");

  const passChoices = page.locator('label[for$="-pass"]');
  const passCount = await passChoices.count();
  for (let index = 0; index < passCount; index += 1) {
    await passChoices.nth(index).click();
  }

  await page.getByRole("button", { name: "Sign & submit" }).click();
  await expect(page.getByText("Inspection submitted", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Regulatory trace: Review Required .* 0 verified evidence links/)
  ).toBeVisible();
  const submissionCall = await page.evaluate(() =>
    window.__safetyOpsFakeDb.calls.find(
      (call) => call.method === "rpc" && call.name === "submit_inspection_with_regulatory_evidence"
    )
  );
  expect(Object.keys(submissionCall.payload.target_answers).sort()).toEqual([
    "fork-condition",
    "leaks",
    "operator-controls"
  ]);
  expect(
    await page.evaluate(() =>
      window.__safetyOpsFakeDb.calls.some(
        (call) => call.method === "insert" && call.table === "inspections"
      )
    )
  ).toBe(false);
});

test("incident report appears in the register", async ({ page }) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Report incident" }).click();
  await expect(page.getByRole("heading", { name: "Report an incident or near miss" })).toBeVisible();

  await page.getByLabel("What happened?").fill("Pallet shifted during unloading");
  await page.getByLabel("Initial description").fill("The pallet shifted, but the exclusion zone prevented contact.");
  await page.getByRole("button", { name: "Submit report" }).click();

  await expect(page.getByRole("heading", { name: "Incidents & near misses" })).toBeVisible();
  await expect(
    page.getByRole("cell").filter({ hasText: "Pallet shifted during unloading" })
  ).toBeVisible();
});

test("mobile layout avoids horizontal overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile-only layout assertion");
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
});
