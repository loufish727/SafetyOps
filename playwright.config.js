const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 5,
  use: {
    baseURL: process.env.SAFETYOPS_BASE_URL || "http://127.0.0.1:4173"
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
  webServer: process.env.SAFETYOPS_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: true,
        timeout: 30_000
      }
});
