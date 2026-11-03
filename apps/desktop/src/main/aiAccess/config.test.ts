import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AiAccessSettings } from '../../shared/aiAccessSettings';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * How an agent tab Runova opens gets the AI access server: on the CLI's command line, from one
 * shared script and config in the app's data folder. Only while access is on, attaching is on and
 * Runova's own tabs may connect.
 */

useTempUserData();

const on: AiAccessSettings = {
  enabled: true,
  mode: 'sensitive',
  prompt: 'modal',
  clients: 'both',
  attachToTabs: true,
};

describe('aiAccessLaunchArgs', () => {
  it('hands Claude Code the config and lets Runova, not Claude, decide what needs asking', async () => {
    const { aiAccessLaunchArgs } = await import('./config');
    const args = await aiAccessLaunchArgs('claude-code', on);

    expect(args[0]).toBe('--mcp-config');
    expect(args[1]).toMatch(/ai-access\/mcp\.json$/);
    expect(args[1]).not.toContain('\\');
    expect(args.slice(2)).toEqual(['--allowedTools', 'mcp__runova_app__*']);
    const config = JSON.parse(readFileSync(args[1], 'utf-8'));
    expect(config.mcpServers.runova_app.command).toBe('node');
    expect(readFileSync(config.mcpServers.runova_app.args[0], 'utf-8')).toContain(
      'RUNOVA_AI_ACCESS_KEY',
    );
  });

  it('gives Codex TOML overrides and Copilot an extra config file', async () => {
    const { aiAccessLaunchArgs } = await import('./config');

    const codex = await aiAccessLaunchArgs('codex-cli', on);
    expect(codex[1]).toBe("mcp_servers.runova_app.command='node'");
    expect(codex[3]).toMatch(/^mcp_servers\.runova_app\.args=\['.*runova-app-mcp\.cjs'\]$/);
    expect(codex.join(' ')).not.toContain('"');

    const copilot = await aiAccessLaunchArgs('copilot-cli', on);
    expect(copilot[0]).toBe('--additional-mcp-config');
    const file = JSON.parse(readFileSync(copilot[1].slice(1), 'utf-8'));
    expect(file.mcpServers.runova_app).toMatchObject({ type: 'local', tools: ['*'] });
  });

  it('attaches nothing while access is off, attaching is off, or only other apps may connect', async () => {
    const { aiAccessLaunchArgs } = await import('./config');

    expect(await aiAccessLaunchArgs('claude-code', { ...on, enabled: false })).toEqual([]);
    expect(await aiAccessLaunchArgs('claude-code', { ...on, attachToTabs: false })).toEqual([]);
    expect(await aiAccessLaunchArgs('claude-code', { ...on, clients: 'external' })).toEqual([]);
    expect(await aiAccessLaunchArgs('claude-code', { ...on, clients: 'runova' })).not.toEqual([]);
    expect(await aiAccessLaunchArgs('gemini-cli', on)).toEqual([]);
  });
});

describe('aiAccessConfigSnippet', () => {
  it('is a standard mcpServers block another app can paste', async () => {
    const { aiAccessConfigSnippet } = await import('./config');
    const snippet = JSON.parse(await aiAccessConfigSnippet());

    expect(snippet).toEqual({
      mcpServers: {
        runova_app: { command: 'node', args: [expect.stringMatching(/runova-app-mcp\.cjs$/)] },
      },
    });
  });
});
