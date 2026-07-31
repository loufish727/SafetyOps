const { test, expect } = require("@playwright/test");
const {
  WORKSPACE_FIXTURE,
  configureAuthenticatedWorkspace
} = require("./helpers/authenticated-workspace");

test.beforeEach(async ({ page }) => {
  await configureAuthenticatedWorkspace(page);
});

async function openGuide(page, projectName) {
  await page.goto("/");
  if (projectName === "mobile") {
    await page.getByRole("button", { name: "Guide", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "OSHA reference", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "OSHA standards reference" })).toBeVisible();
}

test("OSHA guide searches the full corpus and opens a source trace", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);

  await page.getByRole("tab", { name: "Federal baseline" }).click();
  await expect(page.getByText(/1,547 in view/)).toBeVisible();
  const currentThrough = await page.evaluate(() => window.SafetyOpsRegulatoryData.meta.currentThrough);
  await expect(page.getByText(new RegExp(`current through ${currentThrough}`, "i")).first()).toBeVisible();

  await page.getByLabel("Search citations, titles, topics, and summaries").fill("1910.178");
  await page.getByRole("button", { name: "Search guide" }).click();

  const result = page.locator(".standard-result-card").filter({ hasText: "Powered industrial trucks" });
  await expect(result).toBeVisible();
  await expect(result.getByRole("link", { name: "Official text" })).toHaveAttribute(
    "href",
    "https://www.ecfr.gov/current/title-29/section-1910.178"
  );

  await result.getByRole("button", { name: "View trace" }).click();
  const drawer = page.locator(".reference-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "29 CFR 1910.178" })).toBeVisible();
  await expect(drawer.getByText("Source fingerprint")).toBeVisible();
  await expect(drawer.getByText(/Current through/)).toBeVisible();
  await drawer.getByRole("button", { name: "Close regulatory trace" }).click();
  await expect(drawer).toBeHidden();
});

test("guide changes jurisdiction context by location", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);

  const citations = await page.evaluate(() => Object.fromEntries(
    ["OR", "WA", "CA"].map((stateCode) => [
      stateCode,
      window.SafetyOpsStateRegulatoryData.standards.find((item) => item.stateCode === stateCode)?.citation
    ])
  ));
  const planNames = {
    OR: "Oregon OSHA",
    WA: "Washington DOSH",
    CA: "Cal/OSHA"
  };
  const contexts = WORKSPACE_FIXTURE.locations.map((location) => ({
    planName: planNames[location.stateCode],
    jurisdiction: location.jurisdiction,
    locationId: location.id,
    locationName: location.name,
    citation: citations[location.stateCode]
  }));
  expect(contexts.every((item) => item.locationId && item.citation)).toBe(true);

  for (const context of contexts) {
    await page.getByLabel("Filter by location").selectOption(context.locationId);
    await expect(page.locator(".page-heading")).toContainText(context.locationName);
    await expect(page.getByText(context.planName, { exact: true })).toBeVisible();
    await expect(page.getByText("Federal OSHA", { exact: true })).toBeVisible();
    await expect(page.getByText("Jurisdiction review required", { exact: true }).first()).toBeVisible();
    const stateResult = page.locator(".standard-result-card").filter({ hasText: context.citation }).first();
    await expect(stateResult).toBeVisible();
    await expect(stateResult.getByText(context.jurisdiction, { exact: true })).toBeVisible();
  }
});

test("state trace is explicit about pending source snapshots", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);
  const citation = await page.evaluate(() =>
    window.SafetyOpsStateRegulatoryData.standards.find((item) => item.stateCode === "OR").citation
  );
  const context = {
    locationId: WORKSPACE_FIXTURE.locations[0].id,
    citation
  };
  await page.getByLabel("Filter by location").selectOption(context.locationId);
  const result = page.locator(".standard-result-card").filter({ hasText: context.citation }).first();
  await result.getByRole("button", { name: "View trace" }).click();
  const drawer = page.locator(".reference-drawer");
  await expect(drawer.getByText("Official link verified", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Pending server-side source snapshot", { exact: true })).toBeVisible();
  await expect(drawer.getByText(/not yet a compliance-ready legal determination/i)).toBeVisible();
});

test("opening a question trace preserves an in-progress inspection", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Forms & inspections" }).click();
  }

  const forkliftTemplate = page.locator(".template-card").filter({ hasText: "Powered industrial truck pre-use" });
  await forkliftTemplate.getByRole("button", { name: "Start", exact: true }).click();
  const area = page.getByLabel("Area or equipment");
  await area.fill("Forklift 07 / shipping dock");

  await page.locator(".modal").getByRole(
    "button",
    { name: /Open trace for 29 CFR 1910\.178\(q\)\(7\)/ }
  ).first().click();
  await expect(page.locator(".reference-drawer")).toBeVisible();
  await page.getByRole("button", { name: "Close regulatory trace" }).click();

  await expect(area).toHaveValue("Forklift 07 / shipping dock");
});

test("mobile guide has no horizontal page overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile-only layout assertion");
  await openGuide(page, testInfo.project.name);
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
});
