import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  b64u,
  fromB64u,
  type IdentityKeyPair,
  identityFromSeed,
  newIdentity,
} from '@runova/protocol';
import { app, safeStorage } from 'electron';

/**
 * Two kinds of credentials:
 *
 * - Pairing tokens: minted when the operator generates a pairing code. Single
 *   use and short-lived, so a leaked QR code can't be replayed.
 * - Device tokens: minted when a controller successfully pairs. Durable and
 *   persisted to disk (`remote-devices.json` in userData), so a phone that
 *   paired once can reconnect later without scanning a new code. Stopping and
 *   restarting hosting does NOT invalidate them. The file holds only a SHA-256
 *   hash of each token, is readable by this user alone, and a device that has
 *   not connected for `DEVICE_TOKEN_IDLE_MS` has to pair again.
 *
 * Neither ever crosses the network in the clear: the controller only sends one inside the secure
 * link, after the host proved it holds the identity key the pairing code named (see
 * {@link TokenStore.hostIdentity}).
 */

/** A paired device that stays away this long has to pair again with a fresh code. */
export const DEVICE_TOKEN_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PairedDevice {
  /** Stable id the settings screen revokes the device by. */
  id: string;
  /** SHA-256 of the device token, hex. The token itself is never stored. */
  tokenHash: string;
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
}

export class TokenStore {
  private pairing = new Map<string, { expiresAt: number }>();
  private devices: PairedDevice[] | null = null;
  private identity: IdentityKeyPair | null = null;

  /**
   * This computer's LAN identity key. Its public half goes in every pairing code, and the host
   * proves it holds the secret half in the handshake before a controller sends any token. The
   * seed is kept sealed by the OS keychain in `remote-host-key.json`. Without a keychain the key
   * lasts for this run only, so saved servers have to pair again after a restart, rather than the
   * key sitting on disk in the clear.
   */
  hostIdentity(): IdentityKeyPair {
    if (this.identity) return this.identity;
    if (!safeStorage.isEncryptionAvailable()) {
      this.identity = newIdentity();
      return this.identity;
    }
    const path = join(app.getPath('userData'), 'remote-host-key.json');
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as { sealed?: unknown } | null;
        if (typeof raw?.sealed === 'string') {
          const seed = safeStorage.decryptString(Buffer.from(raw.sealed, 'base64'));
          this.identity = identityFromSeed(fromB64u(seed));
          return this.identity;
        }
      }
    } catch {
      // A key that no longer opens (a new OS account, a reset keychain) is replaced, and paired
      // controllers pair again.
    }
    const identity = newIdentity();
    try {
      const sealed = safeStorage.encryptString(b64u(identity.secretKey)).toString('base64');
      writeFileSync(path, JSON.stringify({ sealed }), { encoding: 'utf-8', mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Saving is best-effort; the key still works for this run.
    }
    this.identity = identity;
    return identity;
  }

  /** Mint a fresh pairing token. Any previously issued (still-pending) token is discarded. */
  issue(ttlMs = 5 * 60 * 1000): { token: string; expiresAt: number } {
    this.pairing.clear();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    this.pairing.set(token, { expiresAt });
    return { token, expiresAt };
  }

  /** Validate and consume a pairing token. Returns true only for a live, unused token. */
  consume(candidate: string): boolean {
    // It comes straight off the network, whatever its declared type.
    if (typeof candidate !== 'string') return false;
    this.prune();
    for (const [token, meta] of this.pairing) {
      if (meta.expiresAt < Date.now()) continue;
      if (constantTimeEqual(token, candidate)) {
        this.pairing.delete(token);
        return true;
      }
    }
    return false;
  }

  /**
   * Mint a durable token for a controller that just paired successfully. The
   * controller stores it and presents it on every reconnect.
   */
  issueDeviceToken(deviceName: string): { token: string; id: string } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const id = randomUUID();
    this.liveDevices().push({
      id,
      tokenHash: hashToken(token),
      deviceName,
      createdAt: now,
      lastSeenAt: now,
    });
    this.saveDevices();
    return { token, id };
  }

  /**
   * Validate a durable device token (without consuming it) and note when it was last used. The
   * stored name stays the one the device paired with, whatever name the presenter claims now.
   */
  validateDeviceToken(candidate: string): PairedDevice | null {
    if (typeof candidate !== 'string') return null;
    const hash = hashToken(candidate);
    for (const device of this.liveDevices()) {
      if (constantTimeEqual(device.tokenHash, hash)) {
        device.lastSeenAt = Date.now();
        this.saveDevices();
        return { ...device };
      }
    }
    return null;
  }

  /** The devices that may still reconnect, as copies. */
  listDevices(): PairedDevice[] {
    return this.liveDevices().map((d) => ({ ...d }));
  }

  /** Forget a paired device, so its token stops working. Returns whether it was there. */
  revokeDevice(id: string): boolean {
    const devices = this.loadDevices();
    const next = devices.filter((d) => d.id !== id);
    if (next.length === devices.length) return false;
    this.devices = next;
    this.saveDevices();
    return true;
  }

  revokeDeviceToken(token: string): void {
    const hash = hashToken(token);
    const device = this.loadDevices().find((d) => constantTimeEqual(d.tokenHash, hash));
    if (device) this.revokeDevice(device.id);
  }

  /** Drop pending pairing tokens only. Paired devices survive host restarts. */
  clear(): void {
    this.pairing.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, meta] of this.pairing) {
      if (meta.expiresAt < now) this.pairing.delete(token);
    }
  }

  /** The loaded devices minus any that went unused for too long, which are dropped for good. */
  private liveDevices(): PairedDevice[] {
    const devices = this.loadDevices();
    const now = Date.now();
    const live = devices.filter((d) => now - d.lastSeenAt <= DEVICE_TOKEN_IDLE_MS);
    if (live.length === devices.length) return devices;
    this.devices = live;
    this.saveDevices();
    return live;
  }

  // Lazily loaded because app.getPath('userData') is not available until the
  // Electron app is ready, and the TokenStore is constructed at import time.
  private storePath(): string {
    return join(app.getPath('userData'), 'remote-devices.json');
  }

  private loadDevices(): PairedDevice[] {
    if (this.devices) return this.devices;
    this.devices = [];
    let migrated = false;
    let dropped = false;
    try {
      const path = this.storePath();
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (isClearTokenEntry(entry)) {
              dropped = true;
              continue;
            }
            const device = readDevice(entry);
            if (!device) continue;
            if (device.migrated) migrated = true;
            this.devices.push(device.value);
          }
        }
      }
    } catch {
      // A corrupt store just means everyone re-pairs.
    }
    // Files written before tokens were hashed hold them in the clear, and those tokens also went
    // over the network in the clear, so those devices are forgotten and pair again.
    if (migrated || dropped) this.saveDevices();
    return this.devices;
  }

  private saveDevices(): void {
    if (!this.devices) return;
    try {
      const path = this.storePath();
      writeFileSync(path, JSON.stringify(this.devices, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      // The mode above only applies when the file is created; an older file keeps its own.
      chmodSync(path, 0o600);
    } catch {
      // Persisting is best-effort; tokens still work for this session.
    }
  }
}

/** An entry an older version wrote, holding a token that was sent over ws:// in the clear. */
function isClearTokenEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && 'token' in entry && !('tokenHash' in entry);
}

/** One entry of the devices file, given an id when it has none. */
function readDevice(entry: unknown): { value: PairedDevice; migrated: boolean } | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Record<string, unknown>;
  if (typeof raw.deviceName !== 'string') return null;
  if (typeof raw.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.tokenHash)) return null;
  const tokenHash = raw.tokenHash;
  let migrated = false;
  const now = Date.now();
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : now;
  const lastSeenAt = typeof raw.lastSeenAt === 'number' ? raw.lastSeenAt : createdAt;
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : randomUUID();
  if (id !== raw.id) migrated = true;
  return {
    value: { id, tokenHash, deviceName: raw.deviceName, createdAt, lastSeenAt },
    migrated,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
