import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AiAccessSettings } from '../../shared/aiAccessSettings';
import { createApprovalBroker } from './approvals';
import { createToolRegistry, defineTool } from './registry';
import { type AiAccessServerDeps, type CallerIdentity, createAiAccessServer } from './server';

/**
 * What happens to a tool call from an agent: refused while access is off or for an agent the user
 * did not let in, checked against the tool's schema, run straight away or held for the user's
 * answer in the window or in the CLI, and recorded either way.
 */

const listRun = vi.fn(async () => ({ data: [{ id: 'p1', name: 'Shop' }] }));
const saveRun = vi.fn(
  async (args: { fileName: string }, context: { projectId: string | null }) => ({
    text: `Saved ${args.fileName} in ${context.projectId}.`,
  }),
);

const tools = createToolRegistry([
  defineTool({
    name: 'projects_list',
    area: 'projects',
    title: 'List projects',
    description: 'Every project.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List your projects' }),
    run: listRun,
  }),
  defineTool({
    name: 'env_save_file',
    area: 'environments',
    title: 'Save an env file',
    description: 'Saves one.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: z.string().optional(), fileName: z.string() }),
    preview: (args) => ({ title: `Save ${args.fileName}` }),
    run: saveRun,
  }),
  defineTool({
    name: 'broken_tool',
    area: 'runova',
    title: 'Broken',
    description: 'Throws.',
    risk: 'write',
    input: z.object({}),
    preview: () => ({ title: 'Break' }),
    run: async () => {
      throw new Error('Disk is full.');
    },
  }),
]);

let settings: AiAccessSettings;
let identity: CallerIdentity;
let deps: AiAccessServerDeps;
let broker: ReturnType<typeof createApprovalBroker>;

beforeEach(() => {
  listRun.mockClear();
  saveRun.mockClear();
  settings = {
    enabled: true,
    mode: 'sensitive',
    prompt: 'modal',
    clients: 'both',
    attachToTabs: true,
  };
  identity = { kind: 'runova', agent: 'Claude Code', projectId: 'p1' };
  broker = createApprovalBroker({ timeoutMs: 60_000 });
  deps = {
    registry: tools,
    broker,
    settings: async () => settings,
    identify: () => identity,
    findProject: async (id) =>
      id === 'p1' || id === 'p2' ? { id, name: id === 'p1' ? 'Shop' : 'Blog' } : null,
    projectForFolder: async (cwd) => (cwd === '/work/blog' ? { id: 'p2', name: 'Blog' } : null),
    record: vi.fn(),
    dataChanged: vi.fn(),
  };
});

const call = (
  tool: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  connectionId: 'conn-1',
  tool,
  args,
  ...extra,
});

describe('AI access server', () => {
  it('lists the tools for the bridge', async () => {
    const server = createAiAccessServer(deps);
    const answer = await server.tools({ connectionId: 'conn-1' });
    expect(answer).toEqual({
      ok: true,
      tools: expect.arrayContaining([expect.objectContaining({ name: 'projects_list' })]),
    });
  });

  it('refuses every call while AI access is off, and says where to turn it on', async () => {
    settings.enabled = false;
    const server = createAiAccessServer(deps);

    const answer = await server.call(call('projects_list'));

    expect(answer).toEqual({ ok: false, error: expect.stringContaining('Settings > AI access') });
    expect(listRun).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }));
  });

  it('lets in only the agents the user chose', async () => {
    const server = createAiAccessServer(deps);

    settings.clients = 'runova';
    identity = { kind: 'external', agent: 'Codex', projectId: null };
    expect(await server.call(call('projects_list'))).toEqual({
      ok: false,
      error: expect.stringContaining('only lets agents in its own terminal tabs'),
    });

    settings.clients = 'external';
    identity = { kind: 'runova', agent: 'Claude Code', projectId: 'p1' };
    expect(await server.call(call('projects_list'))).toEqual({
      ok: false,
      error: expect.stringContaining('only lets agents in other apps'),
    });

    settings.clients = 'both';
    expect(await server.call(call('projects_list'))).toMatchObject({ ok: true });
    expect(listRun).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown tool and arguments that do not fit the schema', async () => {
    const server = createAiAccessServer(deps);

    expect(await server.call(call('nope'))).toEqual({
      ok: false,
      error: 'Runova has no tool named nope.',
    });
    expect(await server.call(call('env_save_file', { fileName: 42 }))).toEqual({
      ok: false,
      error: expect.stringContaining('fileName'),
    });
  });

  it('runs a read straight away in the sensitive mode and records it', async () => {
    const server = createAiAccessServer(deps);

    const answer = await server.call(call('projects_list'));

    expect(answer).toEqual({ ok: true, data: [{ id: 'p1', name: 'Shop' }] });
    expect(deps.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'projects_list',
        outcome: 'auto',
        agent: 'Claude Code',
        callerKind: 'runova',
        projectId: 'p1',
        projectName: 'Shop',
      }),
    );
    expect(deps.dataChanged).not.toHaveBeenCalled();
  });

  it('holds a sensitive call for the window, runs it once allowed and announces the change', async () => {
    const server = createAiAccessServer(deps);

    const pending = server.call(call('env_save_file', { fileName: '.env' }));
    await vi.waitFor(() => expect(broker.listForWindow()).toHaveLength(1));
    const [approval] = broker.listForWindow();
    expect(approval).toMatchObject({
      tool: 'env_save_file',
      risk: 'sensitive',
      agent: 'Claude Code',
      projectName: 'Shop',
      preview: { title: 'Save .env' },
      cliFallback: false,
    });
    expect(saveRun).not.toHaveBeenCalled();

    broker.decide(approval.id, 'allow', { channel: 'modal' });

    expect(await pending).toEqual({ ok: true, text: 'Saved .env in p1.' });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
    expect(deps.dataChanged).toHaveBeenCalledWith({ area: 'environments', projectId: 'p1' });
  });

  it('tells the agent the user said no, without running the tool', async () => {
    const server = createAiAccessServer(deps);

    const pending = server.call(call('env_save_file', { fileName: '.env' }));
    await vi.waitFor(() => expect(broker.listForWindow()).toHaveLength(1));
    broker.decide(broker.listForWindow()[0].id, 'deny', { channel: 'modal' });

    expect(await pending).toEqual({
      ok: false,
      error: expect.stringContaining('The user declined'),
    });
    expect(saveRun).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });

  it('skips asking again once the user allowed a tool for the session', async () => {
    const server = createAiAccessServer(deps);

    const first = server.call(call('env_save_file', { fileName: '.env' }));
    await vi.waitFor(() => expect(broker.listForWindow()).toHaveLength(1));
    broker.decide(broker.listForWindow()[0].id, 'allow_session', { channel: 'modal' });
    await first;

    expect(await server.call(call('env_save_file', { fileName: '.env.local' }))).toMatchObject({
      ok: true,
    });
    expect(broker.listForWindow()).toHaveLength(0);
  });

  it('asks in the CLI when the user chose that and the CLI can show it', async () => {
    settings.prompt = 'cli';
    const server = createAiAccessServer(deps);

    const answer = await server.call(
      call('env_save_file', { fileName: '.env' }, { canElicit: true }),
    );

    expect(answer).toEqual({
      ok: true,
      confirm: { approvalId: expect.any(String), message: expect.stringContaining('Save .env') },
    });
    expect(broker.listForWindow()).toEqual([]);
    expect(saveRun).not.toHaveBeenCalled();

    const approvalId = (answer as { confirm: { approvalId: string } }).confirm.approvalId;
    expect(await server.decide({ connectionId: 'other', approvalId, decision: 'allow' })).toEqual({
      ok: false,
      error: expect.stringContaining('no longer waiting'),
    });
    expect(await server.decide({ connectionId: 'conn-1', approvalId, decision: 'allow' })).toEqual({
      ok: true,
      text: 'Saved .env in p1.',
    });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }));
  });

  it('falls back to the window when the CLI cannot show approvals', async () => {
    settings.prompt = 'cli';
    const server = createAiAccessServer(deps);

    void server.call(call('env_save_file', { fileName: '.env' }, { canElicit: false }));

    await vi.waitFor(() =>
      expect(broker.listForWindow()).toEqual([expect.objectContaining({ cliFallback: true })]),
    );
  });

  it('asks before reads too in the strictest mode', async () => {
    settings.mode = 'all';
    const server = createAiAccessServer(deps);

    void server.call(call('projects_list'));

    await vi.waitFor(() => expect(broker.listForWindow()).toHaveLength(1));
    expect(listRun).not.toHaveBeenCalled();
  });

  it('never asks in full access', async () => {
    settings.mode = 'full';
    const server = createAiAccessServer(deps);

    expect(await server.call(call('env_save_file', { fileName: '.env' }))).toMatchObject({
      ok: true,
    });
    expect(broker.listForWindow()).toEqual([]);
  });

  it('picks the project from an argument, then the tab, then the folder the agent runs in', async () => {
    settings.mode = 'full';
    const server = createAiAccessServer(deps);

    await server.call(call('env_save_file', { fileName: '.env', projectId: 'p2' }));
    expect(saveRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'p2' }),
    );

    await server.call(call('env_save_file', { fileName: '.env' }));
    expect(saveRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'p1' }),
    );

    identity = { kind: 'external', agent: 'Codex', projectId: null };
    await server.call(call('env_save_file', { fileName: '.env' }, { cwd: '/work/blog' }));
    expect(saveRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'p2' }),
    );
  });

  it('asks the agent to name a project when it cannot tell which one', async () => {
    identity = { kind: 'external', agent: 'Codex', projectId: null };
    const server = createAiAccessServer(deps);

    expect(
      await server.call(call('env_save_file', { fileName: '.env' }, { cwd: '/elsewhere' })),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('projects_list'),
    });
    expect(
      await server.call(call('env_save_file', { fileName: '.env', projectId: 'gone' })),
    ).toEqual({
      ok: false,
      error: 'Runova has no project with the id gone.',
    });
  });

  it('reports a tool that failed and records why', async () => {
    const server = createAiAccessServer(deps);

    expect(await server.call(call('broken_tool'))).toEqual({ ok: false, error: 'Disk is full.' });
    expect(deps.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', detail: 'Disk is full.' }),
    );
  });
});
