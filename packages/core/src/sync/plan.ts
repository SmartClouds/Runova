/**
 * The decisions of a sync, as pure functions over hashes and revisions. Every item of a collection
 * is known three ways: its content here now (`local`), the content and server revision it had at
 * the last sync (`synced`), and what the server sent since then (`remote`). Hashes are of the
 * shared fields only, so a change to a per-device field (a project's folder) is never a change.
 */

/** What this computer saw at the last sync. A null hash means the item was deleted. */
export interface SyncedState {
  hash: string | null;
  revision: number;
}

/** A record from the server's changes feed, after decrypting it and hashing its shared fields. */
export interface RemoteChange {
  itemId: string;
  revision: number;
  deleted: boolean;
  /** Null for a delete. */
  hash: string | null;
}

export interface PullPlan {
  /** Write these here: the item changed only on the other side. */
  apply: RemoteChange[];
  /** Nothing to write, but remember the server's revision and hash. */
  settle: { itemId: string; revision: number; hash: string | null }[];
  /** Changed on both sides: the person picks. */
  conflicts: (RemoteChange & { localDeleted: boolean })[];
}

export interface PushItem {
  itemId: string;
  baseRevision: number;
  deleted: boolean;
  hash: string | null;
}

/** JSON with every object's keys sorted, so equal data always gives equal text and equal hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined) sorted[key] = sortKeys(field);
    }
    return sorted;
  }
  return value;
}

export function planPull(input: {
  local: ReadonlyMap<string, string>;
  synced: ReadonlyMap<string, SyncedState>;
  remote: readonly RemoteChange[];
}): PullPlan {
  const plan: PullPlan = { apply: [], settle: [], conflicts: [] };
  for (const change of input.remote) {
    const last = input.synced.get(change.itemId);
    if (last && change.revision <= last.revision) continue;
    const here = input.local.get(change.itemId) ?? null;
    const lastHash = last ? last.hash : null;
    const changedHere = here !== lastHash;
    const theirs = change.deleted ? null : change.hash;

    if (here === theirs) {
      plan.settle.push({ itemId: change.itemId, revision: change.revision, hash: theirs });
    } else if (!changedHere) {
      if (change.deleted && here === null) {
        plan.settle.push({ itemId: change.itemId, revision: change.revision, hash: null });
      } else {
        plan.apply.push(change);
      }
    } else {
      plan.conflicts.push({ ...change, localDeleted: here === null });
    }
  }
  return plan;
}

/**
 * What to send: every item whose content differs from the last sync, on the revision it was
 * based on. Items in `held` wait for the person to settle a conflict.
 */
export function planPush(input: {
  local: ReadonlyMap<string, string>;
  synced: ReadonlyMap<string, SyncedState>;
  held: ReadonlySet<string>;
}): PushItem[] {
  const push: PushItem[] = [];
  for (const [itemId, hash] of input.local) {
    if (input.held.has(itemId)) continue;
    const last = input.synced.get(itemId);
    if (last?.hash === hash) continue;
    push.push({ itemId, baseRevision: last?.revision ?? 0, deleted: false, hash });
  }
  for (const [itemId, last] of input.synced) {
    if (input.held.has(itemId) || input.local.has(itemId) || last.hash === null) continue;
    push.push({ itemId, baseRevision: last.revision, deleted: true, hash: null });
  }
  return push;
}
