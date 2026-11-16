import { describe, expect, it, vi } from 'vitest';
import { createMachineShell, type LocalRunInput, type MachineShellDeps } from './machineShell';
import { POSIX_RUNNER } from './posixScripts';
import { WINDOWS_RUNNER } from './windowsScripts';

interface ExecCall {
  command: string;
  stdin?: string;
}

function fakeConnection(answer: (command: string) => { stdout: string; timedOut?: boolean }) {
  const calls: ExecCall[] = [];
  const release = vi.fn();
  const connection = {
    exec: vi.fn(
      async (
        command: string,
        options: { stdin?: string | Buffer; onStdout?: (text: string) => void } = {},
      ) => {
        calls.push({ command, stdin: options.stdin?.toString() });
        const { stdout, timedOut = false } = answer(command);
        options.onStdout?.(stdout);
        return { stdout, stderr: '', exitCode: 0, signal: null, timedOut };
      },
    ),
  };
  return { calls, release, lease: { connection, release } };
}

function deps(overrides: Partial<MachineShellDeps> = {}): MachineShellDeps {
  return {
    platform: 'linux',
    isE2E: false,
    findServer: async () => ({}),
    acquire: async () => {
      throw new Error('no ssh in this test');
    },
    runLocal: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    ...overrides,
  } as MachineShellDeps;
}

const build = (kind: 'posix' | 'windows') => `script for ${kind}`;

describe('createMachineShell over SSH', () => {
  it('finds a Linux or macOS server with uname and sends the POSIX script on stdin', async () => {
    const ssh = fakeConnection((command) => ({
      stdout: command.includes('uname') ? 'Linux\n' : 'os\tLinux\nstep\tdocker\n',
    }));
    const lines: string[] = [];
    const shell = createMachineShell(deps({ acquire: async () => ssh.lease as never }));
    const result = await shell.run({ kind: 'ssh', serverId: 's1' }, build, {
      timeoutMs: 1000,
      onLine: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ ok: true, kind: 'posix' });
    expect(ssh.calls[1]).toEqual({ command: POSIX_RUNNER, stdin: 'script for posix' });
    expect(lines).toEqual(['os\tLinux', 'step\tdocker']);
    expect(ssh.release).toHaveBeenCalled();
  });

  it('falls back to PowerShell, sends the script as base64, and remembers the answer', async () => {
    const ssh = fakeConnection((command) => ({
      stdout: command.includes('uname') ? "'sh' is not recognized\n" : 'os\tWindows\n',
    }));
    const shell = createMachineShell(deps({ acquire: async () => ssh.lease as never }));
    const first = await shell.run({ kind: 'ssh', serverId: 's1' }, build, { timeoutMs: 1000 });
    expect(first).toMatchObject({ ok: true, kind: 'windows' });
    expect(ssh.calls[1].command).toBe(WINDOWS_RUNNER);
    expect(Buffer.from(ssh.calls[1].stdin ?? '', 'base64').toString('utf8')).toBe(
      'script for windows',
    );

    await shell.run({ kind: 'ssh', serverId: 's1' }, build, { timeoutMs: 1000 });
    expect(ssh.calls.filter((call) => call.command.includes('uname'))).toHaveLength(1);
  });

  it('says the server is gone, the vault is locked or the server did not answer', async () => {
    const gone = createMachineShell(
      deps({
        findServer: async () => {
          throw new Error('nope');
        },
      }),
    );
    expect(await gone.run({ kind: 'ssh', serverId: 's1' }, build, { timeoutMs: 10 })).toMatchObject(
      { ok: false, reason: 'missing' },
    );

    const locked = createMachineShell(
      deps({
        acquire: async () => {
          throw Object.assign(new Error('The vault is locked'), { name: 'VaultLockedError' });
        },
      }),
    );
    expect(
      await locked.run({ kind: 'ssh', serverId: 's1' }, build, { timeoutMs: 10 }),
    ).toMatchObject({ ok: false, reason: 'locked' });

    const ssh = fakeConnection((command) => ({
      stdout: command.includes('uname') ? 'Linux' : '',
      timedOut: !command.includes('uname'),
    }));
    const slow = createMachineShell(deps({ acquire: async () => ssh.lease as never }));
    expect(await slow.run({ kind: 'ssh', serverId: 's1' }, build, { timeoutMs: 10 })).toMatchObject(
      { ok: false, reason: 'unreachable', error: expect.stringMatching(/too long/) },
    );
    expect(ssh.release).toHaveBeenCalled();
  });
});

describe('createMachineShell on this computer', () => {
  it('runs the script for this OS locally', async () => {
    const runLocal = vi.fn(async (input: LocalRunInput) => {
      input.onLine?.('os\tWindows');
      return { stdout: 'os\tWindows\n', stderr: '', exitCode: 0, timedOut: false };
    });
    const shell = createMachineShell(deps({ platform: 'win32', runLocal }));
    const lines: string[] = [];
    const result = await shell.run({ kind: 'local' }, build, {
      timeoutMs: 1000,
      onLine: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ ok: true, kind: 'windows' });
    expect(runLocal.mock.calls[0][0]).toMatchObject({
      kind: 'windows',
      script: 'script for windows',
    });
    expect(lines).toEqual(['os\tWindows']);
  });

  it('is off in a test run of the app, so it can never touch the developer’s machine', async () => {
    const runLocal = vi.fn();
    const shell = createMachineShell(deps({ isE2E: true, runLocal }));
    expect(await shell.run({ kind: 'local' }, build, { timeoutMs: 10 })).toMatchObject({
      ok: false,
      reason: 'off',
    });
    expect(runLocal).not.toHaveBeenCalled();
  });

  it('turns a local timeout into a readable failure', async () => {
    const shell = createMachineShell(
      deps({
        runLocal: async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
      }),
    );
    expect(await shell.run({ kind: 'local' }, build, { timeoutMs: 10 })).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });
});
