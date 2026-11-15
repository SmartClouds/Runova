import type {
  CloudflareMeshJoin,
  CloudflareTunnelFirewallRequest,
  CloudflareTunnelOffRequest,
  CloudflareTunnelPreview,
  CloudflareTunnelResult,
  CloudflareTunnelSetup,
  CloudflareTunnelState,
  CloudflareTunnelStatus,
  FirewallChange,
  FirewallChangeSetInfo,
  JobInfo,
  JobKind,
  TunnelBreakGlassRequest,
  TunnelSshMode,
  TunnelSshRequest,
} from '../protocol/generated/Runova.ServerCore.Contracts';
import type { FakeFirewall, FakeFirewallCaller } from './fakeFirewall';
import type { FakeNginx } from './fakeNginx';

/**
 * The server core's Cloudflare Tunnel (E95) in memory. Setting it up is a job that finishes at
 * once with the tunnel connected (cloudflared is pretend); closing the web ports, limiting SSH and
 * turning it off are change sets on the fake firewall, settled once ConfirmFirewallChanges keeps
 * them, as the real core does. A token has to be Cloudflare's shape for the tunnel it names, and
 * it never comes back.
 */

export const FAKE_TUNNEL_PORT = 18080;
export const FAKE_MESH_ADDRESS = '100.96.0.12';

const WEB_PORTS = [80, 443];
const SSH_PORT = 22;
const MESH_RANGE = '100.96.0.0/12';
const MESH_COMMENT = 'cloudflare mesh';

interface Host {
  now: () => number;
  firewall: FakeFirewall;
  nginx: FakeNginx;
  startJob: (kind: JobKind, title: string, options?: { resource?: string }) => JobInfo;
  log: (jobId: string, text: string) => void;
  finishJob: (jobId: string, state: 'succeeded' | 'failed', exitCode?: number) => JobInfo;
  /** Whether the call came through the core domain; with SSH closed it is the only way in. */
  overCoreDomain: () => boolean;
}

/** The tunnel id inside a token, or null when it is not one. */
export function tunnelIdOf(token: string): string | null {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(token)) return null;
  try {
    const json = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >;
    return typeof json.a === 'string' && typeof json.t === 'string' && typeof json.s === 'string'
      ? json.t
      : null;
  } catch {
    return null;
  }
}

/** The account tag inside a token. */
function accountTagOf(token: string): string | null {
  try {
    const json = JSON.parse(atob(token)) as Record<string, unknown>;
    return typeof json.a === 'string' ? json.a : null;
  } catch {
    return null;
  }
}

/** A token in Cloudflare's shape for a tunnel, for tests. */
export function fakeTunnelToken(tunnelId: string): string {
  return btoa(
    JSON.stringify({ a: '699d98642c564d2e855e9661899b7252', t: tunnelId, s: btoa('s'.repeat(32)) }),
  );
}

export class FakeCloudflareTunnelCore {
  enabled = false;
  connected = true;
  tunnelId: string | undefined;
  tunnelName: string | undefined;
  accountTag: string | undefined;
  sshHostname: string | undefined;
  sshMode: TunnelSshMode = 'open';
  webClosed = false;
  meshAddress: string | undefined;
  breakGlassEnabled = false;
  breakGlassDelayMinutes = 30;
  setupJobId: string | undefined;
  changeSetId: string | undefined;
  /** Kept only to prove it never comes back. */
  token: string | undefined;
  private changeKind: 'web' | 'ssh' | 'off' | undefined;
  private pendingSshMode: TunnelSshMode | undefined;

  constructor(private readonly host: Host) {}

  status(): CloudflareTunnelStatus {
    this.settle();
    const change = this.change();
    const open = this.enabled && this.webClosed ? this.openRules() : [];
    const state: CloudflareTunnelState = !this.enabled
      ? 'off'
      : this.changeKind && change?.state === 'awaitingConfirmation'
        ? 'pending'
        : !this.connected
          ? 'down'
          : !this.webClosed
            ? 'portsOpen'
            : open.length > 0
              ? 'drifted'
              : 'connected';
    return {
      enabled: this.enabled,
      state,
      sshMode: this.sshMode,
      webPorts: [...WEB_PORTS],
      sshPorts: [SSH_PORT],
      openRules: open,
      warnings: [],
      connections: this.enabled && this.connected ? 4 : 0,
      cloudflaredInstalled: this.tunnelId !== undefined,
      breakGlassEnabled: this.breakGlassEnabled,
      breakGlassDelayMinutes: this.breakGlassDelayMinutes,
      breakGlassOpen: false,
      ...(this.tunnelId ? { tunnelId: this.tunnelId, cloudflaredVersion: '2025.10.1' } : {}),
      ...(this.tunnelName ? { tunnelName: this.tunnelName } : {}),
      ...(this.accountTag ? { accountTag: this.accountTag } : {}),
      ...(this.sshHostname ? { sshHostname: this.sshHostname } : {}),
      ...(this.enabled ? { tunnelPort: FAKE_TUNNEL_PORT } : {}),
      ...(this.meshAddress ? { meshAddress: this.meshAddress } : {}),
      ...(this.setupJobId ? { setupJobId: this.setupJobId } : {}),
      ...(this.changeSetId ? { changeSetId: this.changeSetId } : {}),
      ...(change ? { changeState: change.state } : {}),
    };
  }

  start(request: CloudflareTunnelSetup): JobInfo {
    if (tunnelIdOf(request.token) !== request.tunnelId) {
      throw new Error(
        'The token belongs to another tunnel than the one the app set up. Set the tunnel up again from the app.',
      );
    }
    this.settle();
    if (this.changeKind) {
      throw new Error(
        "A firewall change of the tunnel's waits for its confirmation. Keep or revert it first.",
      );
    }
    Object.assign(this, {
      enabled: true,
      tunnelId: request.tunnelId,
      tunnelName: request.tunnelName,
      accountTag: accountTagOf(request.token) ?? undefined,
      sshHostname: request.sshHostname ?? undefined,
      token: request.token,
    });
    const job = this.host.startJob('cloudflareTunnelSetup', 'Set up the Cloudflare Tunnel', {
      resource: request.tunnelName,
    });
    this.setupJobId = job.id;
    this.host.log(job.id, 'cloudflared is installed.');
    this.host.log(job.id, 'The tunnel is connected (4 connections to Cloudflare).');
    this.host.nginx.apply();
    return this.host.finishJob(job.id, 'succeeded', 0);
  }

  previewPorts(): CloudflareTunnelPreview {
    return this.preview(this.planWeb());
  }

  closePorts(request: CloudflareTunnelFirewallRequest, caller: FakeFirewallCaller) {
    this.requireConnected();
    return this.applyChanges(this.planWeb(), 'web', request, caller);
  }

  previewSsh(request: TunnelSshRequest): CloudflareTunnelPreview {
    this.checkSshMode(request.mode);
    return this.preview(this.planSsh(request.mode));
  }

  applySsh(request: TunnelSshRequest, caller: FakeFirewallCaller): CloudflareTunnelResult {
    this.requireConnected();
    if (!this.webClosed) throw new Error('Close the web ports first; SSH comes after that.');
    this.checkSshMode(request.mode);
    const result = this.applyChanges(this.planSsh(request.mode), 'ssh', request, caller);
    if (result.changeSet) this.pendingSshMode = request.mode;
    else this.sshMode = request.mode;
    return result;
  }

  previewOff(request: CloudflareTunnelOffRequest): CloudflareTunnelPreview {
    return this.preview(this.planOff(request.reopenWeb !== false));
  }

  turnOff(request: CloudflareTunnelOffRequest, caller: FakeFirewallCaller): CloudflareTunnelResult {
    this.settle();
    if (!this.enabled) throw new Error('The tunnel is already off.');
    const result = this.applyChanges(
      this.planOff(request.reopenWeb !== false),
      'off',
      request,
      caller,
    );
    if (!result.changeSet) this.stop();
    return { ...result, status: this.status() };
  }

  setBreakGlass(request: TunnelBreakGlassRequest): CloudflareTunnelStatus {
    if (request.delayMinutes < 5 || request.delayMinutes > 1440) {
      throw new Error('Choose a delay from 5 minutes to 24 hours.');
    }
    this.breakGlassEnabled = request.enabled;
    this.breakGlassDelayMinutes = request.delayMinutes;
    return this.status();
  }

  joinMesh(request: CloudflareMeshJoin): JobInfo {
    if (tunnelIdOf(request.token) !== request.nodeId) {
      throw new Error('That is not a Cloudflare Mesh node token for this node.');
    }
    if (!this.enabled) {
      throw new Error('Set the tunnel up first; Mesh only limits SSH while the tunnel is on.');
    }
    const job = this.host.startJob('cloudflareMeshSetup', 'Add this server to Cloudflare Mesh', {
      resource: 'mesh',
    });
    this.host.log(job.id, `This server's Mesh address is ${FAKE_MESH_ADDRESS}.`);
    this.meshAddress = FAKE_MESH_ADDRESS;
    return this.host.finishJob(job.id, 'succeeded', 0);
  }

  private settle(): void {
    const change = this.change();
    if (!this.changeKind || !change || change.state === 'awaitingConfirmation') return;
    if (change.state === 'confirmed') {
      if (this.changeKind === 'web') this.webClosed = true;
      if (this.changeKind === 'ssh') this.sshMode = this.pendingSshMode ?? this.sshMode;
      if (this.changeKind === 'off') this.stop();
    }
    this.changeKind = undefined;
    this.pendingSshMode = undefined;
  }

  private stop(): void {
    Object.assign(this, {
      enabled: false,
      webClosed: false,
      sshMode: 'open',
      token: undefined,
      changeKind: undefined,
      pendingSshMode: undefined,
    });
    this.host.nginx.apply();
  }

  private change(): FirewallChangeSetInfo | undefined {
    return this.host.firewall.changeSets.find((candidate) => candidate.id === this.changeSetId);
  }

  private requireConnected(): void {
    this.settle();
    if (!this.enabled) throw new Error('The tunnel is off. Set it up first.');
    if (this.changeKind) {
      throw new Error(
        "A firewall change of the tunnel's waits for its confirmation. Keep or revert it first.",
      );
    }
    if (!this.connected) {
      throw new Error(
        'The tunnel is not connected to Cloudflare, so closing ports now would take the sites and the core domain offline. Wait for it to connect.',
      );
    }
  }

  private checkSshMode(mode: TunnelSshMode): void {
    if (mode === 'cloudflare' && !this.sshHostname) {
      throw new Error(
        'SSH has no name on the tunnel yet. Set the tunnel up again from the app with Cloudflare only SSH.',
      );
    }
    if (mode === 'mesh' && !this.meshAddress) {
      throw new Error(
        'This server is not a Cloudflare Mesh node yet. Add it to Mesh from the app first.',
      );
    }
    if (mode === 'closed' && !this.host.overCoreDomain()) {
      throw new Error(
        'With SSH closed, the core domain through the tunnel is the only way in, so this change has to come over it. Connect through the core domain (Security, Connection) and try again.',
      );
    }
  }

  private applyChanges(
    changes: FirewallChange[],
    kind: 'web' | 'ssh' | 'off',
    request: { sshConnection?: string; overrideConfirmation?: string },
    caller: FakeFirewallCaller,
  ): CloudflareTunnelResult {
    if (changes.length === 0) {
      if (kind === 'web') this.webClosed = true;
      return { status: this.status() };
    }
    const changeSet = this.host.firewall.apply(
      {
        changes,
        ...(request.sshConnection ? { sshConnection: request.sshConnection } : {}),
        ...(request.overrideConfirmation
          ? { overrideConfirmation: request.overrideConfirmation }
          : {}),
      },
      caller,
    );
    this.changeSetId = changeSet.id;
    this.changeKind = kind;
    return { status: this.status(), changeSet };
  }

  private preview(changes: FirewallChange[]): CloudflareTunnelPreview {
    return {
      changes,
      notes: [],
      ...(changes.length > 0 ? { firewall: this.host.firewall.preview({ changes }) } : {}),
    };
  }

  private planWeb(): FirewallChange[] {
    if (!this.host.firewall.active) {
      throw new Error(
        'The firewall is off, so it cannot close anything. Turn it on in the Firewall section first, then set up the tunnel.',
      );
    }
    return this.host.firewall.rules
      .filter(
        (rule) =>
          rule.action === 'allow' && rule.port !== undefined && WEB_PORTS.includes(rule.port),
      )
      .map((rule) => ({ kind: 'removeRule', ruleId: rule.id }));
  }

  private planSsh(mode: TunnelSshMode): FirewallChange[] {
    const rules = this.host.firewall.rules;
    const ssh = rules.filter((rule) => rule.action === 'allow' && rule.port === SSH_PORT);
    const mesh = ssh.filter((rule) => rule.source === MESH_RANGE);
    const publicSsh = ssh.filter((rule) => rule.source !== MESH_RANGE);
    if (mode === 'open') {
      return [
        ...mesh.map((rule): FirewallChange => ({ kind: 'removeRule', ruleId: rule.id })),
        ...(publicSsh.some((rule) => !rule.source)
          ? []
          : [
              {
                kind: 'addRule',
                rule: { action: 'allow', protocol: 'tcp', port: SSH_PORT },
              } as FirewallChange,
            ]),
      ];
    }
    return [
      ...publicSsh.map((rule): FirewallChange => ({ kind: 'removeRule', ruleId: rule.id })),
      ...(mode === 'mesh' && mesh.length === 0
        ? [
            {
              kind: 'addRule',
              rule: {
                action: 'allow',
                protocol: 'tcp',
                port: SSH_PORT,
                source: MESH_RANGE,
                comment: MESH_COMMENT,
              },
            } as FirewallChange,
          ]
        : []),
      ...(mode !== 'mesh'
        ? mesh.map((rule): FirewallChange => ({ kind: 'removeRule', ruleId: rule.id }))
        : []),
    ];
  }

  private planOff(reopenWeb: boolean): FirewallChange[] {
    const rules = this.host.firewall.rules;
    return [
      ...this.planSsh('open'),
      ...(reopenWeb && this.webClosed
        ? WEB_PORTS.filter(
            (port) =>
              !rules.some((rule) => rule.action === 'allow' && !rule.source && rule.port === port),
          ).map(
            (port): FirewallChange => ({
              kind: 'addRule',
              rule: { action: 'allow', protocol: 'tcp', port },
            }),
          )
        : []),
    ];
  }

  private openRules(): string[] {
    return this.host.firewall.rules
      .filter(
        (rule) =>
          rule.action === 'allow' &&
          !rule.source &&
          rule.port !== undefined &&
          (WEB_PORTS.includes(rule.port) || (this.sshMode !== 'open' && rule.port === SSH_PORT)),
      )
      .map((rule) => rule.description);
  }
}
