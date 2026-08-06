const { test, expect } = require("@playwright/test");
const { configureAuthenticatedWorkspace } = require("./helpers/authenticated-workspace");

async function openWorkspaceView(page, projectName, view, navigationLabel) {
  if (projectName === "mobile") {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: navigationLabel, exact: true }).click();
    return;
  }
  await page.getByRole("button", { name: navigationLabel, exact: true }).click();
}

test("worker sees reporting work but not manager-only creation controls", async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page, { role: "worker", singleLocation: true });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Report incident" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Start a form/ })).toBeEnabled();

  await openWorkspaceView(page, testInfo.project.name, "training", "Training");
  await expect(page.getByRole("button", { name: "Assign training" })).toBeDisabled();

  await openWorkspaceView(page, testInfo.project.name, "actions", "Action items");
  await expect(page.getByRole("button", { name: "New action" })).toBeDisabled();

  await openWorkspaceView(page, testInfo.project.name, "locations", "Locations");
  await expect(page.getByRole("button", { name: "Add location" })).toBeDisabled();
});

test("location supervisor can manage assigned-site work but cannot create locations", async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page, { role: "supervisor", singleLocation: true });
  await page.goto("/");

  await openWorkspaceView(page, testInfo.project.name, "training", "Training");
  await expect(page.getByRole("button", { name: "Assign training" })).toBeEnabled();

  await openWorkspaceView(page, testInfo.project.name, "actions", "Action items");
  await expect(page.getByRole("button", { name: "New action" })).toBeEnabled();

  await openWorkspaceView(page, testInfo.project.name, "locations", "Locations");
  await expect(page.getByRole("button", { name: "Add location" })).toBeDisabled();
});

test("auditor role is read-only in operational workflows", async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page, { role: "auditor", singleLocation: true });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Report incident" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Start a form/ })).toBeDisabled();

  await openWorkspaceView(page, testInfo.project.name, "training", "Training");
  await expect(page.getByRole("button", { name: "Assign training" })).toBeDisabled();

  await openWorkspaceView(page, testInfo.project.name, "actions", "Action items");
  await expect(page.getByRole("button", { name: "New action" })).toBeDisabled();
});

test("company administrator with no active location gets a safe setup state", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { role: "corporate_admin", noLocations: true });
  await page.goto("/");

  await expect(page.getByText("Create an active company location")).toBeVisible();
  await expect(page.getByRole("button", { name: "Report incident" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Start a form/ })).toBeDisabled();

  await page.getByRole("button", { name: "Open locations" }).click();
  await expect(page.getByRole("button", { name: "Add location" })).toBeEnabled();
});

test("company administrator creates a location through the tenant-safe RPC", async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");

  await openWorkspaceView(page, testInfo.project.name, "locations", "Locations");
  await page.getByRole("button", { name: "Add location" }).click();
  await page.getByLabel("Location name").fill("Washington Test Site");
  await page.getByLabel("Location code").fill("WA-TEST");
  await page.getByLabel("Address or city").fill("Washington");
  await page.getByLabel("State-plan starting point").selectOption("WA");
  await page.getByRole("button", { name: "Create location" }).click();

  const rpcCall = await page.evaluate(() =>
    window.__safetyOpsFakeDb.calls.find((call) => call.name === "create_company_location")
  );
  expect(rpcCall.payload).toMatchObject({
    location_name: "Washington Test Site",
    location_code: "WA-TEST",
    state_code: "WA",
    location_address: "Washington",
    location_timezone: "America/Los_Angeles"
  });
});

test("Oregon administrator can submit the canonical Boise timezone", async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");

  await openWorkspaceView(page, testInfo.project.name, "locations", "Locations");
  await page.getByRole("button", { name: "Add location" }).click();
  await page.getByLabel("Location name").fill("Oregon Mountain Test Site");
  await page.getByLabel("Location code").fill("OR-MT");
  await page.getByLabel("Address or city").fill("Oregon");
  await page.getByLabel("State-plan starting point").selectOption("OR");
  await page.getByLabel("Timezone").selectOption("America/Boise");
  await page.getByRole("button", { name: "Create location" }).click();

  const rpcCall = await page.evaluate(() =>
    window.__safetyOpsFakeDb.calls.find((call) => call.name === "create_company_location")
  );
  expect(rpcCall.payload).toMatchObject({
    location_name: "Oregon Mountain Test Site",
    location_code: "OR-MT",
    state_code: "OR",
    location_timezone: "America/Boise"
  });
});
