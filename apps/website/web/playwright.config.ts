import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4329);
const apiPort = Number(process.env.E2E_API_PORT || 4339);

// The tests run against the production build served by `bun run start`, so they also prove that
// the Node adapter output runs under the bun runtime. On-demand pages read a fake API.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'bun e2e/fakeReleaseApiServer.ts',
      url: `http://127.0.0.1:${apiPort}/api/v1/releases/latest`,
      env: { FAKE_API_PORT: String(apiPort) },
      reuseExistingServer: false,
    },
    {
      command: 'bun run build && bun run start',
      url: `http://127.0.0.1:${port}/`,
      env: {
        HOST: '127.0.0.1',
        PORT: String(port),
        WEBSITE_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
      },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
