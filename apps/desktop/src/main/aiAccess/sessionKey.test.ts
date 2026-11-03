import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * The key a Runova terminal tab carries in its environment, which tells Runova an agent runs in one
 * of its own tabs rather than in another app. The session id alone is no proof: it is not secret.
 */

const userData = useTempUserData();

const load = () => import('./sessionKey');

describe('AI access session key', () => {
  it('gives a session the same key every time, and a different one per session', async () => {
    const { aiAccessSessionKey } = await load();

    expect(aiAccessSessionKey('tab-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(aiAccessSessionKey('tab-1')).toBe(aiAccessSessionKey('tab-1'));
    expect(aiAccessSessionKey('tab-2')).not.toBe(aiAccessSessionKey('tab-1'));
  });

  it('keeps the secret behind the keys on disk, so a tab still matches after a restart', async () => {
    const first = await load();
    const key = first.aiAccessSessionKey('tab-1');
    expect(existsSync(userData.dataFile('ai-access-secret'))).toBe(true);
    expect(readFileSync(userData.dataFile('ai-access-secret'), 'utf-8')).not.toContain(key);

    const { vi } = await import('vitest');
    vi.resetModules();
    const second = await load();
    expect(second.isAiAccessSessionKey('tab-1', key)).toBe(true);
  });

  it('refuses a missing, wrong or borrowed key', async () => {
    const { aiAccessSessionKey, isAiAccessSessionKey } = await load();

    expect(isAiAccessSessionKey('tab-1', undefined)).toBe(false);
    expect(isAiAccessSessionKey('tab-1', '')).toBe(false);
    expect(isAiAccessSessionKey('tab-1', 'f'.repeat(64))).toBe(false);
    expect(isAiAccessSessionKey('tab-1', aiAccessSessionKey('tab-2'))).toBe(false);
    expect(isAiAccessSessionKey('', aiAccessSessionKey(''))).toBe(false);
  });
});
