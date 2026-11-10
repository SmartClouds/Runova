import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult, SftpEntry } from '../ssh/connection';
import {
  type HistoryConnection,
  listRemoteAgentHistory,
  PROBE_COMMAND,
  parseRemoteProbe,
  type RemoteProbe,
  sftpHistoryFs,
} from './remoteSessionHistory';
import { clearHistoryCaches } from './sessionHistory';

// A saved server's history is read over SFTP through the same collectHistory as this machine's.
// These run against a stand-in connection that serves an in-memory file tree.

interface FakeFile {
  content: string;
  mtimeMs: number;
}

const execResult = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
});

type FakeConnection = HistoryConnection & {
  exec: ReturnType<typeof vi.fn>;
  sftpList: ReturnType<typeof vi.fn>;
  sftpReadRange: ReturnType<typeof vi.fn>;
  sftpRealpath: ReturnType<typeof vi.fn>;
};

function fakeConnection(files: Record<string, FakeFile>, probeOutput = ''): FakeConnection {
  return {
    exec: vi.fn(async () => execResult(probeOutput)),
    sftpRealpath: vi.fn(async (path: string) => (path === '.' ? '/home/me' : path)),
    sftpList: vi.fn(async (dir: string): Promise<SftpEntry[]> => {
      const prefix = `${dir.replace(/\/+$/, '')}/`;
      const entries = new Map<string, SftpEntry>();
      for (const [path, file] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split('/');
        entries.set(
          name,
          rest.length > 0
            ? { name, isDirectory: true, isFile: false, size: 4096, mtimeMs: 0 }
            : {
                name,
                isDirectory: false,
                isFile: true,
                size: Buffer.byteLength(file.content),
                mtimeMs: file.mtimeMs,
              },
        );
      }
      if (entries.size === 0) throw new Error('No such file');
      return [...entries.values()];
    }),
    sftpReadRange: vi.fn(async (path: string, start: number, length: number) => {
      const file = files[path];
      if (!file) throw new Error('No such file');
      return Buffer.from(file.content).subarray(start, start + length);
    }),
  };
}

const jsonl = (...records: unknown[]): string =>
  `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

function claudeTranscript(cwd: string, prompt: string): string {
  return jsonl({
    type: 'user',
    cwd,
    timestamp: '2026-09-01T10:00:00.000Z',
    message: { role: 'user', content: prompt },
  });
}

function codexRollout(id: string, cwd: string, prompt: string): string {
  return jsonl(
    { type: 'session_meta', payload: { id, cwd, timestamp: '2026-09-01T10:00:00.000Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
  );
}

const probe = (overrides: Partial<RemoteProbe> = {}): RemoteProbe => ({
  home: '/home/me',
  claudeConfigDir: null,
  codexHome: null,
  clis: {
    claude: false,
    codex: false,
    gemini: false,
    cursor: false,
    continue: false,
    grok: false,
    cline: false,
    opencode: false,
    qwen: false,
    freebuff: false,
  },
  ...overrides,
});

beforeEach(() => {
  clearHistoryCaches();
});

describe('parseRemoteProbe', () => {
  it('reads the home folder, the agent folders and which CLIs are there', () => {
    const stdout = [
      '__RN_HOME=/home/me',
      '__RN_CLAUDE_CONFIG_DIR=/home/me/.claude-work',
      '__RN_CODEX_HOME=/opt/codex',
      '__RN_CLAUDE=1',
      '__RN_CODEX=1',
      '__RN_END',
    ].join('\n');

    expect(parseRemoteProbe(stdout)).toEqual({
      home: '/home/me',
      claudeConfigDir: '/home/me/.claude-work',
      codexHome: '/opt/codex',
      clis: {
        claude: true,
        codex: true,
        gemini: false,
        cursor: false,
        continue: false,
        grok: false,
        cline: false,
        opencode: false,
        qwen: false,
        freebuff: false,
      },
    });
  });

  it('treats unset variables and missing CLIs as absent', () => {
    const stdout = '__RN_HOME=/root\n__RN_CLAUDE_CONFIG_DIR=\n__RN_CODEX_HOME=\n__RN_END\n';

    expect(parseRemoteProbe(stdout)).toEqual({
      home: '/root',
      claudeConfigDir: null,
      codexHome: null,
      clis: {
        claude: false,
        codex: false,
        gemini: false,
        cursor: false,
        continue: false,
        grok: false,
        cline: false,
        opencode: false,
        qwen: false,
        freebuff: false,
      },
    });
  });

  it('reads every probed CLI flag', () => {
    const stdout = [
      '__RN_HOME=/home/me',
      '__RN_GEMINI=1',
      '__RN_CURSOR=1',
      '__RN_CONTINUE=1',
      '__RN_GROK=1',
      '__RN_CLINE=1',
      '__RN_OPENCODE=1',
      '__RN_QWEN=1',
      '__RN_FREEBUFF=1',
      '__RN_END',
    ].join('\n');
    const probe = parseRemoteProbe(stdout);
    expect(probe.clis).toMatchObject({
      gemini: true,
      cursor: true,
      continue: true,
      grok: true,
      cline: true,
      opencode: true,
      qwen: true,
      freebuff: true,
      claude: false,
      codex: false,
    });
  });

  it('ignores login noise around the markers, even on the same line', () => {
    const stdout = [
      'Welcome to Ubuntu 24.04 LTS',
      ' * Documentation:  https://help.ubuntu.com',
      'nvm: using node v22__RN_HOME=/home/me',
      '__RN_CLAUDE_CONFIG_DIR=',
      '__RN_CODEX_HOME=',
      'HOME=/elsewhere',
      '__RN_CODEX=1',
      '__RN_END',
      'Last login: yesterday',
    ].join('\n');

    expect(parseRemoteProbe(stdout)).toEqual({
      home: '/home/me',
      claudeConfigDir: null,
      codexHome: null,
      clis: {
        claude: false,
        codex: true,
        gemini: false,
        cursor: false,
        continue: false,
        grok: false,
        cline: false,
        opencode: false,
        qwen: false,
        freebuff: false,
      },
    });
  });

  it('copes with CRLF line endings', () => {
    const stdout = '__RN_HOME=/home/me\r\n__RN_CODEX_HOME=/x\r\n__RN_CLAUDE=1\r\n__RN_END\r\n';

    expect(parseRemoteProbe(stdout)).toEqual({
      home: '/home/me',
      claudeConfigDir: null,
      codexHome: '/x',
      clis: {
        claude: true,
        codex: false,
        gemini: false,
        cursor: false,
        continue: false,
        grok: false,
        cline: false,
        opencode: false,
        qwen: false,
        freebuff: false,
      },
    });
  });

  it('returns nothing for output without markers', () => {
    expect(parseRemoteProbe('sh: not found\n')).toEqual({
      home: null,
      claudeConfigDir: null,
      codexHome: null,
      clis: {
        claude: false,
        codex: false,
        gemini: false,
        cursor: false,
        continue: false,
        grok: false,
        cline: false,
        opencode: false,
        qwen: false,
        freebuff: false,
      },
    });
  });
});

describe('PROBE_COMMAND', () => {
  it('is one line without single quotes inside, so any login shell can pass it to sh', () => {
    const inner = PROBE_COMMAND.slice("sh -lc '".length, -1);

    expect(PROBE_COMMAND.startsWith("sh -lc '")).toBe(true);
    expect(PROBE_COMMAND.endsWith("'")).toBe(true);
    expect(inner).not.toMatch(/['\n!]/);
  });
});

describe('sftpHistoryFs', () => {
  it('lists and reads through SFTP under the server scope', async () => {
    const connection = fakeConnection({
      '/home/me/a.txt': { content: 'héllo wörld', mtimeMs: 5 },
    });
    const fs = sftpHistoryFs(connection, 'srv-1', probe());

    expect(fs.scope).toBe('ssh:srv-1');
    expect(fs.caseInsensitive).toBe(false);
    expect(fs.join('/home/me', '.claude', 'projects')).toBe('/home/me/.claude/projects');
    expect(await fs.list('/home/me')).toEqual([
      { name: 'a.txt', isDirectory: false, isFile: true, size: 13, mtimeMs: 5 },
    ]);
    expect(await fs.readRange('/home/me/a.txt', 0, 6)).toBe('héllo');
    expect(connection.sftpReadRange).toHaveBeenCalledWith('/home/me/a.txt', 0, 6);
  });

  it('takes the home folder and agent folders from the probe', async () => {
    const fs = sftpHistoryFs(
      fakeConnection({}),
      'srv-1',
      probe({ home: '/root', claudeConfigDir: '/cfg/claude', codexHome: '/cfg/codex' }),
    );

    expect(await fs.home()).toBe('/root');
    expect(await fs.env('CLAUDE_CONFIG_DIR')).toBe('/cfg/claude');
    expect(await fs.env('CODEX_HOME')).toBe('/cfg/codex');
    expect(await fs.env('PATH')).toBeUndefined();
  });

  it('asks SFTP for the home folder when the probe could not tell', async () => {
    const connection = fakeConnection({});
    const fs = sftpHistoryFs(connection, 'srv-1', probe({ home: null }));

    expect(await fs.home()).toBe('/home/me');
    expect(connection.sftpRealpath).toHaveBeenCalledWith('.');
    expect(await fs.env('CLAUDE_CONFIG_DIR')).toBeUndefined();
  });

  it('keeps no more SFTP requests in flight than its limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const connection = fakeConnection({});
    connection.sftpList.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [];
    });
    const fs = sftpHistoryFs(connection, 'srv-1', probe(), { maxInFlight: 2 });

    await Promise.all(Array.from({ length: 7 }, (_, i) => fs.list(`/d${i}`)));

    expect(connection.sftpList).toHaveBeenCalledTimes(7);
    expect(peak).toBe(2);
  });

  it('frees its slot when a request fails', async () => {
    const connection = fakeConnection({});
    const fs = sftpHistoryFs(connection, 'srv-1', probe(), { maxInFlight: 1 });

    await expect(fs.list('/missing')).rejects.toThrow('No such file');
    connection.sftpList.mockResolvedValueOnce([]);
    await expect(fs.list('/other')).resolves.toEqual([]);
  });
});

describe('listRemoteAgentHistory', () => {
  const tree: Record<string, FakeFile> = {
    '/home/me/.claude/projects/-srv-app/11111111-aaaa.jsonl': {
      content: claudeTranscript('/srv/app', 'Fix the deploy'),
      mtimeMs: 3000,
    },
    '/home/me/.claude/projects/-home-me-api/22222222-bbbb.jsonl': {
      content: claudeTranscript('/home/me/api', 'Add a route'),
      mtimeMs: 1000,
    },
    '/home/me/.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-cx1.jsonl': {
      content: codexRollout('cx1', '/srv/app', 'Tune nginx'),
      mtimeMs: 2000,
    },
  };
  const probeOutput = '__RN_HOME=/home/me\n__RN_CLAUDE=1\n__RN_END\n';

  function fakePool(connection: HistoryConnection) {
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ connection, release }));
    return { pool: { acquire }, release, acquire };
  }

  it('lists every conversation on the server with its folder', async () => {
    const connection = fakeConnection(tree, probeOutput);
    const { pool, release, acquire } = fakePool(connection);

    const result = await listRemoteAgentHistory('srv-1', { pool });

    expect(acquire).toHaveBeenCalledWith('srv-1');
    expect(connection.exec).toHaveBeenCalledWith(
      PROBE_COMMAND,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(result.home).toBe('/home/me');
    expect(result.clis).toMatchObject({ claude: true, codex: false });
    expect(result.sessions.map((s) => [s.provider, s.id, s.cwd, s.firstPrompt])).toEqual([
      ['claude-code', '11111111-aaaa', '/srv/app', 'Fix the deploy'],
      ['codex', 'cx1', '/srv/app', 'Tune nginx'],
      ['claude-code', '22222222-bbbb', '/home/me/api', 'Add a route'],
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('finds the history where CLAUDE_CONFIG_DIR and CODEX_HOME point', async () => {
    const connection = fakeConnection(
      {
        '/cfg/claude/projects/-srv-app/abc.jsonl': {
          content: claudeTranscript('/srv/app', 'Moved'),
          mtimeMs: 10,
        },
        '/cfg/codex/sessions/2026/09/01/rollout-x.jsonl': {
          content: codexRollout('x', '/srv/app', 'Also moved'),
          mtimeMs: 20,
        },
      },
      '__RN_HOME=/home/me\n__RN_CLAUDE_CONFIG_DIR=/cfg/claude\n__RN_CODEX_HOME=/cfg/codex\n',
    );

    const result = await listRemoteAgentHistory('srv-1', fakePool(connection));

    expect(result.sessions.map((s) => s.id)).toEqual(['x', 'abc']);
  });

  it('still lists when the probe gives up, using the SFTP home folder', async () => {
    const connection = fakeConnection(tree);
    connection.exec.mockResolvedValueOnce({ ...execResult(''), exitCode: null, timedOut: true });

    const result = await listRemoteAgentHistory('srv-1', fakePool(connection));

    expect(result.home).toBe('/home/me');
    expect(result.clis).toMatchObject({ claude: false, codex: false });
    expect(result.sessions).toHaveLength(3);
  });

  it('returns an empty list for a server without any history', async () => {
    const connection = fakeConnection({}, probeOutput);

    const result = await listRemoteAgentHistory('srv-1', fakePool(connection));

    expect(result.sessions).toEqual([]);
  });

  it('still lists over SFTP when the server refuses to run commands', async () => {
    // An SFTP-only account (ForceCommand internal-sftp) cannot run the probe.
    const connection = fakeConnection(tree);
    connection.exec.mockRejectedValueOnce(new Error('Unable to exec'));

    const result = await listRemoteAgentHistory('srv-1', fakePool(connection));

    expect(result.sessions).toHaveLength(3);
    expect(result.clis).toMatchObject({ claude: false, codex: false });
  });

  it('hands the connection back when the listing fails', async () => {
    const connection = fakeConnection(tree);
    const closed = new Error('The SSH connection to box is closed.');
    connection.exec.mockRejectedValueOnce(closed);
    connection.sftpRealpath.mockRejectedValueOnce(closed);
    const { pool, release } = fakePool(connection);

    await expect(listRemoteAgentHistory('srv-1', { pool })).rejects.toThrow(/closed/);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('passes a connect failure through untouched, so its code survives', async () => {
    const failure = new Error('[ssh:host-key-changed] The host key changed.');
    const pool = { acquire: vi.fn(async () => Promise.reject(failure)) };

    await expect(listRemoteAgentHistory('srv-1', { pool })).rejects.toBe(failure);
  });
});
