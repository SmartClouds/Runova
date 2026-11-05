import type { PromptTemplate } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { promptTemplatesAdapter } from './promptTemplates';

const template: PromptTemplate = {
  id: 't1',
  name: 'Bug report',
  promptType: 'bugfix',
  targetAI: 'claude',
  content: 'Fix the bug in {file}',
  createdAt: '2026-11-01T00:00:00.000Z',
};

function memoryStore(initial: PromptTemplate[] = []) {
  let templates = structuredClone(initial);
  return {
    getTemplates: async () => structuredClone(templates),
    setTemplates: async (next: PromptTemplate[]) => {
      templates = structuredClone(next);
    },
    get: () => templates,
  };
}

describe('promptTemplatesAdapter', () => {
  it('syncs a template as it is stored', async () => {
    const [item] = await promptTemplatesAdapter(memoryStore([template])).list();

    expect(item).toEqual({ id: 't1', teamId: null, value: template });
  });

  it('adds, updates and removes templates', async () => {
    const store = memoryStore();
    const adapter = promptTemplatesAdapter(store);

    await adapter.apply({ id: 't1', teamId: null, value: { ...template } });
    await adapter.apply({ id: 't1', teamId: null, value: { ...template, name: 'Bugs' } });
    expect(store.get()).toEqual([{ ...template, name: 'Bugs' }]);

    await adapter.remove('t1');
    expect(store.get()).toEqual([]);
  });
});
