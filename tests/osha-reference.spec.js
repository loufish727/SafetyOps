const { test, expect } = require("@playwright/test");

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

  await expect(page.getByText(/1,547 provisions/)).toBeVisible();
  await expect(page.getByText(/current through 2026-07-28/i).first()).toBeVisible();

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

  const contexts = await page.evaluate(() => {
    const locationName = (id) => window.SafetyOpsData.locations.find((item) => item.id === id)?.name;
    return window.SafetyOpsRegulatoryData.statePlans
      .filter((item) => item.jurisdiction !== "US-FED" && item.locationIds.some((id) => locationName(id)))
      .slice(0, 2)
      .map((item) => ({
        planName: item.name,
        locationId: item.locationIds.find((id) => locationName(id)),
        locationName: locationName(item.locationIds.find((id) => locationName(id)))
      }));
  });
  expect(contexts).toHaveLength(2);

  await page.getByLabel("Filter by location").selectOption(contexts[0].locationId);
  await expect(page.locator(".page-heading")).toContainText(contexts[0].locationName);
  await expect(page.getByText(contexts[0].planName, { exact: true })).toBeVisible();
  await expect(page.getByText("Federal OSHA", { exact: true })).toBeVisible();

  await page.getByLabel("Filter by location").selectOption(contexts[1].locationId);
  await expect(page.locator(".page-heading")).toContainText(contexts[1].locationName);
  await expect(page.getByText(contexts[1].planName, { exact: true })).toBeVisible();
  await expect(page.getByText("Federal OSHA", { exact: true })).toBeVisible();
  await expect(page.getByText(contexts[0].planName, { exact: true })).toBeHidden();
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
