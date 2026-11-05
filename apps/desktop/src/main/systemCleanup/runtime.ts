import { readdir, realpath, stat } from 'node:fs/promises';
import {
  assessDeleteTarget,
  CACHE_PROVIDERS,
  type CacheProvider,
  type CacheProviderId,
  type CleanResult,
  type DevOs,
  pathFlavour,
  type SafetyContext,
  type SystemCleanupScan,
  type SystemCleanupStatus,
  type SystemScanEvent,
} from '@runova/core';
import { CleanRefused, type CleanRequest, type DeletionLogEntry, runClean } from './engine/cleaner';
import type { measurePath } from './engine/measure';
import { removeItem } from './engine/removeTree';
import {
  type LiveScan,
  publicScan,
  runScan,
  systemVolumeOf,
  type VolumeInfo,
  volumesOf,
} from './engine/scanner';
import { type ResolvedLocation, resolveLocations } from './locations';
import type { CleanupAvailability } from './sandbox';
import type { ToolRunner } from './tools';

/**
 * Disk Cleanup as the rest of the app sees it: a scan, a clean-up, and the one live scan they share.
 *
 * It holds that live scan, so a clean-up can only ever be built from something a scan found in this
 * run of the app, and it lets one thing happen at a time, because a scan racing a clean-up of the
 * same folders could measure what is being removed. Everything that touches the machine is passed
 * in, so the whole thing is tested without one.
 */

export interface RuntimeDeps {
  availability: () => CleanupAvailability;
  os: DevOs;
  baseEnv: () => NodeJS.ProcessEnv;
  homeDir: () => string;
  /** Documents, Downloads, the app's own data, the system folders. */
  protectedFolders: () => string[];
  projectFolders: () => Promise<string[]>;
  findTools: (commands: readonly string[]) => Promise<Set<string>>;
  makeRunner: (home: string, env: NodeJS.ProcessEnv) => ToolRunner;
  newId: () => string;
  now: () => number;
  log: (entry: DeletionLogEntry) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  volumeOf?: (path: string) => Promise<VolumeInfo | null>;
  measure?: typeof measurePath;
  progressGapMs?: number;
  providers?: readonly CacheProvider[];
}

export interface ScanRequest {
  requestId: string;
  /** Just these caches. Leave out for all of them. */
  providerIds?: readonly CacheProviderId[];
  signal?: AbortSignal;
  onEvent: (event: SystemScanEvent) => void;
}

export interface SystemCleanupService {
  status(): SystemCleanupStatus;
  scan(request: ScanRequest): Promise<SystemCleanupScan>;
  clean(request: CleanRequest): Promise<CleanResult>;
  /** Stops a scan or clean-up that is running. False if there is none with that id. */
  cancel(requestId: string): boolean;
  /** The scan the next clean-up will be built from, if there is one. */
  current(): SystemCleanupScan | null;
  /** The folder a cache is in, to show in the file manager. */
  rootOf(providerId: CacheProviderId): Promise<string | null>;
  /** Resolves when any leftover from an earlier clean-up has been finished off. */
  whenTidy(): Promise<void>;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function insideFolder(path: string, folder: string, os: DevOs): boolean {
  const flavour = pathFlavour(os);
  const fold = (value: string): string =>
    os === 'linux' ? flavour.normalize(value) : flavour.normalize(value).toLowerCase();
  const target = fold(path);
  const base = fold(folder);
  return (
    target === base || target.startsWith(base.endsWith(flavour.sep) ? base : base + flavour.sep)
  );
}

export function createSystemCleanup(deps: RuntimeDeps): SystemCleanupService {
  const providers = deps.providers ?? CACHE_PROVIDERS;
  let live: LiveScan | null = null;
  let busy = false;
  let tidy: Promise<void> = Promise.resolve();
  const running = new Map<string, AbortController>();

  function assertEnabled(): void {
    const availability = deps.availability();
    if (!availability.enabled) throw new Error(availability.reason ?? 'Disk Cleanup is off.');
  }

  /** Runs one operation, refusing to start while another is going, and makes it cancellable. */
  async function exclusive<T>(
    requestId: string,
    outer: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (busy) {
      throw new Error('Disk Cleanup is already working. Wait for it to finish, or cancel it.');
    }
    busy = true;
    const controller = new AbortController();
    running.set(requestId, controller);
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      return await work(controller.signal);
    } finally {
      busy = false;
      running.delete(requestId);
    }
  }

  async function context() {
    const { sandbox } = deps.availability();
    const env = sandbox ? sandbox.env : deps.baseEnv();
    const home = sandbox ? sandbox.home : deps.homeDir();
    const safety: SafetyContext = {
      os: deps.os,
      home,
      protectedFolders: deps.protectedFolders(),
      projectFolders: await deps.projectFolders(),
    };
    return { sandbox, env, home, safety, runner: deps.makeRunner(home, env) };
  }

  async function locate(wanted: readonly CacheProvider[]): Promise<{
    locations: ResolvedLocation[];
    safety: SafetyContext;
  }> {
    const ctx = await context();
    const commands = wanted.flatMap((provider) =>
      [
        provider.locate.query?.command,
        provider.clearCommand?.command,
        provider.tidyCommand?.command,
      ].filter((command): command is string => command !== undefined),
    );
    // In a sandbox nothing is installed and nothing is asked: only the caches the test built.
    const tools = ctx.sandbox ? new Set<string>() : await deps.findTools(commands);

    const found = await resolveLocations(wanted, {
      os: deps.os,
      env: ctx.env,
      home: ctx.home,
      safety: ctx.safety,
      hasTool: (command) => tools.has(command),
      query: ctx.sandbox ? async () => null : ctx.runner.query,
      isDirectory,
      realpath: (path) => realpath(path),
      listDirectory,
    });

    const locations = ctx.sandbox
      ? found.map((location): ResolvedLocation => {
          const outside =
            location.status === 'found' &&
            location.realRoot !== null &&
            !insideFolder(location.realRoot, ctx.home, deps.os);
          return outside
            ? {
                ...location,
                status: 'refused',
                root: null,
                realRoot: null,
                reason: 'That folder is outside the test sandbox.',
              }
            : location;
        })
      : found;
    return { locations, safety: ctx.safety };
  }

  /** Finishes off folders an earlier, interrupted clean-up set aside to delete. */
  function sweep(fresh: LiveScan, safety: SafetyContext): void {
    const work = async (): Promise<void> => {
      for (const provider of fresh.providers.values()) {
        const root = provider.location.realRoot;
        if (!root) continue;
        for (const path of provider.leftovers) {
          try {
            await removeItem(path, {
              sleep: deps.sleep,
              guard: (real) => {
                const verdict = assessDeleteTarget(real, root, safety);
                return verdict.ok ? null : verdict.reason;
              },
            });
          } catch {
            // It will be tried again after the next scan.
          }
        }
      }
    };
    tidy = tidy.then(work, work);
  }

  /** Puts a newer look at some caches into the scan already held, without losing the others. */
  function merged(previous: LiveScan | null, fresh: LiveScan, partial: boolean): LiveScan {
    if (!previous || (!partial && !fresh.cancelled)) return fresh;
    const providersById = new Map(previous.providers);
    for (const [id, provider] of fresh.providers) {
      // A cache that was cut short keeps what was known about it before.
      if (provider.scan.status === 'cancelled' && providersById.has(id)) continue;
      providersById.set(id, provider);
    }
    const order = providers.map((provider) => provider.id).filter((id) => providersById.has(id));
    return {
      scanId: previous.scanId,
      startedAt: fresh.startedAt,
      finishedAt: fresh.finishedAt,
      cancelled: fresh.cancelled,
      order,
      providers: providersById,
      volumes: [],
    };
  }

  return {
    status() {
      const availability = deps.availability();
      return availability.enabled
        ? { enabled: true }
        : { enabled: false, reason: availability.reason };
    },

    async scan(request) {
      assertEnabled();
      return exclusive(request.requestId, request.signal, async (signal) => {
        const partial = request.providerIds !== undefined;
        const wanted = request.providerIds
          ? providers.filter((provider) => request.providerIds?.includes(provider.id))
          : providers;
        const { locations, safety } = await locate(wanted);

        const keepId = partial && live ? live.scanId : undefined;
        const fresh = await runScan(
          {
            locations,
            newScanId: () => keepId ?? deps.newId(),
            now: deps.now,
            volumeOf: deps.volumeOf,
            measure: deps.measure,
            progressGapMs: deps.progressGapMs,
          },
          { requestId: request.requestId, signal, onEvent: request.onEvent },
        );

        live = merged(live, fresh, partial);
        live.volumes = await volumesOf(live, deps.volumeOf ?? systemVolumeOf);
        sweep(fresh, safety);
        return publicScan(live);
      });
    },

    async clean(request) {
      assertEnabled();
      return exclusive(request.requestId, request.signal, async (signal) => {
        if (!live) throw new CleanRefused('Scan first, then clean up.');
        const ctx = await context();
        const current = live;
        const result = await runClean(
          {
            live: current,
            safety: ctx.safety,
            now: deps.now,
            sleep: deps.sleep,
            measure: deps.measure,
            runCommand: ctx.runner.runCommand,
            log: async (entry) => {
              try {
                await deps.log(entry);
              } catch {
                // A record that cannot be written must not stop a clean-up half way.
              }
            },
          },
          { ...request, signal },
        );
        // What was removed shows up as free space, so the disks are read again.
        current.volumes = await volumesOf(current, deps.volumeOf ?? systemVolumeOf);
        return { ...result, volumes: current.volumes };
      });
    },

    cancel(requestId) {
      const controller = running.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },

    current() {
      return live ? publicScan(live) : null;
    },

    async rootOf(providerId) {
      if (!deps.availability().enabled) return null;
      const wanted = providers.filter((provider) => provider.id === providerId);
      const { locations } = await locate(wanted);
      const found = locations[0];
      return found?.status === 'found' ? found.root : null;
    },

    whenTidy: () => tidy,
  };
}
