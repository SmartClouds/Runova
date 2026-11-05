import type {
  CleanupRemoveEvent,
  CleanupRemoveItem,
  CleanupRemoveResult,
  CleanupScanEvent,
  ProjectCleanupScan,
} from '@shared/projectCleanupTypes';

/**
 * Runs a scan or a removal through the preload bridge. Each run gets its own request id, so the
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
    Promise.resolve(window.runova.projectCleanup.cancel(requestId)).catch(() => undefined);
  };
  signal?.addEventListener('abort', stop, { once: true });

  try {
    const result = await start(requestId);
    if (!result) throw new Error('Clean-up did not answer. Try again.');
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', stop);
  }
}

export function runScan(
  projectId: string,
  handlers: RunHandlers<CleanupScanEvent> = {},
): Promise<ProjectCleanupScan> {
  const api = window.runova.projectCleanup;
  return run<CleanupScanEvent, ProjectCleanupScan>(
    api.onScanEvent,
    (requestId) => api.scan(projectId, requestId),
    handlers,
  );
}

export function runRemove(
  projectId: string,
  items: CleanupRemoveItem[],
  handlers: RunHandlers<CleanupRemoveEvent> = {},
): Promise<CleanupRemoveResult> {
  const api = window.runova.projectCleanup;
  return run<CleanupRemoveEvent, CleanupRemoveResult>(
    api.onRemoveEvent,
    (requestId) => api.remove(projectId, requestId, items),
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
