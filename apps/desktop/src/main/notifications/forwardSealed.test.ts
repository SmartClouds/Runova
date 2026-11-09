import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNotificationForwarder, type ForwarderDeps, LISTENERS_FOR_MS } from './forward';
import { sealKeyId } from './sealedItem';

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function phoneKey(): string {
  const { x } = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
  return x as string;
}

function setup(options: { sealing?: boolean; keys?: string[]; refuseSealed?: number } = {}) {
  const calls: Call[] = [];
  let clock = 1_000;
  const api: ForwarderDeps['api'] = async <T>(method: string, path: string, body?: unknown) => {
    if (path === '/accounts/me/notification-listeners') {
      calls.push({ method, path, body: {} });
      return { count: 1, sealing: options.sealing ?? true } as T;
    }
    const sent = body as Record<string, unknown>;
    calls.push({ method, path, body: sent });
    if (options.refuseSealed && sent.sealedFor) {
      throw Object.assign(new Error('nope'), { problem: { status: options.refuseSealed } });
    }
    return undefined as T;
  };
  const logs: string[] = [];
  const forwarder = createNotificationForwarder({
    api,
    signedIn: async () => true,
    now: () => clock,
    log: (message) => logs.push(message),
    sealKeys: async () => options.keys ?? [],
  });
  return {
    calls,
    logs,
    forwarder,
    posts: () => calls.filter((call) => call.path === '/notification-events'),
    tick: (ms: number) => {
      clock += ms;
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 5)),
  };
}

const event = {
  category: 'deploys' as const,
  status: 'critical',
  subject: 'prod',
  project: 'Shop',
  agent: 'Codex',
  itemId: 'p1',
};

describe('forwarding when notifications are encrypted', () => {
  it('sends the category and sealed copies, and none of the names', async () => {
    const key = phoneKey();
    const world = setup({ keys: [key] });

    world.forwarder.forward(event);
    await world.settle();

    const [post] = world.posts();
    expect(Object.keys(post?.body ?? {}).sort()).toEqual(['category', 'itemId', 'sealedFor']);
    expect(post?.body.category).toBe('deploys');
    const copies = (post?.body.sealedFor ?? []) as { keyId: string; sealed: string }[];
    const copy = copies[0];
    expect(copy?.keyId).toBe(sealKeyId(Buffer.from(key, 'base64url')));
    expect(JSON.stringify(post?.body)).not.toContain('prod');
    expect(JSON.stringify(post?.body)).not.toContain('Critical');
  });

  it('makes one copy for each phone, up to the limit', async () => {
    const world = setup({ keys: Array.from({ length: 12 }, phoneKey) });

    world.forwarder.forward(event);
    await world.settle();

    expect(world.posts()[0]?.body.sealedFor).toHaveLength(8);
  });

  it('still sends an event with no copies when it knows no phone yet', async () => {
    const world = setup({ keys: [] });

    world.forwarder.forward(event);
    await world.settle();

    const [post] = world.posts();
    expect(post?.body.sealedFor).toEqual([]);
    expect(post?.body.subject).toBeUndefined();
  });

  it('skips a key that is not a key, and keeps the good ones', async () => {
    const world = setup({ keys: ['not-a-key', phoneKey()] });

    world.forwarder.forward(event);
    await world.settle();

    expect(world.posts()[0]?.body.sealedFor).toHaveLength(1);
  });

  it('drops an event the templates can not word, rather than sending it plain', async () => {
    const world = setup({ keys: [phoneKey()] });

    world.forwarder.forward({ category: 'deploys', status: 'exploded' });
    await world.settle();

    expect(world.posts()).toEqual([]);
  });

  it('goes back to normal when the plan no longer covers it', async () => {
    const world = setup({ keys: [phoneKey()], refuseSealed: 403 });

    world.forwarder.forward(event);
    await world.settle();

    const posts = world.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body.sealedFor).toBeUndefined();
    expect(posts[1]?.body.subject).toBe('prod');
  });

  it('asks again straight after the plan turned it down', async () => {
    const world = setup({ keys: [phoneKey()], refuseSealed: 403 });

    world.forwarder.forward(event);
    await world.settle();
    world.forwarder.forward(event);
    await world.settle();

    const asked = world.calls.filter((call) => call.path.endsWith('notification-listeners'));
    expect(asked).toHaveLength(2);
  });

  it('never sends plain after any other failure', async () => {
    const world = setup({ keys: [phoneKey()], refuseSealed: 500 });

    world.forwarder.forward(event);
    await world.settle();

    expect(world.posts()).toHaveLength(1);
    expect(world.logs).toHaveLength(1);
  });

  it('stays plain when the switch is off', async () => {
    const world = setup({ sealing: false, keys: [phoneKey()] });

    world.forwarder.forward(event);
    await world.settle();

    expect(world.posts()[0]?.body.subject).toBe('prod');
    expect(world.posts()[0]?.body.sealedFor).toBeUndefined();
  });

  it('notices a change of the switch at once when told to', async () => {
    const world = setup({ keys: [phoneKey()] });
    world.forwarder.forward(event);
    await world.settle();

    world.forwarder.refresh();
    world.tick(LISTENERS_FOR_MS - 1);
    world.forwarder.forward(event);
    await world.settle();

    const asked = world.calls.filter((call) => call.path.endsWith('notification-listeners'));
    expect(asked).toHaveLength(2);
  });
});
