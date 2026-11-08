import { createHash } from 'node:crypto';

/**
 * A short code for a phone's identity key. The computer shows it before anyone approves the phone
 * and the phone shows it while it waits, so a key slipped in through the server can be noticed.
 */
export function keyFingerprint(identityKey: string): string {
  const hash = createHash('sha256').update(Buffer.from(identityKey, 'base64url')).digest('hex');
  return `${hash.slice(0, 4)} ${hash.slice(4, 8)}`.toUpperCase();
}
