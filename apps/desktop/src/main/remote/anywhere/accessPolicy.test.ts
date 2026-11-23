import { describe, expect, it } from 'vitest';
import { decideIncoming, decideSend, type IncomingFacts, PasswordLockout } from './accessPolicy';
import { DEFAULT_ANYWHERE_SETTINGS } from './settings';

const teammate: IncomingFacts = {
  mode: 'ask',
  relation: 'teammate',
  controllerUserId: 4,
  teams: ['Ops'],
  hasPasswordSecret: false,
  lockedOut: false,
  keyApproved: true,
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

  it('asks about a key nobody here accepted yet, whoever the hub says is asking', () => {
    const fresh: IncomingFacts = { ...teammate, keyApproved: false };
    const settings = {
      ...DEFAULT_ANYWHERE_SETTINGS,
      allowOwnDevices: true,
      alwaysAllow: [{ userId: 4, displayName: 'Kim' }],
    };

    expect(decideIncoming(fresh, settings)).toBe('ask');
    expect(decideIncoming({ ...fresh, relation: 'own', teams: [] }, settings)).toBe('ask');
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

describe('decideSend', () => {
  const own = { relation: 'own' as const, mode: 'ask' as const, teams: [], hasKey: true };
  const mate = {
    relation: 'teammate' as const,
    mode: 'ask' as const,
    teams: ['Ops'],
    hasKey: true,
  };

  it('opens the link for my devices and teammates; the person is asked once the list arrives', () => {
    expect(decideSend(own, DEFAULT_ANYWHERE_SETTINGS)).toBe('accept');
    expect(decideSend(mate, DEFAULT_ANYWHERE_SETTINGS)).toBe('accept');
  });

  it('takes only my own devices when told to', () => {
    const settings = { ...DEFAULT_ANYWHERE_SETTINGS, receiveFrom: 'own' as const };

    expect(decideSend(own, settings)).toBe('accept');
    expect(decideSend(mate, settings)).toBe('decline');
  });

  it('takes nothing from anyone when told to', () => {
    const settings = { ...DEFAULT_ANYWHERE_SETTINGS, receiveFrom: 'nobody' as const };

    expect(decideSend(own, settings)).toBe('decline');
    expect(decideSend(mate, settings)).toBe('decline');
  });

  it('declines whatever the server said for a stranger, a teammate with no shared team, a password or no key', () => {
    expect(decideSend({ ...mate, relation: 'other' }, DEFAULT_ANYWHERE_SETTINGS)).toBe('decline');
    expect(decideSend({ ...mate, teams: [] }, DEFAULT_ANYWHERE_SETTINGS)).toBe('decline');
    expect(decideSend({ ...own, mode: 'password' }, DEFAULT_ANYWHERE_SETTINGS)).toBe('decline');
    expect(decideSend({ ...own, hasKey: false }, DEFAULT_ANYWHERE_SETTINGS)).toBe('decline');
  });

  it('declines every send while connections are switched off', () => {
    const settings = {
      ...DEFAULT_ANYWHERE_SETTINGS,
      acceptConnections: false,
      autoAcceptOwn: true,
    };

    expect(decideSend(own, settings)).toBe('decline');
    expect(decideSend(mate, settings)).toBe('decline');
  });
});
