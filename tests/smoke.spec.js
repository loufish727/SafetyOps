const { test, expect } = require("@playwright/test");

test("dashboard and location context work", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Safety command center" })).toBeVisible();
  const tenant = await page.evaluate(() => ({
    companyName: window.SafetyOpsData.company.name,
    locationId: window.SafetyOpsData.locations[0].id,
    locationName: window.SafetyOpsData.locations[0].name,
    training: window.SafetyOpsData.locations[0].training
  }));
  await expect(page.getByText(tenant.companyName, { exact: true })).toBeVisible();
  await expect(page.getByText("Training current", { exact: true })).toBeVisible();

  await page.getByLabel("Filter by location").selectOption(tenant.locationId);
  await expect(page.locator(".page-heading")).toContainText(tenant.locationName);
  await expect(
    page.locator(".metric-card").filter({ hasText: "Training current" }).getByText(`${tenant.training}%`, { exact: true })
  ).toBeVisible();
});

test("inspection workflow creates a submitted record", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Forms & inspections" }).click();
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
  await expect(page.getByText(/Template 1\.5 · OSHA snapshot 2026-07-28/)).toBeVisible();
});

test("incident report appears in the register", async ({ page }) => {
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
  await page.goto("/");
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
});
