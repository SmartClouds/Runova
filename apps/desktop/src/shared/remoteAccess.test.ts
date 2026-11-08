import { describe, expect, it } from 'vitest';
import type { AccountStatus } from './accountTypes';
import { canUseRemote } from './remoteAccess';

const account = { id: 1, email: 'sam@example.com', displayName: 'Sam' };
const signedIn: AccountStatus = {
  state: 'signed-in',
  deviceId: 'd',
  sessionId: 1,
  account,
  rememberedOnDisk: true,
  needsSignIn: false,
};

describe('canUseRemote', () => {
  it('is true for a live sign-in', () => {
    expect(canUseRemote(signedIn)).toBe(true);
  });

  it('is false when signed out, signing in, or when the server refused the session', () => {
    expect(canUseRemote({ state: 'signed-out', deviceId: 'd' })).toBe(false);
    expect(canUseRemote({ state: 'signing-in', deviceId: 'd' })).toBe(false);
    expect(canUseRemote({ ...signedIn, needsSignIn: true })).toBe(false);
  });
});
