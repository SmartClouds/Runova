import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanName,
  createNotificationForwarder,
  type ForwarderDeps,
  forwardNotification,
  LISTENERS_FOR_MS,
  startNotificationForwarding,
  stopNotificationForwarding,
} from './forward';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function setup(options: { listeners?: number; signedIn?: boolean; fail?: boolean } = {}) {
  const calls: Call[] = [];
  let clock = 1_000;
  const deps: ForwarderDeps = {
    api: vi.fn(async <T>(method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (options.fail) throw new Error('offline');
      return (path.endsWith('listeners') ? { count: options.listeners ?? 1 } : {}) as T;
    }) as ForwarderDeps['api'],
    signedIn: async () => options.signedIn ?? true,
    now: () => clock,
  };
  return {
    calls,
    deps,
    forwarder: createNotificationForwarder(deps),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function posts(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'POST');
}

async function settle(calls: Call[], count: number): Promise<void> {
  await vi.waitFor(() => expect(posts(calls).length).toBe(count));
}

describe('notification forwarding', () => {
  afterEach(() => stopNotificationForwarding());

  it('forwards a category and bounded names', async () => {
    const { calls, forwarder } = setup();

    forwarder.forward({ category: 'agent-needs-input', agent: 'Claude Code', project: 'Shop' });

    await settle(calls, 1);
    expect(posts(calls)[0]).toMatchObject({
      method: 'POST',
      path: '/notification-events',
      body: {
        category: 'agent-needs-input',
        status: null,
        agent: 'Claude Code',
        project: 'Shop',
        subject: null,
        itemId: null,
      },
    });
  });

  it('sends only the known fields', async () => {
    const { calls, forwarder } = setup();

    forwarder.forward({
      category: 'pipelines',
      status: 'failed',
      project: 'Shop',
      subject: 'Build',
      // biome-ignore lint/suspicious/noExplicitAny: proving an extra property is not passed along
      ...({ message: 'npm ERR! whole terminal output', title: '$ rm -rf /' } as any),
    });

    await settle(calls, 1);
    expect(Object.keys(posts(calls)[0].body as object).sort()).toEqual([
      'agent',
      'category',
      'itemId',
      'project',
      'status',
      'subject',
    ]);
    expect(JSON.stringify(posts(calls)[0].body)).not.toContain('terminal output');
  });

  it('asks whether anyone listens once a minute', async () => {
    const { calls, forwarder, advance } = setup({ listeners: 1 });

    forwarder.forward({ category: 'agent-finished', agent: 'A', project: 'P' });
    await settle(calls, 1);
    forwarder.forward({ category: 'agent-finished', agent: 'A', project: 'P' });
    await settle(calls, 2);
    advance(LISTENERS_FOR_MS + 1);
    forwarder.forward({ category: 'agent-finished', agent: 'A', project: 'P' });
    await settle(calls, 3);

    expect(calls.filter((call) => call.path.endsWith('listeners')).length).toBe(2);
  });

  it('sends nothing when no phone is signed in', async () => {
    const { calls, forwarder } = setup({ listeners: 0 });

    forwarder.forward({ category: 'agent-finished', agent: 'A', project: 'P' });

    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(posts(calls)).toEqual([]);
  });

  it('sends nothing when signed out', async () => {
    const { calls, forwarder } = setup({ signedIn: false });

    forwarder.forward({ category: 'agent-finished', agent: 'A', project: 'P' });

    await vi.waitFor(() => expect(calls).toEqual([]));
  });

  it('never throws when the server can not be reached', async () => {
    const { calls, forwarder } = setup({ fail: true });

    expect(() =>
      forwarder.forward({ category: 'agent-finished', agent: 'A', project: 'P' }),
    ).not.toThrow();

    await vi.waitFor(() => expect(calls.length).toBe(1));
  });

  it('does nothing until forwarding has started', () => {
    expect(() => forwardNotification({ category: 'tool-updates', subject: 'Node' })).not.toThrow();
  });

  it('routes the module function through the started forwarder', async () => {
    const { calls, deps } = setup();
    startNotificationForwarding(deps);

    forwardNotification({ category: 'tool-updates', subject: 'Node' });

    await settle(calls, 1);
    expect(posts(calls)[0].body).toMatchObject({ category: 'tool-updates', subject: 'Node' });
  });

  it('turns terminal text into a harmless name, or nothing', () => {
    expect(cleanName('\u001b[31mfatal\u001b[0m', 80)).not.toContain('\u001b');
    expect(cleanName('line one\nline two', 80)).toBe('line one line two');
    expect(cleanName('$!', 80)).toBeUndefined();
    expect(cleanName('x'.repeat(200), 80)?.length).toBe(80);
  });

  it('drops an item id that is not an id', async () => {
    const { calls, forwarder } = setup();

    forwarder.forward({ category: 'agent-finished', agent: 'A', project: 'P', itemId: 'a b/c' });

    await settle(calls, 1);
    expect(posts(calls)[0].body).toMatchObject({ itemId: null });
  });
});
