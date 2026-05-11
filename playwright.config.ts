import { defineConfig, devices } from '@playwright/test'

// Playwright integration tests run against a sandbox API spun up in
// `globalSetup` (see test/e2e/global-setup.ts). The harness page is
// served by Playwright's webServer block — it loads the built SDK
// (or the source via vite during dev) and exercises real navigator.credentials
// using the WebAuthn virtual authenticator (CDP).

export default defineConfig({
  testDir: './test/e2e/specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:14173',
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
