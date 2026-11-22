import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * The Apps of a Deploy server (E07) against the DevHost: a project with a compose file and an
 * environment from its Environments tab becomes an app through the New App wizard, its deploy
 * shows as a timeline of steps, a second revision follows, and a rollback brings the first one
 * back as a third. The DevHost's docker compose is simulated on its pretend engine, so this runs
 * wherever the .NET SDK does.
 *
 * A port something on the server already holds is named on the Expose step, even when Docker
 * does not list it as published: the DevHost's shop worker runs on the host network and listens
 * on 3000, so only the server's listening sockets give it away.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'runova-local-password';

const compose = (image: string, port = 8080) => `services:
  web:
    image: ${image}
    restart: unless-stopped
    environment:
      GREETING: \${GREETING}
    ports:
      - "${port}:80"
    healthcheck:
      test: ["CMD", "true"]
`;

let devHost: DevHost | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  devHost = await startDevHost();
});

test.afterAll(() => {
  devHost?.stop();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Goes through the wizard from the Source step, the project and environment already picked. */
async function throughTheWizard(page: Page): Promise<void> {
  const wizard = page.getByRole('list', { name: 'New app steps' });
  await expect(wizard).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  // Configure: the env key shows, never its value.
  await expect(page.getByRole('list', { name: 'Env keys' }).getByText('GREETING')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('hello from e2e')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  // Expose: the published port goes to 127.0.0.1, and Websites is where public access comes from.
  await expect(page.getByRole('list', { name: 'Exposure' })).toBeVisible();
  await expect(page.getByText('127.0.0.1').first()).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
}

/**
 * Launches the app against the DevHost with a project whose compose file is `composeText` and a
 * Production environment, signs in to the core and opens the New App wizard on Source, with the
 * project, compose file and environment picked and the app named `name`. The first app checks
 * that the server had none.
 */
async function openNewApp(
  composeText: string,
  name: string,
  { firstApp = false }: { firstApp?: boolean } = {},
): Promise<LaunchedApp> {
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page, projectDir } = launched;
  writeFileSync(join(projectDir, 'compose.yaml'), composeText);
  const projectId = await createProject(launched);
  await page.evaluate(async (id) => {
    const api = (
      window as unknown as {
        runova: {
          environments: {
            save(input: unknown): Promise<{ id: string }>;
            saveFile(input: unknown): Promise<unknown>;
          };
        };
      }
    ).runova.environments;
    const environment = await api.save({ projectId: id, name: 'Production', kind: 'production' });
    await api.saveFile({
      environmentId: environment.id,
      fileName: '.env',
      content: 'GREETING="hello from e2e"\n',
    });
  }, projectId);
  await page.reload();

  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name: 'Apps' })
    .click();
  // The DevHost is shared by the tests in this file, so only the first one finds no apps.
  if (firstApp) {
    await expect(page.getByText('No apps on this server yet')).toBeVisible({ timeout: 30_000 });
  }
  await page.getByRole('button', { name: 'New app' }).click({ timeout: 30_000 });

  // Source: the project, its compose file and its environment, and a name.
  await page.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: 'e2e project' }).click();
  await page.getByRole('radio', { name: /compose\.yaml/ }).check();
  await page.getByRole('combobox', { name: 'Environment', exact: true }).click();
  await page.getByRole('option', { name: /^Production/ }).click();
  await page.getByLabel('App name').fill(name);
  return launched;
}

test('deploys an app from a project, follows its timeline and rolls back', async () => {
  test.setTimeout(240_000);
  const { page, projectDir } = await openNewApp(compose('nginx:1.29'), 'e2e-site', {
    firstApp: true,
  });
  await throughTheWizard(page);
  await page.getByRole('button', { name: 'Deploy e2e-site' }).click();

  // The timeline: every step reached, the revision live.
  const steps = page.getByRole('list', { name: 'Deploy steps' });
  await expect(steps).toBeVisible({ timeout: 60_000 });
  for (const step of ['Validate', 'Pull images', 'Build', 'Start containers', 'Health check']) {
    await expect(steps.getByRole('listitem', { name: step })).toBeVisible();
  }
  await expect(page.getByText('Revision 1 is live.')).toBeVisible({ timeout: 90_000 });

  // A second revision from the same project, with another image.
  await page.getByRole('button', { name: /Open the app/ }).click();
  await expect(page.getByRole('heading', { name: 'e2e-site' })).toBeVisible({ timeout: 30_000 });
  writeFileSync(join(projectDir, 'compose.yaml'), compose('nginx:1.30'));
  await page.getByRole('button', { name: 'Deploy again' }).click();
  await throughTheWizard(page);
  await page.getByRole('button', { name: 'Deploy e2e-site' }).click();
  await expect(page.getByText('Revision 2 is live.')).toBeVisible({ timeout: 90_000 });

  // Roll back to the first revision: it comes back as revision 3.
  await page.getByRole('button', { name: /Open the app/ }).click();
  const revisions = page.getByRole('list', { name: 'Revisions' });
  await expect(revisions.getByRole('listitem', { name: 'Revision 2' })).toBeVisible({
    timeout: 30_000,
  });
  await revisions.getByRole('button', { name: 'Roll back to revision 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByText('Revision 3 is live.')).toBeVisible({ timeout: 90_000 });
  await expect(revisions.getByRole('listitem', { name: 'Revision 3' })).toContainText(/1/);
});

test('names a container on the host network that already holds a port the app publishes', async () => {
  test.setTimeout(180_000);
  const { page } = await openNewApp(compose('nginx:1.29', 3000), 'e2e-port');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('list', { name: 'Env keys' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Next' }).click();

  // shop-worker-1 publishes no port; its node program listens on 3000 on the host network.
  const warning = page.getByRole('alert', { name: 'Ports already in use' });
  await expect(warning).toContainText(
    '3000/tcp for web is held by shop-worker-1 (app shop, host network).',
    { timeout: 30_000 },
  );
  await expect(page.getByRole('table', { name: 'Ports of web' })).toContainText(
    'In use by shop-worker-1 (app shop, host network)',
  );
  // Still only a warning: the review repeats it.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alert', { name: 'Ports already in use' })).toContainText(
    'shop-worker-1 (app shop, host network)',
  );
});
