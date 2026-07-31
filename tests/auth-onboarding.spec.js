const { test, expect } = require("@playwright/test");

const fakeSupabaseClient = `
  window.__safetyOpsAuthCalls = [];
  window.supabase = {
    createClient: function () {
      return {
        auth: {
          getSession: async function () {
            return {
              data: { session: window.__safetyOpsTestSession || null },
              error: null
            };
          },
          onAuthStateChange: function () {
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
          signInWithPassword: async function (payload) {
            window.__safetyOpsAuthCalls.push({ method: "signIn", payload: payload });
            return { data: { session: null }, error: null };
          },
          signUp: async function (payload) {
            window.__safetyOpsAuthCalls.push({ method: "signUp", payload: payload });
            return { data: { session: null, user: { id: "test-user" } }, error: null };
          },
          signOut: async function () {
            window.__safetyOpsAuthCalls.push({ method: "signOut" });
            return { error: null };
          }
        },
        from: function () {
          var chain = {
            select: function () { return chain; },
            eq: function () { return chain; },
            order: function () { return chain; },
            limit: function () { return chain; },
            maybeSingle: async function () { return { data: null, error: null }; }
          };
          return chain;
        },
        rpc: async function (name, payload) {
          window.__safetyOpsAuthCalls.push({ method: "rpc", name: name, payload: payload });
          return { data: null, error: null };
        }
      };
    }
  };
`;

async function configureSupabaseRoutes(page, session = null) {
  await page.route("**/vendor/supabase.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: fakeSupabaseClient
  }));
  await page.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.SAFETYOPS_SUPABASE_URL = "https://safetyops-test.supabase.co";
      window.SAFETYOPS_SUPABASE_ANON_KEY = "test-publishable-key";
      window.__safetyOpsTestSession = ${JSON.stringify(session)};
    `
  }));
}

test("configured public shell requires account access", async ({ page }, testInfo) => {
  await configureSupabaseRoutes(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Safety command center" })).toBeHidden();

  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Full name").fill("Prototype Owner");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "Create secure account" }).click();

  await expect(page.getByText(/Account created\. Check your email/)).toBeVisible();
  const calls = await page.evaluate(() => window.__safetyOpsAuthCalls);
  expect(calls).toEqual([
    {
      method: "signUp",
      payload: {
        email: "owner@example.test",
        password: "correct-horse-battery-staple",
        options: { data: { full_name: "Prototype Owner" } }
      }
    }
  ]);

  if (testInfo.project.name === "mobile") {
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  }
});

test("authenticated user without a membership sees company onboarding", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      user_metadata: { full_name: "Prototype Owner" }
    }
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Create your SafetyOps company" })).toBeVisible();
  await expect(page.getByText("GitHub receives no tenant data.")).toBeVisible();
  await expect(page.getByLabel("Company name")).toBeVisible();
  await expect(page.getByLabel("First location name")).toBeVisible();
  await expect(page.getByLabel("Location state")).toBeVisible();
});

test("company onboarding sends the location and state to the tenant-safe RPC", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      user_metadata: { full_name: "Prototype Owner" }
    }
  });
  await page.goto("/");

  await page.getByLabel("Company name").fill("Example Manufacturing");
  await page.getByLabel("First location name").fill("Oregon Test Site");
  await page.getByLabel("Location state").selectOption("OR");
  await page.getByRole("button", { name: "Create company" }).click();

  const rpcCall = await page.evaluate(() =>
    window.__safetyOpsAuthCalls.find((call) => call.method === "rpc")
  );
  expect(rpcCall.name).toBe("create_company_with_owner");
  expect(rpcCall.payload).toMatchObject({
    company_name: "Example Manufacturing",
    first_location_name: "Oregon Test Site",
    first_state_code: "OR"
  });
  expect(rpcCall.payload.company_slug).toMatch(/^example-manufacturing-[a-z0-9-]+$/);
});
