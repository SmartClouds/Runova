import { describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/** What agents did through AI access, newest first, kept to the last 200 calls across restarts. */

useTempUserData();

const load = () => import('./audit');

const entry = (tool: string) => ({
  tool,
  toolTitle: tool,
  area: 'projects' as const,
  risk: 'read' as const,
  agent: 'Claude Code',
  callerKind: 'runova' as const,
  projectId: null,
  projectName: null,
  outcome: 'auto' as const,
});

describe('AI access activity', () => {
  it('records calls newest first with a time and an id', async () => {
    const { aiAccessActivity } = await load();

    await aiAccessActivity.record(entry('one'));
    await aiAccessActivity.record(entry('two'));

    const list = await aiAccessActivity.list();
    expect(list.map((item) => item.tool)).toEqual(['two', 'one']);
    expect(list[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), at: expect.any(Number) }),
    );
  });

  it('keeps only the last 200 calls', async () => {
    const { aiAccessActivity, AI_ACCESS_ACTIVITY_LIMIT } = await load();
    expect(AI_ACCESS_ACTIVITY_LIMIT).toBe(200);

    for (let index = 0; index < 205; index += 1) await aiAccessActivity.record(entry(`t${index}`));

    const list = await aiAccessActivity.list();
    expect(list).toHaveLength(200);
    expect(list[0].tool).toBe('t204');
    expect(list.at(-1)?.tool).toBe('t5');
  });

  it('survives a restart and can be cleared', async () => {
    const first = await load();
    await first.aiAccessActivity.record(entry('kept'));

    vi.resetModules();
    const second = await load();
    expect((await second.aiAccessActivity.list()).map((item) => item.tool)).toEqual(['kept']);

    await second.aiAccessActivity.clear();
    expect(await second.aiAccessActivity.list()).toEqual([]);
  });

  it('tells listeners about each new entry', async () => {
    const { aiAccessActivity } = await load();
    const listener = vi.fn();
    const stop = aiAccessActivity.subscribe(listener);

    await aiAccessActivity.record(entry('seen'));
    stop();
    await aiAccessActivity.record(entry('unseen'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ tool: 'seen' }));
  });
});
