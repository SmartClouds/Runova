import { defineConfig, devices } from '@playwright/test';
import { STACK_URL } from './e2e/stack/stackConfig';

// The stack specs run against apps/website/compose.yaml, the way production runs: PostgreSQL, the
// API and the site in their images behind Caddy on one HTTPS origin. Start the stack first
// (`docker compose -f ../compose.yaml up -d --build --wait`); this config starts nothing.
export default defineConfig({
  testDir: 'e2e/stack',
  globalSetup: './e2e/stack/globalSetup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: STACK_URL,
    // Caddy's local certificate authority signs the localhost certificate.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
