import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_ACCESS_AREAS } from '../../shared/aiAccessTypes';
import { allAiTools } from './tools';

/**
 * Rules every AI access tool follows, whichever area adds it. They keep the list an agent sees
 * readable, keep anything that removes, sends, reveals or runs behind the sensitive mark the user's
 * mode is built on, and keep tools away from the AI access settings, so an agent can never raise
 * its own permission.
 */

const tools = allAiTools();

/** A name with one of these words removes, sends, reveals or runs something. */
const SENSITIVE_WORDS =
  /(^|_)(remove|delete|push|discard|execute|send|query|reveal|restore|deploy|dispatch|run|kill|stop|install|uninstall|merge|rotate|import|export|write)(_|$)/;

describe('AI access tools', () => {
  it('has tools to check', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it('names each tool once, in snake case, starting with its area', () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/);
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(48);
    }
  });

  it('gives every tool a title, a description an agent can act on and a known area', () => {
    for (const tool of tools) {
      expect(tool.title.trim(), tool.name).not.toBe('');
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(AI_ACCESS_AREAS, tool.name).toContain(tool.area);
    }
  });

  it('marks anything that removes, sends, reveals or runs as sensitive', () => {
    const unmarked = tools
      .filter((tool) => SENSITIVE_WORDS.test(tool.name) && tool.risk !== 'sensitive')
      .map((tool) => tool.name);
    expect(unmarked).toEqual([]);
  });

  it('keeps every description free of the em dash', () => {
    for (const tool of tools) {
      expect(`${tool.title} ${tool.description}`, tool.name).not.toContain('—');
    }
  });

  it('never lets a tool touch the AI access settings', () => {
    const dir = join(__dirname, 'tools');
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf-8') }));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(
        /aiAccess(Enabled|Mode|Prompt|Clients|AttachToTabs)\s*:/,
      );
      expect(source.text, source.name).not.toMatch(/updateSettings|setSettings/);
    }
  });
});
