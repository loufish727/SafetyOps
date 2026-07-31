const { test, expect } = require("@playwright/test");
const { configureAuthenticatedWorkspace } = require("./helpers/authenticated-workspace");

test.beforeEach(async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page, {
    programFixture:
      testInfo.title === "a program form submits without caller-authored evidence hashes"
  });
});

async function openProgramLibrary(page, projectName) {
  if (projectName === "mobile") {
    await page.addInitScript(() => {
      localStorage.setItem("safetyops.ui.view", "programs");
    });
    await page.goto("/");
  } else {
    await page.goto("/");
    await page.getByRole("button", { name: "Safety programs" }).click();
  }
}

async function requirePrivateLibrary(page) {
  const hasPrivateFixture = await page.evaluate(() => window.SafetyOpsProgramLibrary.programs.length > 0);
  test.skip(!hasPrivateFixture, "Requires an ignored private tenant fixture.");
}

test("private safety program library exposes source trace and folders", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await requirePrivateLibrary(page);

  await expect(page.getByRole("heading", { name: "Safety programs & forms" })).toBeVisible();
  await expect(page.getByText("Private-source inventory connected", { exact: true })).toBeVisible();
  await expect(page.getByText("Accident Prevention Program", { exact: true })).toBeVisible();

  const card = page.locator(".program-card").filter({ hasText: "Accident Prevention Program" });
  await card.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("dialog", { name: "Accident Prevention Program" })).toBeVisible();
  await expect(page.getByText("External source identity — not a content hash", { exact: true })).toBeVisible();
});

test("a program form submits without caller-authored evidence hashes", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Templates/ }).click();

  const card = page.locator(".program-card").filter({ hasText: "Test safety acknowledgement" });
  await card.getByRole("button", { name: "Start form" }).click();

  await page.getByLabel("Employee name *").fill("Test Worker");
  await page.getByText("I acknowledge this statement", { exact: true }).click();
  await page.getByLabel("Worker signature *").fill("Test Worker");
  await page.getByRole("button", { name: "Sign & submit" }).click();

  await expect(page.getByText("Digital form submitted", { exact: true })).toBeVisible();

  const evidenceWrites = await page.evaluate(() => {
    const calls = window.__safetyOpsFakeDb?.calls || [];
    return {
      submit: calls.find((call) => call.method === "rpc" && call.name === "submit_safety_program_form"),
      draft: calls.find((call) =>
        call.method === "insert" && call.table === "safety_program_form_submissions"
      ),
      signatures: calls.find((call) =>
        call.method === "insert" && call.table === "safety_program_form_signatures"
      ),
      stored: window.__safetyOpsFakeDb?.tables?.safety_program_form_submissions?.[0],
      storedSignatures:
        window.__safetyOpsFakeDb?.tables?.safety_program_form_signatures || []
    };
  });
  expect(evidenceWrites.submit?.payload).toEqual({
    target_submission_id: expect.any(String)
  });
  expect(evidenceWrites.draft?.rows?.[0]).not.toHaveProperty("submission_context");
  for (const signature of evidenceWrites.signatures?.rows || []) {
    expect(signature).not.toHaveProperty("signer_name_snapshot");
    expect(signature).not.toHaveProperty("signer_role_snapshot");
    expect(signature).not.toHaveProperty("signature_method");
    expect(signature).not.toHaveProperty("signature_intent");
    expect(signature).not.toHaveProperty("signed_payload_sha256");
    expect(signature).not.toHaveProperty("signature_sha256");
    expect(signature).not.toHaveProperty("signature_record");
  }
  for (const signature of evidenceWrites.storedSignatures) {
    expect(signature.signer_name_snapshot).toBe("Morgan Reed");
    expect(signature.signer_role_snapshot).toBe("corporate_admin");
  }
  expect(evidenceWrites.stored).toMatchObject({
    status: "submitted",
    submitted_payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    submission_context: {
      contextVersion: "safetyops-form-submission-context-v1"
    }
  });
});

test("verified original forms can be previewed and downloaded", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await requirePrivateLibrary(page);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Original forms/ }).click();

  const originalCards = page.locator(".form-file-card");
  await expect(originalCards).toHaveCount(5);
  const firstCard = originalCards.first();
  const downloadLink = firstCard.getByRole("link", { name: "Download" });
  const sourcePath = await downloadLink.getAttribute("href");
  expect(sourcePath).toMatch(/^private\/forms\/.+\.pdf$/);

  const response = await page.request.get(new URL(sourcePath, page.url()).href);
  expect(response.ok()).toBeTruthy();
  expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");

  await firstCard.getByRole("button", { name: "View PDF" }).click();
  const preview = page.getByRole("dialog", { name: await firstCard.getByRole("heading").textContent() });
  await expect(preview).toBeVisible();
  await expect(preview.locator("iframe")).toHaveAttribute("src", new RegExp(sourcePath.replaceAll("/", "\\/")));
  await preview.getByRole("button", { name: "Close PDF preview" }).click();
  await expect(preview).toBeHidden();
});

test("a company form upload is fingerprinted, persisted, and downloadable", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("button", { name: "Stage form locally" }).click();

  await page.getByLabel("Source file").setInputFiles({
    name: "weekly-safety-check.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
  });
  await page.getByLabel("Display title").fill("Weekly safety check");
  await page.getByRole("button", { name: "Fingerprint & save locally" }).click();

  await expect(page.getByText("Company form saved locally", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Local staging/ })).toHaveAttribute("aria-selected", "true");
  const card = page.locator(".form-file-card").filter({ hasText: "Weekly safety check" });
  await expect(card.getByText("Local only", { exact: true })).toBeVisible();
  await expect(card).toContainText("SHA-256");

  const stored = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("safetyops-private-form-uploads", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction("formUploads", "readonly").objectStore("formUploads").getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return records.map((item) => ({
      title: item.title,
      sha256: item.sha256,
      blobSize: item.blob.size,
      syncStatus: item.syncStatus
    }));
  });
  expect(stored).toEqual([
    expect.objectContaining({
      title: "Weekly safety check",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      blobSize: 35,
      syncStatus: "local_only"
    })
  ]);

  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download copy" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("weekly-safety-check.pdf");
});

test("program library has no horizontal page overflow on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile-only layout assertion");
  await openProgramLibrary(page, testInfo.project.name);
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
});
