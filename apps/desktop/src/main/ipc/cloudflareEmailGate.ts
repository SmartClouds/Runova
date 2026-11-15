import type { IpcMainInvokeEvent } from 'electron';
import { isCloudflareId } from '../../shared/cloudflare/dns';
import { isEmailGateSession, MAX_EMAIL_GATE_PEOPLE } from '../../shared/cloudflare/emailGate';
import type {
  EmailGateInput,
  EmailGatePrepareInput,
  EmailGateTarget,
} from '../../shared/cloudflareTypes';
import { IPC } from '../../shared/ipcChannels';
import type { CloudflareEmailGateOps } from '../deploy/cloudflare/emailGate';

/**
 * The email code gate (E96): Cloudflare Access with a one-time PIN in front of a hostname. Main
 * window only, like the rest of the Cloudflare page; every argument is checked for shape and size
 * here, and the content again by the main process before it goes to Cloudflare. No token or pass
 * secret crosses here in either direction.
 */

export interface CloudflareEmailGateIpcRegistry {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface CloudflareEmailGateHandlerDeps {
  ipc: CloudflareEmailGateIpcRegistry;
  ops: Pick<
    CloudflareEmailGateOps,
    'plan' | 'find' | 'prepare' | 'save' | 'remove' | 'letThisComputerThrough' | 'proxy'
  >;
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${what}.`);
  }
  return value as Record<string, unknown>;
}

function zoneId(value: unknown): string {
  if (!isCloudflareId(value)) throw new Error('That is not a Cloudflare zone.');
  return value;
}

function hostname(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!HOSTNAME.test(name)) {
    throw new Error('The email code gate goes on one hostname, with no wildcard or path.');
  }
  return name;
}

function addresses(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EMAIL_GATE_PEOPLE) {
    throw new Error(`The ${what} must be a list of up to ${MAX_EMAIL_GATE_PEOPLE}.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 254) {
      throw new Error(`Each of the ${what} must be an email address or domain.`);
    }
    return item.trim().toLowerCase();
  });
}

function target(value: unknown): EmailGateTarget {
  const input = object(value, 'a hostname in a zone');
  return { zoneId: zoneId(input.zoneId), hostname: hostname(input.hostname) };
}

export function emailGateInput(value: unknown): EmailGateInput {
  const input = object(value, 'the email code gate');
  if (!isEmailGateSession(input.session)) {
    throw new Error('Pick how long people stay in after the code.');
  }
  return {
    ...target(input),
    emails: addresses(input.emails, 'email addresses'),
    emailDomains: addresses(input.emailDomains, 'email domains'),
    session: input.session,
  };
}

function prepareInput(value: unknown): EmailGatePrepareInput {
  const input = object(value, 'the Zero Trust setup');
  if (input.teamName === undefined) return { zoneId: zoneId(input.zoneId) };
  if (typeof input.teamName !== 'string' || input.teamName.trim().length > 63) {
    throw new Error('Pick a team name of up to 63 characters.');
  }
  return { zoneId: zoneId(input.zoneId), teamName: input.teamName.trim() };
}

export function registerCloudflareEmailGateHandlers({
  ipc,
  ops,
  guard,
}: CloudflareEmailGateHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('Cloudflare is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.cloudflareEmailGate.plan, (zone) => ops.plan(zoneId(zone)));
  handle(IPC.cloudflareEmailGate.find, (name) => ops.find(hostname(name)));
  handle(IPC.cloudflareEmailGate.prepare, (input) => ops.prepare(prepareInput(input)));
  handle(IPC.cloudflareEmailGate.save, (input) => ops.save(emailGateInput(input)));
  handle(IPC.cloudflareEmailGate.remove, (input) => ops.remove(target(input)));
  handle(IPC.cloudflareEmailGate.letThisComputerThrough, (input) =>
    ops.letThisComputerThrough(target(input)),
  );
  handle(IPC.cloudflareEmailGate.proxy, (input) => ops.proxy(target(input)));
}
