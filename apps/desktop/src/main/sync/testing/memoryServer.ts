import type { WireRecord } from '../syncDb';
import type { ChangesPage, PushRecord, PushResult, SyncApi, SyncScopeInfo } from '../types';

/**
 * The server's sync rules in memory, for tests: one revision counter per scope, a push that names
 * a stale base revision comes back as a conflict with the server's copy, and the changes feed
 * returns records after a cursor in revision order. Records are kept exactly as pushed, so a test
 * can check what the server would see.
 */
export function createMemorySyncServer(initial: Partial<SyncScopeInfo>[] = [{ id: 1 }]) {
  const scopes = new Map<number, SyncScopeInfo>();
  const records = new Map<number, Map<string, WireRecord>>();
  let clock = Date.parse('2026-11-05T10:00:00Z');

  for (const scope of initial) {
    const id = scope.id ?? scopes.size + 1;
    scopes.set(id, {
      id,
      kind: 'personal',
      teamId: null,
      name: 'Personal',
      canWrite: true,
      canManage: true,
      epoch: 1,
      latestRevision: 0,
      keyVersion: null,
      policy: { servers: false, environments: false, everything: false },
      ...scope,
    });
    records.set(id, new Map());
  }

  const keyOf = (collection: string, itemId: string) => `${collection}/${itemId}`;

  function scope(id: number): SyncScopeInfo {
    const found = scopes.get(id);
    if (!found) throw Object.assign(new Error('not found'), { status: 404 });
    return found;
  }

  /** One connection to the server, as one computer sees it. */
  function client(options: { visible?: () => number[] } = {}): SyncApi {
    return {
      async scopes() {
        const ids = options.visible ? options.visible() : [...scopes.keys()];
        return ids.filter((id) => scopes.has(id)).map((id) => ({ ...scope(id) }));
      },
      async changes(scopeId, since, limit): Promise<ChangesPage> {
        scope(scopeId);
        const after = [...(records.get(scopeId)?.values() ?? [])]
          .filter((r) => r.revision > since)
          .sort((a, b) => a.revision - b.revision);
        const page = after.slice(0, limit);
        return {
          records: page.map((r) => ({ ...r })),
          next: page.length ? (page[page.length - 1] as WireRecord).revision : since,
          more: after.length > page.length,
        };
      },
      async push(scopeId, pushed: PushRecord[]): Promise<PushResult> {
        const target = scope(scopeId);
        if (!target.canWrite) throw Object.assign(new Error('forbidden'), { status: 403 });
        const store = records.get(scopeId) as Map<string, WireRecord>;
        const result: PushResult = { accepted: [], conflicts: [] };
        for (const record of pushed) {
          const key = keyOf(record.collection, record.itemId);
          const current = store.get(key);
          const currentRevision = current?.revision ?? 0;
          if (record.baseRevision !== currentRevision) {
            if (current) result.conflicts.push({ ...current });
            continue;
          }
          target.latestRevision += 1;
          clock += 1000;
          store.set(key, {
            collection: record.collection,
            itemId: record.itemId,
            revision: target.latestRevision,
            deleted: record.deleted,
            encryption: record.encryption,
            keyVersion: record.keyVersion,
            payload: record.deleted ? null : record.payload,
            updatedAt: new Date(clock).toISOString(),
          });
          result.accepted.push({
            collection: record.collection,
            itemId: record.itemId,
            revision: target.latestRevision,
          });
        }
        return result;
      },
    };
  }

  return {
    client,
    scope,
    setScope(id: number, change: Partial<SyncScopeInfo>) {
      scopes.set(id, { ...scope(id), ...change });
    },
    addScope(info: Partial<SyncScopeInfo> & { id: number }) {
      scopes.set(info.id, {
        kind: 'team',
        teamId: info.id,
        name: `Team ${info.id}`,
        canWrite: true,
        canManage: true,
        epoch: 1,
        latestRevision: 0,
        keyVersion: null,
        policy: { servers: false, environments: false, everything: false },
        ...info,
      });
      records.set(info.id, new Map());
    },
    /** The cloud copy reset: every record gone and a new epoch. */
    wipe(id: number) {
      records.set(id, new Map());
      scopes.set(id, { ...scope(id), epoch: scope(id).epoch + 1 });
    },
    removeScope(id: number) {
      scopes.delete(id);
      records.delete(id);
    },
    /** What the server holds for an item. */
    stored(scopeId: number, collection: string, itemId: string): WireRecord | undefined {
      return records.get(scopeId)?.get(keyOf(collection, itemId));
    },
    all(scopeId: number): WireRecord[] {
      return [...(records.get(scopeId)?.values() ?? [])];
    },
  };
}

export type MemorySyncServer = ReturnType<typeof createMemorySyncServer>;
