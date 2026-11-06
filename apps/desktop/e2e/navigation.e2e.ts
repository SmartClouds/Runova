import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Every sidebar destination, plus the routes that have no nav entry of their own. Each one has
 * to render its own page (not an empty shell and not the error card), highlight its sidebar
 * link, and be reachable by hash as well as by click. Back and forward walk the same history.
 *
 * The landmark per page is something only that page shows, so a route that silently rendered
 * nothing (or rendered the previous page) fails here rather than passing on a visible sidebar.
 */

interface Destination {
  /** The sidebar label, which is also the link's accessible name. */
  label: string;
  hash: string;
  landmark: (page: Page) => Locator;
}

const DESTINATIONS: Destination[] = [
  {
    label: 'Dashboard',
    hash: '#/',
    landmark: (page) => page.getByRole('button', { name: 'Edit layout' }),
  },
  {
    label: 'Token Usage',
    hash: '#/usage',
    landmark: (page) => page.getByRole('button', { name: 'Edit card order' }),
  },
  {
    label: 'Prompt Builder',
    hash: '#/prompt-builder',
    landmark: (page) => page.getByLabel('Your request'),
  },
  {
    label: 'Projects',
    hash: '#/projects',
    landmark: (page) => page.getByRole('button', { name: 'New Project' }).first(),
  },
  {
    label: 'Workspace',
    hash: '#/workspace',
    landmark: (page) => page.getByRole('heading', { name: 'Pick a project to work on' }),
  },
  {
    label: 'API Client',
    hash: '#/api-client',
    landmark: (page) =>
      page.getByRole('tree', { name: 'Collections' }).or(page.getByText('No collections yet')),
  },
  {
    // A test run with no sandbox folder leaves it switched off, so it can never touch real caches.
    label: 'Disk Cleanup',
    hash: '#/cleanup',
    landmark: (page) => page.getByText('Disk Cleanup is switched off'),
  },
  {
    label: 'Pipelines',
    hash: '#/pipelines',
    landmark: (page) => page.getByRole('button', { name: /^Refresh runs/ }),
  },
  {
    // The e2e profile has no saved servers, so the page points to Remote; with servers it lists
    // them in its rail.
    label: 'Deploy',
    hash: '#/deploy',
    landmark: (page) =>
      page.getByRole('navigation', { name: 'Servers' }).or(page.getByText('No servers yet')),
  },
  {
    label: 'Skills',
    hash: '#/skills',
    landmark: (page) => page.getByRole('navigation', { name: 'Skill views' }),
  },
  {
    label: 'MCP Servers',
    hash: '#/mcp',
    landmark: (page) => page.getByLabel('Search MCP servers'),
  },
  {
    label: 'Agent Tools',
    hash: '#/tools',
    landmark: (page) => page.getByRole('navigation', { name: 'Tool categories' }),
  },
  {
    // Docker may or may not be installed on the machine running the suite, and the page says so
    // either way. Both outcomes are this page and nothing else.
    label: 'Docker',
    hash: '#/docker',
    landmark: (page) =>
      page.getByLabel('Search containers').or(page.getByText("Docker isn't available")),
  },
  {
    // The Android SDK may or may not be installed on the machine running the suite, and the page
    // says so either way. Both outcomes are this page and nothing else.
    label: 'Android',
    hash: '#/android',
    landmark: (page) =>
      page.getByRole('button', { name: 'Refresh' }).or(page.getByText('Android SDK not found')),
  },
  {
    label: 'Ask AI',
    hash: '#/ask-ai',
    landmark: (page) => page.getByRole('button', { name: 'Clear history' }),
  },
  {
    label: 'Remote',
    hash: '#/remote',
    landmark: (page) => page.getByRole('navigation', { name: 'Remote views' }),
  },
  {
    label: 'Vault',
    hash: '#/vault',
    landmark: (page) => page.getByRole('heading', { name: 'Create your vault' }),
  },
  {
    label: 'Settings',
    hash: '#/settings',
    landmark: (page) => page.getByRole('group', { name: 'Theme' }),
  },
];

/** Routes the sidebar does not list, reached by hash the way a deep link does. */
const HASH_ONLY: { hash: string; landmark: (page: Page) => Locator }[] = [
  {
    hash: '#/prompt-history',
    landmark: (page) => page.getByPlaceholder('Search prompt history…'),
  },
  {
    hash: '#/tools?tab=ai-clis',
    landmark: (page) => page.getByRole('searchbox', { name: 'Filter CLIs' }),
  },
  {
    hash: '#/remote-files',
    landmark: (page) => page.getByText(/^Not connected\./),
  },
];

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** The card an ErrorBoundary puts up in place of a page that threw. */
function errorCard(page: Page): Locator {
  return page.getByText(/Something broke|could not be shown/);
}

async function expectPage(page: Page, destination: Destination | HashOnly): Promise<void> {
  await expect(destination.landmark(page)).toBeVisible({ timeout: 30_000 });
  await expect(errorCard(page)).toHaveCount(0);
}

type HashOnly = (typeof HASH_ONLY)[number];

async function goByHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('every sidebar destination renders its own page', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;

  for (const destination of DESTINATIONS) {
    const link = page.getByRole('link', { name: destination.label });
    await expect(link).toBeVisible();
    await link.click();

    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(destination.hash);
    // NavLink marks the destination it is on, so this is the app's own idea of "you are here".
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expectPage(page, destination);
  }
});

test('each route renders the same page when it is opened by hash', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;

  for (const destination of [...DESTINATIONS, ...HASH_ONLY]) {
    await goByHash(page, destination.hash);
    await expectPage(page, destination);
  }
});

test('the retired notifications route still lands on Pipelines', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;

  await goByHash(page, '#/notifications');
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/pipelines');
  await expect(page.getByRole('button', { name: /^Refresh runs/ })).toBeVisible();
  await expect(errorCard(page)).toHaveCount(0);
});

test('the retired CLI manager route lands on the AI CLIs tab of Agent Tools', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;

  await goByHash(page, '#/cli-manager');
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/tools?tab=ai-clis');
  await expect(page.getByRole('searchbox', { name: 'Filter CLIs' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('link', { name: 'Agent Tools' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(errorCard(page)).toHaveCount(0);
});

test('back and forward walk the pages that were visited', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const trail = ['Projects', 'Settings', 'Vault'];

  for (const label of trail) {
    await page.getByRole('link', { name: label }).click();
    const destination = DESTINATIONS.find((item) => item.label === label)!;
    await expectPage(page, destination);
  }

  // Back to Settings, then to Projects, then forward through both again.
  for (const label of ['Settings', 'Projects']) {
    await page.goBack();
    const destination = DESTINATIONS.find((item) => item.label === label)!;
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(destination.hash);
    await expectPage(page, destination);
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
  }

  for (const label of ['Settings', 'Vault']) {
    await page.goForward();
    const destination = DESTINATIONS.find((item) => item.label === label)!;
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(destination.hash);
    await expectPage(page, destination);
  }
});
