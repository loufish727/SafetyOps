const { test, expect } = require("@playwright/test");

const USER_A = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner-a@example.test",
  user_metadata: { full_name: "Owner A" }
};
const USER_B = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "owner-b@example.test",
  user_metadata: { full_name: "Owner B" }
};

function sessionFor(user, accessToken = `session-${user.id}`) {
  return {
    access_token: accessToken,
    refresh_token: `refresh-${user.id}`,
    user
  };
}

const fakeSupabaseClient = `
  window.supabase = {
    createClient: function () {
      var options = window.__safetyOpsAuthTestOptions || {};
      var currentSession = options.session || null;
      var authCallback = null;
      var pendingMemberships = new Map();
      var clone = function (value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      };

      window.__safetyOpsAuthCalls = [];
      window.__safetyOpsAuthLifecycle = [];
      window.__safetyOpsWorkspaceLoads = 0;
      window.__emitSafetyOpsAuthState = async function (event, session) {
        currentSession = session || null;
        if (authCallback) await authCallback(event, currentSession);
      };
      window.__resolveSafetyOpsMembership = function (userId, data, error) {
        var resolve = pendingMemberships.get(userId);
        if (!resolve) return false;
        pendingMemberships.delete(userId);
        resolve({ data: data || null, error: error || null });
        return true;
      };

      return {
        auth: {
          onAuthStateChange: function (callback) {
            window.__safetyOpsAuthLifecycle.push("subscribe");
            authCallback = callback;
            return { data: { subscription: { unsubscribe: function () {} } } };
          },
          initialize: async function () {
            window.__safetyOpsAuthLifecycle.push("initialize");
            return { error: options.initializeError || null };
          },
          getSession: async function () {
            window.__safetyOpsAuthLifecycle.push("getSession");
            return {
              data: { session: clone(currentSession) },
              error: options.getSessionError || null
            };
          },
          signInWithPassword: async function (payload) {
            window.__safetyOpsAuthCalls.push({ method: "signIn", payload: clone(payload) });
            if (options.signInError) {
              return { data: { session: null }, error: options.signInError };
            }
            currentSession = clone(options.signInSession || null);
            if (currentSession && authCallback) await authCallback("SIGNED_IN", currentSession);
            return { data: { session: clone(currentSession) }, error: null };
          },
          signUp: async function (payload) {
            window.__safetyOpsAuthCalls.push({ method: "signUp", payload: clone(payload) });
            return { data: { session: null, user: { id: "test-user" } }, error: null };
          },
          resetPasswordForEmail: async function (email, resetOptions) {
            window.__safetyOpsAuthCalls.push({
              method: "resetPassword",
              email: email,
              options: clone(resetOptions)
            });
            return options.resetPasswordError
              ? { data: null, error: options.resetPasswordError }
              : { data: {}, error: null };
          },
          updateUser: async function (payload) {
            window.__safetyOpsAuthCalls.push({ method: "updateUser", payload: clone(payload) });
            if (options.updateUserError) {
              return { data: { user: null }, error: options.updateUserError };
            }
            if (currentSession && authCallback) await authCallback("USER_UPDATED", currentSession);
            return { data: { user: currentSession ? clone(currentSession.user) : null }, error: null };
          },
          signOut: async function () {
            window.__safetyOpsAuthCalls.push({ method: "signOut" });
            currentSession = null;
            if (authCallback) await authCallback("SIGNED_OUT", null);
            return { error: null };
          }
        },
        from: function (table) {
          var filters = {};
          var chain = {
            select: function () { return chain; },
            eq: function (column, value) {
              filters[column] = value;
              return chain;
            },
            order: function () { return chain; },
            limit: function () { return chain; },
            maybeSingle: async function () {
              if (table !== "company_memberships") return { data: null, error: null };
              var userId = filters.user_id;
              window.__safetyOpsWorkspaceLoads += 1;
              if ((options.delayedMembershipUserIds || []).includes(userId)) {
                return await new Promise(function (resolve) {
                  pendingMemberships.set(userId, resolve);
                });
              }
              var memberships = options.memberships || {};
              return {
                data: Object.prototype.hasOwnProperty.call(memberships, userId)
                  ? clone(memberships[userId])
                  : null,
                error: null
              };
            }
          };
          return chain;
        },
        rpc: async function (name, payload) {
          window.__safetyOpsAuthCalls.push({ method: "rpc", name: name, payload: clone(payload) });
          return { data: null, error: null };
        }
      };
    }
  };
`;

async function configureSupabaseRoutes(page, initialOptions = {}) {
  let routeOptions = { ...initialOptions };
  await page.route("**/vendor/supabase.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: fakeSupabaseClient
  }));
  await page.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.SAFETYOPS_SUPABASE_URL = "https://safetyops-test.supabase.co";
      window.SAFETYOPS_SUPABASE_ANON_KEY = "test-publishable-key";
      window.SAFETYOPS_ALLOW_PUBLIC_SIGNUP = ${routeOptions.publicSignup === true};
      window.SAFETYOPS_ENABLE_PERSISTENT_AUTH_SESSION = false;
      window.__safetyOpsAuthTestOptions = ${JSON.stringify(routeOptions)};
    `
  }));
  return {
    setOptions(nextOptions) {
      routeOptions = { ...nextOptions };
    }
  };
}

test("invite-only configuration shows sign in without public account creation", async ({ page }) => {
  await configureSupabaseRoutes(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Create account" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__safetyOpsAuthLifecycle.slice(0, 3))).toEqual([
    "subscribe",
    "initialize",
    "getSession"
  ]);
});

test("optional public signup preserves an explicit confirmation redirect", async ({ page }) => {
  await configureSupabaseRoutes(page, { publicSignup: true });
  await page.goto("/");

  await page.getByRole("tab", { name: "Create account" }).click();
  await expect(page.getByLabel("Password")).toHaveAttribute("minlength", "8");
  await page.getByLabel("Full name").fill("Prototype Owner");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("Safety!!");
  await page.getByRole("button", { name: "Create secure account" }).click();

  await expect(page.getByText(/Account created\. Check your email/)).toBeVisible();
  const signUpCall = await page.evaluate(() =>
    window.__safetyOpsAuthCalls.find((call) => call.method === "signUp")
  );
  expect(signUpCall.payload.options.emailRedirectTo).toBe("http://127.0.0.1:4173/?auth=invite");
});

test("verified invite callback requires a new password before provisioning", async ({ page }) => {
  const invitedSession = sessionFor(USER_A, "invite-session");
  await configureSupabaseRoutes(page, { session: invitedSession });
  await page.goto("/?auth=invite#access_token=invite-session&refresh_token=invite-refresh&type=invite");

  await expect(page.getByRole("heading", { name: "Finish your invitation" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("Safety!!");
  await page.getByLabel("Confirm new password", { exact: true }).fill("Safety!!");
  await page.getByRole("button", { name: "Set password and continue" }).click();

  await expect(page.getByRole("heading", { name: "Your company access is being prepared" })).toBeVisible();
  const updateCall = await page.evaluate(() =>
    window.__safetyOpsAuthCalls.find((call) => call.method === "updateUser")
  );
  expect(updateCall.payload.password).toBe("Safety!!");
  expect(new URL(page.url()).searchParams.has("auth")).toBe(false);
  expect(new URL(page.url()).hash).toBe("");
});

test("invite password setup enforces the app's eight-character, capital, and special-character policy", async ({ page }) => {
  const invitedSession = sessionFor(USER_A, "invite-session");
  await configureSupabaseRoutes(page, { session: invitedSession });
  await page.goto("/?auth=invite#access_token=invite-session&refresh_token=invite-refresh&type=invite");

  const newPassword = page.getByLabel("New password", { exact: true });
  const confirmation = page.getByLabel("Confirm new password", { exact: true });
  await expect(newPassword).toHaveAttribute("minlength", "8");
  await expect(confirmation).toHaveAttribute("minlength", "8");

  await newPassword.fill("Short!A");
  expect(await newPassword.evaluate((input) => input.validity.tooShort)).toBe(true);

  await newPassword.fill("lowercase!");
  await confirmation.fill("lowercase!");
  await page.getByRole("button", { name: "Set password and continue" }).click();

  await expect(page.getByRole("status")).toHaveText("Use at least 8 characters with a capital letter and a special character.");
  expect(await page.evaluate(() =>
    window.__safetyOpsAuthCalls.filter((call) => call.method === "updateUser").length
  )).toBe(0);

  await newPassword.fill("Safety!!");
  await confirmation.fill("Safety!?");
  await page.getByRole("button", { name: "Set password and continue" }).click();

  await expect(page.getByRole("status")).toHaveText("The passwords do not match.");
  expect(await page.evaluate(() =>
    window.__safetyOpsAuthCalls.filter((call) => call.method === "updateUser").length
  )).toBe(0);

  await page.getByLabel("New password", { exact: true }).fill("CapitalA");
  await page.getByLabel("Confirm new password", { exact: true }).fill("CapitalA");
  await page.getByRole("button", { name: "Set password and continue" }).click();

  await expect(page.getByRole("status")).toHaveText("Use at least 8 characters with a capital letter and a special character.");
  expect(await page.evaluate(() =>
    window.__safetyOpsAuthCalls.filter((call) => call.method === "updateUser").length
  )).toBe(0);
});

test("PASSWORD_RECOVERY event is authoritative for password setup", async ({ page }) => {
  const recoveredSession = sessionFor(USER_A, "recovery-session");
  await configureSupabaseRoutes(page);
  await page.goto("/");

  await page.evaluate((session) =>
    window.__emitSafetyOpsAuthState("PASSWORD_RECOVERY", session), recoveredSession
  );
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
});

test("a naked recovery query cannot force an ordinary session into password setup", async ({ page }) => {
  await configureSupabaseRoutes(page, { session: sessionFor(USER_A) });
  await page.goto("/?auth=recovery");

  await expect(page.getByRole("heading", { name: "Your company access is being prepared" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toHaveCount(0);
});

test("expired invitation callback fails closed with a generic recovery path", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    initializeError: { message: "otp_expired: internal provider detail" }
  });
  await page.goto("/?auth=invite&code=expired-pkce-code&error=access_denied&error_code=otp_expired&error_description=internal+provider+detail&type=invite");

  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByText("This invitation link is invalid or expired. Ask your SafetyOps administrator for a new invitation.")).toBeVisible();
  await expect(page.getByText(/internal provider detail/)).toHaveCount(0);
  const callbackUrl = new URL(page.url());
  for (const parameter of ["auth", "code", "error", "error_code", "error_description", "type"]) {
    expect(callbackUrl.searchParams.has(parameter)).toBe(false);
  }
  expect(callbackUrl.hash).toBe("");
});

test("expired recovery callback offers a new non-enumerating request", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    initializeError: { message: "otp_expired: internal provider detail" }
  });
  await page.goto("/?auth=recovery#error=access_denied&error_code=otp_expired&type=recovery");

  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByText("This password-recovery link is invalid or expired. Request a new recovery link.")).toBeVisible();
  await expect(page.getByText(/internal provider detail/)).toHaveCount(0);
});

test("password recovery sends a non-enumerating reset request", async ({ page }) => {
  await configureSupabaseRoutes(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByRole("button", { name: "Send recovery link" }).click();

  await expect(page.getByText("If that invited account exists, a recovery link has been sent.")).toBeVisible();
  const resetCall = await page.evaluate(() =>
    window.__safetyOpsAuthCalls.find((call) => call.method === "resetPassword")
  );
  expect(resetCall.email).toBe("owner@example.test");
  expect(resetCall.options.redirectTo).toBe("http://127.0.0.1:4173/?auth=recovery");
});

test("password recovery hides provider errors and account existence", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    resetPasswordError: {
      message: "User not found for owner@example.test: internal provider detail"
    }
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByRole("button", { name: "Send recovery link" }).click();

  await expect(page.getByText("If that invited account exists, a recovery link has been sent.")).toBeVisible();
  await expect(page.getByText(/user not found|internal provider detail|owner@example\.test/i)).toHaveCount(0);
});

test("successful password sign in loads provisioning once despite duplicate auth signals", async ({ page }) => {
  const signedInSession = sessionFor(USER_A, "signed-in-session");
  await configureSupabaseRoutes(page, { signInSession: signedInSession });
  await page.goto("/");

  await page.getByLabel("Email").fill(USER_A.email);
  expect(await page.getByLabel("Password").getAttribute("minlength")).toBeNull();
  await page.getByLabel("Password").fill("Safety!!");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Your company access is being prepared" })).toBeVisible();
  await expect(page.getByText(new RegExp(USER_A.email))).toBeVisible();
  expect(await page.evaluate(() => window.__safetyOpsWorkspaceLoads)).toBe(1);
  const signInCall = await page.evaluate(() =>
    window.__safetyOpsAuthCalls.find((call) => call.method === "signIn")
  );
  expect(signInCall.payload).toEqual({
    email: USER_A.email,
    password: "Safety!!"
  });
});

test("invalid password remains signed out without tenant state", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    signInError: { message: "Invalid login credentials" }
  });
  await page.goto("/");

  await page.getByLabel("Email").fill(USER_A.email);
  await page.getByLabel("Password").fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Invalid login credentials")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByText(USER_A.email)).toHaveCount(0);
});

test("an authenticated account without membership cannot self-create a company", async ({ page }) => {
  await configureSupabaseRoutes(page, { session: sessionFor(USER_A) });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Your company access is being prepared" })).toBeVisible();
  await expect(page.getByLabel("Company name")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create company" })).toHaveCount(0);
  expect(await page.evaluate(() =>
    window.__safetyOpsAuthCalls.some((call) => call.name === "create_company_with_owner")
  )).toBe(false);
});

test("sign out remains signed out after reload when sessions are not persisted", async ({ page }) => {
  const controller = await configureSupabaseRoutes(page, { session: sessionFor(USER_A) });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your company access is being prepared" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  controller.setOptions({ session: null });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("a delayed workspace load cannot restore user A after sign out", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    session: sessionFor(USER_A),
    delayedMembershipUserIds: [USER_A.id]
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Securing your workspace" })).toBeVisible();

  const immediateState = await page.evaluate(async (userId) => {
    void window.__emitSafetyOpsAuthState("SIGNED_OUT", null);
    const resolved = window.__resolveSafetyOpsMembership(userId, null, null);
    await Promise.resolve();
    await Promise.resolve();
    return {
      resolved,
      heading: document.querySelector(".auth-card h2")?.textContent || ""
    };
  }, USER_A.id);
  expect(immediateState).toEqual({
    resolved: true,
    heading: "Securing your workspace"
  });

  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByText(USER_A.email)).toHaveCount(0);
});

test("a delayed user A workspace cannot overwrite user B", async ({ page }) => {
  await configureSupabaseRoutes(page, {
    session: sessionFor(USER_A),
    delayedMembershipUserIds: [USER_A.id]
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Securing your workspace" })).toBeVisible();

  await page.evaluate((session) =>
    window.__emitSafetyOpsAuthState("SIGNED_IN", session), sessionFor(USER_B)
  );
  await expect(page.getByRole("heading", { name: "Your company access is being prepared" })).toBeVisible();
  await expect(page.getByText(new RegExp(USER_B.email))).toBeVisible();
  expect(await page.evaluate((userId) =>
    window.__resolveSafetyOpsMembership(userId, null, null), USER_A.id
  )).toBe(true);
  await page.waitForTimeout(25);

  await expect(page.getByText(new RegExp(USER_B.email))).toBeVisible();
  await expect(page.getByText(USER_A.email)).toHaveCount(0);
});
