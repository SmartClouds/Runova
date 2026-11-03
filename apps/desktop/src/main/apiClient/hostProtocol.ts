import type { EngineEvent, EngineRunInput, EngineRunSummary } from './engine/types';

/**
 * Messages between main and the utility process that runs requests. Each side checks what it
 * receives, and anything of the wrong shape is dropped: a confused process must not be able to
 * resolve someone else's request or crash the other side.
 */

export type MainToHost =
  | { type: 'run'; runId: string; input: EngineRunInput }
  | { type: 'cancel'; runId: string };

export type HostToMain =
  | { type: 'alive' }
  | { type: 'ready'; runtimeVersion: string }
  | { type: 'event'; runId: string; event: EngineEvent }
  | { type: 'done'; runId: string; summary: EngineRunSummary }
  | { type: 'fatal'; error: string };

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRunInput(value: unknown): value is EngineRunInput {
  if (!isRecord(value) || !isRecord(value.collection) || !isRecord(value.options)) return false;
  return Array.isArray(value.collection.item) && typeof value.options.timeoutMs === 'number';
}

const EVENT_TYPES = new Set(['request', 'response', 'assertion', 'console', 'exception']);

function isEvent(value: unknown): value is EngineEvent {
  return isRecord(value) && typeof value.type === 'string' && EVENT_TYPES.has(value.type);
}

function isSummary(value: unknown): value is EngineRunSummary {
  return (
    isRecord(value) &&
    (value.error === null || typeof value.error === 'string') &&
    typeof value.cancelled === 'boolean' &&
    Array.isArray(value.environment) &&
    Array.isArray(value.globals) &&
    Array.isArray(value.collectionVariables)
  );
}

/**
 * The host's "ready" message. Postman's runtime exposes its version as a function returning an
 * object, and anything that is not plain data makes postMessage throw, so only the string goes.
 */
export function readyMessage(runtime: { version?: unknown }): {
  type: 'ready';
  runtimeVersion: string;
} {
  let version: unknown = runtime.version;
  try {
    if (typeof version === 'function') version = (version as () => unknown)();
  } catch {
    version = undefined;
  }
  if (isRecord(version)) version = version.version;
  return { type: 'ready', runtimeVersion: typeof version === 'string' ? version : 'unknown' };
}

/**
 * A copy that postMessage can always carry. Events are built from plain data, but a value from a
 * script (a Date, a function) must not be able to stop a whole run from reporting back.
 */
export function toCloneable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseMainMessage(value: unknown): MainToHost | null {
  if (!isRecord(value) || !isId(value.runId)) return null;
  if (value.type === 'run' && isRunInput(value.input)) {
    return { type: 'run', runId: value.runId, input: value.input };
  }
  if (value.type === 'cancel') return { type: 'cancel', runId: value.runId };
  return null;
}

export function parseHostMessage(value: unknown): HostToMain | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'alive':
      return { type: 'alive' };
    case 'ready':
      return typeof value.runtimeVersion === 'string'
        ? { type: 'ready', runtimeVersion: value.runtimeVersion }
        : null;
    case 'event':
      return isId(value.runId) && isEvent(value.event)
        ? { type: 'event', runId: value.runId, event: value.event }
        : null;
    case 'done':
      return isId(value.runId) && isSummary(value.summary)
        ? { type: 'done', runId: value.runId, summary: value.summary }
        : null;
    case 'fatal':
      return typeof value.error === 'string' ? { type: 'fatal', error: value.error } : null;
    default:
      return null;
  }
}
