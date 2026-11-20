const { test, expect } = require("@playwright/test");
const { WORKSPACE_FIXTURE, configureAuthenticatedWorkspace } = require("./helpers/authenticated-workspace");

const feedbackText = "Please make the inspection reminders easier to find.\nThanks!";
const sent = { data: { sent: true }, error: null };
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function openWorkspace(page, options = {}) {
  await configureAuthenticatedWorkspace(page, { feedback: true, ...options });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

function feedbackButton(page) {
  return page.getByRole("button", { name: "Feedback", exact: true });
}

async function openFeedback(page) {
  await expect(feedbackButton(page)).toHaveCount(1);
  await feedbackButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function feedbackCalls(page) {
  return page.evaluate(() => window.__safetyOpsFakeDb.calls
    .filter((call) => call.method === "function" && call.name === "send-feedback")
    .map((call) => call.options.body));
}

test("sending feedback keeps the same view, location and unsaved search draft", async ({ page }, testInfo) => {
  await openWorkspace(page, { role: "safety_manager" });
  await expect(feedbackButton(page)).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Library" }).click();
  } else {
    await page.getByRole("button", { name: "Company library", exact: true }).click();
  }
  const heading = page.getByRole("heading", { name: "Company forms & programs", exact: true });
  await expect(heading).toBeVisible();
  await page.getByLabel("Filter by location").selectOption(WORKSPACE_FIXTURE.locations[1].id);
  const draft = page.locator("#program-search-form [name=query]");
  await draft.fill("Unsubmitted search for inspection checklist");
  const previousUrl = page.url();

  const dialog = await openFeedback(page);
  const field = dialog.getByLabel("Your feedback", { exact: true });
  await expect(field).toBeFocused();
  await field.fill(` ${feedbackText} `);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Feedback sent", { exact: true })).toBeVisible();
  await expect(feedbackButton(page)).toBeFocused();
  await expect(heading).toBeVisible();
  await expect(draft).toHaveValue("Unsubmitted search for inspection checklist");
  await expect(page.getByLabel("Filter by location")).toHaveValue(WORKSPACE_FIXTURE.locations[1].id);
  expect(page.url()).toBe(previousUrl);
  expect(await feedbackCalls(page)).toEqual([{
    message: feedbackText,
    view: "programs",
    requestId: expect.stringMatching(requestIdPattern)
  }]);
});

test("a failed send retains feedback for retry and prevents a second in-flight send", async ({ page }) => {
  await openWorkspace(page, {
    feedbackResponses: [{ data: null, error: { message: "Fixture delivery failed." } }, sent],
    delayFeedback: true
  });
  const dialog = await openFeedback(page);
  const field = dialog.getByLabel("Your feedback", { exact: true });
  await field.fill(feedbackText);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sending…" })).toBeDisabled();

  // A second submit event while the React-free app is awaiting the provider
  // must still be blocked, even if it arrives without using the disabled button.
  await dialog.locator("form").dispatchEvent("submit", { bubbles: true, cancelable: true });
  expect(await feedbackCalls(page)).toHaveLength(1);
  expect(await page.evaluate(() => window.__resolveSafetyOpsFeedback())).toBe(true);

  await expect(dialog).toContainText("Feedback could not be sent.");
  await expect(field).toHaveValue(feedbackText);
  await expect(page.getByText("Feedback sent", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();

  const [attempt, retry] = await feedbackCalls(page);
  expect(retry).toEqual(attempt);
  expect(await page.evaluate(() => window.__resolveSafetyOpsFeedback())).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Feedback sent", { exact: true })).toBeVisible();
});

test("feedback supports keyboard dismissal without submitting", async ({ page }) => {
  await openWorkspace(page);
  const dialog = await openFeedback(page);
  const field = dialog.getByLabel("Your feedback", { exact: true });
  await expect(field).toBeFocused();
  await field.fill("This is a draft.");
  await field.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(feedbackButton(page)).toBeFocused();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  expect(await feedbackCalls(page)).toEqual([]);
});

test("unconfirmed email delivery retains the message and explains when to resend", async ({ page }) => {
  await openWorkspace(page, {
    feedbackResponses: [{ data: null, error: { context: { status: 409 } } }]
  });
  const dialog = await openFeedback(page);
  const field = dialog.getByLabel("Your feedback", { exact: true });
  await field.fill(feedbackText);
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Check with the app owner before sending it again.");
  await expect(field).toHaveValue(feedbackText);
  await expect(page.getByText("Feedback sent", { exact: true })).toHaveCount(0);
  expect(await feedbackCalls(page)).toHaveLength(1);
});

test("feedback is unavailable on sign-in and standalone employee handoffs", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { feedback: true, signedOut: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
  await expect(feedbackButton(page)).toHaveCount(0);

  await page.goto(`/#handoff=${"f".repeat(64)}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "This employee form cannot be opened", exact: true })).toBeVisible();
  await expect(feedbackButton(page)).toHaveCount(0);
  expect(await feedbackCalls(page)).toEqual([]);
});
