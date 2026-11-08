import { decodeManageStream, type ManageMessage, parseManageMessage } from '@runova/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManageSession,
  type ManageAudit,
  ManageError,
  type ManageLink,
  type ManageMethods,
  type ManagePhone,
} from './session';

class FakeLink implements ManageLink {
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  bufferedAmount = 0;
  private onMessageListener: ((data: Buffer, isBinary: boolean) => void) | null = null;
  private onCloseListener: ((reason: string) => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onCloseListener?.('closed');
  }

  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void {
    this.onMessageListener = listener;
  }

  onClose(listener: (reason: string) => void): void {
    this.onCloseListener = listener;
  }

  fromPhone(message: ManageMessage | string): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    this.onMessageListener?.(Buffer.from(text, 'utf8'), false);
  }

  fromPhoneBinary(bytes: number[]): void {
    this.onMessageListener?.(Buffer.from(bytes), true);
  }

  messages(): ManageMessage[] {
    return this.sent
      .filter((s) => typeof s === 'string')
      .map((s) => parseManageMessage(s as string)!);
  }

  last(): ManageMessage {
    return this.messages().at(-1)!;
  }
}

const TABLE = {
  'things.read': { scope: 'core', risk: 'read' },
  'things.write': { scope: 'git', risk: 'write' },
  'things.secret': { scope: 'vault', risk: 'danger' },
  'things.watch': { scope: 'core', risk: 'read' },
  'things.noHandler': { scope: 'core', risk: 'read' },
} as const;

const phone: ManagePhone = { key: 'phone-key', name: 'Runova app', scopes: ['core', 'git'] };

function setup(methods: Partial<ManageMethods> = {}) {
  const link = new FakeLink();
  const audit = vi.fn<ManageAudit>();
  createManageSession({
    link,
    phone,
    deviceName: "Sam's desk",
    table: TABLE,
    methods: { calls: methods.calls ?? {}, streams: methods.streams ?? {} },
    audit,
  });
  return { link, audit };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('a management session', () => {
  it('says what this phone may do as soon as it opens', () => {
    const { link } = setup();

    expect(link.last()).toEqual({
      t: 'manage-ready',
      v: 1,
      deviceName: "Sam's desk",
      scopes: ['core', 'git'],
    });
  });

  it('answers a call with what the method returned', async () => {
    const { link } = setup({ calls: { 'things.read': () => [{ id: 'a' }] } });

    link.fromPhone({ t: 'rpc-call', id: 3, m: 'things.read' });
    await flush();

    expect(link.last()).toEqual({ t: 'rpc-result', id: 3, ok: true, v: [{ id: 'a' }] });
  });

  it('passes the parameters and says which phone is asking', async () => {
    const handler = vi.fn(() => 'done');
    const { link } = setup({ calls: { 'things.write': handler } });

    link.fromPhone({ t: 'rpc-call', id: 1, m: 'things.write', p: { a: 1 } });
    await flush();

    expect(handler).toHaveBeenCalledWith({ a: 1 }, { phone });
  });

  it.each(['nothing.here', '__proto__', 'constructor', 'toString', 'things.noHandler'])(
    'turns down %s without running anything',
    async (name) => {
      const { link } = setup({ calls: { 'things.read': () => 'x' } });

      link.fromPhone({ t: 'rpc-call', id: 1, m: name });
      await flush();

      expect(link.last()).toMatchObject({
        t: 'rpc-result',
        id: 1,
        ok: false,
        code: 'unknown-method',
      });
    },
  );

  it('refuses a method outside the phone’s scopes and records the attempt', async () => {
    const handler = vi.fn(() => 'secret');
    const { link, audit } = setup({ calls: { 'things.secret': handler } });

    link.fromPhone({ t: 'rpc-call', id: 1, m: 'things.secret' });
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(link.last()).toMatchObject({ ok: false, code: 'forbidden' });
    expect(audit).toHaveBeenCalledWith({
      phone: 'Runova app',
      method: 'things.secret',
      risk: 'danger',
      outcome: 'forbidden',
    });
  });

  it('records changes but not reads', async () => {
    const { link, audit } = setup({
      calls: { 'things.read': () => 1, 'things.write': () => 2 },
    });

    link.fromPhone({ t: 'rpc-call', id: 1, m: 'things.read' });
    link.fromPhone({ t: 'rpc-call', id: 2, m: 'things.write' });
    await flush();

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      phone: 'Runova app',
      method: 'things.write',
      risk: 'write',
      outcome: 'ok',
    });
  });

  it('keeps what went wrong inside to itself', async () => {
    const { link } = setup({
      calls: {
        'things.read': () => {
          throw new Error('C:\\Users\\sam\\secret-path failed');
        },
      },
    });

    link.fromPhone({ t: 'rpc-call', id: 1, m: 'things.read' });
    await flush();

    const result = link.last() as { message: string; code: string };
    expect(result.code).toBe('failed');
    expect(result.message).not.toContain('secret-path');
  });

  it('passes on a message a method wrote for the person', async () => {
    const { link } = setup({
      calls: {
        'things.read': () => {
          throw new ManageError('bad-params', 'That project is gone.');
        },
      },
    });

    link.fromPhone({ t: 'rpc-call', id: 1, m: 'things.read' });
    await flush();

    expect(link.last()).toMatchObject({
      ok: false,
      code: 'bad-params',
      message: 'That project is gone.',
    });
  });

  it('closes on anything that is not a management message', () => {
    const { link } = setup();

    link.fromPhone('{"t":"hello","protocolVersion":4}');

    expect(link.closed).toBe(true);
  });

  it('closes on binary from the phone, which it never needs to send', () => {
    const { link } = setup();

    link.fromPhoneBinary([1, 2, 3]);

    expect(link.closed).toBe(true);
  });

  it('turns away calls past the limit instead of queueing them without end', async () => {
    let release: (value: unknown) => void = () => undefined;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const { link } = setup({ calls: { 'things.read': () => blocked } });

    for (let id = 1; id <= 40; id++) link.fromPhone({ t: 'rpc-call', id, m: 'things.read' });
    await flush();

    const busy = link.messages().filter((m) => m.t === 'rpc-result' && !m.ok);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0]).toMatchObject({ code: 'busy' });
    release(1);
  });
});

describe('subscriptions', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  function watching() {
    const stop = vi.fn();
    let emit: Parameters<ManageMethods['streams'][string]>[1] | null = null;
    const session = setup({
      streams: {
        'things.watch': (_params, stream) => {
          emit = stream;
          return stop;
        },
      },
    });
    session.link.fromPhone({ t: 'rpc-sub', id: 5, m: 'things.watch' });
    return { ...session, stop, emit: () => emit! };
  }

  it('sends events under the subscription’s id', async () => {
    const { link, emit } = watching();
    await Promise.resolve();

    emit().event({ cpu: 12 });

    expect(link.last()).toEqual({ t: 'rpc-event', id: 5, v: { cpu: 12 } });
  });

  it('sends raw bytes as a stream frame', async () => {
    const { link, emit } = watching();
    await Promise.resolve();

    emit().binary(new Uint8Array([7, 8]));

    const frame = link.sent.at(-1) as Uint8Array;
    expect(decodeManageStream(frame)?.subscription).toBe(5);
    expect([...(decodeManageStream(frame)?.payload ?? [])]).toEqual([7, 8]);
  });

  it('stops when the phone stops listening', async () => {
    const { link, stop } = watching();
    await Promise.resolve();

    link.fromPhone({ t: 'rpc-unsub', id: 5 });

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops everything when the link goes away', async () => {
    const { link, stop } = watching();
    await Promise.resolve();

    link.close();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('tells the phone when a stream ends by itself', async () => {
    const { link, emit, stop } = watching();
    await Promise.resolve();

    emit().end();

    expect(link.last()).toEqual({ t: 'rpc-end', id: 5 });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('on a slow link sends only the latest value once it drains', async () => {
    const { link, emit } = watching();
    await Promise.resolve();
    link.bufferedAmount = 10_000_000;

    emit().event({ n: 1 });
    emit().event({ n: 2 });
    emit().event({ n: 3 });
    expect(link.messages().filter((m) => m.t === 'rpc-event')).toHaveLength(0);

    link.bufferedAmount = 0;
    vi.advanceTimersByTime(300);

    expect(link.messages().filter((m) => m.t === 'rpc-event')).toEqual([
      { t: 'rpc-event', id: 5, v: { n: 3 } },
    ]);
  });

  it('refuses a subscription id already in use', async () => {
    const { link } = watching();
    await Promise.resolve();

    link.fromPhone({ t: 'rpc-sub', id: 5, m: 'things.watch' });
    await Promise.resolve();

    expect(link.last()).toMatchObject({ t: 'rpc-end', id: 5, code: 'bad-params' });
  });
});
