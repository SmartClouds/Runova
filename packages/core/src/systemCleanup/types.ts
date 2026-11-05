import type { DevOs } from '../devSetup/types.js';

/**
 * The shapes behind Disk Cleanup (E50): the caches package managers and developer tools keep, what
 * a scan finds in them, and the events a scan and a clean-up report while they run.
 *
 * The window never sends a path. A scan reports what it found with ids, and a clean-up names those
 * ids; the main process turns them back into paths from the scan it holds.
 */

export type { DevOs };

/** `versioned` caches keep one folder per version and can be pruned by version. `opaque` ones
 * (content-addressed stores) are only ever cleaned by the tool's own command. */
export type ProviderKind = 'versioned' | 'opaque';

export type CacheProviderId =
  | 'nuget'
  | 'nuget-http'
  | 'bun'
  | 'cargo'
  | 'go-mod'
  | 'go-build'
  | 'pub'
  | 'gradle-dists'
  | 'gradle-caches'
  | 'playwright'
  | 'electron'
  | 'node-gyp'
  | 'npm'
  | 'pnpm'
  | 'pip';

/** A folder listing entry. Paths given to a `DirReader` are relative to the cache root, with `/`. */
export interface DirEntryInfo {
  name: string;
  isDirectory: boolean;
}

/** Lists one folder under the cache root (`''` is the root). A missing folder lists as empty. */
export type DirReader = (relPath: string) => Promise<DirEntryInfo[]>;

/** One thing a cache holds that can be removed on its own: a package version, a browser build. */
export interface EnumeratedItem {
  /** What the versions belong to: the package, or the browser family. Items sharing it compete. */
  group: string;
  /** How the group is shown. */
  groupLabel: string;
  /** The version as the cache writes it, or null for something that has none (a manifest). */
  version: string | null;
  /** Everything that goes with this version, relative to the cache root, with `/`. */
  paths: string[];
}

/** What a tool's own command does to its cache. */
export interface CommandAction {
  /** What the button says. */
  label: string;
  command: string;
  args: string[];
  /** A command that takes a long time and prints as it goes, so a quiet minute is not a hang. */
  long?: boolean;
}

export interface CacheLocateSpec {
  /** Environment variables that name the cache. The first one set wins. `sub` is appended. */
  env: { name: string; sub?: string; first?: boolean }[];
  /** Asking the tool where its cache is. Only a few tools are ever asked. */
  query?: {
    command: string;
    args: string[];
    /** The folder in the tool's printed answer, or null if there is none. */
    parse: (output: string) => string | null;
    sub?: string;
  };
  /** Where the tool puts it when nothing says otherwise. `%VAR%` and a leading `~` are expanded. */
  defaults: Record<DevOs, string[]>;
}

export interface CacheProviderInfo {
  id: CacheProviderId;
  label: string;
  /** A short phrase for the card, such as ".NET packages". */
  tagline: string;
  kind: ProviderKind;
  /** Said when the cache is cleared, for the confirm. */
  afterClearing: string;
}

export interface CacheProvider extends CacheProviderInfo {
  locate: CacheLocateSpec;
  /** Lists what the cache holds. Versioned caches only. */
  enumerate?: (read: DirReader) => Promise<EnumeratedItem[]>;
  /**
   * Confirms the folder really is this tool's cache, by looking at a few of its items. Layouts
   * that are only "folders inside folders" (NuGet) need it, so a wrong environment variable that
   * names an ordinary folder is never offered for clean-up.
   */
  looksLikeCache?: (read: DirReader, items: EnumeratedItem[]) => Promise<boolean>;
  /** Clearing an opaque cache, or tidying one that cannot be pruned by version. */
  clearCommand?: CommandAction;
  tidyCommand?: CommandAction;
}

/** One removable thing, as a scan reports it. */
export interface ScanItem {
  id: string;
  group: string;
  groupLabel: string;
  version: string | null;
  bytes: number;
  /** Bytes in files another name also points at: deleting this does not free them. */
  sharedBytes: number;
  files: number;
  /** When anything in it last changed, ms since the epoch. */
  newestMs: number;
}

export type ProviderStatus =
  | 'queued'
  | 'locating'
  | 'scanning'
  | 'ready'
  /** Nothing of this tool's cache on this machine. */
  | 'missing'
  /** A folder is there but is not laid out the way this cache should be, so nothing is offered. */
  | 'unverified'
  | 'error'
  | 'cancelled';

export interface ProviderScan {
  id: CacheProviderId;
  label: string;
  tagline: string;
  kind: ProviderKind;
  status: ProviderStatus;
  /** Shown to the person. It is never sent back; the main process keeps its own copy. */
  root: string | null;
  bytes: number;
  files: number;
  sharedBytes: number;
  unreadable: number;
  /** The versioned things in it. Empty for an opaque cache. */
  items: ScanItem[];
  /** The tool's own command for this cache, when there is one and the tool is installed. */
  clearCommand: { label: string } | null;
  tidyCommand: { label: string } | null;
  afterClearing: string;
  error?: string;
}

/** The disk a cache lives on. */
export interface VolumeUse {
  /** What to call it, such as `C:` or `/`. */
  mount: string;
  totalBytes: number;
  freeBytes: number;
  /** Bytes the scanned caches take on this volume. */
  cacheBytes: number;
}

export interface SystemCleanupScan {
  /** Random, used once. A clean-up is only accepted for the scan the main process last made. */
  scanId: string;
  startedAt: number;
  finishedAt: number;
  cancelled: boolean;
  providers: ProviderScan[];
  volumes: VolumeUse[];
}

export interface SystemCleanupStatus {
  /** False under a test run that was not given a sandbox: nothing is scanned or deleted. */
  enabled: boolean;
  /** Why it is off, in words for the person. */
  reason?: string;
}

/** What a clean-up should remove. Ids and counts only, never a path. */
export type CleanSelection =
  | { mode: 'old-versions'; providerId: CacheProviderId; keep: number }
  | { mode: 'everything'; providerId: CacheProviderId }
  | { mode: 'items'; providerId: CacheProviderId; itemIds: string[] }
  | { mode: 'tidy'; providerId: CacheProviderId }
  | { mode: 'clear-command'; providerId: CacheProviderId };

export interface CleanFailure {
  itemId: string | null;
  label: string;
  reason: string;
}

/** A group that was left alone on purpose, with the reason in words. */
export interface CleanSkip {
  label: string;
  reason: string;
}

export interface CleanResult {
  providerId: CacheProviderId;
  removed: number;
  freedBytes: number;
  failed: CleanFailure[];
  skipped: CleanSkip[];
  cancelled: boolean;
  /** The provider as it stands afterwards, so the window can show it without scanning again. */
  provider: ProviderScan;
}

export type SystemScanEvent =
  | {
      type: 'started';
      requestId: string;
      scanId: string;
      providers: { id: CacheProviderId; label: string }[];
    }
  | { type: 'provider-started'; requestId: string; providerId: CacheProviderId }
  | {
      type: 'progress';
      requestId: string;
      providerId: CacheProviderId;
      bytes: number;
      files: number;
    }
  | { type: 'provider-done'; requestId: string; provider: ProviderScan }
  | { type: 'finished'; requestId: string; cancelled: boolean };

export type SystemCleanEvent =
  | {
      type: 'started';
      requestId: string;
      providerId: CacheProviderId;
      total: number;
      bytes: number;
    }
  | {
      type: 'item-done';
      requestId: string;
      providerId: CacheProviderId;
      itemId: string;
      label: string;
      bytes: number;
    }
  | {
      type: 'item-failed';
      requestId: string;
      providerId: CacheProviderId;
      itemId: string;
      label: string;
      reason: string;
    }
  | { type: 'line'; requestId: string; providerId: CacheProviderId; text: string }
  | { type: 'finished'; requestId: string; providerId: CacheProviderId; cancelled: boolean };
