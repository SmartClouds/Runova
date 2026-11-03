import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiExternalClientId, AiExternalClientStatus } from '../../shared/aiAccessTypes';
import { withToolPath } from '../toolPaths';
import { AI_ACCESS_MCP_SERVER } from './bridgeScript';

/**
 * Connecting CLIs the user runs outside Runova (Settings > AI access > Connect other apps).
 * Runova adds itself with the CLI's own `mcp add` command, so the CLI keeps owning its config file,
 * and only reads that file to show whether it is connected.
 */

export interface ExternalDeps {
  home: string;
  /** The bridge script the CLI should start. */
  script: string;
  installed(command: string): Promise<boolean>;
  run(command: string, args: string[]): Promise<{ ok: boolean; output: string }>;
}

interface ClientSpec {
  id: AiExternalClientId;
  label: string;
  command: string;
  add(script: string): string[];
  remove: string[];
  connected(home: string): Promise<boolean>;
}

const CLIENTS: ClientSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    add: (script) => ['mcp', 'add', '--scope', 'user', AI_ACCESS_MCP_SERVER, '--', 'node', script],
    remove: ['mcp', 'remove', '--scope', 'user', AI_ACCESS_MCP_SERVER],
    async connected(home) {
      const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      return Boolean(config.mcpServers?.[AI_ACCESS_MCP_SERVER]);
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    add: (script) => ['mcp', 'add', AI_ACCESS_MCP_SERVER, '--', 'node', script],
    remove: ['mcp', 'remove', AI_ACCESS_MCP_SERVER],
    async connected(home) {
      const toml = await readFile(join(home, '.codex', 'config.toml'), 'utf-8');
      return new RegExp(`^\\[mcp_servers\\.["']?${AI_ACCESS_MCP_SERVER}["']?\\]`, 'm').test(toml);
    },
  },
];

export async function externalClientStatus(deps: ExternalDeps): Promise<AiExternalClientStatus[]> {
  return Promise.all(
    CLIENTS.map(async (client) => ({
      id: client.id,
      label: client.label,
      installed: await deps.installed(client.command).catch(() => false),
      connected: await client.connected(deps.home).catch(() => false),
    })),
  );
}

type Outcome = { ok: true } | { ok: false; error: string };

async function runFor(
  id: AiExternalClientId,
  deps: ExternalDeps,
  args: (client: ClientSpec) => string[],
): Promise<Outcome> {
  const client = CLIENTS.find((one) => one.id === id);
  if (!client) return { ok: false, error: `Runova cannot connect ${id}.` };
  const result = await deps.run(client.command, args(client));
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.output.trim() || 'The command failed.' };
}

export function connectExternalClient(
  id: AiExternalClientId,
  deps: ExternalDeps,
): Promise<Outcome> {
  return runFor(id, deps, (client) => client.add(deps.script));
}

export function disconnectExternalClient(
  id: AiExternalClientId,
  deps: ExternalDeps,
): Promise<Outcome> {
  return runFor(id, deps, (client) => client.remove);
}

/** Quotes an argument for cmd.exe, which runs the CLIs' .cmd shims on Windows. */
function quoteForCmd(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '""')}"`;
}

function runCommand(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return withToolPath().then(
    (env) =>
      new Promise((resolve) => {
        const windows = process.platform === 'win32';
        execFile(
          command,
          windows ? args.map(quoteForCmd) : args,
          { env, shell: windows, timeout: 30_000, windowsHide: true },
          (error, stdout, stderr) =>
            resolve({
              ok: !error,
              output: `${stderr || ''}${stdout || ''}` || (error?.message ?? ''),
            }),
        );
      }),
  );
}

/** The real machine: the user's home folder and their CLIs on the tool PATH. */
export function machineExternalDeps(script: string): ExternalDeps {
  return {
    home: homedir(),
    script,
    installed: async (command) => (await runCommand(command, ['--version'])).ok,
    run: runCommand,
  };
}
