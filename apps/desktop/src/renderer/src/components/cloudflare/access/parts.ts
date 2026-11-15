import type { EmailGateHost } from '@shared/cloudflareTypes';
import { confirmDialog } from '@/stores/confirmStore';

/** Every email code gate query: each zone's tab and each shortcut's lookup (E96). */
export const EMAIL_GATE_KEY = ['cloudflare', 'emailGate'] as const;

/** The key of one name's lookup, for the shortcuts on the core domain card and a site. */
export function emailGateFindKey(hostname: string) {
  return [...EMAIL_GATE_KEY, 'find', hostname.toLowerCase()] as const;
}

/** The short chip that says what a name is to the app; null for a name no server claims. */
export function roleChip(host: EmailGateHost): string | null {
  if (host.role === 'core') return 'Core server';
  if (host.role === 'site') return host.siteName ? `Site ${host.siteName}` : 'Site';
  if (host.role === 'ssh') return 'SSH';
  return null;
}

/** The same in a sentence, with the server named. */
export function roleText(host: EmailGateHost): string | null {
  const on = host.serverName ? ` on ${host.serverName}` : '';
  if (host.role === 'core') return `The core server's domain${on}.`;
  if (host.role === 'site')
    return `${host.siteName ? `The site ${host.siteName}` : 'A site'}${on}.`;
  if (host.role === 'ssh') return `The name SSH goes through${on}.`;
  return null;
}

/** Asks before a gate comes off a name; true when the user said yes. */
export function confirmTurnOff(host: EmailGateHost): Promise<boolean> {
  return confirmDialog({
    title: `Turn the email code off for ${host.hostname}?`,
    description: `Anyone can open ${host.hostname} again, without a code.${
      host.role === 'core' ? " Every computer's pass through it goes too." : ''
    }`,
    confirmLabel: 'Turn off',
    variant: 'destructive',
  });
}
