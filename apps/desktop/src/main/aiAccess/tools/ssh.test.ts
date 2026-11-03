import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

const ssh = vi.hoisted(() => ({
  locked: false,
  exec: vi.fn(async (_command: string, _options: unknown) => ({
    stdout: 'up 3 days\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
  })),
  list: vi.fn(async (_dir: string) => [
    { name: 'releases', isDirectory: true, isFile: false, size: 4096, mtimeMs: 0 },
    { name: 'app.log', isDirectory: false, isFile: true, size: 120, mtimeMs: 0 },
    { name: 'api', isDirectory: true, isFile: false, size: 4096, mtimeMs: 0 },
  ]),
  release: vi.fn(),
  acquired: [] as string[],
}));

vi.mock('../../ssh/sharedPool', async () => {
  const { VaultLockedError: Locked } = await import('../../ssh/vaultErrors');
  return {
    getSshPool: () => ({
      acquire: async (serverId: string) => {
        if (ssh.locked) throw new Locked();
        ssh.acquired.push(serverId);
        return {
          connection: {
            exec: ssh.exec,
            sftpList: ssh.list,
            sftpRealpath: async () => '/home/deploy',
          },
          release: ssh.release,
        };
      },
    }),
  };
});

/** SSH tools: the saved servers, one command on a server, and a folder listing over SFTP. */

const userData = useTempUserData();
const context: ToolContext = { projectId: null, callerKind: 'external', agent: 'Codex', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  ssh.locked = false;
  ssh.acquired = [];
  ssh.exec.mockClear();
  ssh.list.mockClear();
  ssh.release.mockClear();
  userData.writeData('ssh-servers.json', [
    {
      id: 'srv-1',
      nickname: 'Prod web',
      host: 'web.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      secretEnvelope: { iv: 'aaa', data: 'TOP-SECRET-CIPHERTEXT' },
      hostKeyFingerprint: 'SHA256:abc',
      createdAt: 1,
      lastConnectedAt: null,
    },
    {
      id: 'srv-2',
      nickname: 'Backup box',
      host: '10.0.0.9',
      port: 2222,
      username: 'root',
      authMethod: 'privateKey',
      privateKeyPath: 'C:/Users/me/.ssh/id_ed25519',
      createdAt: 2,
      lastConnectedAt: 1_700_000_000_000,
    },
  ]);
  const { sshTools } = await import('./ssh');
  tools = new Map(sshTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('ssh tools', () => {
  it('lists the saved servers without any secret', async () => {
    const data = (await run('ssh_list_hosts')).data as Record<string, unknown>[];
    expect(data).toEqual([
      expect.objectContaining({
        id: 'srv-1',
        name: 'Prod web',
        address: 'deploy@web.example.com:22',
        login: 'password',
        hasSavedSecret: true,
      }),
      expect.objectContaining({ id: 'srv-2', login: 'key file', hasSavedSecret: false }),
    ]);
    const text = JSON.stringify(data);
    expect(text).not.toContain('TOP-SECRET');
    expect(text).not.toContain('secretEnvelope');
    expect(text).not.toContain('id_ed25519');
  });

  it('runs a command on a server found by name and gives back its output', async () => {
    const result = await run('ssh_run_command', { host: 'prod WEB', command: 'uptime' });
    expect(ssh.acquired).toEqual(['srv-1']);
    expect(ssh.exec).toHaveBeenCalledWith('uptime', expect.objectContaining({ timeoutMs: 60_000 }));
    expect(ssh.release).toHaveBeenCalled();
    expect(result.data).toMatchObject({ exitCode: 0, stdout: 'up 3 days\n', timedOut: false });

    const tool = tools.get('ssh_run_command') as AiTool;
    expect(tool.risk).toBe('sensitive');
    const preview = await tool.preview(
      tool.input.parse({ host: 'srv-1', command: 'rm -rf /tmp/x' }),
      context,
    );
    expect(preview).toMatchObject({ title: 'Run a command on Prod web' });
    expect(JSON.stringify(preview)).toContain('rm -rf /tmp/x');
  });

  it('lists a remote folder, home by default, folders first', async () => {
    const result = await run('ssh_list_folder', { host: 'Backup box' });
    expect(ssh.list).toHaveBeenCalledWith('/home/deploy');
    expect(result.data).toMatchObject({
      path: '/home/deploy',
      entries: [
        { name: 'api', type: 'folder' },
        { name: 'releases', type: 'folder' },
        { name: 'app.log', type: 'file', size: 120 },
      ],
    });
    await run('ssh_list_folder', { host: 'srv-2', path: '~/logs' });
    expect(ssh.list).toHaveBeenLastCalledWith('/home/deploy/logs');
  });

  it('asks for the vault to be unlocked, and names the servers when one is unknown', async () => {
    ssh.locked = true;
    await expect(run('ssh_run_command', { host: 'srv-1', command: 'ls' })).rejects.toThrow(
      'Unlock the vault in Runova first',
    );
    await expect(run('ssh_list_folder', { host: 'nope' })).rejects.toThrow('Prod web, Backup box');
  });
});
