// Runs Lighthouse CI against the compose stack (apps/website/compose.yaml) with the budgets in
// lighthouserc.stack.json, after seeding the news item and blog post it audits. Start the stack
// first. Uses Playwright's Chromium unless CHROME_PATH is set.
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { SEED_NEWS_SLUG, SEED_POST_SLUG, seed } from '../e2e/stack/seed.ts';
import { STACK_URL } from '../e2e/stack/stackConfig.ts';

const pages = [
  '/',
  '/features/relay',
  '/help/relay',
  '/download',
  '/news',
  `/news/${SEED_NEWS_SLUG}`,
  `/blog/${SEED_POST_SLUG}`,
];

await seed();
const result = spawnSync(
  'bunx',
  [
    'lhci',
    'autorun',
    '--config=lighthouserc.stack.json',
    ...pages.map((path) => `--collect.url=${STACK_URL}${path}`),
  ],
  {
    env: { ...process.env, CHROME_PATH: process.env.CHROME_PATH || chromium.executablePath() },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(result.status ?? 1);
