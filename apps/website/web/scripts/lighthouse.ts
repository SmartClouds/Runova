// Builds the site for a local origin, so the canonical links point at the page Lighthouse audits,
// then runs Lighthouse CI against `bun run preview` with the budgets in lighthouserc.json. Uses
// Playwright's Chromium unless CHROME_PATH is set.
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const env = {
  ...process.env,
  SITE_URL: 'http://localhost:4321',
  CHROME_PATH: process.env.CHROME_PATH || chromium.executablePath(),
};

for (const command of ['bun run build', 'bunx lhci autorun']) {
  const result = spawnSync(command, { env, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
