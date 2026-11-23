import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64u } from '@runova/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { electronState, setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { DEVICE_TOKEN_IDLE_MS, type PairedDevice, TokenStore } from './tokens';

/**
 * These tokens are the only thing between a phone on the same network and full control of the
 * desktop, so the rules that matter are: a pairing code works once, it stops working, and a
 * paired device keeps working across restarts without a new code.
 *
 * Every `new TokenStore()` here stands in for one app launch: the class holds its device list in
 * memory once loaded, so a second instance is the only way to prove the file was written.
 */

const userData = { dir: '' };

beforeEach(() => {
  userData.dir = tempDir('runova-tokens-');
  setElectronPath('userData', userData.dir);
});

function storeFile(): string {
  return join(userData.dir, 'remote-devices.json');
}

function readStoreFile(): PairedDevice[] {
  return JSON.parse(readFileSync(storeFile(), 'utf-8')) as PairedDevice[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('pairing tokens', () => {
  it('mints a token that is not guessable and reports when it dies', () => {
    const tokens = new TokenStore();
    const before = Date.now();
    const { token, expiresAt } = tokens.issue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(expiresAt).toBeGreaterThan(before);
  });

  it('accepts a token once and never again', () => {
    const tokens = new TokenStore();
    const { token } = tokens.issue();
    expect(tokens.consume(token)).toBe(true);
    // A QR code someone photographed off a screen is worthless after the first use.
    expect(tokens.consume(token)).toBe(false);
  });

  it('rejects a token that is not the issued one', () => {
    const tokens = new TokenStore();
    tokens.issue();
    expect(tokens.consume('not-the-token-at-all-not-even-close')).toBe(false);
  });

  it('rejects anything when nothing was issued', () => {
    expect(new TokenStore().consume('anything')).toBe(false);
  });

  it('compares candidates of a different length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, which a controller can trigger at will.
    const tokens = new TokenStore();
    tokens.issue();
    expect(() => tokens.consume('')).not.toThrow();
    expect(tokens.consume('')).toBe(false);
    expect(tokens.consume('x')).toBe(false);
    expect(tokens.consume('z'.repeat(4096))).toBe(false);
  });

  it('stops accepting a token once its lifetime is up', () => {
    vi.useFakeTimers();
    const tokens = new TokenStore();
    const { token } = tokens.issue(60_000);
    vi.advanceTimersByTime(59_999);
    expect(tokens.consume(token)).toBe(true);

    const second = tokens.issue(60_000).token;
    vi.advanceTimersByTime(60_001);
    expect(tokens.consume(second)).toBe(false);
  });

  it('invalidates the previous code when a new one is generated', () => {
    // Pressing "new code" has to retire the one on the old screenshot.
    const tokens = new TokenStore();
    const first = tokens.issue().token;
    const second = tokens.issue().token;
    expect(first).not.toBe(second);
    expect(tokens.consume(first)).toBe(false);
    expect(tokens.consume(second)).toBe(true);
  });

  it('drops pending codes on clear but leaves paired devices alone', () => {
    const tokens = new TokenStore();
    const pairing = tokens.issue().token;
    const device = tokens.issueDeviceToken('Pixel').token;
    tokens.clear();
    expect(tokens.consume(pairing)).toBe(false);
    expect(tokens.validateDeviceToken(device)?.deviceName).toBe('Pixel');
  });
});

describe('device tokens', () => {
  it('mints a durable token and validates it without consuming it', () => {
    const tokens = new TokenStore();
    const { token } = tokens.issueDeviceToken('Pixel 8');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.validateDeviceToken(token)?.deviceName).toBe('Pixel 8');
    expect(tokens.validateDeviceToken(token)?.deviceName).toBe('Pixel 8');
  });

  it('rejects an unknown token and one of another length', () => {
    const tokens = new TokenStore();
    tokens.issueDeviceToken('Pixel 8');
    expect(tokens.validateDeviceToken('nope')).toBeNull();
    expect(() => tokens.validateDeviceToken('')).not.toThrow();
  });

  it('survives a restart, so a paired phone reconnects without a new code', () => {
    const { token } = new TokenStore().issueDeviceToken('iPad');
    // A brand new instance stands in for the next app launch: nothing in memory, only the file.
    const reloaded = new TokenStore();
    expect(reloaded.listDevices()).toHaveLength(1);
    expect(reloaded.validateDeviceToken(token)?.deviceName).toBe('iPad');
  });

  it('keeps several devices side by side', () => {
    const tokens = new TokenStore();
    const phone = tokens.issueDeviceToken('Phone').token;
    const tablet = tokens.issueDeviceToken('Tablet').token;
    expect(new TokenStore().listDevices().map((d) => d.deviceName)).toEqual(['Phone', 'Tablet']);
    expect(tokens.validateDeviceToken(phone)).not.toBeNull();
    expect(tokens.validateDeviceToken(tablet)).not.toBeNull();
  });

  it('refreshes last seen but keeps the name the device paired with', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const tokens = new TokenStore();
    const { token } = tokens.issueDeviceToken('Old name');
    const createdAt = tokens.listDevices()[0].createdAt;

    vi.advanceTimersByTime(90_000);
    const device = tokens.validateDeviceToken(token);
    expect(device?.deviceName).toBe('Old name');
    expect(device?.createdAt).toBe(createdAt);
    expect(device?.lastSeenAt).toBe(createdAt + 90_000);
    expect(readStoreFile()[0].deviceName).toBe('Old name');
  });

  it('stops accepting a token left unused for too long, and forgets the device', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const tokens = new TokenStore();
    const { token } = tokens.issueDeviceToken('Old phone');

    vi.advanceTimersByTime(DEVICE_TOKEN_IDLE_MS - 1000);
    expect(tokens.validateDeviceToken(token)).not.toBeNull();

    // Using it restarted the clock; now leave it alone for longer than the limit.
    vi.advanceTimersByTime(DEVICE_TOKEN_IDLE_MS + 1);
    expect(tokens.validateDeviceToken(token)).toBeNull();
    expect(tokens.listDevices()).toEqual([]);
    expect(readStoreFile()).toEqual([]);
  });

  it('never writes the token itself to disk', () => {
    const { token } = new TokenStore().issueDeviceToken('Phone');
    expect(readFileSync(storeFile(), 'utf-8')).not.toContain(token);
    expect(readStoreFile()[0].tokenHash).toBe(sha256(token));
  });

  it('hands out a copy of the list, so a caller cannot edit the store', () => {
    const tokens = new TokenStore();
    tokens.issueDeviceToken('Phone');
    tokens.listDevices().pop();
    expect(tokens.listDevices()).toHaveLength(1);
  });

  it('revokes a device and keeps it revoked after a restart', () => {
    const tokens = new TokenStore();
    const doomed = tokens.issueDeviceToken('Lost phone').token;
    const kept = tokens.issueDeviceToken('Laptop').token;
    tokens.revokeDeviceToken(doomed);

    expect(tokens.validateDeviceToken(doomed)).toBeNull();
    expect(tokens.validateDeviceToken(kept)).not.toBeNull();
    expect(readStoreFile()).toHaveLength(1);
    expect(new TokenStore().validateDeviceToken(doomed)).toBeNull();
  });

  it('does nothing when revoking a token it never issued', () => {
    const tokens = new TokenStore();
    const { token } = tokens.issueDeviceToken('Phone');
    tokens.revokeDeviceToken('some-other-token');
    expect(tokens.listDevices()).toHaveLength(1);
    expect(tokens.validateDeviceToken(token)).not.toBeNull();
  });

  it('revokes a device by the id the settings screen shows', () => {
    const tokens = new TokenStore();
    const doomed = tokens.issueDeviceToken('Lost phone');
    const kept = tokens.issueDeviceToken('Laptop');

    expect(tokens.revokeDevice(doomed.id)).toBe(true);
    expect(tokens.revokeDevice(doomed.id)).toBe(false);
    expect(tokens.validateDeviceToken(doomed.token)).toBeNull();
    expect(tokens.validateDeviceToken(kept.token)).not.toBeNull();
    expect(new TokenStore().listDevices().map((d) => d.id)).toEqual([kept.id]);
  });
});

describe('the devices file on disk', () => {
  it('starts empty when there is no file', () => {
    expect(new TokenStore().listDevices()).toEqual([]);
  });

  it('starts empty on corrupt JSON instead of failing to host', () => {
    // Worst case everyone re-pairs, which beats the remote feature refusing to start.
    writeFileSync(storeFile(), '{ this is not json', 'utf-8');
    const tokens = new TokenStore();
    expect(tokens.listDevices()).toEqual([]);
    expect(tokens.validateDeviceToken('anything')).toBeNull();
  });

  it('ignores a file holding something that is not an array', () => {
    writeFileSync(storeFile(), JSON.stringify({ token: 'x' }), 'utf-8');
    expect(new TokenStore().listDevices()).toEqual([]);
  });

  it('keeps only the entries that look like devices', () => {
    const now = Date.now();
    writeFileSync(
      storeFile(),
      JSON.stringify([
        {
          tokenHash: sha256('good'),
          deviceName: 'Phone',
          createdAt: now,
          lastSeenAt: now,
        },
        { tokenHash: 42, deviceName: 'Bad hash type' },
        { deviceName: 'No token' },
        { tokenHash: 'not-hex', deviceName: 'Bad hash' },
        null,
        'a string',
      ]),
      'utf-8',
    );
    const tokens = new TokenStore();
    expect(tokens.listDevices().map((d) => d.deviceName)).toEqual(['Phone']);
    expect(tokens.validateDeviceToken('good')).not.toBeNull();
  });

  it('forgets devices an older version saved with the raw token, since it went over the wire', () => {
    const now = Date.now();
    writeFileSync(
      storeFile(),
      JSON.stringify([
        { token: 'old-raw-token', deviceName: 'Phone', createdAt: now, lastSeenAt: now },
        { tokenHash: sha256('kept'), deviceName: 'Laptop', createdAt: now, lastSeenAt: now },
      ]),
      'utf-8',
    );
    const tokens = new TokenStore();
    expect(tokens.listDevices().map((d) => d.deviceName)).toEqual(['Laptop']);

    expect(readFileSync(storeFile(), 'utf-8')).not.toContain('old-raw-token');
    expect(readStoreFile().map((d) => d.deviceName)).toEqual(['Laptop']);
    expect(tokens.validateDeviceToken('old-raw-token')).toBeNull();
    expect(new TokenStore().validateDeviceToken('old-raw-token')).toBeNull();
  });

  it('overwrites a corrupt file when a device pairs', () => {
    writeFileSync(storeFile(), 'garbage', 'utf-8');
    const tokens = new TokenStore();
    const { token } = tokens.issueDeviceToken('Phone');
    expect(readStoreFile().map((d) => d.tokenHash)).toEqual([sha256(token)]);
  });

  it.skipIf(process.platform === 'win32')('is readable by this user only', () => {
    // A file an older version made with the default mode is tightened on the next write.
    writeFileSync(storeFile(), '[]', { mode: 0o644 });
    new TokenStore().issueDeviceToken('Phone');
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600);
  });
});

describe('the host identity key', () => {
  function keyFile(): string {
    return join(userData.dir, 'remote-host-key.json');
  }

  it('keeps the same key across restarts, sealed by the keychain', () => {
    const first = new TokenStore().hostIdentity();
    const second = new TokenStore().hostIdentity();

    expect(second.publicKey).toEqual(first.publicKey);
    const raw = readFileSync(keyFile(), 'utf-8');
    expect(raw).not.toContain(b64u(first.secretKey));
    expect(raw).not.toContain(b64u(first.publicKey));
  });

  it('writes nothing without a keychain, so the key never sits on disk in the clear', () => {
    electronState.encryptionAvailable = false;
    try {
      const tokens = new TokenStore();
      const key = tokens.hostIdentity();
      expect(tokens.hostIdentity()).toBe(key);
      expect(existsSync(keyFile())).toBe(false);
    } finally {
      electronState.encryptionAvailable = true;
    }
  });

  it('replaces a key that no longer opens', () => {
    writeFileSync(keyFile(), JSON.stringify({ sealed: Buffer.from('junk').toString('base64') }));
    const key = new TokenStore().hostIdentity();

    expect(key.publicKey).toHaveLength(32);
    expect(new TokenStore().hostIdentity().publicKey).toEqual(key.publicKey);
  });
});
