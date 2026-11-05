import { canonicalJson } from './plan.js';

/**
 * Which fields of a synced item never leave this computer (`device`), and which are secrets that
 * travel only end-to-end encrypted (`secret`). Paths are dot-separated (`auth.password`). Every
 * other field is shared.
 */
export interface FieldSpec {
  device: readonly string[];
  secret: readonly string[];
}

export interface SplitItem {
  shared: Record<string, unknown>;
  secret: Record<string, unknown>;
  device: Record<string, unknown>;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function take(target: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  const parts = path.split('.');
  let node: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!node || typeof node !== 'object') return { found: false, value: undefined };
    node = (node as Record<string, unknown>)[part];
  }
  const last = parts[parts.length - 1] as string;
  if (!node || typeof node !== 'object' || !(last in (node as object))) {
    return { found: false, value: undefined };
  }
  const value = (node as Record<string, unknown>)[last];
  delete (node as Record<string, unknown>)[last];
  return { found: true, value };
}

function put(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object') node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

/** Splits an item into its shared, secret and per-device parts. The item itself is not changed. */
export function splitFields(item: object, spec: FieldSpec): SplitItem {
  const shared = clone(item) as Record<string, unknown>;
  const secret: Record<string, unknown> = {};
  const device: Record<string, unknown> = {};
  for (const path of spec.device) {
    const { found, value } = take(shared, path);
    if (found) device[path] = value;
  }
  for (const path of spec.secret) {
    const { found, value } = take(shared, path);
    if (found) secret[path] = value;
  }
  return { shared, secret, device };
}

/** The shared part from the server with this computer's secret and per-device parts put back. */
export function joinFields(
  shared: Record<string, unknown>,
  parts: { secret: Record<string, unknown>; device: Record<string, unknown> },
): Record<string, unknown> {
  const item = clone(shared);
  for (const [path, value] of Object.entries(parts.secret)) put(item, path, clone(value));
  for (const [path, value] of Object.entries(parts.device)) put(item, path, clone(value));
  return item;
}

/** The top-level fields whose values differ between two versions, sorted, for the conflict view. */
export function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => canonicalJson(a[key]) !== canonicalJson(b[key])).sort();
}
