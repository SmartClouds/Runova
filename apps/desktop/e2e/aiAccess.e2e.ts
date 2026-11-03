import { spawn } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * AI access through the real app (E46). The test plays an agent in another app: it starts the
 * bridge script Runova hands out, in the project folder, and sends it the MCP messages Claude Code
 * would. What the agent may do then depends on the settings, and an approval shows in the window.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

type Runova = {
  projects: { create(input: unknown): Promise<{ id: string }> };
  environments: {
    save(input: unknown): Promise<{ id: string; files: { id: string; fileName: string }[] }>;
    saveFile(input: unknown): Promise<{ id: string; files: { id: string; fileName: string }[] }>;
    list(projectId: string): Promise<{ id: string; files: { id: string; fileName: string }[] }[]>;
    readFile(environmentId: string, fileId: string): Promise<string>;
  };
  aiAccess: { configSnippet(): Promise<string> };
  settings: { update(patch: unknown): Promise<unknown> };
};

/** A project with a Staging environment holding one .env file. */
async function seed(current: LaunchedApp): Promise<{ projectId: string; environmentId: string }> {
  return current.page.evaluate(
    async ({ folderPath }) => {
      const api = (window as unknown as { runova: Runova }).runova;
      const project = await api.projects.create({
        name: 'Shop',
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude-code',
        notes: '',
        runCommands: [],
      });
      const environment = await api.environments.save({
        projectId: project.id,
        name: 'Staging',
        kind: 'staging',
      });
      await api.environments.saveFile({
        environmentId: environment.id,
        fileName: '.env',
        content: 'API_URL=https://old.test\n',
      });
      return { projectId: project.id, environmentId: environment.id };
    },
    { folderPath: current.projectDir },
  );
}

async function envContent(page: Page, projectId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const api = (window as unknown as { runova: Runova }).runova;
    const [environment] = await api.environments.list(id);
    const file = environment.files.find((one) => one.fileName === '.env');
    return file ? api.environments.readFile(environment.id, file.id) : '';
  }, projectId);
}

/** Turns AI access on through Settings, letting other apps in, as a user would. */
async function turnOn(page: Page): Promise<void> {
  await page.evaluate(() => {
    location.hash = '#/settings?tab=aiAccess';
  });
  const toggle = page.getByRole('switch', { name: 'Let AI agents use Runova' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page
    .getByRole('group', { name: 'Who can connect' })
    .getByRole('button', { name: /Runova and other apps/ })
    .click();
  await expect(page.getByText(/On for agents in Runova and in other apps/)).toBeVisible();
}

async function bridgeScript(page: Page): Promise<string> {
  const snippet = await page.evaluate(() =>
    (window as unknown as { runova: Runova }).runova.aiAccess.configSnippet(),
  );
  return (JSON.parse(snippet) as { mcpServers: { runova_app: { args: string[] } } }).mcpServers
    .runova_app.args[0];
}

/** Starts the bridge as an agent in another app would, and resolves with the reply to the call. */
function callTool(script: string, cwd: string, name: string, args: Record<string, unknown>) {
  return new Promise<{ text: string; isError: boolean }>((resolve, reject) => {
    const env = { ...process.env };
    // A test run started from a Runova tab must not pass as one.
    delete env.RUNOVA_SESSION_ID;
    delete env.RUNOVA_AI_ACCESS_KEY;
    const child = spawn(process.execPath, [script], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: number;
          result?: { content: { text: string }[]; isError: boolean };
        };
        if (message.id === 2 && message.result) {
          child.kill();
          resolve({ text: message.result.content[0].text, isError: message.result.isError });
        }
      }
    });
    child.on('error', reject);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  });
}

const NEW_CONTENT = 'API_URL=https://new.test\nDEBUG=true\n';

test('an agent asks to update an env file, and Allow in the window carries it out', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page } = current;
  const { projectId } = await seed(current);
  await turnOn(page);
  const script = await bridgeScript(page);

  const reply = callTool(script, current.projectDir, 'env_save_file', {
    environment: 'Staging',
    fileName: '.env',
    content: NEW_CONTENT,
  });

  const dialog = page.getByRole('dialog', { name: 'Update .env in Staging' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Claude Code')).toBeVisible();
  await expect(dialog.getByText('Shop')).toBeVisible();
  await expect(dialog.getByText('DEBUG=••••••')).toBeVisible();
  await expect(dialog.getByText('https://new.test')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Allow', exact: true }).click();

  expect(await reply).toEqual({
    text: expect.stringContaining('Saved .env in Staging'),
    isError: false,
  });
  expect(await envContent(page, projectId)).toBe(NEW_CONTENT);
});

test('Deny tells the agent no and leaves the file alone', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page } = current;
  const { projectId } = await seed(current);
  await turnOn(page);
  const script = await bridgeScript(page);

  const reply = callTool(script, current.projectDir, 'env_save_file', {
    environment: 'Staging',
    fileName: '.env',
    content: NEW_CONTENT,
  });
  const dialog = page.getByRole('dialog', { name: 'Update .env in Staging' });
  await dialog.getByRole('button', { name: 'Deny' }).click();

  expect(await reply).toEqual({ text: expect.stringContaining('declined'), isError: true });
  expect(await envContent(page, projectId)).toBe('API_URL=https://old.test\n');
});

test('full access carries it out without asking, and nothing works while access is off', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page } = current;
  const { projectId } = await seed(current);
  const script = await bridgeScript(page);

  const refused = await callTool(script, current.projectDir, 'env_list', {});
  expect(refused).toEqual({ text: expect.stringContaining('turned off'), isError: true });

  await turnOn(page);
  await page
    .getByRole('group', { name: 'What agents may do without asking' })
    .getByRole('button', { name: /Full access/ })
    .click();
  await expect(page.getByText(/without asking you, including env files/)).toBeVisible();

  const reply = await callTool(script, current.projectDir, 'env_save_file', {
    environment: 'Staging',
    fileName: '.env',
    content: NEW_CONTENT,
  });
  expect(reply.isError).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await envContent(page, projectId)).toBe(NEW_CONTENT);

  await expect(page.getByText('Save an env file').first()).toBeVisible();
});
