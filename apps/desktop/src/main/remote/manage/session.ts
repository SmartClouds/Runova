import {
  encodeManageMessage,
  encodeManageStream,
  MANAGE_METHODS,
  MANAGE_VERSION,
  type ManageErrorCode,
  type ManageMessage,
  type ManageMethod,
  type ManageScope,
  parseManageMessage,
} from '@runova/protocol';

/**
 * One phone managing this computer (E71). It only reaches what the method table names and its
 * scopes allow, and this is the whole of what guards it: nothing here goes through `ipcMain`, so
 * the `senderFrame` checks those handlers rely on do not apply.
 */

export interface ManageLink {
  send(data: string | Uint8Array, options?: { binary?: boolean }): void;
  close(): void;
  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void;
  onClose(listener: (reason: string) => void): void;
  readonly bufferedAmount: number;
}

export interface ManagePhone {
  key: string;
  name: string;
  scopes: ManageScope[];
}

export interface ManageContext {
  phone: ManagePhone;
}

export interface ManageStreamSink {
  event(value: unknown): void;
  binary(payload: Uint8Array): void;
  /** The stream is over. With a code, it ended badly. */
  end(code?: ManageErrorCode, message?: string): void;
}

export type ManageCall = (params: unknown, context: ManageContext) => unknown;
export type ManageStream = (
  params: unknown,
  sink: ManageStreamSink,
  context: ManageContext,
) => (() => void) | Promise<() => void>;

export interface ManageMethods {
  calls: Record<string, ManageCall>;
  streams: Record<string, ManageStream>;
}

export type ManageAudit = (entry: {
  phone: string;
  method: string;
  risk: ManageMethod['risk'];
  outcome: 'ok' | 'failed' | 'forbidden';
}) => void;

/** A failure whose message is written for the person holding the phone. */
export class ManageError extends Error {
  constructor(
    readonly code: ManageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManageError';
  }
}

const MAX_CALLS_IN_FLIGHT = 16;
const MAX_SUBSCRIPTIONS = 32;
/** Past this many unsent bytes, a stream of values keeps only its latest. */
const SLOW_LINK_BYTES = 1024 * 1024;
/** Past this many unsent bytes a phone has stopped reading. It can follow again from a snapshot. */
const STALLED_LINK_BYTES = 32 * 1024 * 1024;
const DRAIN_CHECK_MS = 100;

interface Subscription {
  stop: (() => void) | null;
  ended: boolean;
  latest: { value: unknown } | null;
  timer: NodeJS.Timeout | null;
}

export function createManageSession(options: {
  link: ManageLink;
  phone: ManagePhone;
  deviceName: string;
  methods: ManageMethods;
  audit: ManageAudit;
  table?: Readonly<Record<string, ManageMethod>>;
}): void {
  const { link, phone, methods, audit } = options;
  const table = options.table ?? MANAGE_METHODS;
  const subscriptions = new Map<number, Subscription>();
  let inFlight = 0;
  let closed = false;

  const send = (message: ManageMessage) => {
    if (!closed) link.send(encodeManageMessage(message));
  };

  const refuse = (id: number, code: ManageErrorCode, message: string) =>
    send({ t: 'rpc-result', id, ok: false, code, message });

  /** The method, when it is in the table. Own properties only, so `__proto__` is just a name. */
  function look(name: string): ManageMethod | null {
    return Object.hasOwn(table, name) ? (table[name] as ManageMethod) : null;
  }

  function allowed(name: string, method: ManageMethod): boolean {
    if (phone.scopes.includes(method.scope)) return true;
    audit({ phone: phone.name, method: name, risk: method.risk, outcome: 'forbidden' });
    return false;
  }

  function record(name: string, method: ManageMethod, outcome: 'ok' | 'failed'): void {
    if (method.risk !== 'read' || method.audited)
      audit({ phone: phone.name, method: name, risk: method.risk, outcome });
  }

  async function call(id: number, name: string, params: unknown): Promise<void> {
    const method = look(name);
    const handler = method && Object.hasOwn(methods.calls, name) ? methods.calls[name] : null;
    if (!method || !handler) {
      refuse(id, 'unknown-method', 'This computer does not know that command.');
      return;
    }
    if (!allowed(name, method)) {
      refuse(id, 'forbidden', 'This phone is not allowed to do that on this computer.');
      return;
    }
    if (inFlight >= MAX_CALLS_IN_FLIGHT) {
      refuse(id, 'busy', 'This computer is busy. Try again in a moment.');
      return;
    }
    inFlight++;
    try {
      const value = await handler(params, { phone });
      record(name, method, 'ok');
      send({ t: 'rpc-result', id, ok: true, v: value });
    } catch (error) {
      record(name, method, 'failed');
      if (error instanceof ManageError) refuse(id, error.code, error.message);
      else refuse(id, 'failed', 'That did not work on this computer.');
    } finally {
      inFlight--;
    }
  }

  const end = (id: number, code: ManageErrorCode, message: string) =>
    send({ t: 'rpc-end', id, code, message });

  function stopSubscription(id: number, subscription: Subscription): void {
    subscriptions.delete(id);
    subscription.ended = true;
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = null;
    subscription.stop?.();
    subscription.stop = null;
  }

  function flushLatest(id: number, subscription: Subscription): void {
    subscription.timer = null;
    if (subscription.ended || !subscription.latest) return;
    if (link.bufferedAmount >= SLOW_LINK_BYTES) {
      subscription.timer = setTimeout(() => flushLatest(id, subscription), DRAIN_CHECK_MS);
      return;
    }
    const { value } = subscription.latest;
    subscription.latest = null;
    send({ t: 'rpc-event', id, v: value });
  }

  async function subscribe(id: number, name: string, params: unknown): Promise<void> {
    if (subscriptions.has(id)) {
      end(id, 'bad-params', 'That subscription id is already in use.');
      return;
    }
    const method = look(name);
    const start = method && Object.hasOwn(methods.streams, name) ? methods.streams[name] : null;
    if (!method || !start) {
      end(id, 'unknown-method', 'This computer does not know that command.');
      return;
    }
    if (!allowed(name, method)) {
      end(id, 'forbidden', 'This phone is not allowed to do that on this computer.');
      return;
    }
    if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
      end(id, 'busy', 'This computer is busy. Try again in a moment.');
      return;
    }
    if (method.audited) record(name, method, 'ok');
    const subscription: Subscription = { stop: null, ended: false, latest: null, timer: null };
    subscriptions.set(id, subscription);
    const sink: ManageStreamSink = {
      event(value) {
        if (subscription.ended) return;
        if (link.bufferedAmount < SLOW_LINK_BYTES && !subscription.latest) {
          send({ t: 'rpc-event', id, v: value });
          return;
        }
        subscription.latest = { value };
        subscription.timer ??= setTimeout(() => flushLatest(id, subscription), DRAIN_CHECK_MS);
      },
      binary(payload) {
        if (subscription.ended || closed) return;
        if (link.bufferedAmount >= STALLED_LINK_BYTES) {
          stopSubscription(id, subscription);
          end(id, 'busy', 'The phone stopped keeping up with this.');
          return;
        }
        link.send(encodeManageStream(id, payload), { binary: true });
      },
      end(code, message) {
        if (subscription.ended) return;
        stopSubscription(id, subscription);
        send(
          code ? { t: 'rpc-end', id, code, ...(message ? { message } : {}) } : { t: 'rpc-end', id },
        );
      },
    };
    try {
      const stop = await start(params, sink, { phone });
      if (subscription.ended) stop();
      else subscription.stop = stop;
    } catch (error) {
      if (subscription.ended) return;
      stopSubscription(id, subscription);
      if (error instanceof ManageError) end(id, error.code, error.message);
      else end(id, 'failed', 'That did not work on this computer.');
    }
  }

  link.onMessage((data, isBinary) => {
    const message = isBinary ? null : parseManageMessage(data.toString('utf8'));
    if (!message) {
      // A phone speaking anything else is broken or hostile; there is nothing to recover.
      link.close();
      return;
    }
    switch (message.t) {
      case 'rpc-call':
        void call(message.id, message.m, message.p);
        break;
      case 'rpc-sub':
        void subscribe(message.id, message.m, message.p);
        break;
      case 'rpc-unsub': {
        const subscription = subscriptions.get(message.id);
        if (subscription) stopSubscription(message.id, subscription);
        break;
      }
      default:
        link.close();
    }
  });

  link.onClose(() => {
    closed = true;
    for (const [id, subscription] of [...subscriptions]) stopSubscription(id, subscription);
  });

  send({
    t: 'manage-ready',
    v: MANAGE_VERSION,
    deviceName: options.deviceName,
    scopes: phone.scopes,
  });
}
