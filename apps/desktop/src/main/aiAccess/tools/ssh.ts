import { z } from 'zod';
import type { StoredSshServer } from '../../../shared/apiTypes';
import { resolveRemoteInput } from '../../sftp/remotePaths';
import type { SshConnection } from '../../ssh/connection';
import type { SshLease } from '../../ssh/pool';
import { getSshPool } from '../../ssh/sharedPool';
import { VaultLockedError } from '../../ssh/vaultErrors';
import { store } from '../../store';
import { defineTool } from '../registry';

/**
 * SSH tools: the servers saved in Runova's Remote section, one command run on a server, and a
 * folder listing over SFTP. Both go through the shared connection pool that Deploy and the file
 * manager use, so the saved login, the host key check and the vault lock behave the same. No
 * password, passphrase or key path ever goes back to the agent.
 */

const hostArg = z
  .string()
  .min(1)
  .describe('The saved server, by its name in Runova or its id. ssh_list_hosts lists them.');

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;

async function findServer(ref: string): Promise<StoredSshServer> {
  const servers = await store.getSshServers();
  const wanted = ref.trim().toLowerCase();
  const found =
    servers.find((one) => one.id === ref) ??
    servers.find((one) => one.nickname.trim().toLowerCase() === wanted) ??
    servers.find((one) => one.host.toLowerCase() === wanted);
  if (found) return found;
  const names = servers.map((one) => one.nickname).join(', ');
  throw new Error(
    names
      ? `No saved server named ${ref}. Runova has: ${names}.`
      : 'Runova has no saved SSH servers yet.',
  );
}

function addressOf(server: StoredSshServer): string {
  return `${server.username}@${server.host}:${server.port}`;
}

/** Logs in with the saved credentials, hands the connection to `work`, and gives it back. */
async function withConnection<T>(
  server: StoredSshServer,
  work: (connection: SshConnection) => Promise<T>,
): Promise<T> {
  let lease: SshLease;
  try {
    lease = await getSshPool().acquire(server.id);
  } catch (error) {
    // Also by name: the error can come from another copy of the module (tests reload them).
    if (
      error instanceof VaultLockedError ||
      (error instanceof Error && error.name === 'VaultLockedError')
    ) {
      throw new Error(
        `Unlock the vault in Runova first. The saved login for ${server.nickname} is locked.`,
      );
    }
    throw error;
  }
  try {
    return await work(lease.connection);
  } finally {
    lease.release();
  }
}

export const sshTools = [
  defineTool({
    name: 'ssh_list_hosts',
    area: 'ssh',
    title: 'List saved SSH servers',
    description:
      'The SSH servers saved in Runova, with their address, how they log in and when they were last used. No passwords or keys are included.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List the saved SSH servers' }),
    async run() {
      const servers = await store.getSshServers();
      return {
        data: servers.map((server) => ({
          id: server.id,
          name: server.nickname,
          address: addressOf(server),
          login: server.authMethod === 'password' ? 'password' : 'key file',
          hasSavedSecret: server.secretEnvelope != null,
          hostKeyKnown: Boolean(server.hostKeyFingerprint),
          lastConnectedAt: server.lastConnectedAt
            ? new Date(server.lastConnectedAt).toISOString()
            : null,
        })),
      };
    },
  }),

  defineTool({
    name: 'ssh_run_command',
    area: 'ssh',
    title: 'Run a command on a server',
    description:
      "Runs one shell command on a saved server with its saved login, and returns the output and exit code. Nothing is typed into the user's terminals. There is no terminal, so commands that ask for input (like sudo with a password) fail. Times out after 60 seconds unless timeoutSeconds says otherwise.",
    risk: 'sensitive',
    input: z.object({
      host: hostArg,
      command: z.string().min(1).max(10_000),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    }),
    async preview(args) {
      const server = await findServer(args.host);
      return {
        title: `Run a command on ${server.nickname}`,
        fields: [
          { label: 'Server', value: addressOf(server), mono: true },
          { label: 'Command', value: args.command, mono: true },
        ],
      };
    },
    async run(args) {
      const server = await findServer(args.host);
      const timeoutMs = (args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      const result = await withConnection(server, (connection) =>
        connection.exec(args.command, { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES }),
      );
      return {
        data: {
          server: server.nickname,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    },
  }),

  defineTool({
    name: 'ssh_list_folder',
    area: 'ssh',
    title: 'List a folder on a server',
    description:
      'Lists a folder on a saved server over SFTP: names, folder or file, size and modified time. The path can be absolute, start with ~, or be left out for the home folder.',
    risk: 'read',
    input: z.object({
      host: hostArg,
      path: z
        .string()
        .max(4096)
        .optional()
        .describe('The folder, like /var/www or ~/logs. The home folder when left out.'),
    }),
    async preview(args) {
      const server = await findServer(args.host);
      return { title: `List ${args.path ?? 'the home folder'} on ${server.nickname}` };
    },
    async run(args) {
      const server = await findServer(args.host);
      return withConnection(server, async (connection) => {
        const home = await connection.sftpRealpath('.');
        const path = resolveRemoteInput(args.path?.trim() || '~', home, home);
        const entries = await connection.sftpList(path);
        const sorted = [...entries].sort(
          (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
        );
        const shown = sorted.slice(0, MAX_ENTRIES);
        return {
          data: {
            path,
            entries: shown.map((entry) => ({
              name: entry.name,
              type: entry.isDirectory ? 'folder' : entry.isFile ? 'file' : 'other',
              size: entry.size,
              modifiedAt: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : null,
            })),
            ...(sorted.length > shown.length
              ? { note: `Showing the first ${MAX_ENTRIES} of ${sorted.length} entries.` }
              : {}),
          },
        };
      });
    },
  }),
];
