import { getCliDefinition } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { progressDecoderFor } from './progressFormat';

/**
 * The live log in "Update version in files" reads Claude Code's stream-json. The events below
 * have the shape a real `claude -p --output-format stream-json --verbose` run printed.
 */

const claude = getCliDefinition('claude-code');
const codex = getCliDefinition('codex-cli');
if (!claude || !codex) throw new Error('registry is missing a CLI these tests use');

const CWD = process.platform === 'win32' ? 'E:\\MyWebSite' : '/work/MyWebSite';
const inside = (file: string) => `${CWD.replace(/\\/g, '/')}/${file}`;

const assistant = (...content: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { content } });
const user = (...content: unknown[]) => JSON.stringify({ type: 'user', message: { content } });
const tool = (name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id: 'toolu_1',
  name,
  input,
});

function decoder() {
  const made = progressDecoderFor(claude as NonNullable<typeof claude>, CWD);
  if (!made) throw new Error('Claude Code should have a progress decoder');
  return made;
}

describe('Claude Code stream-json progress', () => {
  it('asks Claude Code for its steps as they happen', () => {
    expect(claude?.promptProgressArgs).toEqual(['--output-format', 'stream-json', '--verbose']);
  });

  it('turns each tool call into one short line, with paths inside the project made relative', () => {
    const d = decoder();
    expect(d.lines(assistant(tool('Read', { file_path: inside('package.json') })))).toEqual([
      '› Read package.json',
    ]);
    expect(
      d.lines(assistant(tool('Edit', { file_path: inside('apps/web/package.json') }))),
    ).toEqual(['› Edit apps/web/package.json']);
    expect(
      d.lines(assistant(tool('Grep', { pattern: '"version"', path: inside('apps') }))),
    ).toEqual(['› Grep "version" in apps']);
    expect(d.lines(assistant(tool('Glob', { pattern: '**/package.json' })))).toEqual([
      '› Glob **/package.json',
    ]);
    expect(d.lines(assistant(tool('TodoWrite', { todos: [] })))).toEqual(['› TodoWrite']);
  });

  it('keeps a path outside the project whole, so a stray edit stands out', () => {
    expect(
      decoder().lines(assistant(tool('Edit', { file_path: 'E:/CuraLink/package.json' }))),
    ).toEqual(['› Edit E:/CuraLink/package.json']);
  });

  it('shows the first line of a shell command, cut to fit', () => {
    const d = decoder();
    expect(d.lines(assistant(tool('Bash', { command: 'git status --short\necho done' })))).toEqual([
      '$ git status --short',
    ]);
    const [long] = d.lines(assistant(tool('Bash', { command: `echo ${'x'.repeat(400)}` })));
    expect(long?.length).toBeLessThanOrEqual(162);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('shows what the CLI says, line by line, and skips its thinking', () => {
    expect(
      decoder().lines(
        assistant(
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Found 3 manifests.\nUpdating them now.' },
        ),
      ),
    ).toEqual(['Found 3 manifests.', 'Updating them now.']);
  });

  it('shows failed steps and leaves successful results (whole files) out', () => {
    const d = decoder();
    expect(
      d.lines(user({ type: 'tool_result', content: '1\t{"version":"1.0.0"}', is_error: false })),
    ).toEqual([]);
    expect(
      d.lines(
        user({
          type: 'tool_result',
          is_error: true,
          content: [{ type: 'text', text: 'File is in a directory that is denied.\nmore' }],
        }),
      ),
    ).toEqual(['✗ File is in a directory that is denied.']);
  });

  it('takes the answer from the result event and shows nothing for it', () => {
    const d = decoder();
    expect(d.answer()).toBeNull();
    expect(d.lines(JSON.stringify({ type: 'system', subtype: 'init', cwd: CWD }))).toEqual([]);
    expect(
      d.lines(
        JSON.stringify({ type: 'result', subtype: 'success', result: 'package.json: 1 -> 2' }),
      ),
    ).toEqual([]);
    expect(d.answer()).toBe('package.json: 1 -> 2');
  });

  it('passes through a line that is not an event, such as a warning before the run starts', () => {
    expect(decoder().lines('Warning: this sign-in ends soon')).toEqual([
      'Warning: this sign-in ends soon',
    ]);
  });

  it('has no decoder for a CLI that prints its steps as plain text', () => {
    expect(progressDecoderFor(codex as NonNullable<typeof codex>, CWD)).toBeNull();
  });
});
