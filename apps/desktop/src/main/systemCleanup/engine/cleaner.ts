import { lstat, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  assessDeleteTarget,
  type CacheProviderId,
  type CleanFailure,
  type CleanResult,
  type CleanSelection,
  type CleanSkip,
  type CommandAction,
  type PlanItem,
  type ProviderScan,
  planEverything,
  planKeepNewest,
  planSelection,
  type SafetyContext,
  type SystemCleanEvent,
  summarizePlan,
} from '@runova/core';
import { type Counters, createCounters, measurePath } from './measure';
import { type RemoveOptions, type RemoveOutcome, removeItem } from './removeTree';
import type { LiveItem, LiveProvider, LiveScan } from './scanner';

/**
 * A clean-up: removing what the person chose from one cache.
 *
 * It is built only from a live scan the main process made. The window sends a scan id, a cache and
 * item ids (or just "keep the newest N"); anything that does not match what that scan found is
 * refused as a whole before a single file is touched. Each removal is then checked three more
 * times, because a mistake here cannot be taken back:
 *
 *   1. the path is checked against the safety rules (inside the cache, never the cache itself),
 *   2. it is checked against what it looked like during the scan, and left alone if it has changed
 *      since (a tool may have started using it),
 *   3. the removal itself runs the rules once more on the real path.
 */

export class CleanRefused extends Error {}

export interface DeletionLogEntry {
  at: number;
  providerId: CacheProviderId;
  label: string;
  paths: string[];
  bytes: number;
}

export interface CommandOutcome {
  code: number | null;
  cancelled: boolean;
  notFound: boolean;
  timedOut: boolean;
}

export interface CleanDeps {
  live: LiveScan;
  safety: SafetyContext;
  now: () => number;
  /** Writes down what was removed. Removal is permanent, so there is a record of it. */
  log: (entry: DeletionLogEntry) => Promise<void> | void;
  runCommand: (
    action: CommandAction,
    onLine: (line: string) => void,
    signal: AbortSignal | undefined,
  ) => Promise<CommandOutcome>;
  remove?: (path: string, options: RemoveOptions) => Promise<RemoveOutcome>;
  measure?: typeof measurePath;
  sleep?: (ms: number) => Promise<void>;
}

export interface CleanRequest {
  requestId: string;
  scanId: string;
  selection: CleanSelection;
  signal?: AbortSignal;
  onEvent: (event: SystemCleanEvent) => void;
}

const CHANGED = 'It changed after the scan, so it was left alone. A tool may be using it.';

function labelOf(item: { groupLabel: string; version: string | null }): string {
  return item.version === null ? item.groupLabel : `${item.groupLabel} ${item.version}`;
}

function commandFailure(outcome: CommandOutcome): string | null {
  if (outcome.notFound) return 'The tool could not be found. Is it installed?';
  if (outcome.timedOut) return 'It took too long and was stopped.';
  if (outcome.code !== 0) {
    return `The command stopped with an error (exit code ${outcome.code ?? 'unknown'}).`;
  }
  return null;
}

export async function runClean(deps: CleanDeps, request: CleanRequest): Promise<CleanResult> {
  const { live } = deps;
  const { selection, signal } = request;
  const emit = request.onEvent;
  const remove = deps.remove ?? removeItem;
  const measure = deps.measure ?? measurePath;

  if (request.scanId !== live.scanId) {
    throw new CleanRefused('That scan is out of date. Scan again, then clean up.');
  }
  const provider = live.providers.get(selection.providerId);
  if (!provider || provider.scan.status !== 'ready' || !provider.location.realRoot) {
    throw new CleanRefused('That cache was not found by the scan, so it cannot be cleaned.');
  }
  const root = provider.location.realRoot;
  const providerId = selection.providerId;

  if (selection.mode === 'tidy' || selection.mode === 'clear-command') {
    return runCommandClean(provider, selection.mode);
  }
  if (provider.scan.kind !== 'versioned') {
    throw new CleanRefused('This cache is cleaned by its own tool, not by removing its files.');
  }

  const all = [...provider.items.values()].map((entry) => entry.item);
  let toRemove: PlanItem[];
  let skipped: CleanSkip[] = [];
  if (selection.mode === 'old-versions') {
    const plan = planKeepNewest(all, { keep: selection.keep });
    toRemove = plan.remove;
    skipped = plan.skipped.map((skip) => ({ label: skip.label, reason: skip.reason }));
  } else if (selection.mode === 'everything') {
    toRemove = planEverything(all).remove;
  } else {
    if (selection.itemIds.length === 0) throw new CleanRefused('Nothing was chosen.');
    const chosen = planSelection(all, selection.itemIds);
    if (chosen.unknown.length > 0) {
      throw new CleanRefused('The choice includes something the scan did not find.');
    }
    toRemove = chosen.remove;
  }

  const summary = summarizePlan(toRemove);
  emit({
    type: 'started',
    requestId: request.requestId,
    providerId,
    total: summary.items,
    bytes: summary.bytes,
  });

  const failed: CleanFailure[] = [];
  const goneIds: string[] = [];
  let removedCount = 0;
  let freedBytes = 0;
  let cancelled = false;

  const refusalFor = (path: string): string | null => {
    const verdict = assessDeleteTarget(path, root, deps.safety);
    return verdict.ok ? null : verdict.reason;
  };

  async function isStale(entry: LiveItem): Promise<boolean> {
    for (const stamp of entry.stamps) {
      try {
        const info = await lstat(stamp.path);
        if (stamp.ino !== 0 && Number(info.ino) !== stamp.ino) return true;
        if (stamp.mtimeMs !== 0 && info.mtimeMs !== stamp.mtimeMs) return true;
      } catch {
        // Gone already, which is what is wanted.
      }
    }
    return false;
  }

  /** Takes away the folders a removal leaves empty, up to but never including the cache itself. */
  async function pruneEmptyParents(path: string): Promise<void> {
    let parent = dirname(path);
    while (assessDeleteTarget(parent, root, deps.safety).ok) {
      try {
        await rmdir(parent);
      } catch {
        return;
      }
      parent = dirname(parent);
    }
  }

  const fail = (entry: LiveItem, label: string, reason: string): void => {
    failed.push({ itemId: entry.id, label, reason });
    emit({
      type: 'item-failed',
      requestId: request.requestId,
      providerId,
      itemId: entry.id,
      label,
      reason,
    });
  };

  for (const planned of toRemove) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const entry = provider.items.get(planned.id);
    if (!entry) continue;
    const label = labelOf(entry.item);

    const refusal = entry.paths.map(refusalFor).find((reason) => reason !== null);
    if (refusal) {
      fail(entry, label, refusal);
      continue;
    }
    if (await isStale(entry)) {
      fail(entry, label, CHANGED);
      continue;
    }

    let problem: string | null = null;
    let removedSomething = false;
    for (const path of entry.paths) {
      const outcome = await remove(path, {
        signal,
        sleep: deps.sleep,
        guard: (real) => refusalFor(real),
      });
      if (outcome.status === 'cancelled') {
        cancelled = true;
        break;
      }
      if (outcome.status === 'removed') {
        removedSomething = true;
        await pruneEmptyParents(path);
      } else if (outcome.status !== 'gone') {
        problem = outcome.reason;
        break;
      }
    }
    if (cancelled) break;
    if (problem !== null) {
      fail(entry, label, problem);
      continue;
    }

    removedCount += 1;
    goneIds.push(entry.id);
    const freed = removedSomething ? entry.item.bytes : 0;
    freedBytes += freed;
    if (removedSomething) {
      await deps.log({
        at: deps.now(),
        providerId,
        label,
        paths: entry.paths,
        bytes: entry.item.bytes,
      });
    }
    emit({
      type: 'item-done',
      requestId: request.requestId,
      providerId,
      itemId: entry.id,
      label,
      bytes: freed,
    });
  }

  const updated = withoutItems(provider, goneIds);
  emit({ type: 'finished', requestId: request.requestId, providerId, cancelled });
  return {
    providerId,
    removed: removedCount,
    freedBytes,
    failed,
    skipped,
    cancelled,
    provider: updated,
  };

  async function runCommandClean(
    target: LiveProvider,
    mode: 'tidy' | 'clear-command',
  ): Promise<CleanResult> {
    const defined =
      mode === 'tidy'
        ? target.location.provider.tidyCommand
        : target.location.provider.clearCommand;
    const available = mode === 'tidy' ? target.scan.tidyCommand : target.scan.clearCommand;
    if (!defined || !available) {
      throw new CleanRefused('That tool is not installed, so its clean-up command cannot be run.');
    }

    const before = target.scan.bytes;
    emit({ type: 'started', requestId: request.requestId, providerId, total: 1, bytes: before });

    const outcome = await deps.runCommand(
      defined,
      (text) => emit({ type: 'line', requestId: request.requestId, providerId, text }),
      signal,
    );

    const failures: CleanFailure[] = [];
    let freed = 0;
    if (outcome.cancelled || signal?.aborted) {
      emit({ type: 'finished', requestId: request.requestId, providerId, cancelled: true });
      return {
        providerId,
        removed: 0,
        freedBytes: 0,
        failed: [],
        skipped: [],
        cancelled: true,
        provider: target.scan,
      };
    }

    const reason = commandFailure(outcome);
    if (reason) {
      failures.push({ itemId: null, label: defined.label, reason });
      emit({
        type: 'item-failed',
        requestId: request.requestId,
        providerId,
        itemId: 'command',
        label: defined.label,
        reason,
      });
    } else {
      // What a tool removed is only known by looking again.
      const counters: Counters = createCounters();
      const size = await measure(root, { counters, signal });
      freed = Math.max(0, before - size.bytes);
      target.scan = {
        ...target.scan,
        bytes: size.bytes,
        files: size.files,
        sharedBytes: size.sharedBytes,
      };
      emit({
        type: 'item-done',
        requestId: request.requestId,
        providerId,
        itemId: 'command',
        label: defined.label,
        bytes: freed,
      });
    }

    emit({ type: 'finished', requestId: request.requestId, providerId, cancelled: false });
    return {
      providerId,
      removed: failures.length === 0 ? 1 : 0,
      freedBytes: freed,
      failed: failures,
      skipped: [],
      cancelled: false,
      provider: target.scan,
    };
  }
}

/** The live provider with the given items taken out of it, and its scan brought up to date. */
function withoutItems(provider: LiveProvider, ids: readonly string[]): ProviderScan {
  const gone = new Set(ids);
  let bytes = 0;
  let files = 0;
  let sharedBytes = 0;
  for (const id of gone) {
    const entry = provider.items.get(id);
    if (!entry) continue;
    bytes += entry.item.bytes;
    files += entry.item.files;
    sharedBytes += entry.item.sharedBytes;
    provider.items.delete(id);
  }
  provider.scan = {
    ...provider.scan,
    bytes: Math.max(0, provider.scan.bytes - bytes),
    files: Math.max(0, provider.scan.files - files),
    sharedBytes: Math.max(0, provider.scan.sharedBytes - sharedBytes),
    items: provider.scan.items.filter((item) => !gone.has(item.id)),
  };
  return provider.scan;
}
