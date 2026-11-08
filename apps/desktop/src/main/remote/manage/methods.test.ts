import type { Project } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type { ManageDeployDeps } from './deployMethods';
import type { ManageGitDeps } from './gitMethods';
import { createManageMethods, type ManageMethodDeps } from './methods';
import type { ManageStreamSink } from './session';
import type { ManageStatusDeps } from './statusMethods';
import type { ManageVaultDeps } from './vaultMethods';

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['core' as const] } };

function deps(change: Partial<ManageMethodDeps> = {}): ManageMethodDeps {
  return {
    listProjects: async () => [],
    listTerminals: async () => [],
    terminalShell: () => 'bash',
    attachTerminal: async () => ({ data: 'screen', cols: 120, rows: 30 }),
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
    writeTerminal: () => undefined,
    terminalProcesses: async () => [],
    git: {} as ManageGitDeps,
    status: {} as ManageStatusDeps,
    vault: {} as ManageVaultDeps,
    deploy: {} as ManageDeployDeps,
    ...change,
  };
}

function sink() {
  const events: unknown[] = [];
  const bytes: string[] = [];
  const ended: unknown[][] = [];
  const stream: ManageStreamSink = {
    event: (value) => events.push(value),
    binary: (payload) => bytes.push(Buffer.from(payload).toString('utf8')),
    end: (...args) => ended.push(args),
  };
  return { stream, events, bytes, ended };
}

function project(change: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Website',
    folderPath: 'C:\\Users\\sam\\secret-client\\website',
    tags: ['web'],
    pinned: true,
    archived: false,
    iconDataUrl: `data:image/png;base64,${'A'.repeat(50_000)}`,
    iconBgColor: '#102030',
    iconColor: '#ffffff',
    repoUrl: 'https://github.com/acme/website',
    prompt: 'private standing prompt',
    notes: 'private notes',
    ...change,
  } as Project;
}

describe('projects.list', () => {
  it('gives the phone what it shows and leaves paths, prompts and large icons behind', async () => {
    const methods = createManageMethods(deps({ listProjects: vi.fn(async () => [project()]) }));

    const result = await methods.calls['projects.list'](undefined, context);

    expect(result).toEqual([
      {
        id: 'p1',
        name: 'Website',
        tags: ['web'],
        pinned: true,
        archived: false,
        iconBgColor: '#102030',
        iconColor: '#ffffff',
        hasRepository: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-client');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('says plainly when a project has no repository', async () => {
    const methods = createManageMethods(
      deps({ listProjects: vi.fn(async () => [project({ repoUrl: undefined })]) }),
    );

    const result = (await methods.calls['projects.list'](undefined, context)) as {
      hasRepository: boolean;
    }[];

    expect(result[0]?.hasRepository).toBe(false);
  });
});

describe('terminals.follow', () => {
  it('attaches without a size, so the phone can never resize the desktop terminal', async () => {
    const attachTerminal = vi.fn(deps().attachTerminal);
    const methods = createManageMethods(deps({ attachTerminal, terminalShell: () => 'zsh' }));

    await methods.streams['terminals.follow']({ sessionId: 's1' }, sink().stream, context);

    expect(attachTerminal).toHaveBeenCalledWith('s1', 'zsh');
    expect(Object.keys(attachTerminal.mock.calls[0] ?? [])).toHaveLength(2);
  });

  it('sends the screen first and then the output as it comes', async () => {
    let emit: (data: string) => void = () => undefined;
    const { stream, events, bytes } = sink();
    const methods = createManageMethods(
      deps({
        onTerminalOutput: (_id, listener) => {
          emit = listener;
          return () => undefined;
        },
      }),
    );

    await methods.streams['terminals.follow']({ sessionId: 's1' }, stream, context);
    emit('hello');

    expect(events).toEqual([{ snapshot: { data: 'screen', cols: 120, rows: 30 } }]);
    expect(bytes).toEqual(['hello']);
  });

  it('starts listening only once attached, so nothing is shown twice', async () => {
    const order: string[] = [];
    const methods = createManageMethods(
      deps({
        attachTerminal: async () => {
          order.push('attached');
          return { data: '', cols: 80, rows: 24 };
        },
        onTerminalOutput: () => {
          order.push('listening');
          return () => undefined;
        },
      }),
    );

    await methods.streams['terminals.follow']({ sessionId: 's1' }, sink().stream, context);

    expect(order).toEqual(['attached', 'listening']);
  });

  it('stops listening when the phone does', async () => {
    const stopOutput = vi.fn();
    const stopExit = vi.fn();
    const methods = createManageMethods(
      deps({ onTerminalOutput: () => stopOutput, onTerminalExit: () => stopExit }),
    );

    const stop = await methods.streams['terminals.follow'](
      { sessionId: 's1' },
      sink().stream,
      context,
    );
    stop();

    expect(stopOutput).toHaveBeenCalledTimes(1);
    expect(stopExit).toHaveBeenCalledTimes(1);
  });

  it('ends the stream when the shell exits', async () => {
    let exit: () => void = () => undefined;
    const { stream, ended } = sink();
    const methods = createManageMethods(
      deps({
        onTerminalExit: (_id, listener) => {
          exit = listener;
          return () => undefined;
        },
      }),
    );

    await methods.streams['terminals.follow']({ sessionId: 's1' }, stream, context);
    exit();

    expect(ended).toEqual([[]]);
  });

  it('says so when that terminal is gone', async () => {
    const methods = createManageMethods(deps({ attachTerminal: async () => null }));

    await expect(
      methods.streams['terminals.follow']({ sessionId: 's1' }, sink().stream, context),
    ).rejects.toMatchObject({ code: 'bad-params', message: 'That terminal has ended.' });
  });

  it.each([[undefined], [{}], [{ sessionId: 7 }], [{ sessionId: '' }]])(
    'turns down bad parameters: %j',
    async (params) => {
      const methods = createManageMethods(deps());

      await expect(
        methods.streams['terminals.follow'](params, sink().stream, context),
      ).rejects.toMatchObject({ code: 'bad-params' });
    },
  );
});

describe('terminals.write', () => {
  it('types into the terminal', async () => {
    const writeTerminal = vi.fn();
    const methods = createManageMethods(deps({ writeTerminal }));

    await methods.calls['terminals.write']({ sessionId: 's1', data: 'ls\r' }, context);

    expect(writeTerminal).toHaveBeenCalledWith('s1', 'ls\r');
  });

  it('turns down something too long to be typing', async () => {
    const writeTerminal = vi.fn();
    const methods = createManageMethods(deps({ writeTerminal }));

    await expect(
      Promise.resolve().then(() =>
        methods.calls['terminals.write']({ sessionId: 's1', data: 'x'.repeat(70_000) }, context),
      ),
    ).rejects.toMatchObject({ code: 'bad-params' });
    expect(writeTerminal).not.toHaveBeenCalled();
  });
});

describe('terminals.list and processes', () => {
  it('passes the list through', async () => {
    const terminal = {
      sessionId: 's1',
      title: 'Claude',
      projectId: 'p1',
      cliId: 'claude',
      status: 'needs-input',
      createdAt: 5,
    } as const;
    const methods = createManageMethods(deps({ listTerminals: async () => [terminal] }));

    await expect(methods.calls['terminals.list'](undefined, context)).resolves.toEqual([terminal]);
  });

  it("asks for one terminal's processes", async () => {
    const terminalProcesses = vi.fn(async () => []);
    const methods = createManageMethods(deps({ terminalProcesses }));

    await methods.calls['terminals.processes']({ sessionId: 's1' }, context);

    expect(terminalProcesses).toHaveBeenCalledWith('s1');
  });
});
