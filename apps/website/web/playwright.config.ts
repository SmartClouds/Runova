import { defineConfig, devices } from '@playwright/test';
import { ADMIN_BASE_URL } from './e2e/admin/stackConfig';

const port = Number(process.env.E2E_PORT || 4329);
const apiPort = Number(process.env.E2E_API_PORT || 4339);

// The tests run against the production build served by `bun run start`, so they also prove that
// the Node adapter output runs under the bun runtime. On-demand pages read a fake API, except in
// the admin project, which runs against the real API and PostgreSQL (e2e/admin/stack.ts) behind
// an HTTPS proxy, since the session and antiforgery cookies are Secure.
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
  projects: [
    {
      name: 'chromium',
      testIgnore: ['admin/**', 'stack/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'admin',
      testMatch: 'admin/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: ADMIN_BASE_URL, ignoreHTTPSErrors: true },
    },
  ],
  webServer: [
    {
      command: 'bun e2e/fakeApiServer.ts',
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
    {
      // Needs Docker and the .NET SDK. It waits for the build above, then serves the same dist.
      command: 'node e2e/admin/stack.ts',
      url: `${ADMIN_BASE_URL}/admin/sign-in`,
      ignoreHTTPSErrors: true,
      env: { E2E_PORT: String(port) },
      reuseExistingServer: false,
      timeout: 420_000,
    },
  ],
});
