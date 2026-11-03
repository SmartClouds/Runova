import { readFileSync } from 'node:fs';
import type { PromptTemplate } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

/**
 * Prompt tools: the Prompt Builder's saved templates, the project's blueprint steps and the prompt
 * history, over the real JSON stores and SQLite stand-in in a temp userData folder.
 */

const userData = useTempUserData();
const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let tools: Map<string, AiTool>;

const template = (overrides: Partial<PromptTemplate>): PromptTemplate => ({
  id: 't1',
  name: 'Code review',
  promptType: 'Review',
  targetAI: 'Claude Code',
  content: 'Review this diff for bugs.',
  createdAt: '2026-10-01T00:00:00Z',
  ...overrides,
});

beforeEach(async () => {
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: userData.dir, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  userData.writeData('templates.json', [
    template({}),
    template({ id: 't2', name: 'Bug report', content: 'Write a bug report.' }),
  ]);
  const { promptTools } = await import('./prompts');
  tools = new Map(promptTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), context);
}

function templatesOnDisk(): PromptTemplate[] {
  return JSON.parse(readFileSync(userData.dataFile('templates.json'), 'utf-8'));
}

describe('prompt templates', () => {
  it('lists the saved templates with their text', async () => {
    expect((await run('prompts_list')).data).toEqual([
      expect.objectContaining({
        id: 't1',
        name: 'Code review',
        content: 'Review this diff for bugs.',
      }),
      expect.objectContaining({ id: 't2', name: 'Bug report' }),
    ]);
  });

  it('saves a new template at the top of the list, showing its text first', async () => {
    const args = { name: 'Refactor', content: 'Refactor this file.', targetAI: 'Codex' };
    const shown = await preview('prompts_save', args);
    expect(shown.title).toBe('Save the prompt template Refactor');
    expect(shown.diff).toEqual({ fileName: 'Refactor', before: '', after: 'Refactor this file.' });

    await run('prompts_save', args);
    expect(templatesOnDisk()[0]).toMatchObject({
      name: 'Refactor',
      promptType: 'Full Stack',
      targetAI: 'Codex',
      content: 'Refactor this file.',
    });
    expect(templatesOnDisk()).toHaveLength(3);
  });

  it('removes a template by name or id and leaves the rest', async () => {
    expect((await preview('prompts_remove', { template: 'bug REPORT' })).title).toBe(
      'Remove the prompt template Bug report',
    );
    await run('prompts_remove', { template: 'bug REPORT' });
    await run('prompts_remove', { template: 't1' });
    expect(templatesOnDisk()).toEqual([]);
    await expect(run('prompts_remove', { template: 'Nope' })).rejects.toThrow(
      'No prompt template named Nope',
    );
  });
});

describe('the blueprint', () => {
  it('reads every step, empty ones included, without creating a record', async () => {
    const data = (await run('prompts_blueprint')).data as {
      steps: { step: string; text: string }[];
      finalPrompt: string;
    };
    expect(data.steps.map((one) => one.step)).toEqual([
      'idea',
      'architecture',
      'backend',
      'frontend',
      'cicd',
      'quality',
    ]);
    expect(data.finalPrompt).toBe('');
    expect(() => readFileSync(userData.dataFile('blueprints.json'), 'utf-8')).toThrow();
  });

  it('rewrites one step through the same path as the Blueprint tab, with a diff first', async () => {
    await run('prompts_blueprint_update', { step: 'backend', text: 'Node with Postgres.' });
    const shown = await preview('prompts_blueprint_update', {
      step: 'backend',
      text: 'Node with Postgres and Redis.',
    });
    expect(shown.diff).toEqual({
      fileName: 'Blueprint: Backend',
      before: 'Node with Postgres.',
      after: 'Node with Postgres and Redis.',
    });

    await run('prompts_blueprint_update', {
      step: 'backend',
      text: 'Node with Postgres and Redis.',
    });
    const data = (await run('prompts_blueprint')).data as {
      steps: { step: string; text: string }[];
    };
    expect(data.steps.find((one) => one.step === 'backend')?.text).toBe(
      'Node with Postgres and Redis.',
    );
    const { blueprintRevisionDb } = await import('../../blueprintRevisionDb');
    expect(blueprintRevisionDb.list('p1', 'backend')).toHaveLength(2);
  });
});

describe('prompt history', () => {
  it('lists recent prompts, newest first, and finds one by a word in it', async () => {
    const { promptHistoryDb } = await import('../../promptHistoryDb');
    const base = { promptType: 'Feature', targetAI: 'Claude Code', source: 'generate' as const };
    promptHistoryDb.add({ ...base, rawInput: 'login form', content: 'Build a login form.' });
    promptHistoryDb.add({
      ...base,
      rawInput: 'checkout',
      content: 'Build the checkout.',
      projectId: 'p1',
    });

    const all = (await run('prompts_history')).data as { request: string }[];
    expect(all.map((one) => one.request)).toEqual(['checkout', 'login form']);

    const found = (await run('prompts_history', { search: 'login' })).data as { request: string }[];
    expect(found.map((one) => one.request)).toEqual(['login form']);

    const mine = (await run('prompts_history', { onlyThisProject: true })).data as unknown[];
    expect(mine).toHaveLength(1);
  });
});
