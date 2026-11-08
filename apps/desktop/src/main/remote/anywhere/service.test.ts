import type { ManageScope } from '@runova/protocol';
import { b64u, derivePasswordSecret, fromB64u, identityFromSeed } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AnywhereIncoming, AnywhereState } from '../../../shared/anywhere';
import type { ManagePhone } from '../manage/session';
import type { AgentConfigFile } from './agentInstaller';
import type { AnywhereApi, RegisteredDevice } from './api';
import type { AnywhereHub, AnywhereHubHandlers, HubConnectResult } from './hub';
import type { LinkTransport } from './link';
import type { LinkOpener, OpenedLink } from './links';
import {
  type AnywhereManagerPort,
  createAnywhereService,
  type ManagePort,
  type SavedPasswords,
} from './service';
import { type AnywhereStoreIo, createAnywhereStore } from './settings';

// --- A pretend website: devices, teams, presence and the hub's routing ---------------

interface ServerDevice {
  id: number;
  userId: number;
  remoteId: string;
  name: string;
  platform: 'windows' | 'macos' | 'linux';
  identityKey: string;
  allowOwnDevices: boolean;
  unattendedEnabled: boolean;
  teamIds: number[];
}

class FakeServer {
  readonly devices: ServerDevice[] = [];
  readonly teams = new Map<number, { name: string; members: number[] }>();
  readonly online = new Map<number, AnywhereHubHandlers>();
  readonly users = new Map<number, { displayName: string; email: string }>();
  readonly sessions = new Map<
    string,
    { host: AnywhereHubHandlers; controller: AnywhereHubHandlers; accepted: boolean }
  >();
  readonly connected: { sessionId: string; transport: string }[] = [];
  readonly requests: { remoteId: string; mode: string }[] = [];
  readonly agents = new Map<number, string>();
  /** Computers whose app is away, so requests reach the background agent. */
  readonly agentAnswers = new Set<number>();
  private nextId = 1;
  private nextSession = 1;

  user(userId: number, displayName: string): void {
    this.users.set(userId, { displayName, email: `${displayName.toLowerCase()}@example.com` });
  }

  team(id: number, name: string, members: number[]): void {
    this.teams.set(id, { name, members });
  }

  private shared(device: ServerDevice, userId: number): string[] {
    return device.teamIds
      .map((id) => this.teams.get(id))
      .filter(
        (t): t is { name: string; members: number[] } =>
          !!t && t.members.includes(userId) && t.members.includes(device.userId),
      )
      .map((t) => t.name);
  }

  api(userId: number): AnywhereApi {
    const toDto = (d: ServerDevice): RegisteredDevice => ({
      id: d.id,
      remoteId: d.remoteId,
      name: d.name,
      platform: d.platform,
      allowOwnDevices: d.allowOwnDevices,
      unattendedEnabled: d.unattendedEnabled,
      teamIds: d.teamIds,
    });
    const entry = (d: ServerDevice) => ({
      id: d.id,
      remoteId: d.remoteId,
      name: d.name,
      platform: d.platform,
      kind: 'app' as const,
      identityKey: d.identityKey,
      unattendedEnabled: d.unattendedEnabled,
      online: this.online.has(d.id),
      lastSeenAt: '2026-11-08T09:00:00Z',
      owner: {
        userId: d.userId,
        displayName: this.users.get(d.userId)?.displayName ?? '',
        email: '',
      },
      teams: [],
    });
    return {
      register: async (input) => {
        let device = this.devices.find((d) => d.userId === userId && d.name === input.name);
        if (!device) {
          device = {
            id: this.nextId,
            userId,
            remoteId: String(100_000_000 + this.nextId++ * 111),
            name: input.name,
            platform: input.platform,
            identityKey: input.identityKey,
            allowOwnDevices: false,
            unattendedEnabled: false,
            teamIds: [],
          };
          this.devices.push(device);
        }
        device.identityKey = input.identityKey;
        return toDto(device);
      },
      update: async (id, patch) => {
        const device = this.devices.find((d) => d.id === id && d.userId === userId);
        if (!device) throw new Error('404');
        Object.assign(
          device,
          Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        );
        return toDto(device);
      },
      remove: async () => undefined,
      reachable: async () => ({
        mine: this.devices.filter((d) => d.userId === userId).map(entry),
        teammates: this.devices
          .filter((d) => d.userId !== userId && this.shared(d, userId).length > 0)
          .map(entry),
      }),
      teams: async () =>
        [...this.teams.entries()]
          .filter(([, t]) => t.members.includes(userId))
          .map(([id, t]) => ({ id, name: t.name })),
      sessions: async () => [],
      deleteSession: async () => undefined,
      enableAgent: async (id, identityKey) => {
        const device = this.devices.find((d) => d.id === id && d.userId === userId);
        if (!device) throw new Error('404');
        this.agents.set(id, identityKey);
        return { identityKey, agentSecret: `ras1.secret-for-${id}` };
      },
      disableAgent: async (id) => {
        this.agents.delete(id);
      },
    };
  }

  hub(userId: number): AnywhereHub & { handlers: AnywhereHubHandlers | null } {
    let handlers: AnywhereHubHandlers | null = null;
    const server = this;
    return {
      get handlers() {
        return handlers;
      },
      start: async (h) => {
        handlers = h;
      },
      stop: async () => {
        for (const [id, h] of server.online) if (h === handlers) server.online.delete(id);
      },
      goOnline: async (deviceId) => {
        if (handlers) server.online.set(deviceId, handlers);
      },
      requestConnect: async ({
        remoteId,
        mode,
        controllerDeviceId,
        intent,
      }): Promise<HubConnectResult> => {
        server.requests.push({ remoteId, mode });
        const none: HubConnectResult = {
          status: 'unavailable',
          sessionId: null,
          relation: null,
          host: null,
        };
        const target = server.devices.find((d) => d.remoteId === remoteId);
        if (!target || !handlers) return none;
        const teams = target.userId === userId ? [] : server.shared(target, userId);
        const relation = target.userId === userId ? 'own' : teams.length > 0 ? 'teammate' : 'other';
        const allowed = mode === 'ask' ? relation !== 'other' : target.unattendedEnabled;
        if (!allowed) return none;
        const host = server.online.get(target.id);
        if (!host) return { status: 'offline', sessionId: null, relation: null, host: null };
        const sessionId = `s${server.nextSession++}`;
        server.sessions.set(sessionId, { host, controller: handlers, accepted: false });
        const from = server.devices.find((d) => d.id === controllerDeviceId && d.userId === userId);
        const user = server.users.get(userId);
        host.incoming({
          sessionId,
          mode,
          relation,
          intent,
          controller: {
            userId,
            displayName: user?.displayName ?? '',
            email: user?.email ?? '',
            deviceName: from?.name ?? null,
            platform: from?.platform ?? null,
            remoteId: from?.remoteId ?? null,
            identityKey: from?.identityKey ?? null,
          },
          teams,
        });
        return {
          status: 'ringing',
          sessionId,
          relation,
          host: {
            remoteId,
            name: relation === 'other' ? '' : target.name,
            platform: target.platform,
            kind: server.agentAnswers.has(target.id) ? 'agent' : 'app',
            identityKey: server.agentAnswers.has(target.id)
              ? (server.agents.get(target.id) ?? '')
              : target.identityKey,
          },
        };
      },
      respond: async (sessionId, accept) => {
        const session = server.sessions.get(sessionId);
        if (!session || session.host !== handlers) throw new Error('no such request');
        if (accept) session.accepted = true;
        else server.sessions.delete(sessionId);
        session.controller.resolved({
          sessionId,
          accepted: accept,
          reason: accept ? null : 'declined',
        });
      },
      signal: async (sessionId, payload) => {
        const session = server.sessions.get(sessionId);
        if (!session?.accepted) throw new Error('no such session');
        (session.host === handlers ? session.controller : session.host).signal(sessionId, payload);
      },
      connected: async (sessionId, transport) => {
        server.connected.push({ sessionId, transport });
      },
      relayTicket: async (sessionId) => ({ path: `/relay/remote/${sessionId}`, ticket: 't' }),
      end: async (sessionId) => {
        const session = server.sessions.get(sessionId);
        if (!session) return;
        server.sessions.delete(sessionId);
        (session.host === handlers ? session.controller : session.host).ended({
          sessionId,
          reason: 'ended',
        });
      },
    };
  }
}

// --- Links: both computers' open() calls for a session meet in memory ----------------

class FakeLinks {
  private readonly waiting = new Map<string, (link: OpenedLink) => void>();

  opener(): LinkOpener {
    return {
      open: ({ sessionId }) =>
        new Promise<OpenedLink>((resolve) => {
          const other = this.waiting.get(sessionId);
          if (!other) {
            this.waiting.set(sessionId, resolve);
            return;
          }
          this.waiting.delete(sessionId);
          const [a, b] = transportPair();
          other({ transport: a, kind: 'direct', localFingerprint: '', remoteFingerprint: '' });
          resolve({ transport: b, kind: 'direct', localFingerprint: '', remoteFingerprint: '' });
        }),
      deliverSignal: () => undefined,
      cancel: (sessionId) => this.waiting.delete(sessionId),
    };
  }
}

function transportPair(): [LinkTransport, LinkTransport] {
  const make = () => {
    const frames: ((f: Uint8Array) => void)[] = [];
    const closes: ((r: string) => void)[] = [];
    let peer: { frames: typeof frames; closes: typeof closes; closed: boolean } | null = null;
    const self = { frames, closes, closed: false };
    const transport: LinkTransport = {
      send: (frame) =>
        setTimeout(() => peer && !peer.closed && peer.frames.forEach((l) => l(frame)), 0),
      bufferedAmount: () => 0,
      close: (reason) => {
        if (self.closed) return;
        self.closed = true;
        for (const l of closes) l(reason);
        setTimeout(() => {
          if (peer && !peer.closed) {
            peer.closed = true;
            for (const l of peer.closes) l(reason);
          }
        }, 0);
      },
      onFrame: (l) => frames.push(l),
      onClose: (l) => closes.push(l),
    };
    return { transport, self, connect: (p: typeof self) => (peer = p) };
  };
  const a = make();
  const b = make();
  a.connect(b.self);
  b.connect(a.self);
  return [a.transport, b.transport];
}

// --- One computer ------------------------------------------------------------------

function memoryIo(): AnywhereStoreIo {
  let file: unknown = null;
  return {
    read: async () => file,
    write: async (value) => {
      file = JSON.parse(JSON.stringify(value));
    },
    canSeal: () => true,
    seal: (plain) => `sealed:${plain}`,
    open: (sealed) => sealed.slice('sealed:'.length),
  };
}

function memoryPasswords(): SavedPasswords & {
  entries: Map<string, { hostKey: string; secret: Uint8Array }>;
} {
  const entries = new Map<string, { hostKey: string; secret: Uint8Array }>();
  return {
    entries,
    get: async (remoteId, hostKey) => {
      const e = entries.get(remoteId);
      return e && e.hostKey === hostKey ? e.secret : null;
    },
    has: async (remoteId) => entries.has(remoteId),
    set: async (remoteId, hostKey, secret) => {
      entries.set(remoteId, { hostKey, secret });
    },
    forget: async (remoteId) => {
      entries.delete(remoteId);
    },
  };
}

function fakeManager() {
  const port = {
    hostPeers: [] as {
      link: unknown;
      info: Parameters<AnywhereManagerPort['attachHostPeer']>[1];
    }[],
    clients: [] as { link: unknown; info: Parameters<AnywhereManagerPort['attachClient']>[1] }[],
    windows: 0,
    ended: [] as string[],
    paused: false,
    attachHostPeer: vi.fn(
      (link: unknown, info: Parameters<AnywhereManagerPort['attachHostPeer']>[1]) => {
        port.hostPeers.push({ link, info });
        return `peer-${port.hostPeers.length}`;
      },
    ),
    attachClient: vi.fn(
      (link: unknown, info: Parameters<AnywhereManagerPort['attachClient']>[1]) => {
        port.clients.push({ link, info });
      },
    ),
    openSessionWindow: vi.fn(() => {
      port.windows++;
    }),
    endHostPeer: vi.fn((peerId: string) => {
      port.ended.push(peerId);
    }),
    setInputPaused: vi.fn((paused: boolean) => {
      port.paused = paused;
    }),
  };
  return port;
}

function fakeInstaller(options: { fail?: boolean } = {}) {
  const installer = {
    configs: [] as AgentConfigFile[],
    isInstalled: false,
    unavailable: () => null,
    installed: async () => installer.isInstalled,
    install: async (config: AgentConfigFile) => {
      if (options.fail)
        throw new Error('Windows did not get permission to set up the background service.');
      installer.configs.push(config);
      installer.isInstalled = true;
    },
    uninstall: async () => {
      installer.isInstalled = false;
    },
  };
  return installer;
}

function fakeManage() {
  const port = {
    sessions: [] as { link: { close(): void }; phone: ManagePhone }[],
    attach: vi.fn((link: { close(): void }, phone: ManagePhone) => {
      port.sessions.push({ link, phone });
    }),
  };
  return port;
}

function computer(
  server: FakeServer,
  links: FakeLinks,
  userId: number,
  name: string,
  options: {
    ringMs?: number;
    installer?: ReturnType<typeof fakeInstaller>;
    registerGate?: Promise<void>;
    checkAccount?: () => void;
  } = {},
) {
  const manager = fakeManager();
  const manage = fakeManage();
  const installer = options.installer ?? fakeInstaller();
  const passwords = memoryPasswords();
  const incoming: AnywhereIncoming[] = [];
  const notices: string[] = [];
  let state: AnywhereState | null = null;
  const hub = server.hub(userId);
  const api = server.api(userId);
  const service = createAnywhereService({
    api: options.registerGate
      ? {
          ...api,
          register: async (input) => {
            await options.registerGate;
            return api.register(input);
          },
        }
      : api,
    hub,
    store: createAnywhereStore(memoryIo()),
    links: links.opener(),
    manager: manager as unknown as AnywhereManagerPort,
    manage: manage as unknown as ManagePort,
    passwords,
    account: async () => ({
      deviceId: `device-${userId}`,
      displayName: server.users.get(userId)?.displayName ?? '',
      email: '',
    }),
    device: { name, platform: 'windows' },
    announce: (s) => {
      state = s;
    },
    showIncoming: (request) => incoming.push(request),
    hostedChanged: () => undefined,
    notify: (title, body) => notices.push(`${title}: ${body}`),
    ringMs: options.ringMs ?? 60_000,
    siteUrl: 'https://runovahq.test',
    agent: installer,
    ...(options.checkAccount ? { checkAccount: options.checkAccount } : {}),
  });
  return {
    service,
    installer,
    manager,
    manage,
    passwords,
    incoming,
    notices,
    hub,
    state: () => {
      if (!state) throw new Error('nothing announced yet');
      return state;
    },
  };
}

async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Sam (1) owns the host and is in Ops with Kim (2); Lee (3) is a stranger. */
async function world(options: { ringMs?: number } = {}) {
  const server = new FakeServer();
  server.user(1, 'Sam');
  server.user(2, 'Kim');
  server.user(3, 'Lee');
  server.team(10, 'Ops', [1, 2]);
  const links = new FakeLinks();
  const sam = computer(server, links, 1, "Sam's desk", options);
  const kim = computer(server, links, 2, "Kim's laptop", options);
  const lee = computer(server, links, 3, "Lee's PC", options);
  await sam.service.start();
  await kim.service.start();
  await lee.service.start();
  const samId = sam.state().device?.remoteId ?? '';
  return { server, links, sam, kim, lee, samId };
}

describe('Runova Anywhere service: starting', () => {
  it('registers this computer, goes online, and tells the server nothing is allowed yet', async () => {
    const { server, sam, samId } = await world();

    expect(sam.state().status).toBe('online');
    expect(samId).toMatch(/^\d{9}$/);
    expect(server.online.has(sam.state().device?.id ?? -1)).toBe(true);
    const device = server.devices.find((d) => d.remoteId === samId);
    expect(device).toMatchObject({ allowOwnDevices: false, unattendedEnabled: false, teamIds: [] });
  });

  it('stays signed out without an account', async () => {
    const server = new FakeServer();
    const links = new FakeLinks();
    const announced: AnywhereState[] = [];
    const service = createAnywhereService({
      api: server.api(1),
      hub: server.hub(1),
      store: createAnywhereStore(memoryIo()),
      links: links.opener(),
      manager: fakeManager() as unknown as AnywhereManagerPort,
      passwords: memoryPasswords(),
      account: async () => null,
      device: { name: 'PC', platform: 'linux' },
      announce: (s) => announced.push(s),
      showIncoming: () => undefined,
      hostedChanged: () => undefined,
      notify: () => undefined,
    });

    await service.start();

    expect(service.state().status).toBe('signed-out');
    expect(server.devices).toEqual([]);
  });
});

describe('Runova Anywhere service: a teammate asks', () => {
  async function shownToOps() {
    const w = await world();
    await w.sam.service.updateSettings({ teamIds: [10] });
    await w.kim.service.refresh();
    return w;
  }

  it('shows the request to the person, and connects both sides once they accept', async () => {
    const { server, sam, kim, samId } = await shownToOps();

    await kim.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => sam.incoming.length === 1, 'the request window');
    expect(kim.state().outgoing).toMatchObject({ phase: 'waiting', hostName: "Sam's desk" });
    expect(sam.incoming[0]).toMatchObject({
      relation: 'teammate',
      teams: ['Ops'],
      controller: { displayName: 'Kim' },
    });

    await sam.service.respondIncoming(sam.incoming[0].sessionId, {
      accept: true,
      permissions: { control: false, clipboard: true, files: false },
      alwaysAllow: false,
    });
    await until(() => kim.state().outgoing?.phase === 'connected', 'connected');
    await until(() => sam.state().hosted.length === 1, 'hosted');

    expect(kim.manager.attachClient).toHaveBeenCalledWith(expect.anything(), {
      deviceName: "Sam's desk",
      intent: 'control',
    });
    expect(kim.manager.windows).toBe(1);
    expect(sam.manager.hostPeers[0].info).toMatchObject({
      intent: 'control',
      permissions: { control: false, clipboard: true, files: false },
    });
    expect(sam.state().hosted[0]).toMatchObject({ controllerName: 'Kim', transport: 'direct' });
    expect(kim.state().outgoing?.safetyCode).toBe(sam.state().hosted[0].safetyCode);
    expect(server.connected).toEqual([
      { sessionId: sam.incoming[0].sessionId, transport: 'direct' },
    ]);
    expect(sam.notices.some((n) => n.includes('Kim'))).toBe(true);
  });

  it('tells the controller when the person declines', async () => {
    const { sam, kim, samId } = await shownToOps();

    await kim.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, {
      accept: false,
      permissions: { control: true, clipboard: true, files: false },
      alwaysAllow: false,
    });
    await until(() => kim.state().outgoing?.phase === 'failed');

    expect(kim.state().outgoing?.error).toMatch(/declined/);
    expect(sam.state().incoming).toEqual([]);
  });

  it('declines on its own when no one answers in time', async () => {
    const w = await world({ ringMs: 50 });
    await w.sam.service.updateSettings({ teamIds: [10] });
    await w.kim.service.refresh();

    await w.kim.service.connect({ remoteId: w.samId, intent: 'control' });
    await until(() => w.kim.state().outgoing?.phase === 'failed', 'declined after the timeout');

    expect(w.sam.state().incoming).toEqual([]);
  });

  it('lets in a teammate who is always allowed without asking', async () => {
    const { sam, kim, samId } = await shownToOps();
    await kim.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, {
      accept: true,
      permissions: { control: true, clipboard: true, files: false },
      alwaysAllow: true,
    });
    await until(() => kim.state().outgoing?.phase === 'connected');
    expect(sam.state().settings.alwaysAllow).toEqual([{ userId: 2, displayName: 'Kim' }]);

    await kim.service.connect({ remoteId: samId, intent: 'files' });
    await until(() => sam.manager.hostPeers.length === 2, 'the second session');

    expect(sam.incoming).toHaveLength(1);
    expect(sam.manager.hostPeers[1].info.intent).toBe('files');
  });

  it('can end a hosted session from this computer', async () => {
    const { sam, kim, samId } = await shownToOps();
    await kim.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, {
      accept: true,
      permissions: { control: true, clipboard: true, files: false },
      alwaysAllow: false,
    });
    await until(() => sam.state().hosted.length === 1);

    sam.service.endHosted(sam.state().hosted[0].sessionId);
    await until(() => kim.state().outgoing === null, 'the controller sees it end');

    expect(sam.state().hosted).toEqual([]);
    expect(sam.manager.ended).toEqual(['peer-1']);
  });

  it('pauses input for every hosted session', async () => {
    const { sam } = await shownToOps();

    sam.service.pauseInput(true);

    expect(sam.manager.paused).toBe(true);
    expect(sam.state().inputPaused).toBe(true);
  });
});

describe('Runova Anywhere service: a password', () => {
  it('refuses a weak password and keeps a good one as a secret, not the password', async () => {
    const { server, sam, samId } = await world();

    await expect(sam.service.setPassword('short')).rejects.toThrow(/10 characters/);
    await sam.service.setPassword('purple monkey dishwasher');

    expect(sam.state().settings.passwordSet).toBe(true);
    expect(server.devices.find((d) => d.remoteId === samId)?.unattendedEnabled).toBe(true);
  });

  it('asks a stranger for the password before ringing anyone', async () => {
    const { server, lee, samId } = await world();

    await lee.service.connect({ remoteId: samId, intent: 'control' });

    expect(lee.state().outgoing).toMatchObject({ phase: 'needs-password', wrongPassword: false });
    expect(server.requests).toEqual([]);
  });

  it('connects a stranger with the right password, without asking anyone, and saves it when asked', async () => {
    const { sam, lee, samId } = await world();
    await sam.service.setPassword('purple monkey dishwasher');

    await lee.service.connect({
      remoteId: samId,
      intent: 'control',
      password: 'purple monkey dishwasher',
      savePassword: true,
    });
    await until(() => lee.state().outgoing?.phase === 'connected', 'connected');

    expect(sam.incoming).toEqual([]);
    expect(lee.state().outgoing?.hostName).toBe('');
    expect(lee.passwords.entries.has(samId)).toBe(true);
    expect([...lee.passwords.entries.values()][0].secret).toHaveLength(32);
    expect(lee.state().recent[0]).toMatchObject({ remoteId: samId, savedPassword: true });
  });

  it('uses a saved password next time without asking for it', async () => {
    const { sam, lee, samId } = await world();
    await sam.service.setPassword('purple monkey dishwasher');
    await lee.service.connect({
      remoteId: samId,
      intent: 'control',
      password: 'purple monkey dishwasher',
      savePassword: true,
    });
    await until(() => lee.state().outgoing?.phase === 'connected');
    lee.service.disconnect();

    await lee.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => lee.manager.clients.length === 2, 'connected again');
  });

  it('says the password was wrong, and the host counts it', async () => {
    const { sam, lee, samId } = await world();
    await sam.service.setPassword('purple monkey dishwasher');

    await lee.service.connect({
      remoteId: samId,
      intent: 'control',
      password: 'purple monkey dishwasher!',
    });
    await until(() => lee.state().outgoing?.phase === 'needs-password', 'asked again');

    expect(lee.state().outgoing?.wrongPassword).toBe(true);
    await until(() => sam.service.passwordFailures() === 1, 'the host counted it');
    expect(sam.manager.hostPeers).toEqual([]);
  });

  it('forgets a saved password that stopped working', async () => {
    const { sam, lee, samId } = await world();
    await sam.service.setPassword('purple monkey dishwasher');
    await lee.service.connect({
      remoteId: samId,
      intent: 'control',
      password: 'purple monkey dishwasher',
      savePassword: true,
    });
    await until(() => lee.state().outgoing?.phase === 'connected');
    lee.service.disconnect();
    await sam.service.setPassword('a completely new phrase');

    await lee.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => lee.state().outgoing?.phase === 'needs-password');

    expect(lee.passwords.entries.has(samId)).toBe(false);
  });
});

describe('Runova Anywhere service: other outcomes', () => {
  it('says when the other computer is offline', async () => {
    const { sam, kim, samId } = await world();
    await sam.service.updateSettings({ teamIds: [10] });
    await kim.service.refresh();
    await sam.service.stop();

    await kim.service.connect({ remoteId: samId, intent: 'control' });

    expect(kim.state().outgoing).toMatchObject({
      phase: 'failed',
      error: expect.stringMatching(/offline/),
    });
  });

  it('refuses an ID that is not nine digits', async () => {
    const { kim } = await world();

    await kim.service.connect({ remoteId: '12345', intent: 'control' });

    expect(kim.state().outgoing).toMatchObject({
      phase: 'failed',
      error: expect.stringMatching(/9-digit/),
    });
  });

  it('stops when the host key changed since last time, until the person trusts the new one', async () => {
    const { server, sam, kim, samId } = await world();
    await sam.service.updateSettings({ teamIds: [10] });
    await kim.service.refresh();
    await kim.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, {
      accept: true,
      permissions: { control: true, clipboard: true, files: false },
      alwaysAllow: true,
    });
    await until(() => kim.state().outgoing?.phase === 'connected');
    kim.service.disconnect();
    const device = server.devices.find((d) => d.remoteId === samId);
    if (device) device.identityKey = 'A'.repeat(43);

    await kim.service.connect({ remoteId: samId, intent: 'control' });

    expect(kim.state().outgoing?.phase).toBe('key-changed');
    expect(kim.manager.clients).toHaveLength(1);
  });

  it('marks a teammate computer online and offline as the hub says', async () => {
    const { sam, kim } = await world();
    await sam.service.updateSettings({ teamIds: [10] });
    await kim.service.refresh();
    const entry = kim.state().directory.teammates[0];

    kim.hub.handlers?.presence({ deviceId: entry.id, remoteId: entry.remoteId, online: false });

    expect(kim.state().directory.teammates[0].online).toBe(false);
  });

  it('pushes the access settings to the server', async () => {
    const { server, sam, samId } = await world();

    await sam.service.updateSettings({ allowOwnDevices: true, teamIds: [10] });

    expect(server.devices.find((d) => d.remoteId === samId)).toMatchObject({
      allowOwnDevices: true,
      teamIds: [10],
    });
    expect(sam.state().settings).toMatchObject({ allowOwnDevices: true, teamIds: [10] });
  });
});

describe('Runova Anywhere service: the background agent', () => {
  it('registers its own key, gets its secret and installs with the owner settings', async () => {
    const { server, sam, samId } = await world();
    await sam.service.updateSettings({ allowOwnDevices: true });

    await sam.service.enableAgent();

    const config = sam.installer.configs[0];
    const device = server.devices.find((d) => d.remoteId === samId);
    expect(config).toMatchObject({
      siteUrl: 'https://runovahq.test',
      remoteId: samId,
      deviceId: device?.id,
      deviceName: "Sam's desk",
      agentSecret: `ras1.secret-for-${device?.id}`,
      passwordSecret: null,
      allowOwnDevices: true,
      alwaysAllow: [],
    });
    expect(fromB64u(config.identitySeed)).toHaveLength(32);
    expect(b64u(identityFromSeed(fromB64u(config.identitySeed)).publicKey)).toBe(
      server.agents.get(device?.id ?? -1),
    );
    expect(server.agents.get(device?.id ?? -1)).not.toBe(device?.identityKey);
    expect(sam.state().settings.agent).toMatchObject({ installed: true, unavailableReason: null });
  });

  it('needs the password again to give the agent its own password secret, and checks it', async () => {
    const { server, sam, samId } = await world();
    await sam.service.setPassword('purple monkey dishwasher');

    await expect(sam.service.enableAgent()).rejects.toThrow(/password/);
    await expect(sam.service.enableAgent('not it at all')).rejects.toThrow(/does not match/);
    await sam.service.enableAgent('purple monkey dishwasher');

    const agentKey =
      server.agents.get(server.devices.find((d) => d.remoteId === samId)?.id ?? -1) ?? '';
    const expected = await derivePasswordSecret('purple monkey dishwasher', agentKey);
    expect(sam.installer.configs[0].passwordSecret).toBe(b64u(expected));
  });

  it('takes the agent off the website again when installing fails', async () => {
    const server = new FakeServer();
    server.user(1, 'Sam');
    const links = new FakeLinks();
    const sam = computer(server, links, 1, "Sam's desk", {
      installer: fakeInstaller({ fail: true }),
    });
    await sam.service.start();

    await expect(sam.service.enableAgent()).rejects.toThrow(/permission/);

    expect(server.agents.size).toBe(0);
    expect(sam.state().settings.agent.installed).toBe(false);
  });

  it('uninstalls and takes the agent off the website', async () => {
    const { server, sam } = await world();
    await sam.service.enableAgent();

    await sam.service.disableAgent();

    expect(sam.installer.isInstalled).toBe(false);
    expect(server.agents.size).toBe(0);
    expect(sam.state().settings.agent.installed).toBe(false);
  });

  it('sets the agent up again when the password changes, so it keeps working', async () => {
    const { sam } = await world();
    await sam.service.setPassword('purple monkey dishwasher');
    await sam.service.enableAgent('purple monkey dishwasher');

    await sam.service.setPassword('an entirely new phrase');

    expect(sam.installer.configs).toHaveLength(2);
    expect(sam.installer.configs[1].passwordSecret).not.toBe(
      sam.installer.configs[0].passwordSecret,
    );
  });
});

describe('Runova Anywhere service: pinned keys', () => {
  it('pins the agent key apart from the app key, so reaching the agent is not a changed key', async () => {
    const { server, sam, kim, samId } = await world();
    await sam.service.updateSettings({ teamIds: [10] });
    await kim.service.refresh();
    await kim.service.connect({ remoteId: samId, intent: 'control' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, {
      accept: true,
      permissions: { control: true, clipboard: true, files: false },
      alwaysAllow: true,
    });
    await until(() => kim.state().outgoing?.phase === 'connected');
    kim.service.disconnect();
    const device = server.devices.find((d) => d.remoteId === samId);
    server.agents.set(device?.id ?? -1, 'B'.repeat(43));
    server.agentAnswers.add(device?.id ?? -1);

    await kim.service.connect({ remoteId: samId, intent: 'control' });

    expect(kim.state().outgoing?.phase).not.toBe('key-changed');
  });
});

describe('Runova Anywhere service: signing out', () => {
  async function ringing() {
    const w = await world();
    await w.sam.service.updateSettings({ teamIds: [10] });
    await w.kim.service.refresh();
    await w.kim.service.connect({ remoteId: w.samId, intent: 'control' });
    await until(() => w.sam.incoming.length === 1, 'the request window');
    return w;
  }

  async function connected() {
    const w = await ringing();
    await w.sam.service.respondIncoming(w.sam.incoming[0].sessionId, {
      accept: true,
      permissions: { control: true, clipboard: true, files: false },
      alwaysAllow: false,
    });
    await until(() => w.sam.state().hosted.length === 1, 'hosted');
    await until(() => w.kim.state().outgoing?.phase === 'connected', 'connected');
    return w;
  }

  it('drops the session when the computer being controlled signs out', async () => {
    const { sam, kim } = await connected();

    await sam.service.stop();

    expect(sam.state().hosted).toEqual([]);
    expect(sam.manager.ended).toEqual(['peer-1']);
    await until(() => kim.state().outgoing === null, 'the controller sees it end');
  });

  it('drops the session when the computer in control signs out', async () => {
    const { sam, kim } = await connected();

    await kim.service.stop();

    expect(kim.state().outgoing).toBeNull();
    await until(() => sam.state().hosted.length === 0, 'the host sees it end');
  });

  it('closes a request still waiting for an answer', async () => {
    const { sam } = await ringing();

    await sam.service.stop();

    expect(sam.state().incoming).toEqual([]);
  });

  it('keeps nothing of the account in what the screens can read', async () => {
    const { kim } = await connected();
    expect(kim.state().directory.teammates).not.toEqual([]);

    await kim.service.stop();

    expect(kim.state()).toMatchObject({
      status: 'signed-out',
      account: null,
      device: null,
      recent: [],
      directory: { mine: [], teammates: [] },
    });
  });

  it('stays signed out when the sign-out arrives while it is still starting', async () => {
    const server = new FakeServer();
    server.user(1, 'Sam');
    let open = () => undefined as void;
    const registerGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const sam = computer(server, new FakeLinks(), 1, "Sam's desk", { registerGate });
    const starting = sam.service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await sam.service.stop();
    open();
    await starting;

    expect(sam.state()).toMatchObject({ status: 'signed-out', account: null, device: null });
    expect(server.online.size).toBe(0);
  });

  it('asks whether it is still signed in when the hub drops', async () => {
    const server = new FakeServer();
    server.user(1, 'Sam');
    let checks = 0;
    const sam = computer(server, new FakeLinks(), 1, "Sam's desk", {
      checkAccount: () => {
        checks += 1;
      },
    });
    await sam.service.start();

    sam.hub.handlers?.disconnected();

    expect(checks).toBe(1);
  });
});

describe('Runova Anywhere service: a phone asks to manage this computer', () => {
  async function withPhone() {
    const w = await world();
    const phone = computer(w.server, w.links, 1, 'Runova app');
    await phone.service.start();
    await w.sam.service.refresh();
    return { ...w, phone };
  }

  const approve = (scopes: ManageScope[]) => ({
    accept: true,
    permissions: { control: false, clipboard: false, files: false },
    alwaysAllow: false,
    scopes,
  });

  it('asks the person the first time, even when own devices may connect freely', async () => {
    const { sam, phone, samId } = await withPhone();
    await sam.service.updateSettings({ allowOwnDevices: true });

    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1, 'the request window');

    expect(sam.incoming[0]).toMatchObject({ intent: 'manage', relation: 'own' });
    expect(sam.manage.attach).not.toHaveBeenCalled();
  });

  it('opens a session with the scopes the person chose, and core always', async () => {
    const { sam, phone, samId } = await withPhone();

    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, approve(['git']));
    await until(() => sam.manage.sessions.length === 1, 'a management session');

    expect(sam.manage.sessions[0].phone).toMatchObject({
      name: 'Runova app',
      scopes: ['core', 'git'],
    });
    expect(sam.manager.attachHostPeer).not.toHaveBeenCalled();
  });

  it('lets an approved phone straight back in', async () => {
    const { sam, phone, samId } = await withPhone();
    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, approve([]));
    await until(() => sam.manage.sessions.length === 1);
    phone.service.disconnect();
    await until(() => sam.state().trustedPhones[0]?.connected === false, 'hung up');

    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.manage.sessions.length === 2, 'the second session');

    expect(sam.incoming).toHaveLength(1);
  });

  it('asks again after the phone is forgotten, and ends the session it had', async () => {
    const { sam, phone, samId } = await withPhone();
    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, approve([]));
    await until(() => sam.manage.sessions.length === 1);
    const key = sam.state().trustedPhones[0].key;

    await sam.service.forgetPhone(key);
    await until(() => sam.state().trustedPhones.length === 0, 'forgotten');
    await until(() => phone.state().outgoing === null, 'the phone sees the end');

    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 2, 'asked again');
  });

  it('shows a code to compare with the phone before anyone approves it', async () => {
    const { sam, phone, samId } = await withPhone();

    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);

    expect(sam.incoming[0].controller.fingerprint).toMatch(/^[0-9A-F]{4} [0-9A-F]{4}$/);
  });

  it('ends a phone session when the computer signs out', async () => {
    const { sam, phone, samId } = await withPhone();
    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, approve([]));
    await until(() => sam.manage.sessions.length === 1);

    await sam.service.stop();

    await until(() => phone.state().outgoing === null, 'the phone sees the end');
  });

  it('ends a phone session when connections are switched off', async () => {
    const { sam, phone, samId } = await withPhone();
    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, approve([]));
    await until(() => sam.manage.sessions.length === 1);

    await sam.service.updateSettings({ acceptConnections: false });

    await until(() => phone.state().outgoing === null, 'the phone sees the end');
  });

  it('applies changed scopes by ending the session, so the phone reconnects with them', async () => {
    const { sam, phone, samId } = await withPhone();
    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, approve(['vault']));
    await until(() => sam.manage.sessions.length === 1);
    const key = sam.state().trustedPhones[0].key;

    await sam.service.setPhoneScopes(key, ['git']);
    await until(() => phone.state().outgoing === null, 'the old session ended');
    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.manage.sessions.length === 2);

    expect(sam.manage.sessions[1].phone.scopes).toEqual(['core', 'git']);
  });

  it('declines a teammate, whatever the server said', async () => {
    const { server, sam, kim, samId } = await withPhone();
    await sam.service.updateSettings({ teamIds: [10] });
    await kim.service.refresh();

    await kim.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => kim.state().outgoing?.phase === 'failed', 'declined');

    expect(sam.incoming).toHaveLength(0);
    expect(server.connected).toHaveLength(0);
  });

  it('declines every phone when connections are switched off', async () => {
    const { sam, phone, samId } = await withPhone();
    await sam.service.updateSettings({ acceptConnections: false });

    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => phone.state().outgoing?.phase === 'failed', 'declined');

    expect(sam.incoming).toHaveLength(0);
  });

  it('treats a new key on the same phone as a new phone', async () => {
    const { server, sam, phone, samId } = await withPhone();
    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 1);
    await sam.service.respondIncoming(sam.incoming[0].sessionId, approve([]));
    await until(() => sam.manage.sessions.length === 1);
    phone.service.disconnect();
    await until(() => sam.state().trustedPhones[0]?.connected === false);
    const record = server.devices.find((d) => d.name === 'Runova app');
    if (!record) throw new Error('no phone record');
    record.identityKey = b64u(identityFromSeed(new Uint8Array(32).fill(5)).publicKey);

    await phone.service.connect({ remoteId: samId, intent: 'manage' });
    await until(() => sam.incoming.length === 2, 'asked about the new key');

    expect(sam.manage.sessions).toHaveLength(1);
  });
});
