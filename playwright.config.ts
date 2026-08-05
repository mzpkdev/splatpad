import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build:example && npm run preview:example",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
})
