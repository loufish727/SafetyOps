const { test, expect } = require("@playwright/test");
const {
  WORKSPACE_FIXTURE,
  configureAuthenticatedWorkspace
} = require("./helpers/authenticated-workspace");

test.beforeEach(async ({ page }) => {
  await configureAuthenticatedWorkspace(page);
});

async function openGuide(page, projectName) {
  if (projectName === "mobile") {
    await page.addInitScript(() => {
      localStorage.setItem("safetyops.ui.view", "standards");
    });
    await page.goto("/");
  } else {
    await page.goto("/");
    await page.getByRole("button", { name: "OSHA guide", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "Oregon OSHA manufacturing guide" })).toBeVisible();
}

test("Oregon guide opens on manufacturing priorities with an explicit review boundary", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);

  await expect(page.getByRole("heading", { name: "Oregon OSHA · Division 2 general industry" })).toBeVisible();
  await expect(page.getByText("Industry profile review required", { exact: true })).toBeVisible();
  await expect(page.getByText(/Curated manufacturing index—not the complete Oregon OSHA rulebook/i)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Manufacturing priorities" })).toHaveAttribute("aria-selected", "true");

  const priorityTitles = [
    "Machinery and Machine Guarding",
    "Control of Hazardous Energy (Lockout/Tagout)",
    "Material Handling and Powered Industrial Trucks",
    "Occupational Noise and Audiometric Testing",
    "Welding, Cutting, Brazing, and Hot Work",
    "Hazard Communication"
  ];
  for (const title of priorityTitles) {
    await expect(page.locator(".standard-result-card").filter({ hasText: title })).toBeVisible();
  }
  await expect(page.locator(".standard-result-card").filter({ hasText: "Construction Fall Protection" })).toHaveCount(0);

  await page.getByRole("tab", { name: "All indexed Oregon sources" }).click();
  await expect(page.locator(".standard-result-card").filter({ hasText: "Construction Fall Protection" })).toBeVisible();
});

test("Oregon manufacturing search covers metal-fabrication terms", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);

  await page.getByRole("button", { name: "Cranes & slings" }).click();
  await expect(page.locator(".standard-result-card").filter({ hasText: "Cranes, Hoists, and Slings" })).toBeVisible();

  const searches = [
    ["press brake", "Machinery and Machine Guarding"],
    ["forklift", "Material Handling and Powered Industrial Trucks"],
    ["manganese", "Welding, Cutting, Brazing, and Hot Work"]
  ];
  for (const [query, expectedTitle] of searches) {
    await page.getByLabel("Search citations, titles, topics, and summaries").fill(query);
    await page.getByRole("button", { name: "Search guide" }).click();
    await expect(page.locator(".standard-result-card").filter({ hasText: expectedTitle })).toBeVisible();
  }
});

test("OSHA guide searches the full corpus and opens a source trace", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);

  await page.getByRole("tab", { name: "Federal baseline" }).click();
  await expect(page.getByRole("link", { name: "Open official eCFR" })).toHaveAttribute(
    "href",
    "https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XVII"
  );
  await page.getByRole("tab", { name: "Entire federal chapter" }).click();
  await expect(page.getByText(/1,547 indexed/)).toBeVisible();
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

test("changing locations resets to the selected state authority", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);
  await page.getByRole("tab", { name: "Federal baseline" }).click();

  const washington = WORKSPACE_FIXTURE.locations.find((location) => location.stateCode === "WA");
  await page.getByLabel("Filter by location").selectOption(washington.id);

  await expect(page.getByRole("heading", { name: "Washington DOSH safety reference" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Location rules" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Oregon OSHA · Division 2 general industry" })).toHaveCount(0);
  await expect(page.locator(".standard-result-card").filter({ hasText: "WAC 296-800-140" })).toBeVisible();
  await expect(page.locator(".standard-result-card").filter({ hasText: "WAC 296-800-140" }).getByText("Curated priority", { exact: true })).toBeVisible();
});

test("all-locations view requires a location before showing state rules", async ({ page }, testInfo) => {
  await openGuide(page, testInfo.project.name);
  await page.getByLabel("Filter by location").selectOption("all");

  await expect(page.getByRole("heading", { name: "State OSHA safety reference" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose an Oregon location for the Oregon manufacturing guide" })).toBeVisible();
  await expect(page.getByText("Location required", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".standard-result-card")).toHaveCount(0);
});

test("global search preserves state results in a jurisdiction-labeled research view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Global search is intentionally hidden in the compact mobile shell");
  await page.goto("/");
  await page.getByLabel("Filter by location").selectOption("all");
  const search = page.getByLabel("Search the safety workspace");
  await search.fill("WAC 296-800-140");
  await search.press("Enter");

  await page.locator(".task-row").filter({ hasText: "WAC 296-800-140" }).first().click();
  await expect(page.getByText("Cross-jurisdiction research results", { exact: true })).toBeVisible();
  const result = page.locator(".standard-result-card").filter({ hasText: "WAC 296-800-140" });
  await expect(result).toBeVisible();
  await expect(result.getByText("US-WA", { exact: true })).toBeVisible();
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
    await page.getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("button", { name: "Forms", exact: true })
      .click();
  } else {
    await page.getByLabel("Primary navigation")
      .getByRole("button", { name: "Forms", exact: true })
      .click();
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
