import type { IpcMainInvokeEvent } from 'electron';
import type { SshRoute } from '../../shared/apiTypes';
import type {
  CloudflareTunnelBreakGlassInput,
  CloudflareTunnelOffInput,
  CloudflareTunnelSetupInput,
  CloudflareTunnelSshInput,
} from '../../shared/cloudflareTypes';
import type { TunnelSshMode } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { IPC } from '../../shared/ipcChannels';
import type { CloudflareTunnelOps } from '../deploy/cloudflare/tunnel';

/**
 * The Cloudflare Tunnel on one server (E95). Main window only, like the rest of Deploy; every
 * argument is checked for shape and size here, and again by the core. No token crosses here in
 * either direction.
 */

export interface CloudflareTunnelIpcRegistry {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface CloudflareTunnelHandlerDeps {
  ipc: CloudflareTunnelIpcRegistry;
  ops: Pick<
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
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CLOUDFLARE_ACCOUNT = /^[0-9a-f]{32}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MODES: ReadonlySet<string> = new Set<TunnelSshMode>(['open', 'closed', 'cloudflare', 'mesh']);
const ROUTES: ReadonlySet<string> = new Set<SshRoute>(['cloudflare', 'mesh']);
const MAX_SECRET = 1024;

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${what}.`);
  }
  return value as Record<string, unknown>;
}

function serverId(value: unknown): string {
  if (typeof value !== 'string' || !SERVER_ID.test(value)) {
    throw new Error('That is not a saved server.');
  }
  return value;
}

function flag(value: unknown, question: string): boolean {
  if (typeof value !== 'boolean') throw new Error(question);
  return value;
}

function optionalText(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_SECRET)
    throw new Error(`That is not ${what}.`);
  return value;
}

export function setupInput(value: unknown): CloudflareTunnelSetupInput {
  const input = object(value, 'the tunnel settings');
  if (
    typeof input.cloudflareAccountId !== 'string' ||
    !CLOUDFLARE_ACCOUNT.test(input.cloudflareAccountId)
  ) {
    throw new Error('That is not a Cloudflare account.');
  }
  let sshHostname: string | null = null;
  if (input.sshHostname !== null && input.sshHostname !== undefined) {
    const name =
      typeof input.sshHostname === 'string' ? input.sshHostname.trim().toLowerCase() : '';
    if (!HOSTNAME.test(name))
      throw new Error('That is not a host name for SSH, like ssh.example.com.');
    sshHostname = name;
  }
  return {
    serverId: serverId(input.serverId),
    cloudflareAccountId: input.cloudflareAccountId,
    sshHostname,
  };
}

export function sshInput(value: unknown): CloudflareTunnelSshInput {
  const input = object(value, 'who may open SSH');
  if (typeof input.mode !== 'string' || !MODES.has(input.mode)) {
    throw new Error(
      'Choose who may open SSH: everyone, no one, Cloudflare only or Cloudflare Mesh.',
    );
  }
  const overrideConfirmation = optionalText(input.overrideConfirmation, 'the phrase');
  const password = optionalText(input.password, 'a password');
  const totpCode = optionalText(input.totpCode, 'a code');
  return {
    serverId: serverId(input.serverId),
    mode: input.mode as TunnelSshMode,
    ...(overrideConfirmation ? { overrideConfirmation } : {}),
    ...(password ? { password } : {}),
    ...(totpCode ? { totpCode } : {}),
  };
}

function offInput(value: unknown): CloudflareTunnelOffInput {
  const input = object(value, 'how to turn the tunnel off');
  return {
    serverId: serverId(input.serverId),
    reopenWeb: flag(input.reopenWeb, 'Say whether ports 80 and 443 open to everyone again.'),
  };
}

function breakGlassInput(value: unknown): CloudflareTunnelBreakGlassInput {
  const input = object(value, 'the break-glass settings');
  const delay = input.delayMinutes;
  if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 5 || delay > 1440) {
    throw new Error('Choose a delay from 5 minutes to 24 hours.');
  }
  return {
    serverId: serverId(input.serverId),
    enabled: flag(input.enabled, 'Say whether break-glass is on.'),
    delayMinutes: delay,
  };
}

function route(value: unknown): SshRoute {
  if (typeof value !== 'string' || !ROUTES.has(value)) throw new Error('That is not an SSH route.');
  return value as SshRoute;
}

export function registerCloudflareTunnelHandlers({
  ipc,
  ops,
  guard,
}: CloudflareTunnelHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event))
        throw new Error('The Cloudflare Tunnel is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.cloudflareTunnel.status, (id) => ops.status(serverId(id)));
  handle(IPC.cloudflareTunnel.plan, (id) => ops.plan(serverId(id)));
  handle(IPC.cloudflareTunnel.setUp, (input) => ops.setUp(setupInput(input)));
  handle(IPC.cloudflareTunnel.route, (id) => ops.route(serverId(id)));
  handle(IPC.cloudflareTunnel.closePorts, (id) => ops.closePorts(serverId(id)));
  handle(IPC.cloudflareTunnel.previewSsh, (input) => ops.previewSsh(sshInput(input)));
  handle(IPC.cloudflareTunnel.probeSsh, (id, which) => ops.probeSsh(serverId(id), route(which)));
  handle(IPC.cloudflareTunnel.applySsh, (input) => ops.applySsh(sshInput(input)));
  handle(IPC.cloudflareTunnel.previewOff, (input) => ops.previewOff(offInput(input)));
  handle(IPC.cloudflareTunnel.turnOff, (input) => ops.turnOff(offInput(input)));
  handle(IPC.cloudflareTunnel.cleanUp, (id, pointBack) =>
    ops.cleanUp(serverId(id), flag(pointBack, 'Say whether the names point back at the server.')),
  );
  handle(IPC.cloudflareTunnel.joinMesh, (id) => ops.joinMesh(serverId(id)));
  handle(IPC.cloudflareTunnel.breakGlass, (input) => ops.breakGlass(breakGlassInput(input)));
}
