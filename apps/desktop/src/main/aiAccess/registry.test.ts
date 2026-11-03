import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolRegistry, defineTool } from './registry';

/** The tools as an MCP client sees them: a JSON Schema per tool and hints about what each does. */

const read = defineTool({
  name: 'projects_list',
  area: 'projects',
  title: 'List projects',
  description: 'Every project in Runova.',
  risk: 'read',
  input: z.object({ includeArchived: z.boolean().optional() }),
  preview: () => ({ title: 'List your projects' }),
  run: async () => ({ data: [] }),
});

const sensitive = defineTool({
  name: 'env_save_file',
  area: 'environments',
  title: 'Save an env file',
  description: 'Creates or replaces an env file.',
  risk: 'sensitive',
  input: z.object({ fileName: z.string().describe('Like .env.local'), content: z.string() }),
  preview: (args) => ({ title: `Save ${args.fileName}` }),
  run: async () => ({ text: 'Saved.' }),
});

describe('tool registry', () => {
  it('describes each tool with its schema and what it may do', () => {
    const registry = createToolRegistry([read, sensitive]);

    expect(registry.descriptors()).toEqual([
      {
        name: 'projects_list',
        title: 'List projects',
        description: 'Every project in Runova.',
        inputSchema: {
          type: 'object',
          properties: { includeArchived: { type: 'boolean' } },
          additionalProperties: false,
        },
        annotations: { title: 'List projects', readOnlyHint: true, destructiveHint: false },
      },
      expect.objectContaining({
        name: 'env_save_file',
        inputSchema: {
          type: 'object',
          properties: {
            fileName: { type: 'string', description: 'Like .env.local' },
            content: { type: 'string' },
          },
          required: ['fileName', 'content'],
          additionalProperties: false,
        },
        annotations: { title: 'Save an env file', readOnlyHint: false, destructiveHint: true },
      }),
    ]);
  });

  it('finds a tool by name and lists what Settings shows', () => {
    const registry = createToolRegistry([read, sensitive]);

    expect(registry.get('env_save_file')).toBe(sensitive);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.infos()).toEqual([
      {
        name: 'projects_list',
        area: 'projects',
        title: 'List projects',
        description: 'Every project in Runova.',
        risk: 'read',
      },
      {
        name: 'env_save_file',
        area: 'environments',
        title: 'Save an env file',
        description: 'Creates or replaces an env file.',
        risk: 'sensitive',
      },
    ]);
  });

  it('refuses two tools with one name', () => {
    expect(() => createToolRegistry([read, read])).toThrow(/projects_list/);
  });
});
