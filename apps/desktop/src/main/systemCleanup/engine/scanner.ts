import { lstat, stat, statfs } from 'node:fs/promises';
import { join, parse } from 'node:path';
import {
  type CacheProviderId,
  enumerateProvider,
  OTHER_GROUP,
  type ProviderScan,
  type ScanItem,
  type SystemCleanupScan,
  type SystemScanEvent,
  type VolumeUse,
} from '@runova/core';
import { throttle } from '../../projectCleanup/throttle';
import { limiter } from '../../util/limiter';
import type { ResolvedLocation } from '../locations';
import { type Counters, createCounters, measurePath } from './measure';
import { createDirReader } from './readDir';

/**
 * A scan: for each cache that was found, what is in it and how much each thing takes.
 *
 * It produces two things. The window gets a `ProviderScan` per cache, with ids and sizes and no
 * paths beyond the cache folder to show. This module keeps the other half, the `LiveScan`, which
 * maps each id back to the real paths and remembers what each looked like when it was measured.
 * A clean-up is built from that half, so the window can only ever name something a scan found.
 */

/** What a path looked like when it was measured, so a clean-up can tell if it has changed since. */
export interface PathStamp {
  path: string;
  ino: number;
  mtimeMs: number;
}

export interface LiveItem {
  id: string;
  /** Full paths, inside the cache folder, with links in the parents already followed. */
  paths: string[];
  stamps: PathStamp[];
  item: ScanItem;
}

export interface LiveProvider {
  location: ResolvedLocation;
  scan: ProviderScan;
  items: Map<string, LiveItem>;
  /** Folders an earlier clean-up set aside to delete and did not finish. */
  leftovers: string[];
}

export interface LiveScan {
  scanId: string;
  startedAt: number;
  finishedAt: number;
  cancelled: boolean;
  order: CacheProviderId[];
  providers: Map<CacheProviderId, LiveProvider>;
  volumes: VolumeUse[];
}

export interface VolumeInfo {
  /** Two caches with the same key are on the same disk. */
  key: string;
  mount: string;
  totalBytes: number;
  freeBytes: number;
}

export interface ScanDeps {
  locations: readonly ResolvedLocation[];
  newScanId: () => string;
  now: () => number;
  volumeOf?: (path: string) => Promise<VolumeInfo | null>;
  measure?: typeof measurePath;
  /** Files between progress ticks from a walk. */
  progressEveryFiles?: number;
  /** Least time between progress events for one cache. */
  progressGapMs?: number;
  /** Caches read at once. A disk that has to jump between several is slower than reading in turn. */
  providerConcurrency?: number;
  /** Things in one cache measured at once. */
  itemConcurrency?: number;
}

export interface ScanRun {
  requestId: string;
  signal?: AbortSignal;
  onEvent: (event: SystemScanEvent) => void;
}

const DEFAULT_PROVIDER_CONCURRENCY = 2;
const DEFAULT_ITEM_CONCURRENCY = 4;
const DEFAULT_PROGRESS_GAP_MS = 150;
/** Filesystem calls in flight inside one measured folder. Several of those run at once. */
const WALK_CONCURRENCY = 8;

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function toolLabels(
  location: ResolvedLocation,
): Pick<ProviderScan, 'clearCommand' | 'tidyCommand'> {
  const { provider, tools } = location;
  return {
    clearCommand:
      tools.clear && provider.clearCommand ? { label: provider.clearCommand.label } : null,
    tidyCommand: tools.tidy && provider.tidyCommand ? { label: provider.tidyCommand.label } : null,
  };
}

function skeleton(
  location: ResolvedLocation,
  status: ProviderScan['status'],
  extra: Partial<ProviderScan> = {},
): ProviderScan {
  const { provider } = location;
  return {
    id: provider.id,
    label: provider.label,
    tagline: provider.tagline,
    kind: provider.kind,
    status,
    root: location.root,
    bytes: 0,
    files: 0,
    sharedBytes: 0,
    unreadable: 0,
    items: [],
    clearCommand: null,
    tidyCommand: null,
    afterClearing: provider.afterClearing,
    ...extra,
  };
}

export async function runScan(deps: ScanDeps, run: ScanRun): Promise<LiveScan> {
  const measure = deps.measure ?? measurePath;
  const { signal } = run;
  const scanId = deps.newScanId();
  const startedAt = deps.now();

  const live: LiveScan = {
    scanId,
    startedAt,
    finishedAt: startedAt,
    cancelled: false,
    order: deps.locations.map((location) => location.provider.id),
    providers: new Map(),
    volumes: [],
  };

  run.onEvent({
    type: 'started',
    requestId: run.requestId,
    scanId,
    providers: deps.locations.map((location) => ({
      id: location.provider.id,
      label: location.provider.label,
    })),
  });

  /** Totals for one cache, with a throttled progress event as it reads. */
  function progressFor(location: ResolvedLocation): (counters: Counters) => void {
    return throttle(
      (counters: Counters) =>
        run.onEvent({
          type: 'progress',
          requestId: run.requestId,
          providerId: location.provider.id,
          bytes: counters.bytes,
          files: counters.files,
        }),
      deps.progressGapMs ?? DEFAULT_PROGRESS_GAP_MS,
    );
  }

  async function scanOpaque(location: ResolvedLocation, root: string): Promise<LiveProvider> {
    const counters = createCounters();
    const size = await measure(root, {
      counters,
      signal,
      progressEvery: deps.progressEveryFiles,
      onTick: progressFor(location),
    });
    return {
      location,
      items: new Map(),
      leftovers: [],
      scan: skeleton(location, 'ready', {
        bytes: size.bytes,
        files: size.files,
        sharedBytes: size.sharedBytes,
        unreadable: size.unreadable,
        ...toolLabels(location),
      }),
    };
  }

  async function stampOf(path: string): Promise<PathStamp> {
    try {
      const info = await lstat(path);
      return { path, ino: Number(info.ino), mtimeMs: info.mtimeMs };
    } catch {
      return { path, ino: 0, mtimeMs: 0 };
    }
  }

  async function scanVersioned(location: ResolvedLocation, root: string): Promise<LiveProvider> {
    const { provider } = location;
    let unreadable = 0;
    const leftovers: string[] = [];
    const read = createDirReader(
      root,
      undefined,
      () => {
        unreadable += 1;
      },
      (relPath) => leftovers.push(join(root, ...relPath.split('/'))),
    );

    const found = await enumerateProvider(provider, read);
    const recognised =
      found.length === 0 ||
      (found.some((entry) => entry.group !== OTHER_GROUP) &&
        (await provider.looksLikeCache?.(read, found)) !== false);

    const counters = createCounters();
    const tick = progressFor(location);

    if (!recognised) {
      // Something is there, but it is not laid out like this cache. Show how big it is, offer nothing.
      const size = await measure(root, {
        counters,
        signal,
        progressEvery: deps.progressEveryFiles,
        onTick: tick,
      });
      return {
        location,
        items: new Map(),
        leftovers: [],
        scan: skeleton(location, 'unverified', {
          bytes: size.bytes,
          files: size.files,
          sharedBytes: size.sharedBytes,
          unreadable: size.unreadable + unreadable,
          error: `This folder is not laid out like a ${provider.label} cache, so nothing in it is offered for clean-up.`,
        }),
      };
    }

    const limit = limiter(deps.itemConcurrency ?? DEFAULT_ITEM_CONCURRENCY);
    const measured = await Promise.all(
      found.map((entry, index) =>
        limit(async () => {
          const paths = entry.paths.map((relPath) => join(root, ...relPath.split('/')));
          let bytes = 0;
          let files = 0;
          let sharedBytes = 0;
          let newestMs = 0;
          let unread = 0;
          for (const path of paths) {
            const size = await measure(path, {
              counters,
              signal,
              concurrency: WALK_CONCURRENCY,
              progressEvery: deps.progressEveryFiles,
              onTick: tick,
            });
            bytes += size.bytes;
            files += size.files;
            sharedBytes += size.sharedBytes;
            newestMs = Math.max(newestMs, size.newestMs);
            unread += size.unreadable;
          }
          const stamps = await Promise.all(paths.map(stampOf));
          const item: ScanItem = {
            id: index.toString(36),
            group: entry.group,
            groupLabel: entry.groupLabel,
            version: entry.version,
            bytes,
            sharedBytes,
            files,
            newestMs,
          };
          return { live: { id: item.id, paths, stamps, item } satisfies LiveItem, unread };
        }),
      ),
    );

    const items = new Map<string, LiveItem>();
    let bytes = 0;
    let files = 0;
    let sharedBytes = 0;
    let unreadableTotal = unreadable;
    for (const entry of measured) {
      items.set(entry.live.id, entry.live);
      bytes += entry.live.item.bytes;
      files += entry.live.item.files;
      sharedBytes += entry.live.item.sharedBytes;
      unreadableTotal += entry.unread;
    }

    return {
      location,
      items,
      leftovers,
      scan: skeleton(location, 'ready', {
        bytes,
        files,
        sharedBytes,
        unreadable: unreadableTotal,
        items: measured.map((entry) => entry.live.item),
        ...toolLabels(location),
      }),
    };
  }

  async function scanOne(location: ResolvedLocation): Promise<LiveProvider> {
    const base = (status: ProviderScan['status'], extra?: Partial<ProviderScan>): LiveProvider => ({
      location,
      items: new Map(),
      leftovers: [],
      scan: skeleton(location, status, extra),
    });

    if (signal?.aborted) return base('cancelled');
    run.onEvent({
      type: 'provider-started',
      requestId: run.requestId,
      providerId: location.provider.id,
    });

    if (location.status === 'refused') return base('unverified', { error: location.reason });
    if (location.status === 'missing' || !location.realRoot) return base('missing');

    try {
      return location.provider.kind === 'opaque'
        ? await scanOpaque(location, location.realRoot)
        : await scanVersioned(location, location.realRoot);
    } catch (error) {
      if (isAbort(error)) return base('cancelled');
      return base('error', {
        error: error instanceof Error ? error.message : 'The folder could not be read.',
      });
    }
  }

  const limit = limiter(deps.providerConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY);
  await Promise.all(
    deps.locations.map((location) =>
      limit(async () => {
        const provider = await scanOne(location);
        live.providers.set(location.provider.id, provider);
        run.onEvent({ type: 'provider-done', requestId: run.requestId, provider: provider.scan });
      }),
    ),
  );

  live.cancelled = signal?.aborted === true;
  live.volumes = await volumesOf(live, deps.volumeOf ?? systemVolumeOf);
  live.finishedAt = deps.now();
  run.onEvent({ type: 'finished', requestId: run.requestId, cancelled: live.cancelled });
  return live;
}

export async function volumesOf(
  live: LiveScan,
  volumeOf: (path: string) => Promise<VolumeInfo | null>,
): Promise<VolumeUse[]> {
  const byKey = new Map<string, VolumeUse>();
  for (const id of live.order) {
    const provider = live.providers.get(id);
    const root = provider?.location.realRoot;
    if (!provider || !root || provider.scan.bytes <= 0) continue;
    try {
      const volume = await volumeOf(root);
      if (!volume) continue;
      const existing = byKey.get(volume.key);
      if (existing) existing.cacheBytes += provider.scan.bytes;
      else {
        byKey.set(volume.key, {
          mount: volume.mount,
          totalBytes: volume.totalBytes,
          freeBytes: volume.freeBytes,
          cacheBytes: provider.scan.bytes,
        });
      }
    } catch {
      // A disk that cannot be asked about is simply left out of the bar.
    }
  }
  return [...byKey.values()];
}

/** The disk a folder is on, how big it is and how much of it is free. */
export async function systemVolumeOf(path: string): Promise<VolumeInfo | null> {
  const [space, info] = await Promise.all([statfs(path), stat(path)]);
  const totalBytes = Number(space.blocks) * Number(space.bsize);
  if (!(totalBytes > 0)) return null;
  const drive = process.platform === 'win32' ? parse(path).root.replace(/[\\/]+$/, '') : '';
  return {
    key: drive ? drive.toUpperCase() : String(info.dev),
    mount: drive ? drive.toUpperCase() : '/',
    totalBytes,
    freeBytes: Number(space.bavail) * Number(space.bsize),
  };
}

/** What the window gets: the same scan with every path left behind. */
export function publicScan(live: LiveScan): SystemCleanupScan {
  return {
    scanId: live.scanId,
    startedAt: live.startedAt,
    finishedAt: live.finishedAt,
    cancelled: live.cancelled,
    providers: live.order.flatMap((id) => {
      const provider = live.providers.get(id);
      return provider ? [provider.scan] : [];
    }),
    volumes: live.volumes,
  };
}
