import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dockerAvailable,
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  startSshServer,
} from '../../../e2e/sshServer';
import { probeHostKey } from '../ssh/connectConfig';
import { SshConnection } from '../ssh/connection';
import { SshConnectionPool } from '../ssh/pool';
import { listRemoteAgentHistory, PROBE_COMMAND, parseRemoteProbe } from './remoteSessionHistory';
import { clearHistoryCaches } from './sessionHistory';

/**
 * A saved server's AI history against a real OpenSSH server in Docker: the probe through a real
 * login shell, and transcripts read over real SFTP. Skipped without Docker.
 */

const docker = dockerAvailable();
const HOME = `/home/${SSH_USER}`;
let server: SshTestServer | null = null;
let seeder: SshConnection | null = null;

const jsonl = (...records: unknown[]): string =>
  `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

function claudeTranscript(cwd: string, prompt: string): string {
  return jsonl(
    {
      type: 'user',
      cwd,
      timestamp: '2026-09-01T10:00:00.000Z',
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      cwd,
      timestamp: '2026-09-01T10:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    },
  );
}

function codexRollout(id: string, cwd: string, prompt: string): string {
  return jsonl(
    { type: 'session_meta', payload: { id, cwd, timestamp: '2026-09-01T10:00:00.000Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
  );
}

async function open(): Promise<SshConnection> {
  if (!server) throw new Error('no server');
  return SshConnection.open({
    host: server.host,
    port: server.port,
    storedFingerprint: await probeHostKey(server.host, server.port),
    username: SSH_USER,
    authMethod: 'password',
    password: SSH_PASSWORD,
  });
}

/** Writes `content` to `path` on the server with the given mtime, making folders on the way. */
async function seed(path: string, content: string, mtime: string): Promise<void> {
  if (!seeder) throw new Error('no connection');
  const result = await seeder.exec(
    `mkdir -p "$(dirname "${path}")" && cat > "${path}" && touch -d "${mtime}" "${path}"`,
    { stdin: content },
  );
  if (result.exitCode !== 0) throw new Error(`seeding ${path} failed: ${result.stderr}`);
}

async function run(command: string): Promise<void> {
  if (!seeder) throw new Error('no connection');
  const result = await seeder.exec(command);
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr}`);
}

beforeAll(async () => {
  if (!docker) return;
  server = await startSshServer();
  seeder = await open();
  await seed(
    `${HOME}/.claude/projects/-srv-app/0b6e3a52-1111-4c2e-9d55-6a7f1b2c3d4e.jsonl`,
    claudeTranscript('/srv/app', 'Why does the deploy fail?'),
    '2026-09-01 10:00:00',
  );
  await seed(
    `${HOME}/.claude/projects/-home-${SSH_USER}-api/7c1d2e3f-2222-4a5b-8c9d-0e1f2a3b4c5d.jsonl`,
    claudeTranscript(`${HOME}/api`, 'Add a health route'),
    '2026-09-01 09:00:00',
  );
  // A transcript kept elsewhere and linked into the projects folder still counts.
  await seed(
    '/tmp/elsewhere/5e6f7a8b-3333-4c4d-9e0f-1a2b3c4d5e6f.jsonl',
    claudeTranscript('/srv/app', 'Linked conversation'),
    '2026-09-01 08:00:00',
  );
  await run(
    `ln -s /tmp/elsewhere/5e6f7a8b-3333-4c4d-9e0f-1a2b3c4d5e6f.jsonl ` +
      `${HOME}/.claude/projects/-srv-app/5e6f7a8b-3333-4c4d-9e0f-1a2b3c4d5e6f.jsonl`,
  );
  await seed(
    `${HOME}/.codex/sessions/2026/09/01/rollout-2026-09-01T09-30-00-cx-0001.jsonl`,
    codexRollout('cx-0001', '/srv/app', 'Tune the nginx config'),
    '2026-09-01 09:30:00',
  );
  // Claude where Ubuntu's ~/.profile puts it on the PATH, Codex in an nvm folder it does not.
  await seed(`${HOME}/.local/bin/claude`, '#!/bin/sh\n', '2026-09-01 00:00:00');
  await seed(`${HOME}/.nvm/versions/node/v22.9.0/bin/codex`, '#!/bin/sh\n', '2026-09-01 00:00:00');
  await run(`chmod +x ${HOME}/.local/bin/claude ${HOME}/.nvm/versions/node/v22.9.0/bin/codex`);
}, 900_000);

afterAll(() => {
  seeder?.close();
  server?.stop();
});

beforeEach(() => {
  clearHistoryCaches();
});

function newPool(): SshConnectionPool {
  return new SshConnectionPool({
    endpoint: async () => {
      if (!server) throw new Error('no server');
      return {
        host: server.host,
        port: server.port,
        storedFingerprint: await probeHostKey(server.host, server.port),
        username: SSH_USER,
        authMethod: 'password',
        password: SSH_PASSWORD,
      };
    },
  });
}

describe.skipIf(!docker)('remote AI history against OpenSSH', () => {
  it('probes the home folder and finds both CLIs through a real login shell', async () => {
    const connection = await open();
    try {
      const result = await connection.exec(PROBE_COMMAND, { timeoutMs: 15_000 });

      expect(result.exitCode).toBe(0);
      expect(parseRemoteProbe(result.stdout)).toMatchObject({
        home: HOME,
        claudeConfigDir: null,
        codexHome: null,
        clis: { claude: true, codex: true },
      });
    } finally {
      connection.close();
    }
  });

  it('lists every conversation on the server over SFTP and hands the connection back', async () => {
    const pool = newPool();
    try {
      const result = await listRemoteAgentHistory('test-server', { pool });

      expect(result.home).toBe(HOME);
      expect(result.clis).toMatchObject({ claude: true, codex: true });
      expect(result.sessions.map((s) => [s.provider, s.id, s.cwd, s.firstPrompt])).toEqual([
        [
          'claude-code',
          '0b6e3a52-1111-4c2e-9d55-6a7f1b2c3d4e',
          '/srv/app',
          'Why does the deploy fail?',
        ],
        ['codex', 'cx-0001', '/srv/app', 'Tune the nginx config'],
        [
          'claude-code',
          '7c1d2e3f-2222-4a5b-8c9d-0e1f2a3b4c5d',
          `${HOME}/api`,
          'Add a health route',
        ],
        ['claude-code', '5e6f7a8b-3333-4c4d-9e0f-1a2b3c4d5e6f', '/srv/app', 'Linked conversation'],
      ]);
      expect(result.sessions[0].updatedAt).toBe(Date.parse('2026-09-01T10:00:00Z'));
      // Released, so the pool's only connection is idle and the next lease reuses it.
      const again = await listRemoteAgentHistory('test-server', { pool });
      expect(again.sessions).toHaveLength(4);
    } finally {
      pool.closeAll();
    }
  });
});

describe.skipIf(!docker)('SFTP reads against OpenSSH', () => {
  it('reads a range larger than one SFTP packet, and less at the end of the file', async () => {
    const content = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`).join('');
    await seed('/tmp/big.txt', content, '2026-09-01 00:00:00');
    const connection = await open();
    try {
      const middle = await connection.sftpReadRange('/tmp/big.txt', 1000, 100_000);
      const end = await connection.sftpReadRange('/tmp/big.txt', content.length - 10, 1000);

      expect(middle.toString()).toBe(content.slice(1000, 101_000));
      expect(end.toString()).toBe(content.slice(-10));
      expect(await connection.sftpRealpath('.')).toBe(HOME);
      const listed = await connection.sftpList('/tmp');
      expect(listed.find((entry) => entry.name === 'big.txt')).toMatchObject({
        isFile: true,
        size: content.length,
      });
      await expect(connection.sftpList('/does/not/exist')).rejects.toThrow();
    } finally {
      connection.close();
    }
  });
});
