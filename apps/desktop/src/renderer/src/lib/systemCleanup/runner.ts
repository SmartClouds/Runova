import type {
  CacheProviderId,
  CleanResult,
  CleanSelection,
  SystemCleanEvent,
  SystemCleanupScan,
  SystemScanEvent,
} from '@runova/core';

/**
 * Runs a scan or a clean-up through the preload bridge. Each run gets its own request id, so the
 * progress events of one never reach the screen of another, and a signal turns into the Cancel
 * the main process understands. A cancelled run always ends as an `AbortError`, so a caller can
 * tell "the person stopped it" from "it failed" without reading wording that Electron wraps.
 */

export interface RunHandlers<Event> {
  onEvent?: (event: Event) => void;
  signal?: AbortSignal;
}

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function abortError(): Error {
  return new DOMException('Cancelled.', 'AbortError');
}

async function run<Event extends { requestId: string }, Result>(
  subscribe: (callback: (event: Event) => void) => () => void,
  start: (requestId: string) => Promise<Result | undefined>,
  handlers: RunHandlers<Event>,
): Promise<Result> {
  const { signal, onEvent } = handlers;
  if (signal?.aborted) throw abortError();

  const requestId = newRequestId();
  // Listening first, so an event sent before the call returns is not missed.
  const unsubscribe = subscribe((event) => {
    if (event.requestId === requestId) onEvent?.(event);
  });
  const stop = (): void => {
    Promise.resolve(window.runova.systemCleanup.cancel(requestId)).catch(() => undefined);
  };
  signal?.addEventListener('abort', stop, { once: true });

  try {
    const result = await start(requestId);
    if (!result) throw new Error('Disk Cleanup did not answer. Try again.');
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', stop);
  }
}

export interface ScanOptions extends RunHandlers<SystemScanEvent> {
  /** Just these caches. Leave out for all of them. */
  providerIds?: CacheProviderId[];
}

export function runScan(options: ScanOptions = {}): Promise<SystemCleanupScan> {
  const api = window.runova.systemCleanup;
  return run<SystemScanEvent, SystemCleanupScan>(
    api.onScanEvent,
    (requestId) => api.scan(requestId, options.providerIds),
    options,
  );
}

export function runClean(
  scanId: string,
  selection: CleanSelection,
  handlers: RunHandlers<SystemCleanEvent> = {},
): Promise<CleanResult> {
  const api = window.runova.systemCleanup;
  return run<SystemCleanEvent, CleanResult>(
    api.onCleanEvent,
    (requestId) => api.clean(requestId, scanId, selection),
    handlers,
  );
}

/**
 * Whether an error is the person stopping a run rather than a run failing. It goes by the name
 * alone: a `DOMException` is not always an `Error` to the code checking it, since the two can
 * come from different realms.
 */
export function isCancelled(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}
