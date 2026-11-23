/**
 * SSH failures the renderer has to react to, rather than just show. Electron only carries an
 * error's message across IPC, so the code rides inside it, as with the Vault's errors.
 */
export type SshErrorCode =
  | 'host-key-changed'
  /** A server never connected to before: its key has to be trusted before the login is sent. */
  | 'host-key-unknown'
  | 'sudo-password-required'
  | 'sudo-password-rejected'
  /** The Servers vault holds the server's secret and has to be unlocked with its passkey. */
  | 'vault-locked'
  /** Cloudflare Access refused the service token for SSH through the Cloudflare Tunnel (E95). */
  | 'access-refused';

const CODES: ReadonlySet<string> = new Set<SshErrorCode>([
  'host-key-changed',
  'host-key-unknown',
  'sudo-password-required',
  'sudo-password-rejected',
  'vault-locked',
  'access-refused',
]);
const CODE = /\[ssh:([a-z-]+)\]\s*/;
const REMOTE_PREFIX = /^Error invoking remote method '[^']+': (?:\w*Error: )?/;

export function encodeSshError(code: SshErrorCode, message: string): string {
  return `[ssh:${code}] ${message}`;
}

export function sshErrorCode(error: unknown): SshErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(CODE)?.[1];
  return code && CODES.has(code) ? (code as SshErrorCode) : null;
}

/** The human part of the message, without Electron's wrapper or the code tag. */
export function sshErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(REMOTE_PREFIX, '').replace(CODE, '');
}
