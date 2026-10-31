// Builds the site for a local origin, so the canonical links point at the page Lighthouse audits,
// then runs Lighthouse CI against `bun run preview` with the budgets in lighthouserc.json. The
// download page, the blog post and the news item read e2e/fakeApiServer.ts, started here. Uses
// Playwright's Chromium unless CHROME_PATH is set.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const apiPort = Number(process.env.FAKE_API_PORT || 4349);
const env = {
  ...process.env,
  SITE_URL: 'http://localhost:4321',
  CHROME_PATH: process.env.CHROME_PATH || chromium.executablePath(),
  FAKE_API_PORT: String(apiPort),
  WEBSITE_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
};

const api: ChildProcess = spawn('bun', ['e2e/fakeApiServer.ts'], { env, stdio: 'inherit' });
let status = 0;
try {
  await waitForApi();
  for (const command of ['bun run build', 'bunx lhci autorun']) {
    const result = spawnSync(command, { env, stdio: 'inherit', shell: true });
    status = result.status ?? 1;
    if (status !== 0) break;
  }
} finally {
  api.kill();
}
process.exit(status);

async function waitForApi() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ok = await fetch(`${env.WEBSITE_API_INTERNAL_URL}/api/v1/releases/latest`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The fake API did not start.');
}
