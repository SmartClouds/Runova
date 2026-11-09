import {
  b64u,
  derivePasswordSecret,
  equalBytes,
  fromB64u,
  HandshakeError,
  type IdentityKeyPair,
  type ManageScope,
  newIdentity,
} from '@runova/protocol';
import {
  type AnywhereConnectRequest,
  type AnywhereDirectoryEntry,
  type AnywhereHosted,
  type AnywhereIncoming,
  type AnywhereIncomingAnswer,
  type AnywhereMode,
  type AnywhereOutgoing,
  type AnywherePermissions,
  type AnywherePlatform,
  type AnywhereReadiness,
  type AnywhereSessionRecord,
  type AnywhereSettingsPatch,
  type AnywhereState,
  type AnywhereStatus,
  EMPTY_ANYWHERE_STATE,
  formatRemoteId,
  parseRemoteId,
} from '../../../shared/anywhere';
import { passwordProblem } from '../../../shared/anywherePassword';
import { forwardNotification } from '../../notifications/forward';
import type { ManagePhone } from '../manage/session';
import type { AttachableSocket, PeerPermissions } from '../manager';
import { decideIncoming, decideManage, PasswordLockout } from './accessPolicy';
import type { AgentInstaller } from './agentInstaller';
import type { AnywhereApi, RegisteredDevice } from './api';
import { keyFingerprint } from './fingerprint';
import type { AnywhereHub, AnywhereHubHandlers, HubConnectResult, HubIncomingRequest } from './hub';
import { SecureLink } from './link';
import type { LinkOpener } from './links';
import type { AnywhereSettings, AnywhereStore, TrustedPhone } from './settings';

/** The part of the remote-control manager the Anywhere service drives. */
export interface AnywhereManagerPort {
  attachHostPeer(
    socket: AttachableSocket,
    info: {
      deviceName: string;
      address: string;
      intent: 'control' | 'files';
      permissions: PeerPermissions;
    },
  ): string;
  endHostPeer(peerId: string): void;
  setInputPaused(paused: boolean): void;
  attachClient(
    socket: AttachableSocket,
    info: { deviceName: string; intent: 'control' | 'files' },
  ): void;
  openSessionWindow(): void;
}

/** Serves a phone once its link is secure (E71). */
export interface ManagePort {
  attach(link: SecureLink, phone: ManagePhone): void;
}

/** Password secrets saved for other computers, sealed in the Servers vault. */
export interface SavedPasswords {
  get(remoteId: string, hostKey: string): Promise<Uint8Array | null>;
  has(remoteId: string): Promise<boolean>;
  set(remoteId: string, hostKey: string, secret: Uint8Array): Promise<void>;
  forget(remoteId: string): Promise<void>;
}

export interface AnywhereServiceDeps {
  api: AnywhereApi;
  hub: AnywhereHub;
  store: AnywhereStore;
  links: LinkOpener;
  manager: AnywhereManagerPort;
  manage?: ManagePort;
  passwords: SavedPasswords;
  /** The signed-in account and this install's device id, or null when signed out. */
  account(): Promise<{ deviceId: string; displayName: string; email: string } | null>;
  device: { name: string; platform: AnywherePlatform };
  announce(state: AnywhereState): void;
  /** Brings up the window that asks the person at this computer. */
  showIncoming(request: AnywhereIncoming): void;
  /** The live sessions controlling this computer changed, for the always-on-top bar. */
  hostedChanged(hosted: AnywhereHosted[]): void;
  notify(title: string, body: string): void;
  log?(message: string): void;
  now?(): number;
  /** How long a request rings here before it is declined on its own. */
  ringMs?: number;
  /** What this computer still needs before it can be seen and controlled. */
  readiness?: () => AnywhereReadiness;
  /** The website, for the background agent's config. */
  siteUrl?: string;
  /** Installs the background agent (E64), where this build and OS have one. */
  agent?: AgentInstaller;
  /** Asks the website whether this sign-in still stands, for when the hub drops this computer. */
  checkAccount?: () => void;
}

const RETRY_REGISTER_MS = 60_000;

interface Outgoing {
  attempt: number;
  /** Where the host key is pinned: the app and the background agent each have their own key. */
  pinKey: string | null;
  view: AnywhereOutgoing;
  request: AnywhereConnectRequest;
  sessionId: string | null;
  hostKey: string | null;
  secret: Uint8Array | null;
  usedSavedSecret: boolean;
  link: SecureLink | null;
}

interface Pending {
  request: HubIncomingRequest;
  view: AnywhereIncoming;
  timer: NodeJS.Timeout;
}

interface Hosted {
  view: AnywhereHosted;
  peerId: string;
  link: SecureLink;
}

/**
 * Runova Anywhere on this computer (E61): registering it, keeping it online on the website's hub,
 * connecting out by ID, and deciding on and serving the requests that come in. Every decision
 * about who gets in is made here; the server only routes.
 */
export function createAnywhereService(deps: AnywhereServiceDeps) {
  const now = deps.now ?? Date.now;
  const ringMs = deps.ringMs ?? 60_000;
  const lockout = new PasswordLockout(now);

  let status: AnywhereStatus = 'signed-out';
  let error: string | null = null;
  let account: { deviceId: string; displayName: string; email: string } | null = null;
  let device: RegisteredDevice | null = null;
  let identity: IdentityKeyPair | null = null;
  let settings: AnywhereSettings | null = null;
  let passwordSet = false;
  let directory: { mine: AnywhereDirectoryEntry[]; teammates: AnywhereDirectoryEntry[] } = {
    mine: [],
    teammates: [],
  };
  let teams: { id: number; name: string }[] = [];
  let recent: AnywhereState['recent'] = [];
  let outgoing: Outgoing | null = null;
  let attempts = 0;
  const pending = new Map<string, Pending>();
  const hosted = new Map<string, Hosted>();
  /** Phones managing this computer right now, by session. */
  const managed = new Map<string, { key: string; link: SecureLink }>();
  let phones: TrustedPhone[] = [];
  /** Answers that came before this side knew the session id. */
  const earlyResolved = new Map<string, { accepted: boolean; reason: string | null }>();
  let inputPaused = false;
  let retry: NodeJS.Timeout | null = null;
  let running = false;
  let agentInstalled = false;
  /** Goes up with every start and stop, so work a sign-out overtook can tell. */
  let generation = 0;

  function state(): AnywhereState {
    return {
      status,
      error,
      account: account ? { displayName: account.displayName, email: account.email } : null,
      device: device
        ? { id: device.id, remoteId: device.remoteId, name: device.name, platform: device.platform }
        : null,
      settings: {
        ...(settings ?? EMPTY_ANYWHERE_STATE.settings),
        passwordSet: settings ? passwordSet : false,
        canKeepSecrets: deps.store.remembersIdentity(),
        agent: {
          installed: agentInstalled,
          unavailableReason: deps.agent
            ? deps.agent.unavailable()
            : 'The background service is not part of this build.',
        },
      },
      directory,
      recent,
      teams,
      outgoing: outgoing ? { ...outgoing.view } : null,
      incoming: [...pending.values()].map((p) => p.view),
      hosted: [...hosted.values()].map((h) => h.view),
      trustedPhones: phones.map((phone) => ({
        ...phone,
        connected: [...managed.values()].some((session) => session.key === phone.key),
      })),
      inputPaused,
      passwordLockedUntil: lockout.lockedUntil(),
      readiness: deps.readiness?.() ?? EMPTY_ANYWHERE_STATE.readiness,
    };
  }

  function announce(): void {
    deps.announce(state());
  }

  function log(message: string): void {
    deps.log?.(`[anywhere] ${message}`);
  }

  async function loadRecent(): Promise<void> {
    const entries = await deps.store.recent();
    recent = await Promise.all(
      entries.map(async (r) => ({ ...r, savedPassword: await deps.passwords.has(r.remoteId) })),
    );
  }

  // --- Lifecycle -------------------------------------------------------------------

  const handlers: AnywhereHubHandlers = {
    incoming: (request) =>
      void onIncoming(request).catch((e) => log(`a request failed: ${String(e)}`)),
    resolved: (resolved) => onResolved(resolved.sessionId, resolved.accepted, resolved.reason),
    signal: (sessionId, payload) => deps.links.deliverSignal(sessionId, payload),
    ended: (ended) => onEnded(ended.sessionId, ended.reason),
    presence: (presence) => {
      const flip = (list: AnywhereDirectoryEntry[]) =>
        list.map((e) => (e.id === presence.deviceId ? { ...e, online: presence.online } : e));
      directory = { mine: flip(directory.mine), teammates: flip(directory.teammates) };
      announce();
    },
    reconnected: () => {
      if (device) void deps.hub.goOnline(device.id).catch(() => undefined);
      status = 'online';
      announce();
    },
    disconnected: () => {
      if (status === 'online') status = 'offline';
      announce();
      // The server also closes this when the sign-in was ended from another device.
      deps.checkAccount?.();
    },
  };

  function forgetAccount(): void {
    account = null;
    device = null;
    identity = null;
    settings = null;
    passwordSet = false;
    agentInstalled = false;
    directory = { mine: [], teammates: [] };
    teams = [];
    recent = [];
    error = null;
    earlyResolved.clear();
  }

  /** True when a sign-out or a newer start overtook this work. A sign-out leaves nothing behind. */
  function overtaken(run: number): boolean {
    if (run === generation) return false;
    if (!running) forgetAccount();
    return true;
  }

  async function start(): Promise<void> {
    const run = ++generation;
    running = true;
    account = await deps.account();
    if (overtaken(run)) return;
    if (!account) {
      forgetAccount();
      status = 'signed-out';
      announce();
      return;
    }
    settings = await deps.store.settings();
    phones = await deps.store.phones();
    passwordSet = await deps.store.hasPasswordSecret();
    agentInstalled = deps.agent ? await deps.agent.installed().catch(() => false) : false;
    await loadRecent();
    if (overtaken(run)) return;
    status = 'starting';
    announce();
    try {
      identity = await deps.store.identity();
      device = await deps.api.register({
        deviceId: account.deviceId,
        name: deps.device.name,
        platform: deps.device.platform,
        identityKey: b64u(identity.publicKey),
      });
      if (overtaken(run)) return;
      await pushSettings();
      if (overtaken(run)) return;
      await deps.hub.start(handlers);
      if (overtaken(run)) {
        if (!running) await deps.hub.stop().catch(() => undefined);
        return;
      }
      if (!device) return;
      await deps.hub.goOnline(device.id);
      if (overtaken(run)) return;
      status = 'online';
      error = null;
      await refresh();
    } catch (e) {
      if (overtaken(run)) return;
      status = 'offline';
      error = 'Runova Anywhere could not reach the website. It keeps trying.';
      log(`starting failed: ${String(e)}`);
      if (running) retry = setTimeout(() => void start(), RETRY_REGISTER_MS);
    }
    announce();
  }

  async function stop(): Promise<void> {
    generation += 1;
    running = false;
    if (retry) clearTimeout(retry);
    disconnect();
    for (const sessionId of [...hosted.keys()]) endHosted(sessionId);
    endAllPhoneSessions();
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    status = 'signed-out';
    forgetAccount();
    announce();
    await deps.hub.stop().catch(() => undefined);
  }

  async function refresh(): Promise<void> {
    if (!device) return;
    const run = generation;
    try {
      const [reachable, myTeams] = await Promise.all([deps.api.reachable(), deps.api.teams()]);
      if (overtaken(run)) return;
      directory = reachable;
      teams = myTeams;
    } catch (e) {
      log(`reading the directory failed: ${String(e)}`);
    }
    await loadRecent();
    if (overtaken(run)) return;
    announce();
  }

  /** The server only gets the flags it needs to turn away requests early; never the password. */
  async function pushSettings(): Promise<void> {
    if (!device || !settings) return;
    device = await deps.api.update(device.id, {
      allowOwnDevices: settings.acceptConnections && settings.allowOwnDevices,
      unattendedEnabled: settings.acceptConnections && passwordSet,
      teamIds: settings.acceptConnections ? settings.teamIds : [],
    });
  }

  async function updateSettings(patch: AnywhereSettingsPatch): Promise<void> {
    const current = settings ?? (await deps.store.settings());
    const { removeAlwaysAllow, ...rest } = patch;
    settings = await deps.store.updateSettings({
      ...rest,
      ...(removeAlwaysAllow
        ? { alwaysAllow: current.alwaysAllow.filter((p) => !removeAlwaysAllow.includes(p.userId)) }
        : {}),
    });
    await pushSettings();
    if (settings && !settings.acceptConnections) endAllPhoneSessions();
    announce();
  }

  async function setPassword(password: string | null): Promise<void> {
    if (!identity) identity = await deps.store.identity();
    const hostKey = b64u(identity.publicKey);
    if (password === null) {
      await deps.store.setPasswordSecret(null, hostKey);
      passwordSet = false;
    } else {
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      await deps.store.setPasswordSecret(await derivePasswordSecret(password, hostKey), hostKey);
      passwordSet = true;
      lockout.succeeded();
    }
    await pushSettings();
    announce();
    // The agent checks passwords with a secret of its own; it needs the new one too.
    if (agentInstalled) await enableAgent(password ?? undefined);
  }

  /**
   * Turns on the background agent (E64): a key of its own registered with the website, its
   * one-time secret, and the owner's choices, handed to the agent's installer, which Windows asks
   * permission for. With a password set, the person types it once more so the agent gets a password
   * secret for its own key; it is checked against this computer's first.
   */
  async function enableAgent(password?: string): Promise<void> {
    if (!device || !identity)
      throw new Error('Runova Anywhere is not set up on this computer yet.');
    const installer = deps.agent;
    const reason = installer
      ? installer.unavailable()
      : 'The background service is not part of this build.';
    if (!installer || reason) throw new Error(reason ?? 'The background service is not available.');
    if (passwordSet) {
      if (!password) {
        throw new Error(
          'Type the unattended-access password so the background service can check it too.',
        );
      }
      const appKey = b64u(identity.publicKey);
      const stored = await deps.store.passwordSecret(appKey);
      const typed = await derivePasswordSecret(password, appKey);
      if (!stored || !equalBytes(stored, typed)) {
        throw new Error('That password does not match the one set on this computer.');
      }
    }
    const current = settings ?? (await deps.store.settings());
    const agentIdentity = newIdentity();
    const agentKey = b64u(agentIdentity.publicKey);
    const { agentSecret } = await deps.api.enableAgent(device.id, agentKey);
    try {
      await installer.install({
        siteUrl: deps.siteUrl ?? '',
        remoteId: device.remoteId,
        deviceId: device.id,
        deviceName: device.name,
        identitySeed: b64u(agentIdentity.secretKey),
        agentSecret,
        passwordSecret:
          passwordSet && password ? b64u(await derivePasswordSecret(password, agentKey)) : null,
        allowOwnDevices: current.allowOwnDevices,
        alwaysAllow: current.alwaysAllow.map((p) => p.userId),
        defaultPermissions: current.defaultPermissions,
      });
    } catch (e) {
      await deps.api.disableAgent(device.id).catch(() => undefined);
      agentInstalled = await installer.installed().catch(() => false);
      announce();
      throw e;
    }
    agentInstalled = true;
    announce();
  }

  async function disableAgent(): Promise<void> {
    if (deps.agent) await deps.agent.uninstall();
    if (device) await deps.api.disableAgent(device.id).catch(() => undefined);
    agentInstalled = false;
    announce();
  }

  // --- Connecting out --------------------------------------------------------------

  function setOutgoing(change: Partial<AnywhereOutgoing>): void {
    if (!outgoing) return;
    outgoing.view = { ...outgoing.view, ...change };
    announce();
  }

  function fail(attempt: number, message: string): void {
    if (outgoing?.attempt !== attempt) return;
    if (outgoing.sessionId) void deps.hub.end(outgoing.sessionId).catch(() => undefined);
    if (outgoing.sessionId) deps.links.cancel(outgoing.sessionId);
    outgoing.link?.close();
    outgoing.link = null;
    setOutgoing({ phase: 'failed', error: message });
  }

  async function connect(request: AnywhereConnectRequest): Promise<void> {
    disconnect();
    const attempt = ++attempts;
    const remoteId = parseRemoteId(request.remoteId) ?? request.remoteId;
    const entry = [...directory.mine, ...directory.teammates].find((e) => e.remoteId === remoteId);
    outgoing = {
      attempt,
      request,
      pinKey: null,
      sessionId: null,
      hostKey: null,
      secret: null,
      usedSavedSecret: false,
      link: null,
      view: {
        phase: 'requesting',
        remoteId,
        hostName: entry?.name ?? '',
        platform: entry?.platform ?? null,
        mode: 'ask',
        intent: request.intent,
        transport: null,
        safetyCode: null,
        ringsUntil: null,
        error: null,
        wrongPassword: false,
      },
    };
    if (!parseRemoteId(request.remoteId)) {
      fail(attempt, 'Enter a 9-digit Runova ID.');
      return;
    }
    if (device && remoteId === device.remoteId) {
      fail(attempt, 'That is this computer.');
      return;
    }
    const hasSaved = await deps.passwords.has(remoteId);
    const mode: AnywhereMode =
      request.password || hasSaved ? 'password' : entry ? 'ask' : 'password';
    if (mode === 'password' && !request.password && !hasSaved) {
      setOutgoing({ phase: 'needs-password', mode });
      return;
    }
    setOutgoing({ mode });
    announce();

    let result: HubConnectResult;
    try {
      result = await deps.hub.requestConnect({
        remoteId,
        mode,
        controllerDeviceId: device?.id ?? null,
        intent: request.intent,
      });
    } catch {
      fail(
        attempt,
        'Runova Anywhere is not connected to the website right now. Try again in a moment.',
      );
      return;
    }
    if (outgoing?.attempt !== attempt) return;
    if (result.status !== 'ringing' || !result.sessionId || !result.host) {
      fail(attempt, messageFor(result.status, mode));
      return;
    }
    outgoing.sessionId = result.sessionId;
    outgoing.hostKey = result.host.identityKey;
    setOutgoing({ hostName: result.host.name, platform: result.host.platform });

    outgoing.pinKey = result.host.kind === 'agent' ? `${remoteId}#agent` : remoteId;
    const pinned = await deps.store.pin(outgoing.pinKey);
    // An answer can arrive during that wait, and it must not be painted over below.
    if (outgoing?.attempt !== attempt || outgoing.sessionId !== result.sessionId) return;
    if (pinned && pinned !== result.host.identityKey) {
      void deps.hub.end(result.sessionId).catch(() => undefined);
      outgoing.sessionId = null;
      setOutgoing({ phase: 'key-changed' });
      return;
    }

    if (mode === 'password') {
      const typed = request.password;
      outgoing.secret = typed
        ? await derivePasswordSecret(typed, result.host.identityKey)
        : await deps.passwords.get(remoteId, result.host.identityKey);
      outgoing.usedSavedSecret = !typed;
      if (!outgoing.secret) {
        void deps.hub.end(result.sessionId).catch(() => undefined);
        outgoing.sessionId = null;
        setOutgoing({ phase: 'needs-password' });
        return;
      }
      setOutgoing({ phase: 'connecting' });
    } else if (outgoing.view.phase === 'requesting') {
      setOutgoing({ phase: 'waiting', ringsUntil: now() + ringMs });
    }

    const early = earlyResolved.get(result.sessionId);
    if (early) {
      earlyResolved.delete(result.sessionId);
      onResolved(result.sessionId, early.accepted, early.reason);
    }
  }

  function onResolved(sessionId: string, accepted: boolean, reason: string | null): void {
    if (!outgoing || outgoing.sessionId !== sessionId) {
      earlyResolved.set(sessionId, { accepted, reason });
      return;
    }
    const attempt = outgoing.attempt;
    if (!accepted) {
      const who = outgoing.view.hostName || 'The other computer';
      outgoing.sessionId = null;
      fail(attempt, reason === 'timeout' ? 'No one answered in time.' : `${who} declined.`);
      return;
    }
    void openAsController(attempt, sessionId);
  }

  async function openAsController(attempt: number, sessionId: string): Promise<void> {
    const current = outgoing;
    if (!current || current.attempt !== attempt || !identity || !current.hostKey) return;
    setOutgoing({ phase: 'connecting', ringsUntil: null });
    try {
      const opened = await deps.links.open({
        sessionId,
        role: 'controller',
        relayOnly: settings?.alwaysRelay ?? false,
        signal: (payload) => void deps.hub.signal(sessionId, payload).catch(() => undefined),
      });
      if (outgoing?.attempt !== attempt) {
        opened.transport.close('cancelled');
        return;
      }
      setOutgoing({ phase: 'securing', transport: opened.kind });
      const link = new SecureLink(opened.transport, opened.cipher ? { cipher: opened.cipher } : {});
      current.link = link;
      const keys = await link.runAsController({
        sessionId,
        mode: current.view.mode,
        identity,
        expectedHostKey: fromB64u(current.hostKey),
        ...(current.secret ? { passwordSecret: current.secret } : {}),
        localFingerprint: opened.localFingerprint,
        remoteFingerprint: opened.remoteFingerprint,
      });
      if (outgoing?.attempt !== attempt) {
        link.close();
        return;
      }
      const { remoteId, hostName, platform } = current.view;
      await deps.store.setPin(current.pinKey ?? remoteId, current.hostKey);
      if (current.secret && current.request.savePassword) {
        await deps.passwords.set(remoteId, current.hostKey, current.secret);
      }
      await deps.store.addRecent({ remoteId, name: hostName, platform: platform ?? '', at: now() });
      await loadRecent();
      current.secret = null;
      setOutgoing({
        phase: 'connected',
        safetyCode: keys.safetyCode,
        error: null,
        wrongPassword: false,
      });
      link.onClose(() => {
        if (outgoing?.link === link) {
          outgoing = null;
          announce();
        }
      });
      if (current.view.intent === 'manage') return;
      deps.manager.attachClient(link, {
        deviceName: hostName || formatRemoteId(remoteId),
        intent: current.view.intent,
      });
      if (current.view.intent === 'control') deps.manager.openSessionWindow();
    } catch (e) {
      if (outgoing?.attempt !== attempt) return;
      void deps.hub.end(sessionId).catch(() => undefined);
      current.sessionId = null;
      current.link = null;
      if (e instanceof HandshakeError && e.reason === 'wrong-password') {
        if (current.usedSavedSecret) await deps.passwords.forget(current.view.remoteId);
        current.secret = null;
        await loadRecent();
        setOutgoing({ phase: 'needs-password', wrongPassword: true, transport: null });
        return;
      }
      fail(attempt, connectionFailure(e));
    }
  }

  /** The person typed the password the outgoing connection asked for. */
  async function submitPassword(password: string, savePassword: boolean): Promise<void> {
    if (!outgoing) return;
    await connect({
      ...outgoing.request,
      remoteId: outgoing.view.remoteId,
      password,
      savePassword,
    });
  }

  /** The person checked the new key with the owner and trusts it from now on. */
  async function trustNewKey(): Promise<void> {
    if (!outgoing || outgoing.view.phase !== 'key-changed' || !outgoing.hostKey) return;
    await deps.store.setPin(outgoing.pinKey ?? outgoing.view.remoteId, outgoing.hostKey);
    await connect({ ...outgoing.request, remoteId: outgoing.view.remoteId });
  }

  /** Stops the outgoing request or session, if there is one. */
  function disconnect(): void {
    const current = outgoing;
    outgoing = null;
    if (!current) return;
    if (current.sessionId) {
      void deps.hub.end(current.sessionId).catch(() => undefined);
      deps.links.cancel(current.sessionId);
    }
    current.link?.close();
    announce();
  }

  // --- Requests coming in ----------------------------------------------------------

  async function onIncoming(request: HubIncomingRequest): Promise<void> {
    const current = settings ?? (await deps.store.settings());
    const key = request.controller.identityKey;
    const decision = !key
      ? 'decline'
      : request.intent === 'manage'
        ? decideManage({
            accepting: current.acceptConnections,
            relation: request.relation,
            mode: request.mode,
            trusted: (await deps.store.phone(key)) !== null,
          })
        : decideIncoming(
            {
              mode: request.mode,
              relation: request.relation,
              controllerUserId: request.controller.userId,
              teams: request.teams,
              hasPasswordSecret: passwordSet,
              lockedOut: lockout.locked(),
            },
            current,
          );
    if (decision === 'decline') {
      await deps.hub.respond(request.sessionId, false).catch(() => undefined);
      return;
    }
    if (decision === 'accept') {
      await deps.hub.respond(request.sessionId, true);
      void serve(request, current.defaultPermissions);
      return;
    }
    const view: AnywhereIncoming = {
      sessionId: request.sessionId,
      mode: request.mode,
      relation: request.relation,
      intent: request.intent,
      controller: {
        userId: request.controller.userId,
        displayName: request.controller.displayName,
        email: request.controller.email,
        deviceName: request.controller.deviceName,
        platform: request.controller.platform,
        remoteId: request.controller.remoteId,
        fingerprint:
          request.intent === 'manage' && request.controller.identityKey
            ? keyFingerprint(request.controller.identityKey)
            : null,
      },
      teams: request.teams,
      receivedAt: now(),
      expiresAt: now() + ringMs,
    };
    if (!running) return;
    const timer = setTimeout(() => {
      if (!pending.delete(request.sessionId)) return;
      void deps.hub.respond(request.sessionId, false).catch(() => undefined);
      announce();
    }, ringMs);
    pending.set(request.sessionId, { request, view, timer });
    deps.showIncoming(view);
    announce();
  }

  async function respondIncoming(sessionId: string, answer: AnywhereIncomingAnswer): Promise<void> {
    const entry = pending.get(sessionId);
    if (!entry) return;
    pending.delete(sessionId);
    clearTimeout(entry.timer);
    announce();
    if (!answer.accept) {
      await deps.hub.respond(sessionId, false).catch(() => undefined);
      return;
    }
    if (answer.alwaysAllow && entry.request.relation === 'teammate') {
      const current = settings ?? (await deps.store.settings());
      const person = {
        userId: entry.request.controller.userId,
        displayName: entry.request.controller.displayName,
      };
      settings = await deps.store.updateSettings({
        alwaysAllow: [...current.alwaysAllow.filter((p) => p.userId !== person.userId), person],
      });
      announce();
    }
    const phoneKey = entry.request.controller.identityKey;
    if (entry.request.intent === 'manage' && phoneKey) {
      await deps.store.trustPhone({
        key: phoneKey,
        name: entry.request.controller.deviceName ?? 'Phone',
        platform: entry.request.controller.platform,
        scopes: answer.scopes ?? [],
        approvedAt: now(),
        lastSeenAt: now(),
      });
      phones = await deps.store.phones();
      announce();
    }
    await deps.hub.respond(sessionId, true);
    void serve(entry.request, answer.permissions);
  }

  async function serve(
    request: HubIncomingRequest,
    permissions: AnywherePermissions,
  ): Promise<void> {
    const sessionId = request.sessionId;
    if (!identity || !request.controller.identityKey) return;
    let link: SecureLink | null = null;
    try {
      const opened = await deps.links.open({
        sessionId,
        role: 'host',
        relayOnly: settings?.alwaysRelay ?? false,
        signal: (payload) => void deps.hub.signal(sessionId, payload).catch(() => undefined),
      });
      link = new SecureLink(opened.transport, opened.cipher ? { cipher: opened.cipher } : {});
      const secret =
        request.mode === 'password'
          ? await deps.store.passwordSecret(b64u(identity.publicKey))
          : null;
      if (request.mode === 'password' && !secret)
        throw new HandshakeError('protocol', 'No password is set here.');
      const keys = await link.runAsHost({
        sessionId,
        mode: request.mode,
        identity,
        expectedControllerKey: fromB64u(request.controller.identityKey),
        ...(secret ? { passwordSecret: secret } : {}),
        localFingerprint: opened.localFingerprint,
        remoteFingerprint: opened.remoteFingerprint,
      });
      if (request.mode === 'password') lockout.succeeded();
      await deps.hub.connected(sessionId, opened.kind).catch(() => undefined);
      if (request.intent === 'manage') {
        await serveManage(sessionId, request.controller.identityKey, link);
        return;
      }
      const name = request.controller.displayName || request.controller.email || 'Someone';
      const peerId = deps.manager.attachHostPeer(link, {
        deviceName: request.controller.deviceName
          ? `${name} (${request.controller.deviceName})`
          : name,
        address: opened.kind === 'direct' ? 'Runova Anywhere, direct' : 'Runova Anywhere, relay',
        intent: request.intent,
        permissions,
      });
      const view: AnywhereHosted = {
        sessionId,
        controllerName: name,
        controllerEmail: request.controller.email,
        deviceName: request.controller.deviceName,
        transport: opened.kind,
        intent: request.intent,
        permissions,
        startedAt: now(),
        safetyCode: keys.safetyCode,
      };
      const served = link;
      hosted.set(sessionId, { view, peerId, link: served });
      served.onClose(() => {
        if (hosted.get(sessionId)?.link !== served) return;
        hosted.delete(sessionId);
        deps.hostedChanged(state().hosted);
        announce();
      });
      forwardNotification({ category: 'remote', status: 'connected', subject: name });
      deps.notify(
        request.intent === 'files'
          ? `${name} opened your files`
          : `${name} is connected to this computer`,
        'Runova Anywhere. End the session any time from the bar at the top of the screen.',
      );
      deps.hostedChanged(state().hosted);
      announce();
    } catch (e) {
      link?.close();
      void deps.hub.end(sessionId).catch(() => undefined);
      deps.links.cancel(sessionId);
      if (e instanceof HandshakeError && e.reason === 'wrong-password') {
        lockout.failed();
        if (lockout.lockedUntil()) {
          forwardNotification({ category: 'remote', status: 'locked' });
          deps.notify(
            'Password access is locked for 15 minutes',
            'Someone tried the wrong unattended-access password too many times.',
          );
        }
        announce();
        return;
      }
      log(`serving a session failed: ${String(e)}`);
    }
  }

  /** Hands a secured link to the phone's session. The key is checked once more, here. */
  async function serveManage(sessionId: string, key: string, link: SecureLink): Promise<void> {
    const phone = await deps.store.phone(key);
    if (!phone || !deps.manage) {
      link.close();
      return;
    }
    await deps.store.touchPhone(key, now());
    phones = await deps.store.phones();
    managed.set(sessionId, { key, link });
    link.onClose(() => {
      if (managed.get(sessionId)?.link !== link) return;
      managed.delete(sessionId);
      announce();
    });
    deps.manage.attach(link, {
      key,
      name: phone.name,
      scopes: ['core', ...phone.scopes],
    });
    announce();
  }

  function endAllPhoneSessions(): void {
    for (const [sessionId, session] of [...managed]) {
      managed.delete(sessionId);
      session.link.close();
    }
  }

  function endPhoneSessions(key: string): void {
    for (const [sessionId, session] of [...managed]) {
      if (session.key !== key) continue;
      managed.delete(sessionId);
      session.link.close();
    }
  }

  /** Takes a phone's approval away and ends whatever it has open. */
  async function forgetPhone(key: string): Promise<void> {
    await deps.store.forgetPhone(key);
    endPhoneSessions(key);
    phones = await deps.store.phones();
    announce();
  }

  /** New scopes take effect on a new session, so a live one is ended and the phone reconnects. */
  async function setPhoneScopes(key: string, scopes: ManageScope[]): Promise<void> {
    await deps.store.setPhoneScopes(key, scopes);
    endPhoneSessions(key);
    phones = await deps.store.phones();
    announce();
  }

  function onEnded(sessionId: string, reason: string): void {
    const waiting = pending.get(sessionId);
    if (waiting) {
      clearTimeout(waiting.timer);
      pending.delete(sessionId);
      announce();
    }
    deps.links.cancel(sessionId);
    if (outgoing?.sessionId === sessionId && outgoing.view.phase !== 'connected') {
      const attempt = outgoing.attempt;
      outgoing.sessionId = null;
      fail(
        attempt,
        reason === 'timeout' ? 'No one answered in time.' : 'The other computer ended the request.',
      );
    }
  }

  function endHosted(sessionId: string): void {
    const session = hosted.get(sessionId);
    if (!session) return;
    hosted.delete(sessionId);
    deps.manager.endHostPeer(session.peerId);
    session.link.close();
    deps.hostedChanged(state().hosted);
    announce();
  }

  function pauseInput(paused: boolean): void {
    inputPaused = paused;
    deps.manager.setInputPaused(paused);
    announce();
  }

  async function setPhoneSealKey(key: string, sealKey: string): Promise<void> {
    await deps.store.setPhoneSealKey(key, sealKey);
    phones = await deps.store.phones();
  }

  /** Who sealed notifications can be written for, the most recently seen first. */
  async function sealKeys(): Promise<string[]> {
    return (await deps.store.phones())
      .filter((phone) => phone.sealKey !== undefined)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((phone) => phone.sealKey as string);
  }

  return {
    forgetPhone,
    setPhoneSealKey,
    sealKeys,
    setPhoneScopes,
    start,
    stop,
    refresh,
    state,
    connect,
    submitPassword,
    trustNewKey,
    disconnect,
    respondIncoming,
    endHosted,
    pauseInput,
    updateSettings,
    setPassword,
    passwordFailures: () => lockout.failures(),
    enableAgent,
    disableAgent,
    history: (): Promise<AnywhereSessionRecord[]> => deps.api.sessions(),
    deleteHistory: (id: number) => deps.api.deleteSession(id),
    async forgetRecent(remoteId: string): Promise<void> {
      await deps.store.forgetRecent(remoteId);
      await deps.passwords.forget(remoteId);
      await loadRecent();
      announce();
    },
    async forgetSavedPassword(remoteId: string): Promise<void> {
      await deps.passwords.forget(remoteId);
      await loadRecent();
      announce();
    },
  };
}

export type AnywhereService = ReturnType<typeof createAnywhereService>;

function messageFor(status: HubConnectResult['status'], mode: AnywhereMode): string {
  switch (status) {
    case 'offline':
      return 'That computer is offline. It needs Runova open and signed in.';
    case 'rate-limited':
      return 'Too many tries in a short time. Wait a minute and try again.';
    case 'self':
      return 'That is this computer.';
    default:
      return mode === 'password'
        ? 'There is no computer with that ID, or it does not take password connections.'
        : 'There is no computer with that ID, or it does not take requests from you. Try its password instead.';
  }
}

function connectionFailure(error: unknown): string {
  if (error instanceof HandshakeError) {
    if (
      error.reason === 'identity' ||
      error.reason === 'signature' ||
      error.reason === 'fingerprint'
    ) {
      return 'The other computer could not prove it is the one you asked for, so Runova stopped. Nothing was shared.';
    }
    return 'The secure connection could not be set up.';
  }
  const message = error instanceof Error ? error.message : String(error);
  return message || 'The connection failed.';
}
