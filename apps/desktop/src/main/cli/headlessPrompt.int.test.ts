import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';

/**
 * Real cmd.exe, no child_process mock. Background AI runs start the CLI by its bare name with the
 * project folder as cwd, and cmd.exe normally looks in the current directory before PATH, so a
 * repository that commits claude.cmd would run instead of the real CLI.
 */

// Counts the CLI as installed without probing the real one.
vi.mock('../installMethod', () => ({
  resolveExecutable: vi.fn(async (names: string[]) => `C:\\tools\\${names[0]}.exe`),
}));
vi.mock('../toolPaths', () => ({
  withToolPath: vi.fn(async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) })),
}));
vi.mock('../store', () => ({
  store: {
    getSettings: async () => ({ defaultCliId: 'claude-code', cliArgs: {}, cliLaunchDefaults: {} }),
  },
}));

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['PATH', 'Path', 'NoDefaultCurrentDirectoryInExePath', 'CLAUDE_CONFIG_DIR']) {
    saved[key] = process.env[key];
  }
  // Only System32 on PATH, so the real Claude Code (if installed) can never answer, and a parent
  // that already sets the variable can not hide the bug.
  delete process.env.Path;
  process.env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  process.env.CLAUDE_CONFIG_DIR = tempDir('runova-headless-claude-');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.runIf(process.platform === 'win32')('headless runs against a real cmd.exe', () => {
  function plantedRepo(): { repo: string; marker: string } {
    const repo = tempDir('runova-headless-shadow-');
    const marker = join(tempDir('runova-headless-marker-'), 'planted.txt');
    writeFileSync(join(repo, 'claude.cmd'), `@echo PLANTED> "${marker}"\r\n`);
    return { repo, marker };
  }

  it('never runs a claude.cmd the project folder ships (buffered run)', async () => {
    const { repo, marker } = plantedRepo();
    const { runHeadlessCliPrompt } = await import('./headlessPrompt');
    await runHeadlessCliPrompt('hello', repo, { preferredCliId: 'claude-code', strictCli: true });
    expect(existsSync(marker)).toBe(false);
  });

  it('never runs a claude.cmd the project folder ships (streamed run)', async () => {
    const { repo, marker } = plantedRepo();
    const { streamHeadlessCliPrompt } = await import('./headlessStream');
    await streamHeadlessCliPrompt('hello', repo, {
      preferredCliId: 'claude-code',
      strictCli: true,
      signal: new AbortController().signal,
      onLine: () => undefined,
      timeoutMs: 30000,
    });
    expect(existsSync(marker)).toBe(false);
  });

  /**
   * A CLI that takes the prompt as its last argument (Cursor here), installed as an npm .cmd shim
   * on PATH. The prompt holds text from a repository or a pull request, so quotes and cmd's own
   * separators in it must reach the CLI as text and never run as commands.
   */
  function argModeCli(): { repo: string; marker: string; seen: string } {
    const repo = tempDir('runova-headless-quote-');
    const tools = tempDir('runova-headless-tools-');
    const seen = join(tools, 'seen.json');
    // The shape of an npm shim: node runs the CLI's script with %*. This one notes its arguments.
    const script = join(tools, 'cli.cjs');
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));`,
    );
    writeFileSync(join(tools, 'cursor-agent.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    process.env.PATH = `${process.env.PATH};${tools}`;
    return { repo, marker: join(tools, 'pwned.txt'), seen };
  }

  // Quotes around and after cmd's separators, a backslash before a quote and one at the end.
  const injected = (marker: string) =>
    `Summarize "this" commit " & echo PWNED> ${marker} & rem " | more, say C:\\dir\\" and end in C:\\`;

  /** The prompt as the CLI read it: its last argument. */
  const promptSeen = (seen: string) => (JSON.parse(readFileSync(seen, 'utf8')) as string[]).at(-1);

  it('passes quotes and & in a prompt through as text (buffered run)', async () => {
    const { repo, marker, seen } = argModeCli();
    const { runHeadlessCliPrompt } = await import('./headlessPrompt');
    await runHeadlessCliPrompt(injected(marker), repo, {
      preferredCliId: 'cursor-cli',
      strictCli: true,
    });
    expect(existsSync(marker)).toBe(false);
    expect(promptSeen(seen)).toBe(injected(marker));
  });

  it('runs nothing from a later line of the prompt', async () => {
    const { repo, marker, seen } = argModeCli();
    const { runHeadlessCliPrompt } = await import('./headlessPrompt');
    const prompt = `First line\r\nsecond " & echo PWNED> ${marker} & rem "\nthird line`;
    await runHeadlessCliPrompt(prompt, repo, { preferredCliId: 'cursor-cli', strictCli: true });
    expect(existsSync(marker)).toBe(false);
    // cmd.exe ends its /c line at the first line break, so only that much reaches the CLI.
    expect(promptSeen(seen)).toBe('First line');
  });

  it('passes quotes and & in a prompt through as text (streamed run)', async () => {
    const { repo, marker, seen } = argModeCli();
    const { streamHeadlessCliPrompt } = await import('./headlessStream');
    await streamHeadlessCliPrompt(injected(marker), repo, {
      preferredCliId: 'cursor-cli',
      strictCli: true,
      signal: new AbortController().signal,
      onLine: () => undefined,
      timeoutMs: 30000,
    });
    expect(existsSync(marker)).toBe(false);
    expect(promptSeen(seen)).toBe(injected(marker));
  });
});
