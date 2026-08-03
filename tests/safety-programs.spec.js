const { test, expect } = require("@playwright/test");
const { configureAuthenticatedWorkspace } = require("./helpers/authenticated-workspace");

const ordinaryCompanyMemberTests = new Set([
  "Drive company access is visible to ordinary authorized company members"
]);

const safetyManagerTests = new Set([
  "Drive archive review controls update scope and status for safety managers"
]);

test.beforeEach(async ({ page }, testInfo) => {
  await configureAuthenticatedWorkspace(page, {
    importCandidates: true,
    mislabeledCandidate:
      testInfo.title === "Drive archive never certifies a PDF from its filename alone",
    functionCandidateMetadataMismatch:
      testInfo.title === "Drive archive rejects mismatched download metadata",
    archiveQueryError:
      testInfo.title === "Drive archive query failure does not break the workspace",
    archiveFolderHierarchy:
      testInfo.title === "Drive archive folders organize originals into browsable categories",
    role: ordinaryCompanyMemberTests.has(testInfo.title)
      ? "worker"
      : safetyManagerTests.has(testInfo.title)
        ? "safety_manager"
        : undefined,
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
  const acknowledgement = page.getByLabel("I acknowledge this statement");
  await acknowledgement.locator("..").click();
  await expect(acknowledgement).toBeChecked();
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

test("Drive archive review shows full original trace and classification filters", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Drive archive review/ }).click();

  await expect(page.getByRole("heading", { level: 2, name: "Drive archive review" })).toBeVisible();
  await expect(page.getByText("7 source items · 4 verified original PDFs · 26 verified PDF pages", { exact: true })).toBeVisible();
  await expect(page.locator(".import-candidate-card")).toHaveCount(7);

  const reusableForm = page.locator(".import-candidate-card.kind-form").filter({
    hasText: "Hazard Assessment Checklist.pdf"
  });
  await expect(reusableForm.getByText("Reusable form candidate", { exact: true })).toBeVisible();
  await expect(reusableForm.getByText("Verified original PDF · 12 pages", { exact: true })).toBeVisible();
  await expect(reusableForm.getByText("Synthetic source / Operations", { exact: true })).toBeVisible();
  await expect(reusableForm.getByText("application/pdf", { exact: true })).toBeVisible();
  await expect(reusableForm.getByText("340 KB", { exact: true })).toBeVisible();
  await expect(reusableForm.getByText("LOC-01, LOC-02", { exact: true })).toBeVisible();
  await expect(reusableForm).toContainText("1".repeat(64));
  await expect(reusableForm.getByText("Internal", { exact: true })).toBeVisible();

  const completedRecord = page.locator(".import-candidate-card.kind-record");
  const evidence = page.locator(".import-candidate-card.kind-evidence");
  await expect(completedRecord.getByText("Completed record", { exact: true })).toBeVisible();
  await expect(completedRecord.getByText("Restricted", { exact: true })).toBeVisible();
  await expect(completedRecord).toContainText("Reconfirm business need before downloading");
  await expect(evidence.getByText("Safety evidence", { exact: true })).toBeVisible();
  await expect(page.locator(".import-archive-review")).not.toContainText(/cover|preview/i);
  await expect(page.locator("body")).not.toContainText("drive-provider-secret-must-not-render");
  await expect(page.locator("body")).not.toContainText("private-object-path-must-not-render");

  await page.getByRole("button", { name: /^Completed records 1$/ }).click();
  await expect(page.locator(".import-candidate-card")).toHaveCount(1);
  await expect(completedRecord).toBeVisible();

  await page.getByRole("button", { name: /^All items 7$/ }).click();
  await page.locator("#form-archive-status").selectOption("reviewed");
  await expect(page.locator(".import-candidate-card")).toHaveCount(1);
  await expect(completedRecord).toBeVisible();

  await page.locator("#form-archive-status").selectOption("all");
  await page.getByLabel("Search Drive archive").fill("Oregon OSHA");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".import-candidate-card")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Oregon OSHA Quick Reference.pdf" })).toBeVisible();
});

test("Drive archive folders organize originals into browsable categories", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Drive archive review/ }).click();

  const library = page.locator('.import-folder-library[aria-label="Drive folder library"]');
  await expect(library).toBeVisible();

  const rootGroups = library.locator(":scope > .import-folder-group");
  await expect(rootGroups).toHaveCount(2);
  await expect(library.locator(
    ".import-folder-group > .import-folder-summary > .import-folder-title"
  ))
    .toHaveText([
      "Forms & Appendices",
      "Spanish Translations"
    ]);

  const formsCollection = library.locator(
    '[data-folder-headline="Forms & Appendices"][data-folder-path="Forms & Appendices"]'
  );
  await expect(page.locator(
    '[data-folder-headline="Forms & Appendices"] > .import-folder-summary > .import-folder-count'
  ))
    .toHaveText("6 files");
  await expect(formsCollection).toHaveAttribute("open", "");
  await expect(formsCollection.locator(
    ":scope > .import-folder-children > .import-folder-category > .import-folder-summary > .import-folder-title"
  )).toHaveText([
    "Job Hazard Analysis",
    "Safety Committee",
    "Safety Programs",
    "Training"
  ]);

  const jha = formsCollection.locator(
    ':scope > .import-folder-children > .import-folder-category[data-folder-category="Job Hazard Analysis"][data-folder-path="Forms & Appendices / Job Hazard Analysis"]'
  );
  await expect(jha.locator(":scope > .import-folder-summary > .import-folder-count"))
    .toHaveText("2 files");
  await expect(jha).toHaveAttribute("open", "");

  const northPlant = jha.locator(
    ':scope > .import-folder-children > .import-folder-category[data-folder-category="North Plant"][data-folder-path="Forms & Appendices / Job Hazard Analysis / North Plant"]'
  );
  await expect(northPlant.locator(":scope > .import-folder-summary > .import-folder-count"))
    .toHaveText("2 files");
  await expect(northPlant).toHaveAttribute("open", "");
  await expect(northPlant.locator(
    ":scope > .import-folder-children > .import-folder-category > .import-folder-summary > .import-folder-title"
  )).toHaveText(["Department A"]);

  const departmentA = northPlant.locator(
    ':scope > .import-folder-children > .import-folder-category[data-folder-category="Department A"][data-folder-path="Forms & Appendices / Job Hazard Analysis / North Plant / Department A"]'
  );
  await expect(departmentA.locator(":scope > .import-folder-summary > .import-folder-count"))
    .toHaveText("2 files");
  await expect(departmentA).toHaveAttribute("open", "");
  await expect(departmentA.locator(
    ":scope > .import-folder-children > .import-folder-file-grid > .import-candidate-card h3"
  )).toHaveText([
    "Hazard Assessment Checklist.pdf",
    "Oregon OSHA Quick Reference.pdf"
  ]);

  const companyCard = departmentA.locator(".import-candidate-card").filter({
    hasText: "Hazard Assessment Checklist.pdf"
  });
  await expect(companyCard.getByText("Company access", { exact: true })).toBeVisible();
  await expect(companyCard.getByRole("checkbox", { name: "Safety/admin private" })).not.toBeChecked();
  await expect(companyCard.getByRole("button", { name: "Download original" })).toBeEnabled();

  await page.locator('[data-folder-headline="Forms & Appendices"] > .import-folder-summary').click();
  await expect(formsCollection).not.toHaveAttribute("open", "");
  await expect(companyCard).toBeHidden();
  await page.locator('[data-folder-headline="Forms & Appendices"] > .import-folder-summary').click();
  await expect(formsCollection).toHaveAttribute("open", "");
  await expect(companyCard).toBeVisible();

  const formsRootFiles = page.locator(
    '[data-folder-headline="Forms & Appendices"] > .import-folder-children > .import-folder-file-grid > .import-candidate-card'
  );
  await expect(formsRootFiles).toHaveCount(1);
  await expect(formsRootFiles.locator("h3")).toHaveText(["Unsorted Scan.pdf"]);
  const privateCard = formsRootFiles.filter({ hasText: "Unsorted Scan.pdf" });
  await expect(privateCard.getByRole("checkbox", { name: "Safety/admin private" })).toBeChecked();
  await expect(privateCard.getByRole("checkbox", { name: "Safety/admin private" })).toBeDisabled();
  await expect(privateCard.getByRole("button", { name: "Download original" })).toBeEnabled();

  const spanishCollection = library.locator(
    '[data-folder-headline="Spanish Translations"][data-folder-path="Spanish Translations"]'
  );
  await expect(spanishCollection.locator(":scope > .import-folder-summary > .import-folder-count"))
    .toHaveText("2 files");
  await expect(spanishCollection).not.toHaveAttribute("open", "");
  await page.locator('[data-folder-headline="Spanish Translations"] > .import-folder-summary').click();
  await expect(spanishCollection).toHaveAttribute("open", "");

  const spanishJha = spanishCollection.locator(
    ':scope > .import-folder-children > .import-folder-category[data-folder-category="Job Hazard Analysis"][data-folder-path="Spanish Translations / Job Hazard Analysis"]'
  );
  const spanishNorthPlant = spanishJha.locator(
    ':scope > .import-folder-children > .import-folder-category[data-folder-category="North Plant"][data-folder-path="Spanish Translations / Job Hazard Analysis / North Plant"]'
  );
  const machineShop = spanishNorthPlant.locator(
    ':scope > .import-folder-children > .import-folder-category[data-folder-category="Machine Shop"][data-folder-path="Spanish Translations / Job Hazard Analysis / North Plant / Machine Shop"]'
  );
  await expect(spanishJha.locator(":scope > .import-folder-summary > .import-folder-count"))
    .toHaveText("1 file");
  await expect(machineShop.locator(".import-candidate-card h3"))
    .toHaveText(["Guarding Evidence Photo.jpg"]);

  const spanishRootFiles = page.locator(
    '[data-folder-headline="Spanish Translations"] > .import-folder-children > .import-folder-file-grid > .import-candidate-card'
  );
  await expect(spanishRootFiles).toHaveCount(1);
  await expect(spanishRootFiles.locator("h3")).toHaveText(["Loose Safety Policy.pdf"]);
  await expect(spanishRootFiles.getByText("Company access", { exact: true })).toBeVisible();
  await expect(spanishRootFiles.getByRole("button", { name: "Download original" })).toBeEnabled();

  await expect(library.locator(
    '[data-folder-headline="Uncategorized"], [data-folder-headline="Uncategorized source"]'
  )).toHaveCount(0);
});

test("Drive archive secure download authorizes by candidate id", async ({ page }, testInfo) => {
  await page.route("https://safetyops-test.supabase.co/storage/v1/object/sign/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    headers: { "Content-Disposition": 'attachment; filename="Hazard Assessment Checklist.pdf"' },
    body: "%PDF-1.7\n%%EOF\n"
  }));
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Drive archive review/ }).click();

  const card = page.locator(".import-candidate-card").filter({
    hasText: "Hazard Assessment Checklist.pdf"
  });
  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download original" }).click();
  await downloadPromise;
  await expect(page.getByText("Original download started", { exact: true })).toBeVisible();

  const functionCall = await page.evaluate(() => window.__safetyOpsFakeDb.calls.find((call) => (
    call.method === "function" && call.name === "sign-form-file"
  )));
  expect(functionCall.options).toEqual({
    body: { candidate_id: "70000000-0000-4000-8000-000000000001" }
  });
});

test("Drive archive never certifies a PDF from its filename alone", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Drive archive review/ }).click();

  await expect(page.getByText("8 source items · 4 verified original PDFs · 26 verified PDF pages", { exact: true })).toBeVisible();
  const mislabeled = page.locator(".import-candidate-card").filter({ hasText: "Mislabeled Photo.pdf" });
  await expect(mislabeled.getByText("Verified original JPEG · SHA-256 matched", { exact: true })).toBeVisible();
  await expect(mislabeled).not.toContainText("Verified original PDF");
});

test("Drive archive rejects mismatched download metadata", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Drive archive review/ }).click();

  const card = page.locator(".import-candidate-card").filter({
    hasText: "Hazard Assessment Checklist.pdf"
  });
  await card.getByRole("button", { name: "Download original" }).click();
  await expect(page.getByText("Original unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/does not match the reviewed archive record/i)).toBeVisible();
});

test("Drive archive query failure does not break the workspace", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await expect(page.getByRole("heading", { name: "Safety programs & forms" })).toBeVisible();
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Drive archive review/ }).click();

  await expect(page.getByText(/private Drive archive is temporarily unavailable/i)).toBeVisible();
  await expect(page.getByText("Workspace load failed", { exact: true })).toHaveCount(0);
});

test("Drive company access is visible to ordinary authorized company members", async ({ page }, testInfo) => {
  await page.route("https://safetyops-test.supabase.co/storage/v1/object/sign/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    headers: { "Content-Disposition": 'attachment; filename="Hazard Assessment Checklist.pdf"' },
    body: "%PDF-1.7\n%%EOF\n"
  }));
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();

  const archiveTab = page.getByRole("tab", { name: /Company originals/ });
  await expect(archiveTab).toBeVisible();
  await archiveTab.click();

  await expect(page.getByText(
    /available to authenticated company members; original files are never public/i
  ).first()).toBeVisible();
  await expect(page.locator(".import-candidate-card")).toHaveCount(3);

  const companyCard = page.locator(".import-candidate-card").filter({
    hasText: "Hazard Assessment Checklist.pdf"
  });
  await expect(companyCard).toBeVisible();
  await expect(companyCard.getByText("Company access", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signed JHA - July.pdf" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Hearing Conservation Program.docx" })).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await companyCard.getByRole("button", { name: "Download original" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Hazard Assessment Checklist.pdf");

  const privateAttempt = await page.evaluate(async () => {
    const result = await window.supabase.createClient().functions.invoke("sign-form-file", {
      body: { candidate_id: "70000000-0000-4000-8000-000000000003" }
    });
    return {
      data: result.data,
      error: result.error?.message || null
    };
  });
  expect(privateAttempt).toEqual({
    data: null,
    error: "Candidate file access denied."
  });
});

test("Drive archive review controls update scope and status for safety managers", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();

  const archiveTab = page.getByRole("tab", { name: /Drive archive review/ });
  await expect(archiveTab).toBeVisible();
  await archiveTab.click();
  await expect(page.locator(".import-candidate-card")).toHaveCount(7);

  const card = page.locator(".import-candidate-card").filter({
    hasText: "Hazard Assessment Checklist.pdf"
  });
  const privateToggle = card.getByLabel("Safety/admin private");
  await expect(privateToggle).not.toBeChecked();
  await privateToggle.check();
  await card.getByLabel("Review status").selectOption("approved");
  await card.getByRole("button", { name: "Save review" }).click();

  await expect.poll(() => page.evaluate(() => {
    const call = window.__safetyOpsFakeDb.calls.find((item) => (
      item.method === "rpc"
      && item.name === "update_safety_program_import_candidate_review"
    ));
    return call?.payload || null;
  })).toEqual({
    target_candidate_id: "70000000-0000-4000-8000-000000000001",
    target_access_scope: "safety_admin_private",
    target_review_status: "approved"
  });

  const updated = await page.evaluate(() => window.__safetyOpsFakeDb.tables
    .safety_program_import_candidates
    .find((item) => item.id === "70000000-0000-4000-8000-000000000001"));
  expect(updated).toMatchObject({
    access_scope: "safety_admin_private",
    review_status: "approved"
  });
});

test("Drive restricted candidates cannot be made company visible", async ({ page }, testInfo) => {
  await openProgramLibrary(page, testInfo.project.name);
  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Drive archive review/ }).click();

  const restrictedCard = page.locator(".import-candidate-card").filter({
    hasText: "Signed JHA - July.pdf"
  });
  const privateToggle = restrictedCard.getByRole("checkbox", { name: "Safety/admin private" });
  await expect(privateToggle).toBeChecked();
  await expect(privateToggle).toBeDisabled();

  const result = await page.evaluate(async () => {
    const response = await window.supabase.createClient().rpc(
      "update_safety_program_import_candidate_review",
      {
        target_candidate_id: "70000000-0000-4000-8000-000000000002",
        target_access_scope: "company",
        target_review_status: "approved"
      }
    );
    const stored = window.__safetyOpsFakeDb.tables.safety_program_import_candidates.find((item) => (
      item.id === "70000000-0000-4000-8000-000000000002"
    ));
    return {
      error: response.error?.message || null,
      accessScope: stored?.access_scope || null
    };
  });
  expect(result).toMatchObject({
    accessScope: "safety_admin_private"
  });
  expect(result.error).toMatch(/must remain safety\/admin private/i);
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
