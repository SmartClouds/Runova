import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relayCapabilities } from '@runova/core';
import { app } from 'electron';
import type { AiAccessSettings } from '../../shared/aiAccessSettings';
import { portFilePath } from '../notifications/hookServer';
import {
  AI_ACCESS_MCP_SCRIPT,
  AI_ACCESS_MCP_SERVER,
  aiAccessBridgeScriptSource,
} from './bridgeScript';

/**
 * The AI access server is handed to an agent tab's CLI on its command line, never written into the
 * project: one shared script and config in the app's data folder serve every tab, since the script
 * learns its tab from the environment the tab gave it. Other apps get the same script.
 */

function aiAccessDir(): string {
  return join(app.getPath('userData'), 'ai-access');
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== content) await writeFile(path, content, 'utf8');
}

export interface AiAccessMcpFiles {
  script: string;
  /** `--mcp-config` for Claude Code. */
  claudeConfig: string;
  /** `--additional-mcp-config @file` for Copilot, which wants a type and a tool list. */
  copilotConfig: string;
}

let prepared: Promise<AiAccessMcpFiles | null> | null = null;

export function aiAccessMcpFiles(): Promise<AiAccessMcpFiles | null> {
  prepared ??= (async () => {
    const dir = aiAccessDir();
    await mkdir(dir, { recursive: true });
    const script = join(dir, AI_ACCESS_MCP_SCRIPT);
    const claudeConfig = join(dir, 'mcp.json');
    const copilotConfig = join(dir, 'copilot-mcp.json');
    await writeIfChanged(script, aiAccessBridgeScriptSource({ portFile: portFilePath() }));
    const server = { command: 'node', args: [script] };
    await writeIfChanged(
      claudeConfig,
      `${JSON.stringify({ mcpServers: { [AI_ACCESS_MCP_SERVER]: server } }, null, 2)}\n`,
    );
    await writeIfChanged(
      copilotConfig,
      `${JSON.stringify({ mcpServers: { [AI_ACCESS_MCP_SERVER]: { type: 'local', ...server, tools: ['*'] } } }, null, 2)}\n`,
    );
    return { script, claudeConfig, copilotConfig };
  })().catch(() => {
    prepared = null;
    return null;
  });
  return prepared;
}

/**
 * The flags that give an agent tab's CLI the AI access server, or none when the settings say not
 * to or the CLI cannot take one on its command line. Claude Code is also told to allow the tools
 * without its own prompt, since Runova asks by the user's settings and asking twice would only
 * annoy. Paths use forward slashes and Codex values are TOML literal strings, for the same reasons
 * as the Relay server's flags (see relay/mcp/config.ts).
 */
export async function aiAccessLaunchArgs(
  cliId: string,
  settings: AiAccessSettings,
): Promise<string[]> {
  if (!settings.enabled || !settings.attachToTabs || settings.clients === 'external') return [];
  const kind = relayCapabilities(cliId).mcp;
  if (!kind) return [];
  const files = await aiAccessMcpFiles();
  if (!files) return [];
  const slash = (path: string) => path.replaceAll('\\', '/');
  switch (kind) {
    case 'claude':
      return [
        '--mcp-config',
        slash(files.claudeConfig),
        '--allowedTools',
        `mcp__${AI_ACCESS_MCP_SERVER}__*`,
      ];
    case 'codex':
      return [
        '-c',
        `mcp_servers.${AI_ACCESS_MCP_SERVER}.command='node'`,
        '-c',
        `mcp_servers.${AI_ACCESS_MCP_SERVER}.args=['${slash(files.script)}']`,
      ];
    case 'copilot':
      return ['--additional-mcp-config', `@${slash(files.copilotConfig)}`];
  }
}

/** The config block another app (an IDE, a desktop client) can paste into its MCP settings. */
export async function aiAccessConfigSnippet(): Promise<string> {
  const files = await aiAccessMcpFiles();
  const script = files?.script ?? join(aiAccessDir(), AI_ACCESS_MCP_SCRIPT);
  return JSON.stringify(
    { mcpServers: { [AI_ACCESS_MCP_SERVER]: { command: 'node', args: [script] } } },
    null,
    2,
  );
}
