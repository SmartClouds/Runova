import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Every Runova terminal tab gets RUNOVA_AI_ACCESS_KEY in its environment, made from its session id
 * and a secret only the app holds. The MCP bridge an agent starts in that tab passes it on, which
 * is how Runova tells an agent in its own tab from one in another app: the session id is no proof,
 * since it is not secret. The secret is kept on disk so a tab that outlives a restart still
 * matches; it is never handed to a script.
 */

let secret: Buffer | null = null;

function secretPath(): string {
  return join(app.getPath('userData'), 'data', 'ai-access-secret');
}

function loadSecret(): Buffer {
  if (secret) return secret;
  const path = secretPath();
  try {
    const saved = Buffer.from(readFileSync(path, 'utf-8').trim(), 'hex');
    if (saved.length === 32) {
      secret = saved;
      return secret;
    }
  } catch {
    // Not made yet.
  }
  const fresh = randomBytes(32);
  mkdirSync(join(app.getPath('userData'), 'data'), { recursive: true });
  writeFileSync(path, fresh.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
  secret = fresh;
  return secret;
}

export function aiAccessSessionKey(sessionId: string): string {
  return createHmac('sha256', loadSecret()).update(`runova-ai-access:${sessionId}`).digest('hex');
}

export function isAiAccessSessionKey(sessionId: string, key: unknown): boolean {
  if (!sessionId || typeof key !== 'string' || key.length !== 64) return false;
  const expected = Buffer.from(aiAccessSessionKey(sessionId));
  const given = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
