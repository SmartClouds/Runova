// RFC 6238 codes (SHA-1, 6 digits, 30 s), as an authenticator app would show them. The API takes
// each code once and allows one step of drift either way.
import { createHmac } from 'node:crypto';

const PERIOD_SECONDS = 30;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export const timeStep = (now = Date.now()) => Math.floor(now / 1000 / PERIOD_SECONDS);

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = hash.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** A user's authenticator, remembering the last step it gave a code for. */
export interface Authenticator {
  secret: string;
  lastStep: number;
}

/**
 * A code the API has not seen yet: the current step, or the next one (drift allows it) when the
 * current one was used. When both are used it waits for the clock to move on.
 */
export async function nextCode(authenticator: Authenticator): Promise<string> {
  const step = Math.max(timeStep(), authenticator.lastStep + 1);
  const waitMs = (step - 1) * PERIOD_SECONDS * 1000 - Date.now();
  if (waitMs > 0) await new Promise((wake) => setTimeout(wake, waitMs + 250));
  authenticator.lastStep = step;
  return totpCode(authenticator.secret, step);
}
