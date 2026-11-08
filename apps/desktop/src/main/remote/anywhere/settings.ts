import {
  b64u,
  fromB64u,
  type IdentityKeyPair,
  identityFromSeed,
  newIdentity,
} from '@runova/protocol';

/** What a person on this computer lets others do when a session starts. */
export interface AnywherePermissions {
  /** Move the mouse and type. Without it the session is view only. */
  control: boolean;
  clipboard: boolean;
  files: boolean;
}

/** This computer's own Runova Anywhere settings (E61). Nothing here is ever sent anywhere as is. */
export interface AnywhereSettings {
  /** The master switch: off declines every request, whatever else is allowed. */
  acceptConnections: boolean;
  /** The owner's other computers connect without anyone accepting. */
  allowOwnDevices: boolean;
  /** Teams whose members see this computer and may ask to connect. */
  teamIds: number[];
  /** Teammates who connect without anyone accepting, by account id with the name to show. */
  alwaysAllow: { userId: number; displayName: string }[];
  /** Never connect directly: always through the relay, which keeps this computer's address from the other side. */
  alwaysRelay: boolean;
  /** What a new session may do, unless the person changes it when accepting. */
  defaultPermissions: AnywherePermissions;
}

export const DEFAULT_ANYWHERE_SETTINGS: AnywhereSettings = {
  acceptConnections: true,
  allowOwnDevices: false,
  teamIds: [],
  alwaysAllow: [],
  alwaysRelay: false,
  defaultPermissions: { control: true, clipboard: true, files: false },
};

export interface AnywhereRecent {
  remoteId: string;
  name: string;
  platform: string;
  at: number;
}

interface AnywhereFile {
  version: 1;
  settings?: Partial<AnywhereSettings>;
  /** The Ed25519 seed, sealed by the OS keychain. */
  identity?: string;
  /** The secret derived from the unattended-access password, sealed, with the host key it was derived for. */
  password?: { sealed: string; hostKey: string };
  /** Host keys seen on earlier connections, by Runova ID (trust on first use). */
  pins?: Record<string, string>;
  recent?: AnywhereRecent[];
}

export interface AnywhereStoreIo {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  canSeal(): boolean;
  seal(plain: string): string;
  open(sealed: string): string;
}

const RECENT_MAX = 10;

/**
 * Where Runova Anywhere keeps its state on this computer: `anywhere.json`, written atomically and
 * readable by this user only. The identity key and the password secret go in sealed by the OS
 * keychain; when the keychain is not available the identity lives in memory for this run and no
 * password can be set, rather than keeping either in the clear.
 */
export function createAnywhereStore(io: AnywhereStoreIo) {
  let cache: AnywhereFile | null = null;
  let volatileIdentity: IdentityKeyPair | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<AnywhereFile> {
    if (cache) return cache;
    const raw = await io.read();
    cache =
      raw && typeof raw === 'object' && (raw as AnywhereFile).version === 1
        ? (raw as AnywhereFile)
        : { version: 1 };
    return cache;
  }

  /** One change at a time, so two quick updates can not undo each other. */
  function change<T>(apply: (file: AnywhereFile) => T | Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const file = await load();
      const result = await apply(file);
      await io.write(file);
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async settings(): Promise<AnywhereSettings> {
      return normalize((await load()).settings);
    },

    updateSettings(patch: Partial<AnywhereSettings>): Promise<AnywhereSettings> {
      return change((file) => {
        file.settings = normalize({ ...normalize(file.settings), ...patch });
        return file.settings as AnywhereSettings;
      });
    },

    async identity(): Promise<IdentityKeyPair> {
      const file = await load();
      if (file.identity) {
        try {
          return identityFromSeed(fromB64u(io.open(file.identity)));
        } catch {
          // A key that no longer opens (a new OS account, a reset keychain) is replaced.
        }
      }
      if (!io.canSeal()) {
        volatileIdentity ??= newIdentity();
        return volatileIdentity;
      }
      const identity = newIdentity();
      await change((f) => {
        f.identity = io.seal(b64u(identity.secretKey));
      });
      return identity;
    },

    /** Whether the identity key survives a restart. */
    remembersIdentity(): boolean {
      return io.canSeal();
    },

    async hasPasswordSecret(): Promise<boolean> {
      return Boolean((await load()).password);
    },

    /** The password secret, when one is set for this host key. */
    async passwordSecret(hostKey: string): Promise<Uint8Array | null> {
      const stored = (await load()).password;
      if (!stored || stored.hostKey !== hostKey) return null;
      try {
        return fromB64u(io.open(stored.sealed));
      } catch {
        return null;
      }
    },

    setPasswordSecret(secret: Uint8Array | null, hostKey: string): Promise<void> {
      if (secret && !io.canSeal()) {
        return Promise.reject(
          new Error('This computer has no keychain to keep the password secret in.'),
        );
      }
      return change((file) => {
        if (secret) file.password = { sealed: io.seal(b64u(secret)), hostKey };
        else delete file.password;
      });
    },

    async pin(remoteId: string): Promise<string | null> {
      return (await load()).pins?.[remoteId] ?? null;
    },

    setPin(remoteId: string, key: string): Promise<void> {
      return change((file) => {
        file.pins = { ...(file.pins ?? {}), [remoteId]: key };
      });
    },

    async recent(): Promise<AnywhereRecent[]> {
      return [...((await load()).recent ?? [])];
    },

    addRecent(entry: AnywhereRecent): Promise<void> {
      return change((file) => {
        file.recent = [
          entry,
          ...(file.recent ?? []).filter((r) => r.remoteId !== entry.remoteId),
        ].slice(0, RECENT_MAX);
      });
    },

    forgetRecent(remoteId: string): Promise<void> {
      return change((file) => {
        file.recent = (file.recent ?? []).filter((r) => r.remoteId !== remoteId);
      });
    },
  };
}

export type AnywhereStore = ReturnType<typeof createAnywhereStore>;

function people(value: unknown): { userId: number; displayName: string }[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const out: { userId: number; displayName: string }[] = [];
  for (const item of value as { userId?: unknown; displayName?: unknown }[]) {
    if (!Number.isInteger(item?.userId) || seen.has(item.userId as number)) continue;
    seen.add(item.userId as number);
    out.push({
      userId: item.userId as number,
      displayName: typeof item.displayName === 'string' ? item.displayName : '',
    });
  }
  return out;
}

function normalize(value: Partial<AnywhereSettings> | undefined): AnywhereSettings {
  const v = (value ?? {}) as Record<string, unknown>;
  const bool = (key: keyof AnywhereSettings, fallback: boolean) =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : fallback;
  const ids = (key: keyof AnywhereSettings) =>
    Array.isArray(v[key])
      ? [...new Set((v[key] as unknown[]).filter((x): x is number => Number.isInteger(x)))]
      : [];
  const permissions = (v.defaultPermissions ?? {}) as Record<string, unknown>;
  const perm = (key: keyof AnywherePermissions) =>
    typeof permissions[key] === 'boolean'
      ? (permissions[key] as boolean)
      : DEFAULT_ANYWHERE_SETTINGS.defaultPermissions[key];
  return {
    acceptConnections: bool('acceptConnections', DEFAULT_ANYWHERE_SETTINGS.acceptConnections),
    allowOwnDevices: bool('allowOwnDevices', DEFAULT_ANYWHERE_SETTINGS.allowOwnDevices),
    teamIds: ids('teamIds'),
    alwaysAllow: people(v.alwaysAllow),
    alwaysRelay: bool('alwaysRelay', DEFAULT_ANYWHERE_SETTINGS.alwaysRelay),
    defaultPermissions: {
      control: perm('control'),
      clipboard: perm('clipboard'),
      files: perm('files'),
    },
  };
}
