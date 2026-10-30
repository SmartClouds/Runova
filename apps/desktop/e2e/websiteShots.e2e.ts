import { execSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { type CDPSession, expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { createDevSetupSandbox, type DevSetupSandbox } from './devSetupSandbox';
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

/** Creates the project folders (storefront as a git repo) and the projects. Returns their ids. */
async function seedProjects(page: Page, projectsRoot: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const project of NORTHWIND) {
    const folderPath = join(projectsRoot, project.name);
    if (project.name === 'storefront') seedStorefront(folderPath);
    else
      writeFiles(folderPath, {
        'README.md': `# ${project.name}\n\n${project.description}\n`,
      });
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

let drive: DemoDrive | undefined;
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
  launched = await launchApp({
    reuseRoot: root,
    claudeScript: join(__dirname, 'fixtures', 'websiteShotsClaude.cjs'),
    env: demoEnv(root, sandbox),
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
  });
  await emulateShotSize(launched.page);
  projectIds = await seedProjects(launched.page, join(drive.root, 'projects'));
  await seedAppData(launched.page, projectIds);
  // Projects made through IPC are not in the cached list yet.
  await launched.page.reload();
  await launched.page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  await emulateShotSize(launched.page);
});

test.afterAll(async () => {
  if (manifest.length > 0) writeManifest();
  await launched?.close();
  launched = undefined;
  drive?.release();
  drive = undefined;
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
