import { cloudflareErrorMessage } from '../../../shared/cloudflareErrors';
import type {
  FirewallChangePreview,
  FirewallChangeSetInfo,
  OriginLockStatus,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployAccess } from '../../../shared/deployTypes';
import type { CloudflareServerOps } from '../../deploy/cloudflare/serverOps';
import type { CloudflareTunnelOps } from '../../deploy/cloudflare/tunnel';
import { cloudflareServerInputs as server } from '../../ipc/cloudflareServer';
import { cloudflareTunnelInputs as tunnelCheck } from '../../ipc/cloudflareTunnel';
import { ManageError, type ManageMethods } from './session';

/** What a server's Cloudflare-only origin needs from the rest of the app. */
export interface ManageCloudflareOriginDeps {
  access(serverId: string): Promise<DeployAccess>;
  /** The firewall change of this server waiting to be kept, if there is one. */
  firewallPending(serverId: string): Promise<FirewallChangeSetInfo | null>;
  keep(input: { serverId: string; changeSetId: string }): Promise<FirewallChangeSetInfo>;
  revert(input: { serverId: string; changeSetId: string }): Promise<FirewallChangeSetInfo>;
  lock: Pick<CloudflareServerOps, 'originLock' | 'previewOriginLock' | 'applyOriginLock'>;
  tunnel: Pick<
    CloudflareTunnelOps,
    | 'status'
    | 'plan'
    | 'setUp'
    | 'route'
    | 'closePorts'
    | 'previewSsh'
    | 'probeSsh'
    | 'applySsh'
    | 'previewOff'
    | 'turnOff'
    | 'cleanUp'
    | 'joinMesh'
    | 'breakGlass'
  >;
}

const ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
const CHANGE_SET = /^[A-Za-z0-9_-]{1,128}$/;
const KEEP_IT = 'Keep the firewall change within the time shown, or it rolls back.';

function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new ManageError('bad-params', (error as Error).message);
  }
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ManageError) throw error;
    throw new ManageError('failed', cloudflareErrorMessage(error));
  }
}

/** The answer, or the failure in words, so one part that cannot be read never hides the rest. */
async function settle<T>(work: () => Promise<T>): Promise<[T | null, string | null]> {
  try {
    return [await work(), null];
  } catch (error) {
    return [null, cloudflareErrorMessage(error)];
  }
}

/** The highest role the signed-in account holds on the server. */
export function roleOf(access: DeployAccess): (typeof ROLES)[number] | null {
  const held = new Set((access.user?.roles ?? []).map((role) => role.toLowerCase()));
  return ROLES.find((role) => held.has(role)) ?? null;
}

function lockView(lock: OriginLockStatus) {
  return {
    enabled: lock.enabled,
    authenticatedOriginPulls: lock.authenticatedOriginPulls,
    state: lock.state,
    missingRules: lock.missingRules,
    openRules: lock.openRules,
    staleRules: lock.staleRules,
    warnings: lock.warnings,
    ipv4Ranges: lock.ranges?.ipv4.length ?? null,
    ipv6Ranges: lock.ranges?.ipv6.length ?? null,
    rangesFetchedAt: lock.ranges?.fetchedAtUnixMs ?? null,
    lastRefreshError: lock.lastRefreshError ?? null,
  };
}

type TunnelStatus = Awaited<ReturnType<CloudflareTunnelOps['status']>>;

/** The tunnel as a phone shows it: never its id, account or the tokens behind it. */
function tunnelView(status: TunnelStatus) {
  return {
    enabled: status.enabled,
    state: status.state,
    sshMode: status.sshMode,
    connections: status.connections,
    tunnelName: status.tunnelName ?? null,
    sshHostname: status.sshHostname ?? null,
    meshAddress: status.meshAddress ?? null,
    cloudflaredVersion: status.cloudflaredVersion ?? null,
    openRules: status.openRules,
    warnings: status.warnings,
    lastError: status.lastError ?? null,
    breakGlassEnabled: status.breakGlassEnabled,
    breakGlassDelayMinutes: status.breakGlassDelayMinutes,
  };
}

/** A firewall preview in words: its commands, its notes, and why it is blocked, if it is. */
function firewallView(notes: string[], firewall: FirewallChangePreview | undefined | null) {
  return {
    commands: firewall?.commands ?? [],
    notes: [...notes, ...(firewall?.notes ?? [])],
    blocked: firewall?.guard.blocked ? firewall.guard.reasons.join(' ') : null,
  };
}

function domainText(proxied: boolean | null, zoneId: string | null, zoneName: string | null) {
  if (zoneId === null) return 'Not in this Cloudflare account';
  if (proxied === null) return `No address record in ${zoneName}`;
  if (proxied === false) return 'DNS only: visitors would no longer reach it';
  return 'Proxied through Cloudflare';
}

function applied(
  changeSet: FirewallChangeSetInfo | undefined | null,
  done: string,
  already: string,
) {
  return {
    ok: true,
    message: changeSet ? `${done} ${KEEP_IT}` : already,
    changeSetId: changeSet?.id ?? null,
  };
}

const serverOf = (params: unknown) => checked(() => server.serverId(field(params, 'serverId')));

/**
 * A server's Cloudflare-only origin for a phone (E102): the origin lock and the Cloudflare Tunnel,
 * through the desktop's own ops, its SSH link and its saved Cloudflare tokens. A firewall change
 * either makes waits to be kept like any other, and the phone can keep or revert it. The SSH tests
 * run from the computer, since that is the machine whose way in they check.
 */
export function cloudflareOriginMethods(deps: ManageCloudflareOriginDeps): ManageMethods['calls'] {
  const { lock, tunnel } = deps;
  return {
    'cloudflare.origin': async (params) => {
      const id = serverOf(params);
      const access = await run(() => deps.access(id));
      const [[lockStatus, lockProblem], [tunnelStatus, tunnelProblem], [pending]] =
        await Promise.all([
          settle(() => lock.originLock(id)),
          settle(() => tunnel.status(id)),
          settle(() => deps.firewallPending(id)),
        ]);
      return {
        role: roleOf(access),
        signedIn: access.state === 'signed-in',
        lock: lockStatus ? lockView(lockStatus) : null,
        lockProblem,
        tunnel: tunnelStatus ? tunnelView(tunnelStatus) : null,
        tunnelProblem,
        pending:
          pending && pending.state === 'awaitingConfirmation'
            ? {
                id: pending.id,
                summary: pending.summary,
                commands: pending.commands,
                deadline: pending.deadlineUnixMs ?? null,
              }
            : null,
      };
    },
    'cloudflare.originLockPreview': async (params) => {
      const input = checked(() => server.lockInput(params));
      const plan = await run(() => lock.previewOriginLock(input));
      return {
        domains: plan.domains.map((d) => ({
          domain: d.domain,
          text: domainText(d.proxied, d.zoneId, d.zoneName),
          ok: d.proxied === true,
        })),
        ...firewallView(plan.preview.notes, plan.preview.firewall),
      };
    },
    'cloudflare.originLockApply': async (params) => {
      const input = checked(() => server.lockInput(params));
      const result = await run(() => lock.applyOriginLock(input));
      if (!result.nginx.applied) {
        return {
          ok: true,
          message: `The firewall changed, but nginx did not take it: ${result.nginx.error ?? 'see the Websites section'}.`,
          changeSetId: result.changeSet?.id ?? null,
        };
      }
      return applied(
        result.changeSet,
        'Applied.',
        'nginx is up to date. The firewall already matched.',
      );
    },
    'cloudflare.tunnelPlan': async (params) => {
      const id = serverOf(params);
      const plan = await run(() => tunnel.plan(id));
      return {
        accounts: plan.accounts.map((a) => ({ id: a.cloudflareAccountId, label: a.label })),
        domains: plan.domains.map((d) => ({
          domain: d.domain,
          role: d.role,
          cloudflareAccountId: d.cloudflareAccountId,
          routed: d.routed,
          inAccount: d.zoneId !== null,
        })),
        coreDirect: plan.coreDomain?.mode === 'direct' ? plan.coreDomain.domain : null,
        ...firewallView(plan.ports.notes, plan.ports.firewall),
        suggestedSshHostname: plan.suggestedSshHostname,
        blocker: plan.blocker,
      } as Record<string, unknown>;
    },
    'cloudflare.tunnelSetUp': async (params) => {
      const input = checked(() => tunnelCheck.setupInput(params));
      await run(() => tunnel.setUp(input));
      return { ok: true, message: 'Setting up the tunnel: installing cloudflared and connecting.' };
    },
    'cloudflare.tunnelRoute': async (params) => {
      const id = serverOf(params);
      return run(() => tunnel.route(id));
    },
    'cloudflare.tunnelClosePorts': async (params) => {
      const id = serverOf(params);
      const result = await run(() => tunnel.closePorts(id));
      return applied(
        result.changeSet,
        'Ports 80 and 443 are closing.',
        'Ports 80 and 443 were already closed.',
      );
    },
    'cloudflare.tunnelPreviewSsh': async (params) => {
      const input = checked(() => tunnelCheck.sshInput(params));
      const preview = await run(() => tunnel.previewSsh(input));
      return {
        ...firewallView(preview.notes, preview.firewall),
        confirmationPhrase: preview.firewall?.guard.confirmationPhrase ?? null,
      };
    },
    'cloudflare.tunnelProbeSsh': async (params) => {
      const id = serverOf(params);
      const way = checked(() => tunnelCheck.route(field(params, 'route')));
      const probe = await run(() => tunnel.probeSsh(id, way));
      return { ok: probe.ok, message: probe.message };
    },
    'cloudflare.tunnelApplySsh': async (params) => {
      const input = checked(() => tunnelCheck.sshInput(params));
      const result = await run(() => tunnel.applySsh(input));
      return applied(result.changeSet, 'SSH access changed.', 'SSH already worked that way.');
    },
    'cloudflare.tunnelPreviewOff': async (params) => {
      const input = checked(() => tunnelCheck.offInput(params));
      const preview = await run(() => tunnel.previewOff(input));
      return firewallView(preview.notes, preview.firewall);
    },
    'cloudflare.tunnelTurnOff': async (params) => {
      const input = checked(() => tunnelCheck.offInput(params));
      const result = await run(() => tunnel.turnOff(input));
      return applied(
        result.changeSet,
        'The tunnel is turning off. Once the change is kept, it is removed at Cloudflare.',
        'The tunnel is turning off.',
      );
    },
    'cloudflare.tunnelCleanUp': async (params) => {
      const id = serverOf(params);
      const pointBack = checked(() =>
        tunnelCheck.flag(
          field(params, 'pointBack'),
          'Say whether the names point back at the server.',
        ),
      );
      const { skipped } = await run(() => tunnel.cleanUp(id, pointBack));
      return {
        ok: true,
        message:
          skipped.length > 0
            ? `The tunnel is off. Left as they were: ${skipped.join(', ')}.`
            : 'The tunnel is off and removed at Cloudflare.',
      };
    },
    'cloudflare.tunnelJoinMesh': async (params) => {
      const id = serverOf(params);
      await run(() => tunnel.joinMesh(id));
      return { ok: true, message: 'Adding the server to Cloudflare Mesh.' };
    },
    'cloudflare.tunnelBreakGlass': async (params) => {
      const input = checked(() => tunnelCheck.breakGlassInput(params));
      await run(() => tunnel.breakGlass(input));
      return {
        ok: true,
        message: input.enabled
          ? `SSH reopens after ${input.delayMinutes} minutes with the tunnel down.`
          : 'Break-glass is off.',
      };
    },
    'cloudflare.firewallKeep': async (params) => {
      const input = checked(() => decision(params));
      await run(() => deps.keep(input));
      return { ok: true, message: 'Firewall change kept.' };
    },
    'cloudflare.firewallRevert': async (params) => {
      const input = checked(() => decision(params));
      await run(() => deps.revert(input));
      return { ok: true, message: 'Firewall change reverted. The old rules are back.' };
    },
  };
}

function decision(params: unknown): { serverId: string; changeSetId: string } {
  const changeSetId = field(params, 'changeSetId');
  if (typeof changeSetId !== 'string' || !CHANGE_SET.test(changeSetId)) {
    throw new Error('Say which firewall change.');
  }
  return { serverId: server.serverId(field(params, 'serverId')), changeSetId };
}
