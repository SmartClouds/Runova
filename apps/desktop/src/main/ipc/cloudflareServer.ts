import type { IpcMainInvokeEvent } from 'electron';
import { isCloudflareId } from '../../shared/cloudflare/dns';
import type {
  CloudflareDnsTokenInput,
  CloudflareOriginCertificateInput,
  CloudflareOriginLockInput,
  CloudflareRemoveDnsTokenInput,
} from '../../shared/cloudflareTypes';
import { IPC } from '../../shared/ipcChannels';
import type { CloudflareServerOps } from '../deploy/cloudflare/serverOps';

/**
 * Cloudflare work on a server (E14 T5 to T7): the origin lock, Origin CA certificates and DNS
 * tokens for DNS-01. Main window only, like the rest of Deploy; every argument is checked for
 * shape and size here, and again by the core.
 */

export interface CloudflareServerIpcRegistry {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface CloudflareServerHandlerDeps {
  ipc: CloudflareServerIpcRegistry;
  ops: Pick<
    CloudflareServerOps,
    | 'originLock'
    | 'previewOriginLock'
    | 'applyOriginLock'
    | 'originCertificate'
    | 'dnsTokens'
    | 'provisionDnsToken'
    | 'removeDnsToken'
  >;
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ZONE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_TOKEN = 1024;

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${what}.`);
  }
  return value as Record<string, unknown>;
}

function serverId(value: unknown): string {
  if (typeof value !== 'string' || !SERVER_ID.test(value))
    throw new Error('That is not a saved server.');
  return value;
}

function flag(value: unknown, question: string): boolean {
  if (typeof value !== 'boolean') throw new Error(question);
  return value;
}

function lockInput(value: unknown): CloudflareOriginLockInput {
  const input = object(value, 'the origin lock settings');
  return {
    serverId: serverId(input.serverId),
    enabled: flag(input.enabled, 'Say whether the lock is on or off.'),
    authenticatedOriginPulls: flag(
      input.authenticatedOriginPulls,
      'Say whether to check Cloudflare’s client certificate.',
    ),
  };
}

function certificateInput(value: unknown): CloudflareOriginCertificateInput {
  const input = object(value, 'a site');
  if (typeof input.siteId !== 'string' || !SITE_ID.test(input.siteId)) {
    throw new Error('That is not a site.');
  }
  return { serverId: serverId(input.serverId), siteId: input.siteId };
}

function dnsTokenInput(value: unknown): CloudflareDnsTokenInput {
  const input = object(value, 'a DNS token request');
  if (!isCloudflareId(input.zoneId)) throw new Error('That is not a Cloudflare zone.');
  const base = { serverId: serverId(input.serverId), zoneId: input.zoneId };
  if (input.mode === 'mint') return { ...base, mode: 'mint' };
  if (input.mode !== 'paste') throw new Error('Make a token here, or paste one.');
  if (typeof input.token !== 'string' || input.token.length > MAX_TOKEN) {
    throw new Error('Paste the token Cloudflare showed you.');
  }
  return { ...base, mode: 'paste', token: input.token.trim() };
}

function removeInput(value: unknown): CloudflareRemoveDnsTokenInput {
  const input = object(value, 'a DNS token to remove');
  if (typeof input.zone !== 'string' || !ZONE.test(input.zone))
    throw new Error('That is not a zone.');
  return {
    serverId: serverId(input.serverId),
    zone: input.zone,
    deleteAtCloudflare: flag(
      input.deleteAtCloudflare,
      'Say whether to delete it at Cloudflare too.',
    ),
  };
}

/** The same checks for the phone's calls (E101), so what the desktop refuses is refused there too. */
export const cloudflareServerInputs = { serverId, lockInput, dnsTokenInput, removeInput };

export function registerCloudflareServerHandlers({
  ipc,
  ops,
  guard,
}: CloudflareServerHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('Cloudflare is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.cloudflareServer.originLock, (id) => ops.originLock(serverId(id)));
  handle(IPC.cloudflareServer.previewOriginLock, (input) =>
    ops.previewOriginLock(lockInput(input)),
  );
  handle(IPC.cloudflareServer.applyOriginLock, (input) => ops.applyOriginLock(lockInput(input)));
  handle(IPC.cloudflareServer.originCertificate, (input) =>
    ops.originCertificate(certificateInput(input)),
  );
  handle(IPC.cloudflareServer.dnsTokens, (id) => ops.dnsTokens(serverId(id)));
  handle(IPC.cloudflareServer.provisionDnsToken, (input) =>
    ops.provisionDnsToken(dnsTokenInput(input)),
  );
  handle(IPC.cloudflareServer.removeDnsToken, (input) => ops.removeDnsToken(removeInput(input)));
}
