import { describe, expect, it } from 'vitest';
import { decideIncoming, type IncomingFacts, PasswordLockout } from './accessPolicy';
import { DEFAULT_ANYWHERE_SETTINGS } from './settings';

const teammate: IncomingFacts = {
  mode: 'ask',
  relation: 'teammate',
  controllerUserId: 4,
  teams: ['Ops'],
  hasPasswordSecret: false,
  lockedOut: false,
};

describe('decideIncoming', () => {
  it('asks the person about a teammate by default', () => {
    expect(decideIncoming(teammate, DEFAULT_ANYWHERE_SETTINGS)).toBe('ask');
  });

  it('lets in a teammate the owner always allows, without asking', () => {
    expect(
      decideIncoming(teammate, {
        ...DEFAULT_ANYWHERE_SETTINGS,
        alwaysAllow: [{ userId: 4, displayName: 'Kim' }],
      }),
    ).toBe('accept');
  });

  it('asks about the owner own computer unless own computers may connect freely', () => {
    const own: IncomingFacts = { ...teammate, relation: 'own', teams: [] };

    expect(decideIncoming(own, DEFAULT_ANYWHERE_SETTINGS)).toBe('ask');
    expect(decideIncoming(own, { ...DEFAULT_ANYWHERE_SETTINGS, allowOwnDevices: true })).toBe(
      'accept',
    );
  });

  it('declines a stranger asking, whatever the settings', () => {
    const other: IncomingFacts = { ...teammate, relation: 'other', teams: [] };

    expect(
      decideIncoming(other, {
        ...DEFAULT_ANYWHERE_SETTINGS,
        alwaysAllow: [{ userId: 4, displayName: 'Kim' }],
        allowOwnDevices: true,
      }),
    ).toBe('decline');
  });

  it('declines a teammate when the computer is not shown to any shared team any more', () => {
    expect(decideIncoming({ ...teammate, teams: [] }, DEFAULT_ANYWHERE_SETTINGS)).toBe('decline');
  });

  it('takes a password request straight to the handshake only when a password is set', () => {
    const password: IncomingFacts = { ...teammate, mode: 'password', relation: 'other', teams: [] };

    expect(decideIncoming(password, DEFAULT_ANYWHERE_SETTINGS)).toBe('decline');
    expect(
      decideIncoming({ ...password, hasPasswordSecret: true }, DEFAULT_ANYWHERE_SETTINGS),
    ).toBe('accept');
  });

  it('declines password requests while password access is locked', () => {
    const password: IncomingFacts = {
      ...teammate,
      mode: 'password',
      relation: 'other',
      hasPasswordSecret: true,
      lockedOut: true,
    };

    expect(decideIncoming(password, DEFAULT_ANYWHERE_SETTINGS)).toBe('decline');
  });

  it('declines everything while hosting is paused', () => {
    const settings = {
      ...DEFAULT_ANYWHERE_SETTINGS,
      acceptConnections: false,
      alwaysAllow: [{ userId: 4, displayName: 'Kim' }],
    };

    expect(decideIncoming(teammate, settings)).toBe('decline');
    expect(
      decideIncoming({ ...teammate, mode: 'password', hasPasswordSecret: true }, settings),
    ).toBe('decline');
  });
});

describe('PasswordLockout', () => {
  it('waits longer after each wrong password', () => {
    let now = 0;
    const lockout = new PasswordLockout(() => now);

    lockout.failed();
    expect(lockout.waitMs()).toBe(1_000);
    lockout.failed();
    expect(lockout.waitMs()).toBe(2_000);
    lockout.failed();
    expect(lockout.waitMs()).toBe(4_000);
    now += 4_000;
    expect(lockout.waitMs()).toBe(0);
  });

  it('locks password access for 15 minutes after 10 wrong passwords', () => {
    let now = 0;
    const lockout = new PasswordLockout(() => now);

    for (let i = 0; i < 10; i++) {
      now += 60_000;
      lockout.failed();
    }

    expect(lockout.locked()).toBe(true);
    expect(lockout.lockedUntil()).toBe(now + 15 * 60_000);
    now += 15 * 60_000 - 1;
    expect(lockout.locked()).toBe(true);
    now += 1;
    expect(lockout.locked()).toBe(false);
    expect(lockout.failures()).toBe(0);
  });

  it('caps the wait between tries at a minute', () => {
    const now = 0;
    const lockout = new PasswordLockout(() => now);
    for (let i = 0; i < 9; i++) lockout.failed();

    expect(lockout.waitMs()).toBe(60_000);
  });

  it('forgets earlier failures after a success', () => {
    const now = 0;
    const lockout = new PasswordLockout(() => now);
    lockout.failed();
    lockout.failed();

    lockout.succeeded();

    expect(lockout.failures()).toBe(0);
    expect(lockout.waitMs()).toBe(0);
  });

  it('counts a request during the wait as locked', () => {
    let now = 0;
    const lockout = new PasswordLockout(() => now);
    lockout.failed();

    expect(lockout.locked()).toBe(true);
    now += 1_000;
    expect(lockout.locked()).toBe(false);
  });
});
