import { describe, expect, it, vi } from 'vitest';

// Resolving PATH asks Python and others for their script folders, which a test has no use for.
vi.mock('../toolPaths', () => ({
  withToolPath: async (env?: NodeJS.ProcessEnv) => env ?? process.env,
  getExtraToolPathDirs: async () => [],
}));

import { tempDir } from '../../test/main/fixtures';
import { createToolRunner, findTools } from './tools';

function runner() {
  return createToolRunner({ home: tempDir(), baseEnv: process.env });
}

const node = (script: string): string[] => ['-e', script];

describe('createToolRunner.query', () => {
  it('returns what a tool printed', async () => {
    const output = await runner().query('node', node("console.log('/some/where')"));
    expect(output?.trim()).toBe('/some/where');
  });

  it('returns nothing when the tool fails', async () => {
    expect(await runner().query('node', node('process.exit(2)'))).toBeNull();
  });

  it('returns nothing when the tool is not there', async () => {
    expect(await runner().query('definitely-not-a-real-tool-xyz', [])).toBeNull();
  });

  it('keeps .NET from greeting the person or phoning home when it is asked a question', async () => {
    const output = await runner().query(
      'node',
      node('console.log(process.env.DOTNET_NOLOGO + process.env.DOTNET_CLI_TELEMETRY_OPTOUT)'),
    );
    expect(output?.trim()).toBe('11');
  });

  it('stops waiting for a tool that never answers', async () => {
    const slow = createToolRunner({ home: tempDir(), baseEnv: process.env, queryTimeoutMs: 300 });
    const started = Date.now();
    expect(await slow.query('node', node('setTimeout(() => {}, 30000)'))).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('createToolRunner.runCommand', () => {
  const action = (args: string[]) => ({ label: 'node', command: 'node', args });

  it('runs a command and hands over each line it prints, leaving out blank ones', async () => {
    const lines: string[] = [];
    const outcome = await runner().runCommand(
      action(node("console.log('one'); console.log(''); console.log('two')")),
      (line) => lines.push(line),
      undefined,
    );
    expect(outcome).toEqual({ code: 0, cancelled: false, notFound: false, timedOut: false });
    expect(lines).toEqual(['one', 'two']);
  });

  it('reports the exit code of a command that fails', async () => {
    const outcome = await runner().runCommand(
      action(node('process.exit(3)')),
      () => undefined,
      undefined,
    );
    expect(outcome.code).toBe(3);
  });

  it('reports a tool that is not installed', async () => {
    const outcome = await runner().runCommand(
      { label: 'x', command: 'definitely-not-a-real-tool-xyz', args: [] },
      () => undefined,
      undefined,
    );
    expect(outcome.notFound).toBe(true);
  });

  it('stops the command when told to', async () => {
    const controller = new AbortController();
    const running = runner().runCommand(
      action(node('setTimeout(() => {}, 30000)')),
      () => undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 300);
    const outcome = await running;
    expect(outcome.cancelled).toBe(true);
  });

  it('does not start a command when it was already told to stop', async () => {
    const controller = new AbortController();
    controller.abort();
    const lines: string[] = [];
    const outcome = await runner().runCommand(
      action(node("console.log('should not run')")),
      (line) => lines.push(line),
      controller.signal,
    );
    expect(outcome.cancelled).toBe(true);
    expect(lines).toEqual([]);
  });
});

describe('findTools', () => {
  it('names the commands that are installed, without running any of them', async () => {
    const found = await findTools(['node', 'definitely-not-a-real-tool-xyz']);
    expect(found.has('node')).toBe(true);
    expect(found.has('definitely-not-a-real-tool-xyz')).toBe(false);
  });

  it('asks about each command once', async () => {
    const found = await findTools(['node', 'node']);
    expect([...found]).toEqual(['node']);
  });
});
