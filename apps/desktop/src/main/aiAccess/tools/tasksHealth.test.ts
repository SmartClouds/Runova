import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

const scheduler = vi.hoisted(() => ({ checkNow: vi.fn(async (_id: string) => undefined) }));
vi.mock('../../health/scheduler', () => ({ getHealthScheduler: () => scheduler }));
vi.mock('../../notifications/telegramApi', () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: false })),
  editTelegramMessage: vi.fn(async () => ({ ok: false })),
}));

/**
 * Scheduled task and healthcheck tools: queue a prompt for later (one that starts by itself is a
 * separate, sensitive tool), change or cancel it, and read, run or pause a project's healthchecks.
 */

const userData = useTempUserData();

const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let tools: Map<string, AiTool>;

beforeEach(async () => {
  scheduler.checkNow.mockClear();
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: 'C:/code/shop', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  const { taskTools } = await import('./tasks');
  const { healthTools } = await import('./health');
  tools = new Map([...taskTools, ...healthTools].map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('scheduled task tools', () => {
  it('queues a prompt that waits, another that starts by itself, and lists both', async () => {
    await run('task_schedule', { prompt: 'Update deps', runAt: '2026-12-01T09:00:00+01:00' });
    await run('task_schedule_run', {
      prompt: 'Run the audit',
      runAt: '2026-12-02T09:00:00Z',
      cliId: 'codex-cli',
    });

    const tasks = (await run('tasks_list')).data as {
      prompt: string;
      startsByItself: boolean;
      runAt: string;
    }[];
    expect(tasks).toEqual([
      expect.objectContaining({
        prompt: 'Update deps',
        startsByItself: false,
        runAt: '2026-12-01T08:00:00.000Z',
      }),
      expect.objectContaining({ prompt: 'Run the audit', startsByItself: true }),
    ]);
  });

  it('refuses a time without a zone', () => {
    const tool = tools.get('task_schedule') as AiTool;
    expect(() => tool.input.parse({ prompt: 'x', runAt: 'tomorrow' })).toThrow();
  });

  it('moves, cancels and deletes a task of this project only', async () => {
    await run('task_schedule', { prompt: 'Update deps', runAt: '2026-12-01T09:00:00Z' });
    const [task] = (await run('tasks_list')).data as { id: string }[];

    await run('task_update', { taskId: task.id, runAt: '2026-12-05T09:00:00Z', cancel: true });
    expect((await run('tasks_list')).data).toEqual([
      expect.objectContaining({ status: 'cancelled', runAt: '2026-12-05T09:00:00.000Z' }),
    ]);

    await expect(run('task_remove', { taskId: 'someone-else' })).rejects.toThrow(/no task/);
    await run('task_remove', { taskId: task.id });
    expect((await run('tasks_list')).data).toEqual([]);
  });

  it('never lets task_update start a prompt the user did not approve', async () => {
    const { dueTasks } = await import('../../scheduledTasks/scheduler');
    const { store } = await import('../../store');
    await run('task_schedule_run', { prompt: 'Run the tests', runAt: '2026-12-01T09:00:00Z' });
    const [task] = (await run('tasks_list')).data as { id: string }[];

    const tool = tools.get('task_update') as AiTool;
    const args = tool.input.parse({
      taskId: task.id,
      prompt: 'Something else',
      runAt: '2026-12-01T10:00:00Z',
    });
    expect(await tool.preview(args, context)).toMatchObject({
      summary: expect.stringContaining('Run now'),
      fields: [
        expect.objectContaining({ label: 'When' }),
        { label: 'Prompt', value: 'Something else' },
      ],
    });
    const result = await tool.run(args, context);

    expect(result.text).toContain('no longer starts by itself');
    expect((await run('tasks_list')).data).toEqual([
      expect.objectContaining({ prompt: 'Something else', startsByItself: false }),
    ]);
    expect(dueTasks(await store.getScheduledTasks(), new Date('2026-12-01T10:00:30Z'))).toEqual([]);
  });

  it('puts a missed automatic task back in the queue only as one that waits for Run now', async () => {
    const { dueTasks } = await import('../../scheduledTasks/scheduler');
    const { store } = await import('../../store');
    await run('task_schedule_run', { prompt: 'Run the audit', runAt: '2026-01-01T09:00:00Z' });
    const [task] = await store.getScheduledTasks();
    await store.setScheduledTasks([{ ...task, status: 'missed' }]);

    await run('task_update', { taskId: task.id, runAt: '2026-12-01T10:00:00Z' });

    const [moved] = await store.getScheduledTasks();
    expect(moved).toMatchObject({ status: 'pending', runMode: 'manual' });
    expect(dueTasks([moved], new Date('2026-12-01T10:00:30Z'))).toEqual([]);
  });

  it('leaves an automatic task alone when it is only cancelled', async () => {
    await run('task_schedule_run', { prompt: 'Run the audit', runAt: '2026-12-01T09:00:00Z' });
    const [task] = (await run('tasks_list')).data as { id: string }[];

    await run('task_update', { taskId: task.id, cancel: true });

    expect((await run('tasks_list')).data).toEqual([
      expect.objectContaining({ status: 'cancelled', startsByItself: true }),
    ]);
  });
});

describe('healthcheck tools', () => {
  beforeEach(() => {
    userData.writeData('health-targets.json', [
      {
        id: 'h1',
        projectId: 'p1',
        environmentId: null,
        name: 'API',
        serverLabel: null,
        serverLink: null,
        url: 'https://api.shop.test/health',
        intervalSec: 60,
        timeoutSec: 10,
        authMode: 'bearer',
        basicUser: null,
        allowInsecure: false,
        autoDiagnose: false,
        createdAt: 0,
        updatedAt: 0,
        paused: false,
        secretEnvelope: null,
        secretRotatedAt: null,
      },
    ]);
  });

  it('lists the project healthchecks, runs one now and pauses it', async () => {
    expect((await run('health_list')).data).toEqual([
      expect.objectContaining({ id: 'h1', name: 'API', paused: false, state: 'unknown' }),
    ]);

    await run('health_check_now', { target: 'api' });
    expect(scheduler.checkNow).toHaveBeenCalledWith('h1');

    await run('health_pause', { target: 'API', paused: true });
    expect((await run('health_list')).data).toEqual([expect.objectContaining({ paused: true })]);
    expect(JSON.parse(readFileSync(userData.dataFile('health-targets.json'), 'utf-8'))).toEqual([
      expect.objectContaining({ id: 'h1', paused: true }),
    ]);
  });
});
