import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { type CDPSession, expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, startDevHost } from './devHost';
import { createDevSetupSandbox, type DevSetupSandbox } from './devSetupSandbox';
import { SENTRY_TOKEN, startFakeSentry } from './fakeSentryServer';
import { APP_ROOT } from './paths';

/**
 * The screenshots on the website, taken from the real app with demo data: the made-up Northwind
 * shop, its projects, prompt history, vault entries, skills and settings. Opt-in, so CI and the
 * normal e2e run skip it:
 *
 *   RUNOVA_WEBSITE_SHOTS=1 pnpm --filter desktop test:e2e websiteShots
 *
 * Every shot is 1600x1000 at 2x and lands in the site's src/assets/screenshots/ next to a
 * manifest.json the site reads. Before each capture the page is checked for anything that would
 * give away the machine it was taken on: the user data folder, the home folder or the OS user
 * name.
 */

test.skip(
  process.env.RUNOVA_WEBSITE_SHOTS !== '1',
  'Website screenshots run only with RUNOVA_WEBSITE_SHOTS=1',
);
test.describe.configure({ mode: 'serial' });

const SHOTS_DIR = join(APP_ROOT, '..', 'website', 'web', 'src', 'assets', 'screenshots');
const WIDTH = 1600;
const HEIGHT = 1000;
const SCALE = 2;

type Theme = 'dark' | 'light' | 'vscode-dark' | 'vs2026';

interface ManifestEntry {
  name: string;
  route: string;
  theme: Theme;
  alt: string;
}

/** A folder the demo lives in, with a path that names nobody. */
interface DemoDrive {
  /** Where the folder is reached from: a drive letter on Windows, the folder itself elsewhere. */
  root: string;
  /** The folder on disk behind it. */
  target: string;
  release(): void;
}

/**
 * Windows temp folders sit under C:\Users\<name>, so there the demo folder is mapped to a free
 * drive letter with `subst` and every path the app sees starts with that letter. macOS and Linux
 * temp folders carry no user name.
 */
function demoDrive(): DemoDrive {
  const target = mkdtempSync(join(tmpdir(), 'runova-shots-'));
  const remove = (): void => rmSync(target, { recursive: true, force: true, maxRetries: 10 });
  if (process.platform !== 'win32') return { root: target, target, release: remove };
  for (const letter of 'ZYXWVUTSRQPONMLKJIHG') {
    if (existsSync(`${letter}:\\`)) continue;
    try {
      execSync(`subst ${letter}: "${target}"`, { stdio: 'ignore' });
    } catch {
      continue;
    }
    return {
      root: `${letter}:\\`,
      target,
      release: () => {
        try {
          execSync(`subst ${letter}: /D`, { stdio: 'ignore' });
        } catch {
          // Already gone.
        }
        remove();
      },
    };
  }
  throw new Error('No free drive letter for the demo folder');
}

/** Everything on the page a person could read: text, attributes and the values of fields. */
function pageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const fields = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    ].map((field) => field.value);
    return [document.title, document.documentElement.outerHTML, ...fields].join('\n');
  });
}

/** The strings that would give the machine away, in both slash styles and lower case. */
function machineSecrets(paths: string[]): string[] {
  const secrets = new Set<string>();
  for (const path of [...paths, homedir()]) {
    if (!path) continue;
    secrets.add(path.toLowerCase());
    secrets.add(path.replace(/\\/g, '/').toLowerCase());
    secrets.add(path.replace(/\\/g, '\\\\').toLowerCase());
  }
  const name = userInfo().username.toLowerCase();
  if (name.length >= 3) secrets.add(name);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone !== DEMO_TIME_ZONE && zone.includes('/')) secrets.add(zone.toLowerCase());
  return [...secrets];
}

/**
 * The phrases the website must never show (40-website.md, the `forbidden` block up to its first
 * `#` line), so no screenshot carries one either.
 */
function forbiddenPhrases(): string[] {
  const spec = readFileSync(join(APP_ROOT, '..', '..', 'docs', 'epics', '40-website.md'), 'utf8');
  const block = /```forbidden\r?\n([\s\S]*?)```/.exec(spec)?.[1] ?? '';
  const phrases: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('#')) break;
    if (line.trim()) phrases.push(line.trim().toLowerCase());
  }
  return phrases;
}

/**
 * Fails when the page shows the user data folder, the home folder or the OS user name anywhere,
 * or a forbidden phrase in its visible text.
 */
async function expectOnlyDemoData(page: Page, secrets: string[]): Promise<void> {
  const text = (await pageText(page)).toLowerCase();
  // Each find comes with the text around it, so a failure says where on the page it was.
  const found = secrets
    .filter((secret) => text.includes(secret))
    .map((secret) => {
      const at = text.indexOf(secret);
      return `${secret} in "${text.slice(Math.max(at - 120, 0), at + secret.length + 40)}"`;
    });
  expect(found, 'the page shows something from the real machine').toEqual([]);
  const visible = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  const said = forbiddenPhrases().filter((phrase) => visible.includes(phrase));
  expect(said, 'the page shows a phrase the website must not use').toEqual([]);
}

let shotSession: CDPSession | undefined;

/** The demo's time zone, next to the demo IP in the Netherlands. */
const DEMO_TIME_ZONE = 'Europe/Amsterdam';

/** Paints the page at 1600x1000 and 2x, whatever the size of the hidden window or the screen. */
async function emulateShotSize(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  shotSession = cdp;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  // Times and the zone a backup plan starts with would otherwise say where the machine is.
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: DEMO_TIME_ZONE });
}

const THEME_LABELS: Record<Theme, string> = {
  dark: 'Dark',
  light: 'Light',
  'vscode-dark': 'VS Code Dark',
  vs2026: 'VS 2026',
};

/**
 * Picks the theme on the Settings page, the way a person would. Writing the setting alone is not
 * enough: the terminals take their colors from the renderer's theme store, not from <html>.
 */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await openRoute(page, '/settings');
  const option = page
    .getByRole('group', { name: 'Theme' })
    .getByRole('button', { name: new RegExp(`^${THEME_LABELS[theme]}\\b`) });
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
}

async function openRoute(page: Page, route: string): Promise<void> {
  await page.evaluate((hash) => {
    location.hash = `#${hash}`;
  }, route);
}

const manifest: ManifestEntry[] = [];

/** Checks the page, then saves it as `<name>.png` and records it for the manifest. */
async function capture(page: Page, secrets: string[], entry: ManifestEntry): Promise<void> {
  // Animations and the caret settle before the picture is taken.
  await page.evaluate(() => document.fonts.ready);
  // A hover left over from the last click would light up a menu item in the picture.
  await page.mouse.move(1000, 70);
  // A toast says what just happened in the test, not what the screen is for.
  // Animations end where they stop, and the caret is hidden.
  await page.addStyleTag({
    content: `[data-sonner-toaster] { display: none !important; }
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition: none !important;
        caret-color: transparent !important;
      }`,
  });
  await page.waitForTimeout(400);
  await expectOnlyDemoData(page, secrets);
  mkdirSync(SHOTS_DIR, { recursive: true });
  // Playwright's own screenshot of an Electron page comes out at 1x whatever the emulated
  // scale, so the picture is taken over CDP, scaled up to 2x from whatever ratio the page has.
  if (!shotSession) throw new Error('The shot size was never set');
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  const { data } = await shotSession.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: SCALE / ratio },
  });
  const png = Buffer.from(data, 'base64');
  expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({
    width: WIDTH * SCALE,
    height: HEIGHT * SCALE,
  });
  writeFileSync(join(SHOTS_DIR, `${entry.name}.png`), png);
  manifest.push(entry);
}

/** Keeps the entries other tasks wrote and replaces this run's ones by name. */
function writeManifest(): void {
  const file = join(SHOTS_DIR, 'manifest.json');
  const earlier: ManifestEntry[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const names = new Set(manifest.map((entry) => entry.name));
  const merged = [...earlier.filter((entry) => !names.has(entry.name)), ...manifest];
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}

/** Runs git in a demo repo as the made-up Northwind developer. */
function git(cwd: string, args: string, input?: string): void {
  execSync(`git -c user.name="Dana Reyes" -c user.email=dana@northwind.example ${args}`, {
    cwd,
    input,
    stdio: input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
  });
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
}

const PRICE_BEFORE = `export interface Money {
  currency: string;
  amount: number;
}

export function formatMoney({ currency, amount }: Money): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
}

export function sum(values: Money[], currency = 'USD'): Money {
  return { currency, amount: values.reduce((acc, value) => acc + value.amount, 0) };
}
`;

const PRICE_AFTER = `export interface Money {
  currency: string;
  amount: number;
}

export function formatMoney({ currency, amount }: Money): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
}

export function sum(values: Money[], currency = 'USD'): Money {
  const amount = values.reduce((acc, value) => acc + value.amount, 0);
  return { currency, amount };
}

/** Takes a percentage off, never more than the whole amount and never below zero. */
export function discountedBy(money: Money, percent: number): Money {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const saving = Math.round((money.amount * clamped) / 100);
  return { ...money, amount: Math.max(money.amount - saving, 0) };
}
`;

/**
 * The cart totals, self-contained so the workspace diff shows plain TypeScript: the editor has no
 * React types or sibling modules to resolve, and JSX or imports would come up underlined in red.
 */
const TOTALS_BEFORE = `export interface CartLine {
  sku: string;
  name: string;
  unitCents: number;
  quantity: number;
}

export interface CartTotals {
  subtotalCents: number;
  totalCents: number;
}

export function cartTotals(lines: CartLine[]): CartTotals {
  const subtotalCents = lines.reduce((acc, line) => acc + line.unitCents * line.quantity, 0);
  return { subtotalCents, totalCents: subtotalCents };
}
`;

const TOTALS_AFTER = `export interface CartLine {
  sku: string;
  name: string;
  unitCents: number;
  quantity: number;
}

export interface DiscountCode {
  code: string;
  percent: number;
}

export interface CartTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

/** Applies the active code to the subtotal. The total never goes below zero. */
export function cartTotals(lines: CartLine[], discount?: DiscountCode): CartTotals {
  const subtotalCents = lines.reduce((acc, line) => acc + line.unitCents * line.quantity, 0);
  const percent = Math.min(Math.max(discount?.percent ?? 0, 0), 100);
  const discountCents = Math.round((subtotalCents * percent) / 100);
  return { subtotalCents, discountCents, totalCents: Math.max(subtotalCents - discountCents, 0) };
}

export const DISCOUNT_CODES: DiscountCode[] = [
  { code: 'ROAST15', percent: 15 },
  { code: 'WELCOME10', percent: 10 },
];
`;

const DISCOUNTS_TEST = `import { describe, expect, it } from 'vitest';
import { discountedBy } from './price';

const ten = { currency: 'USD', amount: 1000 };

describe('discountedBy', () => {
  it('takes the percentage off', () => {
    expect(discountedBy(ten, 15).amount).toBe(850);
  });

  it('never goes below zero', () => {
    expect(discountedBy(ten, 140).amount).toBe(0);
  });

  it('ignores a negative percentage', () => {
    expect(discountedBy(ten, -5).amount).toBe(1000);
  });
});
`;

/**
 * The Northwind storefront as a git repo: a first commit, then the discount change the agent pane
 * describes, with the money helper staged by hunk (the new function staged, the tidy-up of sum()
 * left out), the cart totals changed and the new test file untracked.
 */
function seedStorefront(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init -q -b main');
  writeFiles(dir, {
    'package.json': `${JSON.stringify(
      {
        name: '@northwind/storefront',
        version: '2.4.0',
        private: true,
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' },
      },
      null,
      2,
    )}\n`,
    'README.md': '# Northwind storefront\n\nThe shop front for Northwind Coffee Co.\n',
    // Runova keeps its records of installed MCP servers in .runova, which stays out of git.
    '.gitignore': 'node_modules\ndist\n.runova/\n',
    'src/lib/price.ts': PRICE_BEFORE,
    'src/cart/totals.ts': TOTALS_BEFORE,
    'src/lib/price.test.ts':
      "import { expect, it } from 'vitest';\nimport { sum } from './price';\n\nit('adds amounts', () => {\n  expect(sum([{ currency: 'USD', amount: 250 }]).amount).toBe(250);\n});\n",
  });
  git(dir, 'add -A');
  git(dir, 'commit -q -m "feat: cart totals with subtotal"');
  writeFiles(dir, { 'src/lib/price.ts': PRICE_AFTER });
  // Only the hunk that adds discountedBy() goes into the index.
  const staged = PRICE_BEFORE + PRICE_AFTER.slice(PRICE_AFTER.indexOf('\n/** Takes'));
  const blob = execSync('git hash-object -w --stdin', { cwd: dir, input: staged })
    .toString()
    .trim();
  git(dir, `update-index --cacheinfo 100644,${blob},src/lib/price.ts`);
  writeFiles(dir, {
    'src/cart/totals.ts': TOTALS_AFTER,
    'src/lib/discounts.test.ts': DISCOUNTS_TEST,
    // The MCP servers the storefront uses, as Runova records an install from the directory.
    '.runova/installed-mcp-servers.json': `${JSON.stringify(
      ['sentry-mcp', 'linear-mcp', 'figma-context-mcp', 'jscpd'].map((serverId) => ({
        serverId,
        repositoryId: 'bowora-directory',
        version: 'latest',
        installedAt: '2026-10-12T09:30:00.000Z',
      })),
      null,
      2,
    )}\n`,
  });
}

interface DemoProject {
  name: string;
  description: string;
  tags: string[];
  agentType: 'claude-code' | 'codex' | 'gemini' | 'opencode';
  iconColor: string;
  runCommands: { id: string; label: string; command: string }[];
  /** The standing prompt agents start from, and the notes next to it. */
  prompt?: string;
  notes?: string;
}

/** The Northwind projects from the README, storefront first since the workspace shots use it. */
const NORTHWIND: DemoProject[] = [
  {
    name: 'storefront',
    description: 'The Northwind Coffee shop front: catalog, cart and checkout.',
    tags: ['react', 'vite', 'shop'],
    agentType: 'claude-code',
    iconColor: '#f97316',
    runCommands: [
      { id: 'dev', label: 'dev', command: 'pnpm dev' },
      { id: 'test', label: 'test', command: 'pnpm test' },
    ],
    prompt:
      'The Northwind Coffee storefront, a React and Vite app. Money is an integer amount of cents with a currency (src/lib/price.ts); never use floats for prices. Every change to the cart or checkout comes with a Vitest test, and `pnpm test` has to pass before you say you are done.',
    notes:
      'Discount codes ship with the autumn roast launch. ROAST15 and WELCOME10 are the first two codes; marketing wants the saving shown on its own line in the cart.',
  },
  {
    name: 'northwind-api',
    description: 'Orders, stock and payments behind the shop.',
    tags: ['dotnet', 'postgres', 'api'],
    agentType: 'codex',
    iconColor: '#22c55e',
    runCommands: [{ id: 'api', label: 'api', command: 'dotnet watch run' }],
  },
  {
    name: 'admin-portal',
    description: 'Back office for orders, refunds and the product catalog.',
    tags: ['react', 'admin'],
    agentType: 'claude-code',
    iconColor: '#6366f1',
    runCommands: [{ id: 'dev', label: 'dev', command: 'pnpm dev' }],
  },
  {
    name: 'mailer-service',
    description: 'Order confirmations, shipping updates and the weekly roast newsletter.',
    tags: ['node', 'queue', 'email'],
    agentType: 'gemini',
    iconColor: '#eab308',
    runCommands: [{ id: 'worker', label: 'worker', command: 'pnpm start' }],
  },
  {
    name: 'docs-site',
    description: 'Help pages for wholesale customers.',
    tags: ['astro', 'docs'],
    agentType: 'claude-code',
    iconColor: '#06b6d4',
    runCommands: [{ id: 'dev', label: 'dev', command: 'pnpm dev' }],
  },
  {
    name: 'infra',
    description: 'Servers, DNS and backups as code.',
    tags: ['terraform', 'docker'],
    agentType: 'opencode',
    iconColor: '#a855f7',
    runCommands: [],
  },
  {
    name: 'design-tokens',
    description: 'Colors, type and spacing shared by every Northwind app.',
    tags: ['css', 'design'],
    agentType: 'claude-code',
    iconColor: '#ec4899',
    runCommands: [{ id: 'build', label: 'build', command: 'pnpm build' }],
  },
  {
    name: 'company-blog',
    description: 'Stories from the roastery and brewing guides.',
    tags: ['wordpress', 'blog'],
    agentType: 'codex',
    iconColor: '#14b8a6',
    runCommands: [],
  },
];

/** The GitHub organization the Northwind repos live in, as Pipelines reads them. */
const GITHUB_OWNER = 'northwind-coffee';
/** The projects with a GitHub origin. */
const GITHUB_REPOS = ['storefront', 'northwind-api', 'admin-portal'];

/**
 * Creates the project folders (storefront and the other GitHub repos as git repos) and the
 * projects. Returns their ids. The origins are there from the start: the app remembers for ten
 * minutes that a folder has none, so adding one in the Pipelines test would come too late.
 */
async function seedProjects(page: Page, projectsRoot: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const project of NORTHWIND) {
    const folderPath = join(projectsRoot, project.name);
    if (project.name === 'storefront') seedStorefront(folderPath);
    else
      writeFiles(folderPath, {
        'README.md': `# ${project.name}\n\n${project.description}\n`,
      });
    if (GITHUB_REPOS.includes(project.name)) {
      if (project.name !== 'storefront') {
        git(folderPath, 'init -q -b main');
        git(folderPath, 'add -A');
        git(folderPath, 'commit -q -m "chore: first commit"');
      }
      git(folderPath, `remote add origin https://github.com/${GITHUB_OWNER}/${project.name}.git`);
    }
    ids[project.name] = await page.evaluate(
      async (input) => {
        const api = (
          window as unknown as {
            runova: { projects: { create(input: unknown): Promise<{ id: string }> } };
          }
        ).runova;
        return (await api.projects.create(input)).id;
      },
      { ...project, folderPath, notes: project.notes ?? '' },
    );
  }
  return ids;
}

const SKILLS: { name: string; description: string; body: string }[] = [
  {
    name: 'react-components',
    description: 'Builds Northwind React components with typed props, tests and stories.',
    body: 'Put each component in its own folder with a test next to it. Props get an interface, never `any`.',
  },
  {
    name: 'vitest-tests',
    description: 'Writes focused Vitest tests for money, cart and checkout logic.',
    body: 'One behavior per test. Money is always in cents. Never mock the module under test.',
  },
  {
    name: 'release-notes',
    description: 'Turns merged pull requests into short release notes for the shop team.',
    body: 'Group by feature, fix and chore. Leave out anything a customer would never notice.',
  },
  {
    name: 'store-setup',
    description: 'Sets up a fresh checkout of the storefront with its tools.',
    body: 'Install the Northwind CLI first:\n\n```sh\ncurl -fsSL https://get.northwind.example/cli.sh | sh\n```\n\nThen run `pnpm install` and copy `.env.example` to `.env`.',
  },
];

/**
 * The fake home: global Claude Code skills, recorded as installed from the skills.sh directory,
 * the way Runova's own install leaves them.
 */
function seedHome(home: string): void {
  const files: Record<string, string> = {};
  for (const skill of SKILLS) {
    files[join('.claude', 'skills', skill.name, 'SKILL.md')] =
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n${skill.body}\n`;
  }
  files[join('.claude', '.runova', 'installed-skills.json')] = `${JSON.stringify(
    SKILLS.map((skill) => ({
      skillId: skill.name,
      repositoryId: 'skills-sh-directory',
      version: '1.2.0',
      installedAt: '2026-10-08T14:20:00.000Z',
      agents: ['claude-code'],
    })),
    null,
    2,
  )}\n`;
  writeFiles(home, files);
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
}

/** AI CLIs the CLI Manager finds installed, next to the scripted `claude` the launcher writes. */
const FAKE_CLIS: Record<string, string> = {
  codex: 'codex-cli 0.58.0',
  gemini: '0.16.0',
  opencode: '1.0.41',
  copilot: '0.0.354',
};

function writeFakeClis(bin: string): void {
  mkdirSync(bin, { recursive: true });
  for (const [name, version] of Object.entries(FAKE_CLIS)) {
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\necho ${version}\r\n`);
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${version}"\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
}

/** What the fake gh or docker prints for a call whose arguments hold every `match` string. */
interface FakeCliAnswer {
  match: string[];
  stdout: string;
  exitCode?: number;
}

const fakeCliAnswers: Record<string, FakeCliAnswer[]> = {};

/**
 * Puts a fake `gh` or `docker` with these answers in the demo bin folder (see
 * fixtures/websiteShotsFakeCli.cjs). Only the tests that need one do this, so the shots before
 * them look the same as without. execFile cannot start a .cmd on Windows, so there the script
 * is compiled into an .exe with bun.
 */
function installFakeCli(root: string, tool: 'gh' | 'docker', answers: FakeCliAnswer[]): void {
  fakeCliAnswers[tool] = answers;
  writeFileSync(join(root, 'fake-cli.json'), JSON.stringify(fakeCliAnswers));
  const script = join(__dirname, 'fixtures', 'websiteShotsFakeCli.cjs');
  const bin = join(root, 'bin');
  if (process.platform === 'win32') {
    execSync(`bun build --compile "${script}" --outfile "${join(bin, `${tool}.exe`)}"`, {
      stdio: 'ignore',
    });
    return;
  }
  writeFileSync(join(bin, tool), `#!/bin/sh\nexec node "${script}" ${tool} "$@"\n`);
  chmodSync(join(bin, tool), 0o755);
}

/**
 * The app's environment: the fake home, a temp folder on the demo drive, and a PATH of only the
 * demo bin folder and the system tools a workspace needs (Node.js for the scripted CLI, git), so
 * no CLI the machine has installed shows up.
 */
function demoEnv(root: string, sandbox: DevSetupSandbox): Record<string, string> {
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  mkdirSync(temp, { recursive: true });
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const system =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\nodejs',
          'C:\\Program Files\\Git\\cmd',
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
          process.env.SystemRoot ?? 'C:\\Windows',
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'Wbem'),
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
        ]
      : [dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  return {
    RUNOVA_E2E_HOME: home,
    // A TEST-NET address for the dashboard's location card, never the machine's own.
    RUNOVA_E2E_IP_GEO: JSON.stringify(DEMO_IP_GEO),
    // The answers of the fake gh and docker, which the Pipelines and Docker tests put on PATH.
    SHOTS_FAKE_CLI_DATA: join(root, 'fake-cli.json'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    USERNAME: 'dana',
    USER: 'dana',
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    [pathKey]: [join(root, 'bin'), ...system.filter((dir) => existsSync(dir))].join(delimiter),
    ...sandbox.env(),
  };
}

const DEMO_IP_GEO = { ip: '203.0.113.24', country: 'Netherlands', countryCode: 'NL' };

/** The machine's real public IP, so a capture can check it never shows. Empty when offline. */
async function realPublicIp(): Promise<string> {
  try {
    const response = await fetch('https://get.geojs.io/v1/ip/geo.json', {
      signal: AbortSignal.timeout(5000),
    });
    const { ip } = (await response.json()) as { ip?: unknown };
    return typeof ip === 'string' ? ip : '';
  } catch {
    return '';
  }
}

/** Calls the app's preload API from the test, as the renderer would. */
function invoke<T>(page: Page, call: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ call, args }) => {
      let target: unknown = (window as unknown as { runova: unknown }).runova;
      const path = call.split('.');
      const method = path.pop() as string;
      for (const key of path) target = (target as Record<string, unknown>)[key];
      const fn = (target as Record<string, (...rest: unknown[]) => unknown>)[method];
      return (await fn.apply(target, args)) as T;
    },
    { call, args },
  );
}

const PROMPT_REQUEST =
  'Add discount codes to the storefront cart. Percent off the subtotal, never below zero, show the saving in the cart totals, and test it.';

const GENERATED_PROMPT = `# Task: discount codes in the cart

## Context
The Northwind storefront is a React and Vite app. Money is an integer amount of cents with a currency (src/lib/price.ts). The cart totals live in src/cart/totals.ts.

## What to build
1. Add \`discountedBy(money, percent)\` to src/lib/price.ts. Clamp the percentage to 0..100 and never return a negative amount.
2. Let the cart hold one active code and apply it to the subtotal.
3. Return the saving and the new total from cartTotals(), zero when no code is active.

## Constraints
- Keep money in cents end to end, and round once.
- Don't change how the subtotal is calculated.

## Done when
- Vitest covers the clamp at both ends and a normal discount.
- \`pnpm test\` passes and the cart shows "Discount (15%)" for the code ROAST15.`;

const BLUEPRINT: { step: string; text: string }[] = [
  {
    step: 'idea',
    text: 'A wholesale portal for cafes that buy Northwind beans in bulk: standing orders, invoices on 30-day terms, and a roast calendar so they know when fresh stock lands.',
  },
  {
    step: 'architecture',
    text: 'The admin portal grows a wholesale area on the same React app. Orders and invoices go through northwind-api; the roast calendar is read from the existing production schedule. Auth reuses the staff login with a new "wholesale" role.',
  },
  {
    step: 'backend',
    text: 'New endpoints on northwind-api: GET /wholesale/orders, POST /wholesale/orders/standing, GET /wholesale/invoices. Invoices are PDFs generated by the mailer-service queue. Postgres gets standing_orders and invoices tables.',
  },
];

/** Settings, the blueprint, a generated prompt and the vault, all through the app's own API. */
async function seedAppData(page: Page, ids: Record<string, string>): Promise<void> {
  for (const { step, text } of BLUEPRINT) {
    await invoke(page, 'blueprints.updateSection', ids['admin-portal'], step, { text });
  }
  await invoke(page, 'promptHistory.add', {
    rawInput: PROMPT_REQUEST,
    promptType: 'Frontend',
    targetAI: 'claude-code',
    content: GENERATED_PROMPT,
    source: 'generate',
    projectId: ids.storefront,
  });
  await invoke(page, 'vault.create', 'northwind-demo-vault');
  const entries = [
    {
      type: 'login',
      title: 'GitHub',
      tags: ['dev'],
      favorite: true,
      username: 'dana@northwind.example',
      password: 'demo-password-not-real',
      urls: ['https://github.com'],
    },
    {
      type: 'apiKey',
      title: 'Stripe test key',
      tags: ['payments'],
      favorite: true,
      service: 'Stripe',
      keyId: 'northwind-storefront',
      secret: 'sk_test_northwind_demo_0000000000',
    },
    {
      type: 'login',
      title: 'Postgres (staging)',
      tags: ['database'],
      favorite: false,
      username: 'northwind_app',
      password: 'demo-password-not-real',
      urls: ['postgres://db.staging.northwind.example:5432'],
    },
    {
      type: 'apiKey',
      title: 'Sentry auth token',
      tags: ['monitoring'],
      favorite: false,
      service: 'Sentry',
      keyId: 'storefront-releases',
      secret: 'sntrys_northwind_demo_0000000000',
    },
    {
      type: 'login',
      title: 'Cloudflare',
      tags: ['dns'],
      favorite: false,
      username: 'ops@northwind.example',
      password: 'demo-password-not-real',
      urls: ['https://dash.cloudflare.com'],
    },
    {
      type: 'note',
      title: 'Roastery Wi-Fi',
      tags: ['office'],
      favorite: false,
      notes: 'Network: northwind-roastery. Ask Sam at the front desk for the guest code.',
    },
  ];
  for (const entry of entries) await invoke(page, 'vault.save', entry);
}

interface ShotsWindow {
  runova: {
    terminal: { onData(callback: (payload: { sessionId: string; data: string }) => void): void };
  };
  __shotsOutput: string;
}

/** A loopback server a test started, stopped again after the last test. */
interface FakeServer {
  port: number;
  stop(): Promise<void>;
}

const fakeServers: FakeServer[] = [];

/** Keeps a fake server for afterAll to stop, by the port in its URL. */
function track(url: string, stop: () => Promise<void>): void {
  fakeServers.push({ port: Number(new URL(url).port), stop });
}

/** Whether anything still answers on the loopback port. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

let drive: DemoDrive | undefined;
let devHost: DevHost | undefined;
let launched: LaunchedApp | undefined;
let secrets: string[] = [];
let projectIds: Record<string, string> = {};

/** The launched app's page; every test after the first one runs on the same app. */
function page(): Page {
  if (!launched) throw new Error('The app did not start');
  return launched.page;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  drive = demoDrive();
  const root = join(drive.root, 'northwind');
  // The launcher takes an existing folder as its root, so the profile and the fake home are
  // made here, on the demo drive, before the app starts.
  // No settings.json is written: a partial one leaves the dashboard without its default cards.
  mkdirSync(join(root, 'user-data', 'data'), { recursive: true });
  seedHome(join(root, 'home'));
  writeFakeClis(join(root, 'bin'));
  const sandbox = createDevSetupSandbox(drive.root);
  sandbox.installGh();
  // The Deploy shots run against the real server core on loopback, which the app finds through
  // RUNOVA_DEPLOY_DEV_CORE when it starts.
  devHost = await startDevHost();
  launched = await launchApp({
    reuseRoot: root,
    claudeScript: join(__dirname, 'fixtures', 'websiteShotsClaude.cjs'),
    env: { ...demoEnv(root, sandbox), RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const publicIp = await realPublicIp();
  secrets = [
    ...machineSecrets([launched.userDataDir, drive.target]),
    ...(publicIp ? [publicIp] : []),
  ];
  // Shells end with the app, so no terminal host outlives the run.
  // Network Status measures over HTTP: plenty of networks drop ICMP, and a card of offline
  // targets says nothing about the app.
  await invoke(launched.page, 'settings.update', {
    theme: 'dark',
    keepTerminalsRunning: false,
    pingMethod: 'http',
    // Deploy lists only the servers the user chose; a fresh profile would get this from the
    // launcher, but the demo profile is made here.
    deployServerIds: ['devhost'],
  });
  await emulateShotSize(launched.page);
  projectIds = await seedProjects(launched.page, join(drive.root, 'projects'));
  await seedAppData(launched.page, projectIds);
  // Projects made through IPC are not in the cached list yet.
  await reloadApp(launched.page);
});

/**
 * Reloads the renderer, so nothing it read before (the project list, whether gh or docker is
 * installed) is cached any more, and sets the shot size again.
 */
async function reloadApp(p: Page): Promise<void> {
  await p.reload();
  await p.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  await emulateShotSize(p);
}

test.afterAll(async () => {
  if (manifest.length > 0) writeManifest();
  await launched?.close();
  launched = undefined;
  const ports = [devHost?.port, ...fakeServers.map((server) => server.port)];
  devHost?.stop();
  devHost = undefined;
  for (const server of fakeServers.splice(0)) await server.stop();
  drive?.release();
  drive = undefined;
  // Nothing the run started may still answer once it is over.
  for (const port of ports) if (port) await expect.poll(() => portOpen(port)).toBe(false);
});

const WORKSPACE_ALT = {
  dark: 'The Runova workspace on the Northwind storefront: Claude Code has finished adding discount codes in an agent pane, the diff of the cart totals is open next to it, and the source control panel lists the changes.',
  light:
    'The same Northwind storefront workspace in the Light theme, with the agent pane, the cart totals diff and source control.',
  'vscode-dark':
    'The Northwind storefront workspace in the VS Code Dark theme, with the agent pane, the cart totals diff and source control.',
  vs2026:
    'The Northwind storefront workspace in the VS 2026 theme, with the agent pane, the cart totals diff and source control.',
} satisfies Record<Theme, string>;

/** Opens the storefront workspace with a finished Claude Code pane and the cart totals diff. */
test('workspace', async () => {
  const p = page();
  const route = `/workspace/${projectIds.storefront}`;
  await openRoute(p, route);
  // The terminal may paint to a canvas, so its output is read from the data stream instead.
  await p.evaluate(() => {
    const target = window as unknown as ShotsWindow;
    target.__shotsOutput = '';
    target.runova.terminal.onData(({ data }) => {
      target.__shotsOutput += data;
    });
  });
  await p.getByRole('button', { name: 'New tab' }).first().click();
  await p
    .getByRole('menuitem', { name: /Claude Code/ })
    .first()
    .click();
  await expect(p.locator('.xterm').first()).toBeVisible();
  await expect
    .poll(() => p.evaluate(() => (window as unknown as ShotsWindow).__shotsOutput))
    .toContain('All 21 tests pass');
  // The diff goes in a second pane to the right of the agent. The split asks what to open in
  // it; the diff opened from source control is the answer, so the question is dismissed.
  await p
    .getByRole('button', { name: /^Split right/ })
    .first()
    .click();
  await p.keyboard.press('Escape');
  await p.getByRole('option', { name: /^src\/cart\/totals\.ts/ }).click();
  await expect(p.getByText('discountCents').first()).toBeVisible();
  await expect(p.locator('.xterm').first()).toBeVisible();
  await capture(p, secrets, { name: 'workspace', route, theme: 'dark', alt: WORKSPACE_ALT.dark });
});

for (const theme of ['light', 'vscode-dark', 'vs2026'] as const) {
  test(`workspace-${theme}`, async () => {
    const p = page();
    const route = `/workspace/${projectIds.storefront}`;
    await setTheme(p, theme);
    await openRoute(p, route);
    await expect(p.getByText('discountCents').first()).toBeVisible();
    await capture(p, secrets, {
      name: `workspace-${theme}`,
      route,
      theme,
      alt: WORKSPACE_ALT[theme],
    });
  });
}

test('workspace-git', async () => {
  const p = page();
  const route = `/workspace/${projectIds.storefront}`;
  await setTheme(p, 'dark');
  await openRoute(p, route);
  // price.ts is in both lists: the new function staged, the tidy-up of sum() not.
  await expect(p.getByRole('option', { name: /^src\/lib\/price\.ts/ })).toHaveCount(2);
  await p
    .getByRole('option', { name: /^src\/lib\/price\.ts/ })
    .first()
    .click();
  await expect(p.getByText('discountedBy').first()).toBeVisible();
  await capture(p, secrets, {
    name: 'workspace-git',
    route,
    theme: 'dark',
    alt: 'Source control in the Northwind storefront workspace: the new discount function in price.ts is staged on its own hunk, while the rest of the change waits unstaged next to a new test file.',
  });
});

test('projects', async () => {
  const p = page();
  await openRoute(p, '/projects');
  await expect(p.getByText('company-blog').first()).toBeVisible();
  await capture(p, secrets, {
    name: 'projects',
    route: '/projects',
    theme: 'dark',
    alt: 'The Projects page listing the Northwind projects, from the storefront and its API to the admin portal, mailer, docs site, infrastructure, design tokens and company blog.',
  });
});

test('project-detail', async () => {
  const p = page();
  const route = `/projects/${projectIds.storefront}`;
  await openRoute(p, route);
  await expect(p.getByText('The Northwind Coffee shop front').first()).toBeVisible();
  await capture(p, secrets, {
    name: 'project-detail',
    route,
    theme: 'dark',
    alt: "The storefront project's page: its description, agent and tags, the standing prompt every agent starts from, and notes for the discount code launch.",
  });
});

test('dashboard', async () => {
  const p = page();
  await openRoute(p, '/');
  await expect(p.getByText('storefront').first()).toBeVisible();
  // The location card shows the demo address, and the network card has a live sample.
  await expect(p.getByText(DEMO_IP_GEO.ip).first()).toBeVisible({ timeout: 30_000 });
  await expect(p.getByText(/^1\/1$/).first()).toBeVisible({ timeout: 30_000 });
  await capture(p, secrets, {
    name: 'dashboard',
    route: '/',
    theme: 'dark',
    alt: 'The Runova dashboard with its default cards: quick actions, tokens and cost today, location and network status, and live CPU, GPU, memory and disk charts.',
  });
});

test('blueprint', async () => {
  const p = page();
  const route = `/projects/${projectIds['admin-portal']}?tab=blueprint`;
  await openRoute(p, route);
  await p
    .getByRole('button', { name: /Backend/ })
    .first()
    .click();
  await expect(p.getByText('/wholesale/orders', { exact: false }).first()).toBeVisible();
  await capture(p, secrets, {
    name: 'blueprint',
    route,
    theme: 'dark',
    alt: "The admin portal's Blueprint partway through: the idea, architecture and backend steps of a wholesale portal are written, with frontend, CI/CD and quality still to come.",
  });
});

test('prompt-builder', async () => {
  const p = page();
  await openRoute(p, '/prompt-builder');
  await p
    .getByRole('button', { name: /History/ })
    .first()
    .click();
  const history = p.getByRole('dialog');
  await history
    .getByText(/Task: discount codes in the cart/)
    .first()
    .click();
  await expect(history).toBeHidden();
  // The editor spaces its text with non-breaking spaces, so single words are what match.
  await expect(p.locator('.monaco-editor').first()).toContainText('Constraints');
  await capture(p, secrets, {
    name: 'prompt-builder',
    route: '/prompt-builder',
    theme: 'dark',
    alt: 'Prompt Builder with a generated prompt for Claude Code: a short request about discount codes turned into a structured task with context, steps, constraints and a definition of done.',
  });
});

test('cli-manager', async () => {
  const p = page();
  await openRoute(p, '/cli-manager');
  await expect(p.getByText('0.58.0').first()).toBeVisible({ timeout: 30_000 });
  await expect(p.getByText('2.0.62').first()).toBeVisible();
  await capture(p, secrets, {
    name: 'cli-manager',
    route: '/cli-manager',
    theme: 'dark',
    alt: 'The AI CLI Manager with Claude Code, Codex, Gemini CLI, OpenCode and GitHub Copilot CLI installed, each with its version, next to the CLIs that are not installed yet.',
  });
});

/** Opens the dialog that lists the skills installed for every project. */
async function openGlobalSkills(p: Page): Promise<Locator> {
  await openRoute(p, '/skills');
  await p.getByRole('button', { name: /Global Skills/ }).click();
  const dialog = p.getByRole('dialog', { name: /Global Skills/ });
  await expect(dialog.getByText('react-components').first()).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test('skills', async () => {
  const p = page();
  await openRoute(p, '/skills');
  // The four seeded skills are installed for every project, counted on the Global Skills button.
  await expect(p.getByRole('button', { name: /Global Skills\s*4/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(p.getByRole('button', { name: /^Install/ }).first()).toBeVisible();
  await capture(p, secrets, {
    name: 'skills',
    route: '/skills',
    theme: 'dark',
    alt: 'The Skills page on its directory of popular agent skills, with official publishers marked, install counts, and four skills already installed for every project.',
  });
});

test('skill-security', async () => {
  const p = page();
  const global = await openGlobalSkills(p);
  await global.getByRole('button', { name: 'Check store-setup for unsafe instructions' }).click();
  await p.getByRole('button', { name: /Run security check/ }).click();
  await expect(p.getByText(/curl/).first()).toBeVisible({ timeout: 30_000 });
  await capture(p, secrets, {
    name: 'skill-security',
    route: '/skills',
    theme: 'dark',
    alt: 'A finished security check of the store-setup skill, which flags the instruction to pipe a downloaded script straight into the shell.',
  });
});

test('mcp', async () => {
  const p = page();
  const route = `/mcp?projectId=${projectIds.storefront}`;
  await openRoute(p, route);
  await p.getByRole('button', { name: /^Installed \(4\)/ }).click();
  await expect(p.getByText(/Sentry/).first()).toBeVisible({ timeout: 30_000 });
  await expect(p.getByText(/Linear/).first()).toBeVisible();
  await capture(p, secrets, {
    name: 'mcp',
    route,
    theme: 'dark',
    alt: 'The MCP directory filtered to the four servers installed in the storefront project: Sentry, Linear, Figma and a copy-paste detector.',
  });
});

test('agent-tools', async () => {
  const p = page();
  await openRoute(p, '/tools?tab=dev-setup');
  await expect(p.getByText('GitHub CLI').first()).toBeVisible({ timeout: 30_000 });
  await capture(p, secrets, {
    name: 'agent-tools',
    route: '/tools?tab=dev-setup',
    theme: 'dark',
    alt: 'Agent Tools on the Dev Setup checklist: Git, Node.js, npm and the GitHub CLI are installed and ready for the coding agents.',
  });
});

test('vault', async () => {
  const p = page();
  await openRoute(p, '/vault');
  await expect(p.getByText('Stripe test key').first()).toBeVisible();
  await capture(p, secrets, {
    name: 'vault',
    route: '/vault',
    theme: 'dark',
    alt: 'The Vault with Northwind demo entries: logins for GitHub, Cloudflare and the staging database, Stripe and Sentry keys, and a note.',
  });
});

test('settings', async () => {
  const p = page();
  await openRoute(p, '/settings?tab=general');
  await expect(p.getByRole('group', { name: 'Theme' })).toBeVisible();
  await capture(p, secrets, {
    name: 'settings',
    route: '/settings?tab=general',
    theme: 'dark',
    alt: 'Settings on the General tab: the theme picker set to Dark next to Light, System, VS Code Dark and VS 2026, the main menu placement and the status bar limits.',
  });
});

const DEV_PASSWORD = 'runova-local-password';

function serverSection(p: Page, name: string): Locator {
  return p.getByRole('navigation', { name: 'Server sections' }).getByRole('button', { name });
}

/** Answers the step-up dialog when the core asks for one, or returns once `done` is on screen. */
async function stepUpIfAsked(p: Page, done: Locator): Promise<void> {
  const proof = p.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(proof.or(done).first()).toBeVisible({ timeout: 30_000 });
  if (await proof.isVisible()) {
    await proof.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
    await proof.getByRole('button', { name: 'Confirm' }).click();
  }
}

/** Waits for a job dialog (nginx setup, a certificate) to finish and closes it. */
async function finishJob(p: Page): Promise<void> {
  const dialog = p.getByRole('dialog').filter({ has: p.getByRole('log', { name: 'Job log' }) });
  await expect(dialog.getByRole('status')).toHaveText(/Done/, { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
}

test('deploy-overview', async () => {
  test.setTimeout(120_000);
  const p = page();
  await openRoute(p, '/deploy');
  await expect(p.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = p.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(p.getByText(/Signed in as/)).toBeVisible({ timeout: 30_000 });
  await expect(p.getByRole('status', { name: 'Live connection: Connected' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(p.getByRole('button', { name: /^Health score \d+ of 100/ })).toBeVisible({
    timeout: 30_000,
  });
  // The charts fill in from the live readings.
  await expect(p.getByRole('img', { name: /^Processor, \d+ readings/ })).toBeVisible({
    timeout: 30_000,
  });
  await p.waitForTimeout(5_000);
  await capture(p, secrets, {
    name: 'deploy-overview',
    route: '/deploy',
    theme: 'dark',
    alt: "A server's Overview in Deploy: its health score, live processor, memory and network charts, and the state of the server core, over a live connection.",
  });
});

test('deploy-containers', async () => {
  const p = page();
  await serverSection(p, 'Containers').click();
  const list = p.getByRole('list', { name: 'Containers' });
  await expect(list.getByRole('heading', { name: 'shop' })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByRole('heading', { name: 'monitoring' })).toBeVisible();
  await expect(
    list.getByRole('listitem', { name: 'shop-api-1' }).getByLabel('Processor for shop-api-1'),
  ).toHaveText(/\d+(\.\d)?%/, { timeout: 30_000 });
  await capture(p, secrets, {
    name: 'deploy-containers',
    route: '/deploy',
    theme: 'dark',
    alt: "The server's containers grouped by Compose project, each with its state and live processor and memory use.",
  });
});

test('deploy-app-store', async () => {
  const p = page();
  await serverSection(p, 'App Store').click();
  const catalog = p.getByRole('region', { name: 'Catalog' });
  await expect(catalog.getByRole('listitem', { name: 'Redis' })).toBeVisible({ timeout: 30_000 });
  await capture(p, secrets, {
    name: 'deploy-app-store',
    route: '/deploy',
    theme: 'dark',
    alt: 'The Deploy App Store: a catalog of databases, caches and tools that install on the server in one step.',
  });
});

/** Adds a proxy site for a service on the server and applies it. */
async function addSite(p: Page, domain: string, service: string, port: number): Promise<void> {
  await p.getByRole('button', { name: /Add a site/ }).click();
  await p.getByRole('textbox', { name: 'Domain 1' }).fill(domain);
  await p.getByRole('tab', { name: 'Proxy' }).click();
  await p.getByLabel('Service name').fill(service);
  await p.getByLabel('Port').fill(String(port));
  await p.getByRole('button', { name: /Save the site/ }).click();
  await expect(p.getByRole('tab', { name: 'SSL', selected: true })).toBeVisible({
    timeout: 30_000,
  });
  const bar = p.getByRole('region', { name: 'Apply changes' });
  await bar.getByRole('button', { name: /Apply changes/ }).click();
  await expect(bar).toBeHidden({ timeout: 60_000 });
}

test('deploy-websites', async () => {
  test.setTimeout(240_000);
  const p = page();
  await serverSection(p, 'Websites').click();
  const setUp = p.getByRole('button', { name: /Set up nginx for Runova|Install nginx/ });
  await expect(setUp.or(p.getByText('Managed by Runova'))).toBeVisible({ timeout: 30_000 });
  if (await setUp.isVisible()) {
    await setUp.click();
    await finishJob(p);
  }
  await expect(p.getByText('Managed by Runova')).toBeVisible({ timeout: 30_000 });
  await addSite(p, 'shop.northwind.example', 'storefront', 3000);
  // The shop gets a certificate from the DevHost's pretend CA.
  await p.getByRole('button', { name: 'Issue a certificate' }).click();
  const order = p.getByRole('dialog', { name: 'Issue a certificate' });
  await order.getByRole('checkbox').click();
  await order.getByRole('button', { name: 'Issue the certificate' }).click();
  await finishJob(p);
  await p.getByRole('button', { name: /All sites/ }).click();
  await addSite(p, 'api.northwind.example', 'northwind-api', 8080);
  await p.getByRole('button', { name: /All sites/ }).click();
  const sites = p.getByRole('list', { name: 'Sites' });
  await expect(
    sites.getByRole('listitem', { name: 'shop.northwind.example' }).getByText(/^SSL, \d+ days$/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(sites.getByRole('listitem', { name: 'api.northwind.example' })).toBeVisible();
  await capture(p, secrets, {
    name: 'deploy-websites',
    route: '/deploy',
    theme: 'dark',
    alt: 'Websites on the server, served by nginx that Runova manages: the Northwind shop with its certificate and the API, each proxied to a service on the server.',
  });
});

test('deploy-firewall', async () => {
  const p = page();
  await serverSection(p, 'Firewall').click();
  await expect(p.getByText('Firewall on')).toBeVisible({ timeout: 30_000 });
  await expect(p.getByRole('row', { name: 'Rule 22 Anywhere' })).toBeVisible();
  await capture(p, secrets, {
    name: 'deploy-firewall',
    route: '/deploy',
    theme: 'dark',
    alt: "The server's firewall with its rules. Every change is reviewed as the exact commands first and rolls back by itself unless it is kept.",
  });
});

test('deploy-backups', async () => {
  test.setTimeout(240_000);
  const p = page();
  await serverSection(p, 'Backups').click();
  await p.getByRole('button', { name: 'Set the secret key' }).click();
  const secret = 'violet harbor lantern pebble';
  await p.getByLabel('New secret key', { exact: true }).fill(secret);
  await p.getByLabel('New secret key again', { exact: true }).fill(secret);
  await p.getByRole('button', { name: 'Set the secret key' }).click();
  const change = p.getByRole('button', { name: 'Change the secret key' });
  await stepUpIfAsked(p, change);
  await expect(change).toBeVisible({ timeout: 30_000 });

  await p.getByRole('tab', { name: 'Destinations' }).click();
  await p.getByRole('button', { name: 'Add a destination' }).click();
  const destination = p.getByRole('dialog', { name: 'Add a destination' });
  await destination.getByRole('combobox', { name: 'Kind' }).click();
  await p.getByRole('option', { name: 'Folder on the server' }).click();
  await destination.getByLabel('Name', { exact: true }).fill('Backup disk');
  await destination.getByLabel('Folder', { exact: true }).fill('/var/backups/northwind');
  await destination.getByRole('button', { name: 'Save' }).click();
  const row = p.getByRole('listitem', { name: 'Backup disk' });
  await stepUpIfAsked(p, row);
  await expect(row).toBeVisible({ timeout: 30_000 });

  await p.getByRole('tab', { name: 'Plans' }).click();
  await p.getByRole('button', { name: 'New plan' }).click();
  const planDialog = p.getByRole('dialog', { name: 'New backup plan' });
  await planDialog.getByLabel('Name', { exact: true }).fill('Nightly');
  await planDialog.getByRole('checkbox', { name: 'Backup disk' }).click();
  await planDialog.getByLabel('Keep the last', { exact: true }).fill('7');
  await planDialog.getByRole('button', { name: 'Save the plan' }).click();
  const plan = p.getByRole('listitem', { name: 'Nightly' });
  await stepUpIfAsked(p, plan);
  await expect(plan.getByText(/Keeps the last 7, on/)).toBeVisible({ timeout: 30_000 });

  const history = p.getByRole('table', { name: 'Backup runs' });
  for (let round = 1; round <= 2; round++) {
    await p.getByRole('tab', { name: 'Plans' }).click();
    await plan.getByRole('button', { name: 'Run now' }).click();
    await p.getByRole('tab', { name: 'Overview' }).click();
    await expect(history.getByRole('row')).toHaveCount(round + 1, { timeout: 60_000 });
    await expect(
      history
        .getByRole('row')
        .nth(1)
        .getByText(/Backup disk: Uploaded/),
    ).toBeVisible({
      timeout: 60_000,
    });
  }
  await capture(p, secrets, {
    name: 'deploy-backups',
    route: '/deploy',
    theme: 'dark',
    alt: 'Server backups on their Overview: an encrypted nightly plan to a backup disk, with the history of its runs.',
  });
});

/** Opens one view of the Remote page. Host and Connect are never captured. */
async function openRemoteView(p: Page, view: 'SSH' | 'Remote Desktop'): Promise<void> {
  await openRoute(p, '/remote');
  await p
    .getByRole('navigation', { name: 'Remote views' })
    .getByRole('button', { name: view, exact: true })
    .click();
}

test('ssh', async () => {
  const p = page();
  // TEST-NET addresses, so no real server is named.
  const servers = [
    { nickname: 'shop-prod', host: '192.0.2.10', username: 'deploy' },
    { nickname: 'shop-staging', host: '192.0.2.20', username: 'deploy' },
    { nickname: 'db-primary', host: '198.51.100.5', username: 'postgres' },
    { nickname: 'mail-relay', host: '198.51.100.30', username: 'ops' },
  ];
  for (const server of servers) {
    await invoke(p, 'ssh.saveServer', {
      ...server,
      port: 22,
      authMethod: 'password',
      secret: 'demo-password-not-real',
    });
  }
  await openRemoteView(p, 'SSH');
  await expect(p.getByRole('button', { name: 'Edit db-primary' })).toBeVisible({
    timeout: 30_000,
  });
  await capture(p, secrets, {
    name: 'ssh',
    route: '/remote',
    theme: 'dark',
    alt: 'The SSH tab on the Remote page with the saved Northwind servers, from the production shop to the database and mail relay, each ready to open in a terminal.',
  });
});

test('remote-desktop', async () => {
  const p = page();
  const options = {
    resolution: 'fitWindow',
    fullscreenOnConnect: false,
    maximizeOnConnect: true,
    clipboard: true,
    fileTransfer: true,
    nla: true,
  };
  const servers = [
    { nickname: 'Office PC', host: '192.0.2.50', username: 'dana', domain: 'NORTHWIND' },
    { nickname: 'Roastery kiosk', host: '192.0.2.61', username: 'kiosk', domain: '' },
    { nickname: 'Build server', host: '198.51.100.12', username: 'builder', domain: 'NORTHWIND' },
  ];
  for (const server of servers) {
    await invoke(p, 'rdp.saveServer', {
      ...server,
      port: 3389,
      secret: 'demo-password-not-real',
      options,
    });
  }
  await openRemoteView(p, 'Remote Desktop');
  await expect(p.getByRole('button', { name: 'Edit Build server' })).toBeVisible({
    timeout: 30_000,
  });
  await capture(p, secrets, {
    name: 'remote-desktop',
    route: '/remote',
    theme: 'dark',
    alt: 'The Remote Desktop tab with saved Windows machines: the office PC, the roastery kiosk and the build server, each opening in its own window.',
  });
});

// The Help home lists every article's summary, and the Remote one speaks of pairing a phone, so
// the shot is an article with the topics beside it. Getting started gives the app's old name.
test('help', async () => {
  const p = page();
  const route = '/help/workspace';
  await openRoute(p, route);
  await expect(p.getByRole('navigation', { name: 'Help topics' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(p.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
  await capture(p, secrets, {
    name: 'help',
    route,
    theme: 'dark',
    alt: 'The Help center on its Workspace guide, with every topic listed by area on the left and an outline of the article on the right.',
  });
});

test('ai-pet', async () => {
  const p = page();
  await openRoute(p, '/settings?tab=companion');
  const show = p.getByRole('switch', { name: 'Show my AI pet' });
  await expect(show).toBeVisible({ timeout: 30_000 });
  if ((await show.getAttribute('aria-checked')) !== 'true') await show.click();
  await expect(show).toHaveAttribute('aria-checked', 'true');
  await capture(p, secrets, {
    name: 'ai-pet',
    route: '/settings?tab=companion',
    theme: 'dark',
    alt: 'The AI Pet in Settings, turned on, with its characters to pick from: a coder pup, an orange voxel, a gremlin, an orca and more.',
  });
});

/** Starts a loopback HTTP server for a test, stopped by afterAll. Returns its base URL. */
async function startFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  track(url, () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return url;
}

const DEMO_ORDERS = {
  page: 1,
  total: 3,
  orders: [
    { id: 'NW-10482', customer: 'Blue Door Cafe', items: 3, totalCents: 4850, status: 'paid' },
    { id: 'NW-10481', customer: 'Harbor Bakery', items: 12, totalCents: 18900, status: 'shipped' },
    { id: 'NW-10480', customer: 'Corner Espresso', items: 1, totalCents: 1600, status: 'paid' },
  ],
};

test('api-client', async () => {
  const p = page();
  const base = await startFakeServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(DEMO_ORDERS));
  });
  const collection = await invoke<{ id: string }>(p, 'apiClient.createCollection', 'Northwind API');
  const requests = [
    { name: 'List orders', method: 'GET', path: '/v1/orders?status=open' },
    { name: 'Create order', method: 'POST', path: '/v1/orders' },
    { name: 'Get stock', method: 'GET', path: '/v1/stock/autumn-roast' },
    { name: 'Refund order', method: 'POST', path: '/v1/orders/NW-10481/refund' },
  ];
  for (const [index, request] of requests.entries()) {
    await invoke(p, 'apiClient.saveRequest', {
      collectionId: collection.id,
      parentId: null,
      item: {
        id: `northwind-request-${index}`,
        name: request.name,
        request: {
          method: request.method,
          url: `${base}${request.path}`,
          header: [{ key: 'Accept', value: 'application/json' }],
          body: request.method === 'POST' ? { mode: 'raw', raw: '{}' } : null,
        },
      },
    });
  }
  await openRoute(p, '/api-client');
  await p.getByRole('treeitem', { name: 'Northwind API' }).click({ timeout: 30_000 });
  await p.getByRole('treeitem', { name: 'GET List orders' }).click();
  await p.getByRole('button', { name: /^Send/ }).click();
  await expect(p.getByText('200 OK')).toBeVisible({ timeout: 30_000 });
  // Scoped to the response: a diff editor from the git shot can still be mounted, hidden.
  await expect(p.getByRole('region', { name: 'Response' }).locator('.monaco-editor')).toContainText(
    'NW-10482',
  );
  await capture(p, secrets, {
    name: 'api-client',
    route: '/api-client',
    theme: 'dark',
    alt: "The API Client with a Northwind collection: a request for the open orders and the API's JSON response next to it.",
  });
});

test('studio', async () => {
  const p = page();
  if (!drive) throw new Error('No demo drive');
  await invoke(p, 'studio.updateSettings', {
    defaultRoot: join(drive.root, 'Videos', 'Runova Studio'),
  });
  await openRoute(p, '/studio');
  await p.getByRole('button', { name: 'New video' }).first().click();
  const dialog = p.getByRole('dialog', { name: 'New video' });
  await dialog.getByLabel('Title').fill('Autumn roast launch');
  await dialog.getByRole('switch', { name: 'Write the scenario with AI' }).click();
  await dialog.getByRole('button', { name: 'Create video' }).click();
  await expect(p.getByLabel('Video title')).toHaveValue('Autumn roast launch');
  const scenes = [
    {
      title: 'Hook',
      narration: 'This autumn, Northwind roasts its darkest blend yet.',
    },
    {
      title: 'The beans',
      narration:
        'Single-origin beans from the hills of Huila, roasted in small batches every week.',
    },
    {
      title: 'Order now',
      narration: 'Use the code ROAST15 for fifteen percent off your first bag.',
    },
  ];
  for (const [index, scene] of scenes.entries()) {
    const number = index + 1;
    await p.getByRole('button', { name: 'Add scene' }).click();
    const region = p.getByRole('region', { name: `Scene ${number}` });
    await region.getByLabel(`Scene ${number} title`).fill(scene.title);
    await region.getByLabel('Narration').click();
    await region.getByLabel('Narration').fill(scene.narration);
  }
  await p.getByLabel('Video title').click();
  await capture(p, secrets, {
    name: 'studio',
    route: '/studio',
    theme: 'dark',
    alt: 'Studio with a short video for the autumn roast launch open: three scenes, each with a title and the narration that will be read over it.',
  });
});

/** What a Northwind service answers on its health endpoint; the mailer's queue is down. */
function healthReport(service: string): { status: number; body: unknown } {
  const failing = service === 'mailer';
  const checks: Record<string, unknown[]> = {
    'postgres:connection': [
      { componentType: 'datastore', status: 'pass', observedValue: 4, observedUnit: 'ms' },
    ],
    'redis:ping': [{ componentType: 'datastore', status: 'pass' }],
  };
  if (failing) {
    checks['rabbitmq:connection'] = [
      {
        componentType: 'datastore',
        status: 'fail',
        output: 'connect ECONNREFUSED 10.0.0.12:5672',
        runova: { errorCode: 'ECONNREFUSED', hint: 'Start the queue container' },
      },
    ];
  }
  return {
    status: failing ? 503 : 200,
    body: {
      status: failing ? 'fail' : 'pass',
      releaseId: '2.4.0',
      checks,
      runova: { protocol: 'runova-health/1' },
    },
  };
}

test('monitoring-uptime', async () => {
  const p = page();
  const base = await startFakeServer((request, response) => {
    // Any key will do: the shot is about the page, not the key check.
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="runova-health"' });
      response.end();
      return;
    }
    const service = /^\/([^/]+)\//.exec(request.url ?? '')?.[1] ?? '';
    const { status, body } = healthReport(service);
    response.writeHead(status, { 'Content-Type': 'application/health+json' });
    response.end(JSON.stringify(body));
  });
  const targets = [
    { project: 'storefront', name: 'Storefront', server: 'web-1', service: 'storefront' },
    { project: 'northwind-api', name: 'API', server: 'api-1', service: 'api' },
    { project: 'admin-portal', name: 'Admin portal', server: 'web-1', service: 'admin' },
    { project: 'mailer-service', name: 'Mailer', server: 'worker-1', service: 'mailer' },
  ];
  for (const target of targets) {
    const { target: created } = await invoke<{ target: { id: string } }>(p, 'health.create', {
      projectId: projectIds[target.project],
      environmentId: null,
      name: target.name,
      serverLabel: target.server,
      serverLink: null,
      url: `${base}/${target.service}/_runova/health`,
      intervalSec: 60,
      timeoutSec: 10,
      authMode: 'bearer',
      basicUser: null,
      allowInsecure: false,
      autoDiagnose: false,
    });
    await invoke(p, 'health.checkNow', created.id);
  }
  await openRoute(p, '/monitoring');
  await expect(p.getByText('Admin portal').first()).toBeVisible({ timeout: 30_000 });
  await capture(p, secrets, {
    name: 'monitoring-uptime',
    route: '/monitoring',
    theme: 'dark',
    alt: "Monitoring's Uptime view: the Northwind storefront, API and admin portal are up, while the mailer is down because its queue refuses connections.",
  });
});

test('monitoring-errors', async () => {
  const p = page();
  const sentry = await startFakeSentry();
  track(sentry.url, sentry.close);
  await openRoute(p, '/monitoring?view=errors');
  await p.getByRole('button', { name: 'Connect Sentry' }).click({ timeout: 30_000 });
  const dialog = p.getByRole('dialog', { name: 'Error tracking connections' });
  await dialog.getByRole('combobox', { name: 'Sentry host', exact: true }).click();
  await p.getByRole('option', { name: 'Self-hosted or GlitchTip' }).click();
  await dialog.getByLabel('Server URL', { exact: true }).fill(sentry.url);
  await dialog.getByLabel('Auth token', { exact: true }).fill(SENTRY_TOKEN);
  await dialog.getByRole('button', { name: 'Check token' }).click();
  await expect(dialog.getByRole('list', { name: 'Token scopes' })).toBeVisible({
    timeout: 30_000,
  });
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(dialog.getByRole('region', { name: 'Link projects' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    dialog.getByRole('combobox', { name: 'Sentry projects for storefront', exact: true }),
  ).toContainText('storefront-api', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Save links' }).click();
  // Earlier captures hide toasts for good, so the toast is only there, not visible.
  await expect(p.getByText('Link saved').first()).toBeAttached({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  const list = p.getByRole('list', { name: 'Issues' });
  await expect(list.getByRole('button', { name: 'Slow checkout render', exact: true })).toBeVisible(
    { timeout: 30_000 },
  );
  await capture(p, secrets, {
    name: 'monitoring-errors',
    route: '/monitoring?view=errors',
    theme: 'dark',
    alt: "Monitoring's Errors view with the issues Sentry recorded for the storefront's web app and API, grouped under the project and ready to hand to an agent.",
  });
});

interface RelayTask {
  id: string;
  title: string;
  status: 'todo' | 'in-progress' | 'testing' | 'done';
  epic: string;
  depends: string[];
}

/** The admin portal's wholesale work as Relay tasks, from finished to waiting. */
const RELAY_TASKS: RelayTask[] = [
  { id: 'T001', title: 'Add the wholesale role', status: 'done', epic: 'E01', depends: [] },
  { id: 'T002', title: 'Standing orders API', status: 'done', epic: 'E01', depends: ['T001'] },
  { id: 'T003', title: 'List wholesale orders', status: 'testing', epic: 'E02', depends: ['T002'] },
  {
    id: 'T004',
    title: 'Invoices on 30-day terms',
    status: 'in-progress',
    epic: 'E02',
    depends: ['T002'],
  },
  { id: 'T005', title: 'Roast calendar', status: 'todo', epic: 'E03', depends: ['T001'] },
  { id: 'T006', title: 'Email invoices', status: 'todo', epic: 'E02', depends: ['T004'] },
  { id: 'T007', title: 'Pause a standing order', status: 'todo', epic: 'E03', depends: ['T003'] },
];

function relayTaskFile(task: RelayTask, order: number): string {
  return [
    '---',
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `epic: ${task.epic}`,
    `order: ${order}`,
    `depends: [${task.depends.join(', ')}]`,
    'estimate: 60000',
    'budget: 200000',
    'specs: [docs/wholesale.md]',
    '---',
    '',
    '## Goal',
    `${task.title}.`,
    '',
    '## Acceptance criteria',
    '- [ ] It works for a cafe with a standing order.',
    '',
  ].join('\n');
}

test('relay', async () => {
  const p = page();
  if (!drive) throw new Error('No demo drive');
  const files: Record<string, string> = {};
  for (const [index, task] of RELAY_TASKS.entries()) {
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    files[join('docs', 'tasks', `${task.id}-${slug}.md`)] = relayTaskFile(task, index + 1);
  }
  writeFiles(join(drive.root, 'projects', 'admin-portal'), files);
  const route = `/projects/${projectIds['admin-portal']}`;
  await openRoute(p, route);
  await p.getByRole('button', { name: 'Task board' }).click();
  const inProgress = p.getByRole('region', { name: 'In progress' });
  await expect(inProgress.getByText(/Invoices on 30-day terms/).first()).toBeVisible({
    timeout: 30_000,
  });
  await capture(p, secrets, {
    name: 'relay',
    route,
    theme: 'dark',
    alt: "The Relay board for the admin portal's wholesale work: tasks move from To do through In progress and Testing to Done as agent sessions pick them up.",
  });
  // The board sits over every page, so it is closed before the next shot.
  await p.getByRole('button', { name: 'Close the board' }).click();
  await expect(inProgress).toBeHidden();
});

const DAY_MS = 86_400_000;

/** Claude Code transcripts for the last two weeks of Northwind work, one session a day. */
function claudeLogs(projectsRoot: string, now: number): Record<string, string> {
  const files: Record<string, string> = {};
  const projects: [string, number][] = [
    ['storefront', 1],
    ['admin-portal', 0.6],
    ['docs-site', 0.25],
  ];
  for (const [name, weight] of projects) {
    const cwd = join(projectsRoot, name);
    const folder = join('.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    for (let day = 13; day >= 0; day--) {
      // Some days are busier than others.
      const turns = Math.round((4 + ((day * 7) % 5) * 2) * weight);
      if (turns === 0) continue;
      const id = `${name}-${day}`;
      const start = now - day * DAY_MS - 3 * 3_600_000;
      const record = (at: number, fields: Record<string, unknown>): string =>
        JSON.stringify({ timestamp: new Date(at).toISOString(), cwd, sessionId: id, ...fields });
      const lines = [
        record(start, {
          type: 'user',
          gitBranch: 'main',
          message: { role: 'user', content: 'Carry on with the next task.' },
        }),
      ];
      for (let turn = 0; turn < turns; turn++) {
        lines.push(
          record(start + turn * 60_000, {
            type: 'assistant',
            message: {
              id: `msg_${id}_${turn}`,
              model: turn % 4 === 3 ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
              usage: {
                input_tokens: 1200 + turn * 150,
                output_tokens: 2400 + ((turn * 37) % 9) * 600,
                cache_creation_input_tokens: 8000,
                cache_read_input_tokens: 180_000 + turn * 12_000,
              },
            },
          }),
        );
      }
      files[join(folder, `${id}.jsonl`)] = `${lines.join('\n')}\n`;
    }
  }
  return files;
}

/** Codex rollouts for the API, with the rate limit Codex reports alongside. */
function codexLogs(projectsRoot: string, now: number): Record<string, string> {
  const files: Record<string, string> = {};
  const cwd = join(projectsRoot, 'northwind-api');
  for (let day = 9; day >= 0; day--) {
    const start = now - day * DAY_MS - 5 * 3_600_000;
    const date = new Date(start);
    const y = String(date.getFullYear());
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const record = (at: number, type: string, payload: unknown): string =>
      JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
    const lines = [
      record(start, 'session_meta', { id: `api-${day}`, cwd }),
      record(start, 'turn_context', { cwd, model: 'gpt-5.5' }),
    ];
    for (let turn = 0; turn < 3 + (day % 3); turn++) {
      lines.push(
        record(start + turn * 90_000, 'event_msg', {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 60_000 + turn * 8_000,
              cached_input_tokens: 48_000 + turn * 6_000,
              output_tokens: 3_000 + turn * 700,
            },
          },
          rate_limits: {
            primary: {
              used_percent: 34,
              window_minutes: 300,
              resets_at: Math.round(now / 1000) + 2 * 3600,
            },
          },
        }),
      );
    }
    files[join('.codex', 'sessions', y, m, d, `rollout-${y}-${m}-${d}-api-${day}.jsonl`)] =
      `${lines.join('\n')}\n`;
  }
  return files;
}

test('usage', async () => {
  const p = page();
  if (!drive) throw new Error('No demo drive');
  const projectsRoot = join(drive.root, 'projects');
  const now = Date.now();
  writeFiles(join(drive.root, 'northwind', 'home'), {
    ...claudeLogs(projectsRoot, now),
    ...codexLogs(projectsRoot, now),
  });
  await openRoute(p, '/usage');
  await expect(p.getByRole('button', { name: 'Add provider' })).toBeVisible({ timeout: 30_000 });
  await expect(p.getByText('14-day trend across all agents')).toBeVisible({ timeout: 60_000 });
  await expect(p.getByText(/storefront/).first()).toBeVisible({ timeout: 60_000 });
  await capture(p, secrets, {
    name: 'usage',
    route: '/usage',
    theme: 'dark',
    alt: 'Token Usage built from the local logs of Claude Code and Codex: tokens and cost per day for the last two weeks, by model and by Northwind project.',
  });
});

/** A stable fake hex id, so every run of the spec shows the same SHAs and container ids. */
function hexId(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

const WORKFLOWS: Record<string, { id: number; name: string; file: string }[]> = {
  storefront: [
    { id: 101, name: 'CI', file: 'ci.yml' },
    { id: 102, name: 'Deploy', file: 'deploy.yml' },
  ],
  'northwind-api': [
    { id: 201, name: 'Build and test', file: 'build.yml' },
    { id: 202, name: 'Release', file: 'release.yml' },
  ],
  'admin-portal': [{ id: 301, name: 'CI', file: 'ci.yml' }],
};

interface DemoRun {
  repo: string;
  workflow: number;
  title: string;
  branch: string;
  hoursAgo: number;
  /** Null while the run is still going. */
  conclusion: 'success' | 'failure' | null;
  actor: string;
}

/** The last two weeks of Northwind Actions runs: mostly green, a few red, one still going. */
const DEMO_RUNS: DemoRun[] = [
  {
    repo: 'storefront',
    workflow: 101,
    title: 'feat(cart): discount codes',
    branch: 'feat/discount-codes',
    hoursAgo: 0.1,
    conclusion: null,
    actor: 'dana-reyes',
  },
  {
    repo: 'northwind-api',
    workflow: 201,
    title: 'feat(wholesale): standing orders API',
    branch: 'feat/standing-orders',
    hoursAgo: 1.2,
    conclusion: 'success',
    actor: 'sam-okafor',
  },
  {
    repo: 'admin-portal',
    workflow: 301,
    title: 'feat(wholesale): invoices on 30-day terms',
    branch: 'feat/invoices',
    hoursAgo: 2.5,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'storefront',
    workflow: 101,
    title: 'fix(checkout): round the tax once',
    branch: 'main',
    hoursAgo: 3,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'storefront',
    workflow: 102,
    title: 'Release 2.4.0',
    branch: 'main',
    hoursAgo: 5,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'northwind-api',
    workflow: 201,
    title: 'fix(stock): reserve before payment',
    branch: 'main',
    hoursAgo: 7,
    conclusion: 'failure',
    actor: 'sam-okafor',
  },
  {
    repo: 'admin-portal',
    workflow: 301,
    title: 'feat(wholesale): the wholesale role',
    branch: 'main',
    hoursAgo: 26,
    conclusion: 'success',
    actor: 'lena-fischer',
  },
  {
    repo: 'storefront',
    workflow: 101,
    title: 'chore(deps): bump vite to 7.1',
    branch: 'renovate/vite',
    hoursAgo: 30,
    conclusion: 'failure',
    actor: 'renovate[bot]',
  },
  {
    repo: 'northwind-api',
    workflow: 202,
    title: 'v1.9.0',
    branch: 'main',
    hoursAgo: 50,
    conclusion: 'success',
    actor: 'sam-okafor',
  },
  {
    repo: 'storefront',
    workflow: 101,
    title: 'feat(catalog): the autumn roast page',
    branch: 'main',
    hoursAgo: 54,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'storefront',
    workflow: 102,
    title: 'Release 2.3.2',
    branch: 'main',
    hoursAgo: 75,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'admin-portal',
    workflow: 301,
    title: 'fix(refunds): show the partial amount',
    branch: 'main',
    hoursAgo: 98,
    conclusion: 'success',
    actor: 'lena-fischer',
  },
  {
    repo: 'northwind-api',
    workflow: 201,
    title: 'feat(payments): retry declined cards once',
    branch: 'main',
    hoursAgo: 120,
    conclusion: 'success',
    actor: 'sam-okafor',
  },
  {
    repo: 'storefront',
    workflow: 101,
    title: 'test(cart): cover an empty cart',
    branch: 'main',
    hoursAgo: 150,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'admin-portal',
    workflow: 301,
    title: 'feat(catalog): bulk price edit',
    branch: 'main',
    hoursAgo: 170,
    conclusion: 'failure',
    actor: 'lena-fischer',
  },
  {
    repo: 'northwind-api',
    workflow: 201,
    title: 'chore: upgrade to .NET 10',
    branch: 'main',
    hoursAgo: 200,
    conclusion: 'success',
    actor: 'sam-okafor',
  },
  {
    repo: 'storefront',
    workflow: 101,
    title: 'fix(a11y): label the quantity field',
    branch: 'main',
    hoursAgo: 230,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'storefront',
    workflow: 102,
    title: 'Release 2.3.1',
    branch: 'main',
    hoursAgo: 260,
    conclusion: 'success',
    actor: 'dana-reyes',
  },
  {
    repo: 'admin-portal',
    workflow: 301,
    title: 'feat(orders): filter by cafe',
    branch: 'main',
    hoursAgo: 280,
    conclusion: 'success',
    actor: 'lena-fischer',
  },
  {
    repo: 'northwind-api',
    workflow: 201,
    title: 'feat(stock): low stock alerts',
    branch: 'main',
    hoursAgo: 300,
    conclusion: 'success',
    actor: 'sam-okafor',
  },
];

/** GitHub's answers to the calls Pipelines makes, through the fake gh. */
function githubAnswers(now: number): FakeCliAnswer[] {
  const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
  const answers: FakeCliAnswer[] = [
    // Agent Tools reads the version too, so it stays the one the earlier shots show.
    { match: ['--version'], stdout: 'gh version 2.62.0 (2024-11-14)\n' },
    // No self-hosted runners: every job runs on GitHub's own machines.
    { match: ['/actions/runners'], stdout: json({ total_count: 0, runners: [] }) },
    { match: ['/jobs'], stdout: json({ total_count: 0, jobs: [] }) },
    // The status bar shows who gh is signed in as.
    { match: ['json user/orgs'], stdout: json([{ login: GITHUB_OWNER }]) },
    { match: ['json user'], stdout: json({ login: 'dana-reyes', name: 'Dana Reyes' }) },
  ];
  for (const [repo, workflows] of Object.entries(WORKFLOWS)) {
    const slug = `${GITHUB_OWNER}/${repo}`;
    answers.push({
      match: [`repos/${slug}/actions/workflows`],
      stdout: json({
        total_count: workflows.length,
        workflows: workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          path: `.github/workflows/${workflow.file}`,
          state: 'active',
          html_url: `https://github.com/${slug}/actions/workflows/${workflow.file}`,
          badge_url: `https://github.com/${slug}/workflows/${workflow.name}/badge.svg`,
        })),
      }),
    });
    const counters = new Map<number, number>();
    const runs = DEMO_RUNS.filter((run) => run.repo === repo)
      // Numbered from the oldest, so the newest run has the highest number.
      .reverse()
      .map((run) => {
        const number = (counters.get(run.workflow) ?? 40 + run.workflow) + 1;
        counters.set(run.workflow, number);
        const id = run.workflow * 100_000 + number;
        const created = now - run.hoursAgo * 3_600_000;
        const running = run.conclusion === null;
        return {
          id,
          workflow_id: run.workflow,
          name: workflows.find((workflow) => workflow.id === run.workflow)?.name ?? 'CI',
          display_title: run.title,
          run_number: number,
          head_branch: run.branch,
          status: running ? 'in_progress' : 'completed',
          conclusion: run.conclusion,
          html_url: `https://github.com/${slug}/actions/runs/${id}`,
          created_at: new Date(created).toISOString(),
          updated_at: new Date(running ? now - 30_000 : created + 4 * 60_000).toISOString(),
          check_suite_id: id + 7,
          event: run.branch === 'main' ? 'push' : 'pull_request',
          actor: { login: run.actor },
          head_sha: hexId(`${repo}-${id}`, 40),
          run_attempt: 1,
        };
      })
      .reverse();
    answers.push({
      match: [`repos/${slug}/actions/runs?`],
      stdout: json({ total_count: runs.length, workflow_runs: runs }),
    });
  }
  return answers;
}

test('pipelines', async () => {
  const p = page();
  if (!drive) throw new Error('No demo drive');
  installFakeCli(join(drive.root, 'northwind'), 'gh', githubAnswers(Date.now()));
  await reloadApp(p);
  await openRoute(p, '/pipelines');
  const runs = p.getByRole('list', { name: 'Workflow runs' });
  await expect(runs.getByText('feat(cart): discount codes').first()).toBeVisible({
    timeout: 60_000,
  });
  await capture(p, secrets, {
    name: 'pipelines',
    route: '/pipelines',
    theme: 'dark',
    alt: 'Pipelines with the GitHub Actions runs of the Northwind repos: the discount codes branch is still building, the few failed runs stand out in red, and the rest passed.',
  });
});

interface DemoContainer {
  name: string;
  image: string;
  /** Null when the container is stopped. */
  stats: { cpu: string; mem: string; net: string; block: string } | null;
  status: string;
  /** The compose project and the folder it was started in, if any. */
  compose?: { project: string; folder: string };
}

const DEMO_CONTAINERS: DemoContainer[] = [
  {
    name: 'storefront-web-1',
    image: 'northwind/storefront:2.4.0',
    stats: { cpu: '0.84%', mem: '96.2MiB / 7.65GiB', net: '18.4MB / 52.1MB', block: '0B / 4.1MB' },
    status: 'Up 5 hours',
    compose: { project: 'storefront', folder: 'storefront' },
  },
  {
    name: 'storefront-api-1',
    image: 'northwind/api:1.9.0',
    stats: { cpu: '2.31%', mem: '212.5MiB / 7.65GiB', net: '41.7MB / 38.9MB', block: '1.2MB / 0B' },
    status: 'Up 5 hours',
    compose: { project: 'storefront', folder: 'storefront' },
  },
  {
    name: 'northwind-postgres',
    image: 'postgres:17-alpine',
    stats: {
      cpu: '1.12%',
      mem: '148.9MiB / 7.65GiB',
      net: '9.8MB / 21.3MB',
      block: '64.2MB / 310MB',
    },
    status: 'Up 2 days (healthy)',
  },
  {
    name: 'northwind-redis',
    image: 'redis:8-alpine',
    stats: { cpu: '0.27%', mem: '12.4MiB / 7.65GiB', net: '3.1MB / 2.8MB', block: '0B / 0B' },
    status: 'Up 2 days',
  },
  {
    name: 'mailer-rabbitmq-1',
    image: 'rabbitmq:4-management',
    stats: null,
    status: 'Exited (137) 2 hours ago',
    compose: { project: 'mailer-service', folder: 'mailer-service' },
  },
  {
    name: 'mailer-worker-1',
    image: 'northwind/mailer:1.8.2',
    stats: { cpu: '0.05%', mem: '64.0MiB / 7.65GiB', net: '1.4MB / 0.9MB', block: '0B / 0B' },
    status: 'Up 2 hours',
    compose: { project: 'mailer-service', folder: 'mailer-service' },
  },
  {
    name: 'docs-site-preview',
    image: 'node:22-alpine',
    stats: null,
    status: 'Exited (0) 3 days ago',
  },
];

/** Image sizes as `docker image ls` prints them, and how long ago each was built. */
const DEMO_IMAGES: Record<string, { size: string; daysAgo: number }> = {
  'northwind/storefront:2.4.0': { size: '186MB', daysAgo: 0 },
  'northwind/api:1.9.0': { size: '242MB', daysAgo: 2 },
  'postgres:17-alpine': { size: '278MB', daysAgo: 12 },
  'redis:8-alpine': { size: '61.2MB', daysAgo: 20 },
  'rabbitmq:4-management': { size: '412MB', daysAgo: 16 },
  'northwind/mailer:1.8.2': { size: '158MB', daysAgo: 6 },
  'node:22-alpine': { size: '163MB', daysAgo: 25 },
};

/** Docker's answers for the Northwind containers, through the fake docker. */
function dockerAnswers(projectsRoot: string, now: number): FakeCliAnswer[] {
  const containerId = (name: string): string => hexId(`container-${name}`, 64);
  const imageId = (image: string): string => `sha256:${hexId(`image-${image}`, 64)}`;
  const ps = (container: DemoContainer): string =>
    JSON.stringify({
      ID: containerId(container.name),
      Names: container.name,
      Image: container.image,
      State: container.stats ? 'running' : 'exited',
      Status: container.status,
      Labels: container.compose
        ? `com.docker.compose.project=${container.compose.project},com.docker.compose.project.working_dir=${join(projectsRoot, container.compose.folder)}`
        : '',
    });
  const lines = (items: string[]): string => `${items.join('\n')}\n`;
  const running = DEMO_CONTAINERS.filter((container) => container.stats);
  const created = (daysAgo: number): string => {
    // `docker image ls` prints local time with the offset, here the demo zone in winter.
    const date = new Date(now - daysAgo * DAY_MS + 3_600_000);
    return `${date.toISOString().slice(0, 19).replace('T', ' ')} +0100 CET`;
  };
  return [
    {
      match: ['version', '--format json'],
      stdout: `${JSON.stringify({ Client: { Version: '28.5.1' }, Server: { Version: '28.5.1' } })}\n`,
    },
    { match: ['ps -a -q'], stdout: lines(DEMO_CONTAINERS.map((item) => containerId(item.name))) },
    { match: ['ps', 'status=running'], stdout: lines(running.map(ps)) },
    { match: ['ps -a --no-trunc'], stdout: lines(DEMO_CONTAINERS.map(ps)) },
    {
      match: ['stats'],
      stdout: lines(
        running.map((container) =>
          JSON.stringify({
            Container: containerId(container.name),
            CPUPerc: container.stats?.cpu,
            MemUsage: container.stats?.mem,
            NetIO: container.stats?.net,
            BlockIO: container.stats?.block,
          }),
        ),
      ),
    },
    // Asked with the ids `ps -a -q` printed, in the same order.
    {
      match: ['container inspect'],
      stdout: lines(DEMO_CONTAINERS.map((container) => imageId(container.image))),
    },
    {
      match: ['image ls'],
      stdout: lines(
        Object.entries(DEMO_IMAGES).map(([image, { size, daysAgo }]) => {
          const [repository, tag] = image.split(':');
          return JSON.stringify({
            ID: imageId(image),
            Repository: repository,
            Tag: tag,
            CreatedAt: created(daysAgo),
            CreatedSince: daysAgo === 0 ? '6 hours ago' : `${daysAgo} days ago`,
            Size: size,
          });
        }),
      ),
    },
  ];
}

test('docker', async () => {
  const p = page();
  if (!drive) throw new Error('No demo drive');
  installFakeCli(
    join(drive.root, 'northwind'),
    'docker',
    dockerAnswers(join(drive.root, 'projects'), Date.now()),
  );
  await reloadApp(p);
  await openRoute(p, '/docker');
  await expect(p.getByText('northwind-postgres').first()).toBeVisible({ timeout: 60_000 });
  await expect(p.getByText('storefront-web-1').first()).toBeVisible();
  await capture(p, secrets, {
    name: 'docker',
    route: '/docker',
    theme: 'dark',
    alt: 'The Docker page with the Northwind containers: the storefront, API, Postgres and Redis running with their CPU and memory, and the stopped mail queue easy to spot.',
  });
});
