import { ipcRenderer } from 'electron';
import type {
  EmailGateInput,
  EmailGateLookup,
  EmailGatePlan,
  EmailGatePrepareInput,
  EmailGateReadiness,
  EmailGateState,
  EmailGateTarget,
} from '../shared/cloudflareTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * The email code gate (E96): Cloudflare Access with a one-time PIN in front of a hostname. The
 * account token and this computer's pass never cross here.
 */
export const cloudflareEmailGate = {
  /** The zone's names, what each is to the app, and whether a gate is on it. Changes nothing. */
  plan: (zoneId: string): Promise<EmailGatePlan> =>
    ipcRenderer.invoke(IPC.cloudflareEmailGate.plan, zoneId),
  /** One name's gate and its zone; null when no connected zone holds it. */
  find: (hostname: string): Promise<EmailGateLookup | null> =>
    ipcRenderer.invoke(IPC.cloudflareEmailGate.find, hostname),
  /** Turns email codes on for the zone's Cloudflare account (Zero Trust and its PIN login). */
  prepare: (input: EmailGatePrepareInput): Promise<EmailGateReadiness> =>
    ipcRenderer.invoke(IPC.cloudflareEmailGate.prepare, input),
  /** Puts the gate on a name, or changes who gets in and for how long. */
  save: (input: EmailGateInput): Promise<EmailGateState> =>
    ipcRenderer.invoke(IPC.cloudflareEmailGate.save, input),
  remove: (target: EmailGateTarget): Promise<void> =>
    ipcRenderer.invoke(IPC.cloudflareEmailGate.remove, target),
  /** A pass of this computer's own through the gate on a core domain. */
  letThisComputerThrough: (target: EmailGateTarget): Promise<void> =>
    ipcRenderer.invoke(IPC.cloudflareEmailGate.letThisComputerThrough, target),
  /** Turns Cloudflare's proxy on for a name, so a gate can go on it. */
  proxy: (target: EmailGateTarget): Promise<void> =>
    ipcRenderer.invoke(IPC.cloudflareEmailGate.proxy, target),
};
