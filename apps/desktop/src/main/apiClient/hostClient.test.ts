import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, EngineRunInput } from './engine/types';
import { createHostEngine, type HostProcess } from './hostClient';

/**
 * The client side of the utility process that runs requests. The process itself is faked here:
 * these check the bookkeeping around it (starting it once, routing replies to the right run,
 * recovering when it dies, and putting it away when idle).
 */

class FakeHost extends EventEmitter implements HostProcess {
  sent: unknown[] = [];
  killed = false;
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  reply(message: unknown): void {
    this.emit('message', message);
  }
  runIds(): string[] {
    return this.sent
      .filter((m): m is { type: 'run'; runId: string } => (m as { type: string }).type === 'run')
      .map((m) => m.runId);
  }
}

const input: EngineRunInput = {
  collection: { info: { name: 'x', schema: 's' }, item: [] },
  options: {
    timeoutMs: 1000,
    strictSSL: true,
    followRedirects: true,
    maxInlineBodyBytes: 10,
    scriptsEnabled: true,
    proxy: null,
  },
};

const summary = (overrides = {}) => ({
  error: null,
  cancelled: false,
  environment: [],
  globals: [],
  collectionVariables: [],
  ...overrides,
});

let hosts: FakeHost[];
const spawn = vi.fn(() => {
  const host = new FakeHost();
  hosts.push(host);
  return host;
});

beforeEach(() => {
  hosts = [];
  spawn.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function started(engine: ReturnType<typeof createHostEngine>, onEvent = vi.fn()) {
  const run = engine.run(input, onEvent);
  await vi.advanceTimersByTimeAsync(0);
  return run;
}

describe('createHostEngine', () => {
  it('starts the host on first use and waits for it to say it is ready', async () => {
    const engine = createHostEngine({ spawn });
    expect(spawn).not.toHaveBeenCalled();

    engine.run(input, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(hosts[0]?.runIds()).toEqual([]);

    hosts[0]?.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);
    expect(hosts[0]?.runIds()).toHaveLength(1);
  });

  it('routes events and the summary to the run they belong to', async () => {
    const engine = createHostEngine({ spawn });
    const firstEvents: EngineEvent[] = [];
    const secondEvents: EngineEvent[] = [];
    const first = engine.run(input, (e) => firstEvents.push(e));
    const second = engine.run(input, (e) => secondEvents.push(e));
    await vi.advanceTimersByTimeAsync(0);
    const host = hosts[0] as FakeHost;
    host.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);

    const [firstId, secondId] = host.runIds();
    const event = { type: 'console', itemId: null, level: 'log', messages: ['hi'] };
    host.reply({ type: 'event', runId: secondId, event });
    host.reply({ type: 'done', runId: secondId, summary: summary({ error: 'two' }) });
    host.reply({ type: 'done', runId: firstId, summary: summary() });

    expect(await second.done).toMatchObject({ error: 'two' });
    expect(await first.done).toMatchObject({ error: null });
    expect(secondEvents).toEqual([event]);
    expect(firstEvents).toEqual([]);
  });

  it('ignores malformed messages and replies for runs it does not know', async () => {
    const engine = createHostEngine({ spawn });
    const run = engine.run(input, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const host = hosts[0] as FakeHost;
    host.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);

    host.reply('garbage');
    host.reply({ type: 'done', runId: 'someone-else', summary: summary() });
    host.reply({ type: 'done', runId: host.runIds()[0], summary: summary() });
    await expect(run.done).resolves.toMatchObject({ error: null });
  });

  it('asks the host to cancel a running request', async () => {
    const engine = createHostEngine({ spawn });
    const run = await started(engine);
    const host = hosts[0] as FakeHost;
    host.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);

    run.cancel();
    expect(host.sent).toContainEqual({ type: 'cancel', runId: host.runIds()[0] });
  });

  it('settles a run cancelled before the host was ready without sending it', async () => {
    const engine = createHostEngine({ spawn });
    const run = await started(engine);
    run.cancel();
    await expect(run.done).resolves.toMatchObject({ cancelled: true, error: null });

    hosts[0]?.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);
    expect(hosts[0]?.runIds()).toEqual([]);
  });

  it('fails running requests when the host dies, and starts a new host next time', async () => {
    const engine = createHostEngine({ spawn });
    const run = await started(engine);
    const host = hosts[0] as FakeHost;
    host.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);

    host.emit('exit', 1);
    await expect(run.done).resolves.toMatchObject({
      error: expect.stringMatching(/stopped unexpectedly/),
    });

    engine.run(input, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('gives up on a host that never gets ready', async () => {
    const engine = createHostEngine({ spawn, readyTimeoutMs: 1000 });
    const run = await started(engine);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(run.done).resolves.toMatchObject({
      error: expect.stringMatching(/did not start/),
    });
    expect(hosts[0]?.killed).toBe(true);
  });

  it('waits as long as the runtime takes to load once the host says it is alive', async () => {
    const engine = createHostEngine({ spawn, readyTimeoutMs: 1000, loadTimeoutMs: 60_000 });
    const run = await started(engine);
    const host = hosts[0] as FakeHost;
    host.reply({ type: 'alive' });
    // Well past the start limit: a cold disk can take this long to read Postman's runtime.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.killed).toBe(false);

    host.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);
    const [runId] = host.runIds();
    host.reply({ type: 'done', runId, summary: summary() });
    await expect(run.done).resolves.toMatchObject({ error: null });
  });

  it('still gives up on a host that is alive but never finishes loading', async () => {
    const engine = createHostEngine({ spawn, readyTimeoutMs: 1000, loadTimeoutMs: 60_000 });
    const run = await started(engine);
    hosts[0]?.reply({ type: 'alive' });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(run.done).resolves.toMatchObject({
      error: expect.stringMatching(/did not start/),
    });
    expect(hosts[0]?.killed).toBe(true);
  });

  it('reports a fatal error from the host to every running request', async () => {
    const engine = createHostEngine({ spawn });
    const run = await started(engine);
    const host = hosts[0] as FakeHost;
    host.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);
    host.reply({ type: 'fatal', error: 'out of memory' });
    await expect(run.done).resolves.toMatchObject({ error: 'out of memory' });
  });

  it('drops a host that fails before it is ready, and starts a new one next time', async () => {
    const engine = createHostEngine({ spawn });
    const run = await started(engine);
    hosts[0]?.reply({ type: 'fatal', error: 'An object could not be cloned.' });

    await expect(run.done).resolves.toMatchObject({
      error: expect.stringContaining('could not be cloned'),
    });
    expect(hosts[0]?.killed).toBe(true);

    engine.run(input, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('stops the host after it has been idle for a while', async () => {
    const engine = createHostEngine({ spawn, idleTimeoutMs: 5000 });
    const run = await started(engine);
    const host = hosts[0] as FakeHost;
    host.reply({ type: 'ready', runtimeVersion: '7' });
    await vi.advanceTimersByTimeAsync(0);
    host.reply({ type: 'done', runId: host.runIds()[0], summary: summary() });
    await run.done;

    await vi.advanceTimersByTimeAsync(4999);
    expect(host.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.killed).toBe(true);
  });

  it('shutdown stops the host and settles what is still running', async () => {
    const engine = createHostEngine({ spawn });
    const run = await started(engine);
    engine.shutdown();
    expect(hosts[0]?.killed).toBe(true);
    await expect(run.done).resolves.toMatchObject({ cancelled: true });
  });
});
