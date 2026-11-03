import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectExternalClient, disconnectExternalClient, externalClientStatus } from './external';

/**
 * Connecting CLIs the user runs outside Runova. Runova adds itself to the CLI's own MCP list with
 * the CLI's own command, so the CLI keeps owning its config file, and reads that file to show
 * whether it is connected.
 */

let home: string;
const SCRIPT = 'C:/Users/me/AppData/Roaming/Runova/ai-access/runova-app-mcp.cjs';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ai-access-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const deps = (over: Partial<Parameters<typeof externalClientStatus>[0]> = {}) => ({
  home,
  script: SCRIPT,
  installed: vi.fn(async () => true),
  run: vi.fn(async () => ({ ok: true, output: '' })),
  ...over,
});

describe('external clients', () => {
  it('reads whether Claude Code and Codex already list Runova', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { runova_app: { command: 'node' } } }),
    );
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.other]\ncommand = "x"\n');

    expect(await externalClientStatus(deps())).toEqual([
      { id: 'claude', label: 'Claude Code', installed: true, connected: true },
      { id: 'codex', label: 'Codex', installed: true, connected: false },
    ]);
  });

  it('treats a missing or broken config as not connected', async () => {
    writeFileSync(join(home, '.claude.json'), '{ not json');
    const status = await externalClientStatus(deps({ installed: vi.fn(async () => false) }));
    expect(status.map((one) => [one.connected, one.installed])).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  it('adds Runova with each CLI own command, for every project of the user', async () => {
    const run = vi.fn(async () => ({ ok: true, output: '' }));

    expect(await connectExternalClient('claude', deps({ run }))).toEqual({ ok: true });
    expect(run).toHaveBeenLastCalledWith('claude', [
      'mcp',
      'add',
      '--scope',
      'user',
      'runova_app',
      '--',
      'node',
      SCRIPT,
    ]);

    await connectExternalClient('codex', deps({ run }));
    expect(run).toHaveBeenLastCalledWith('codex', [
      'mcp',
      'add',
      'runova_app',
      '--',
      'node',
      SCRIPT,
    ]);
  });

  it('removes Runova again, and passes on what the CLI said when it fails', async () => {
    const run = vi.fn(async () => ({ ok: false, output: 'claude: command not found' }));

    expect(await disconnectExternalClient('claude', deps({ run }))).toEqual({
      ok: false,
      error: 'claude: command not found',
    });
    expect(run).toHaveBeenLastCalledWith('claude', [
      'mcp',
      'remove',
      '--scope',
      'user',
      'runova_app',
    ]);
  });
});
