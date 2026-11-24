import { randomUUID } from 'node:crypto';
import {
  type EncryptionPolicy,
  joinFields,
  planPull,
  planPush,
  type RemoteChange,
  type Sealing,
  type SplitItem,
  type SyncCollection,
  sealingFor,
  splitFields,
} from '@runova/core';
import type { StoredConflict, SyncDb, WireRecord } from './syncDb';
import type {
  LocalItem,
  PushRecord,
  SyncAdapter,
  SyncApi,
  SyncScopeInfo,
  SyncStatus,
} from './types';
import {
  contentHash,
  type Decoded,
  decodeRecord,
  encodeRecord,
  type ScopeKey,
  sealedWhole,
  travellingSecret,
} from './wire';

/**
 * The sync engine (E48.13). For each scope the account can see (its own and each team's): pull
 * what changed since the last cursor and write it through the adapters, then push what changed
 * here. An item edited on both sides waits as a conflict for the person to pick. Per-device fields
 * never leave this computer, secrets leave only sealed with the scope's key, and a collection that
 * is all secret (the Vault) waits for a key. Runs are single-flight: a trigger during a run makes
 * one more run after it.
 */

const PAGE = 500;
const PUSH_BATCH = 100;
/** The server takes 16 MB a push; stay well under it. */
const PUSH_BYTES = 8 * 1024 * 1024;
/** Marks an item to push after the person kept this computer's version. */
const KEEP_MINE = 'keep-mine';

export interface SyncEngineDeps {
  api: SyncApi;
  db: SyncDb;
  adapters: SyncAdapter[];
  /** The scope's key on this computer, when it has one. */
  key: (scopeId: number) => Promise<ScopeKey | null>;
  /** Collections the person turned off on the Sync screen. */
  enabled?: (collection: string) => boolean;
  /** After writes from another computer, so the renderer refreshes. */
  onApplied?: (area: string) => void;
  onStatus?: (status: SyncStatus) => void;
  now?: () => number;
  /** For tests: the most payload one push carries. */
  maxPushBytes?: number;
  /**
   * The sealing policy kept on this computer for a scope (account.json), so the server can not
   * turn sealing down on its own. Without these the server's policy is used as it is.
   */
  pinnedPolicy?: (scopeId: number) => Promise<EncryptionPolicy | null>;
  pinPolicy?: (scopeId: number, policy: EncryptionPolicy) => Promise<void>;
}

interface Split extends SplitItem {
  hash: string;
}

const NO_POLICY: EncryptionPolicy = { servers: false, environments: false, everything: false };

/** Each part sealed when either policy seals it. */
function strongerPolicy(a: EncryptionPolicy, b: EncryptionPolicy): EncryptionPolicy {
  return {
    servers: a.servers || b.servers,
    environments: a.environments || b.environments,
    everything: a.everything || b.everything,
  };
}

/** True when `a` seals some part that `b` does not. */
function sealsMore(a: EncryptionPolicy, b: EncryptionPolicy): boolean {
  return (
    (a.servers && !b.servers) ||
    (a.environments && !b.environments) ||
    (a.everything && !b.everything)
  );
}

function sealsWhole(collection: SyncCollection, policy: EncryptionPolicy): boolean {
  return sealingFor(collection, policy, true).mode === 'seal-all';
}

function inScope(item: LocalItem, scope: SyncScopeInfo): boolean {
  return (item.teamId ?? null) === scope.teamId;
}

export function createSyncEngine(deps: SyncEngineDeps) {
  const now = deps.now ?? (() => Date.now());
  const enabled = deps.enabled ?? (() => true);
  let running: Promise<void> | null = null;
  let again = false;
  let status: SyncStatus = {
    phase: 'idle',
    lastSyncedAt: null,
    error: null,
    conflicts: deps.db.conflicts().length,
    needsKey: [],
  };

  function setStatus(change: Partial<SyncStatus>): void {
    status = { ...status, ...change, conflicts: deps.db.conflicts().length };
    deps.onStatus?.(status);
  }

  function adapterFor(collection: string): SyncAdapter | undefined {
    return deps.adapters.find((a) => a.collection.id === collection);
  }

  function splitLocal(
    adapter: SyncAdapter,
    sealing: Sealing,
    value: Record<string, unknown>,
  ): Split {
    const split = splitFields(value, adapter.collection.fields);
    if (adapter.collection.allSecret) {
      // The whole entry is the secret; nothing about it is shared in the clear.
      const whole = { ...split.shared };
      return {
        shared: {},
        secret: whole,
        device: split.device,
        hash: contentHash({}, travellingSecret(sealing, whole)),
      };
    }
    return { ...split, hash: contentHash(split.shared, travellingSecret(sealing, split.secret)) };
  }

  function joined(
    adapter: SyncAdapter,
    decoded: Decoded,
    local: Split | undefined,
  ): Record<string, unknown> {
    if (adapter.collection.allSecret) {
      return joinFields(decoded.secret ?? {}, { secret: {}, device: local?.device ?? {} });
    }
    // A per-device field is this computer's alone. Our own clients never send one, so one in a
    // record (from a teammate's or a forged client) is dropped rather than kept for a new item.
    const shared = splitFields(decoded.shared, {
      device: adapter.collection.fields.device,
      secret: [],
    }).shared;
    return joinFields(shared, {
      secret: decoded.secret ?? local?.secret ?? {},
      device: local?.device ?? {},
    });
  }

  async function localItems(adapter: SyncAdapter, scope: SyncScopeInfo): Promise<LocalItem[]> {
    return (await adapter.list()).filter((item) => inScope(item, scope));
  }

  /**
   * The policy this computer seals the scope's records by: the server's, never weaker than the
   * one pinned here. The pin is what the person set on this computer, raised to the strongest
   * policy seen while this computer held the scope's key. `raised` says the pin just went up.
   */
  async function policyFor(
    scope: SyncScopeInfo,
    key: ScopeKey | null,
  ): Promise<{ policy: EncryptionPolicy; pinned: EncryptionPolicy | null; raised: boolean }> {
    const pinned = (await deps.pinnedPolicy?.(scope.id)) ?? null;
    const policy = pinned ? strongerPolicy(pinned, scope.policy) : scope.policy;
    if (key && deps.pinPolicy && (!pinned || sealsMore(policy, pinned))) {
      await deps.pinPolicy(scope.id, policy);
      return { policy, pinned: policy, raised: sealsMore(policy, pinned ?? NO_POLICY) };
    }
    return { policy, pinned, raised: false };
  }

  /** The items sync works with, and the ids of those it leaves alone here. */
  function syncing(items: LocalItem[]): { items: LocalItem[]; localOnly: Set<string> } {
    return {
      items: items.filter((item) => !item.localOnly),
      localOnly: new Set(items.filter((item) => item.localOnly).map((item) => item.id)),
    };
  }

  async function syncScope(scope: SyncScopeInfo): Promise<{ needsKey: boolean }> {
    // The cloud copy was reset: start over, so everything here is sent again.
    if (deps.db.epoch(scope.id) !== scope.epoch) deps.db.startEpoch(scope.id, scope.epoch);
    // Only the key at the version the server lists seals here; the server takes no other.
    const held = scope.keyVersion === null ? null : await deps.key(scope.id);
    const key = held && held.version === scope.keyVersion ? held : null;
    const keyFor = (version: number) => (key && key.version === version ? key : null);
    const { policy, pinned, raised } = await policyFor(scope, key);
    // The scope seals this collection whole (by its listed key and policy, or by the pin kept
    // here) but this computer has no key for it: it waits, as the Vault does, rather than going
    // out readable.
    const heldBack = (collection: SyncCollection) =>
      !key &&
      ((scope.keyVersion !== null && sealsWhole(collection, policy)) ||
        (pinned !== null && sealsWhole(collection, pinned)));
    const sealingOf = (collection: SyncCollection): Sealing =>
      heldBack(collection) ? { mode: 'needs-key' } : sealingFor(collection, policy, key !== null);
    let needsKey = false;
    // Records whose secrets waited for a key: once it is here they are applied again, even at the
    // revision this computer already has, to fill the secrets in.
    const waited = new Set(deps.db.pending(scope.id).map((r) => `${r.collection}/${r.itemId}`));

    // Pull everything since the cursor, plus records that waited for a key or a store. Only the
    // newest record of each item counts.
    const newest = new Map<string, WireRecord>();
    const take = (record: WireRecord) => {
      const id = `${record.collection}/${record.itemId}`;
      if ((newest.get(id)?.revision ?? -1) < record.revision) newest.set(id, record);
    };
    deps.db.pending(scope.id).forEach(take);
    let cursor = deps.db.cursor(scope.id);
    for (;;) {
      const page = await deps.api.changes(scope.id, cursor, PAGE);
      page.records.forEach(take);
      cursor = page.next;
      if (!page.more) break;
    }
    const incoming = [...newest.values()].sort((a, b) => a.revision - b.revision);

    // Settings and the other collections that can not be shared belong to the person's own scope
    // only. A team scope's records of theirs are dropped, never applied or kept for later, and
    // nothing of theirs is pushed there.
    const forScope = (a: SyncAdapter) => scope.teamId === null || a.collection.shareable;
    const refused = new Set(deps.adapters.filter((a) => !forScope(a)).map((a) => a.collection.id));
    const adapters = deps.adapters.filter(
      (a) => forScope(a) && enabled(a.collection.id) && (a.ready?.() ?? true),
    );
    // A store that is locked or turned off gets its records later, so the cursor can move on.
    const active = new Set(adapters.map((a) => a.collection.id));
    for (const record of incoming) {
      if (refused.has(record.collection)) {
        deps.db.dropPending(scope.id, record.collection, record.itemId);
      } else if (!active.has(record.collection)) {
        deps.db.addPending(scope.id, record);
      }
    }
    let touched = false;
    for (const adapter of adapters) {
      const sealing = sealingOf(adapter.collection);
      if (sealing.mode === 'needs-key') {
        const waiting = incoming.filter((r) => r.collection === adapter.collection.id);
        // Items here that can not go out until the key is here count too.
        if (
          waiting.length ||
          (heldBack(adapter.collection) && (await localItems(adapter, scope)).length)
        ) {
          needsKey = true;
        }
        for (const record of waiting) deps.db.addPending(scope.id, record);
        continue;
      }
      const place = (itemId: string) => ({
        scopeId: scope.id,
        collection: adapter.collection.id,
        itemId,
      });
      const listed = await adapter.list();
      const { items, localOnly } = syncing(listed.filter((item) => inScope(item, scope)));
      // Items kept here in another scope: the person's own, or another team's.
      const elsewhere = new Set(listed.filter((item) => !inScope(item, scope)).map((i) => i.id));
      const locals = new Map(
        items.map((item) => [item.id, splitLocal(adapter, sealing, item.value)]),
      );
      const conflict = (record: WireRecord, localDeleted: boolean) =>
        deps.db.addConflict({
          scopeId: scope.id,
          collection: adapter.collection.id,
          itemId: record.itemId,
          remote: record,
          localDeleted,
          detectedAt: now(),
        });
      const synced = deps.db.synced(scope.id, adapter.collection.id);
      const decoded = new Map<string, Decoded>();
      const remote: RemoteChange[] = [];
      for (const record of incoming.filter(
        (r) => r.collection === adapter.collection.id && !localOnly.has(r.itemId),
      )) {
        if (record.deleted || record.payload === null) {
          remote.push({
            itemId: record.itemId,
            revision: record.revision,
            deleted: true,
            hash: null,
          });
          continue;
        }
        const seen = (synced.get(record.itemId)?.revision ?? 0) >= record.revision;
        if (
          sealing.mode === 'seal-all' &&
          !seen &&
          !sealedWhole({ ...record, payload: record.payload })
        ) {
          // Here every record is sealed whole, so a new one with readable fields did not come
          // from a computer with the key. It is never applied; the person sees it as a conflict.
          // (One this computer already took in, from before the policy went up, is let through.)
          deps.db.dropPending(scope.id, record.collection, record.itemId);
          conflict(record, !locals.has(record.itemId));
          continue;
        }
        const content = decodeRecord({
          place: place(record.itemId),
          encryption: record.encryption,
          keyVersion: record.keyVersion,
          payload: record.payload,
          keyFor,
        });
        if (content === 'needs-key') {
          needsKey = true;
          deps.db.addPending(scope.id, record);
          continue;
        }
        if (content.locked) {
          // The shared fields are applied now; the record waits for the key to bring its secrets.
          needsKey = true;
          deps.db.addPending(scope.id, record);
        } else {
          deps.db.dropPending(scope.id, record.collection, record.itemId);
        }
        decoded.set(record.itemId, content);
        const hash = adapter.collection.allSecret
          ? contentHash({}, travellingSecret(sealing, content.secret ?? {}))
          : contentHash(content.shared, travellingSecret(sealing, content.secret ?? {}));
        remote.push({ itemId: record.itemId, revision: record.revision, deleted: false, hash });
      }

      // A record that waited for its secrets and opens now plans as if just arrived.
      const planned = new Map(synced);
      for (const change of remote) {
        const last = planned.get(change.itemId);
        const opened = !decoded.get(change.itemId)?.locked;
        if (
          opened &&
          last &&
          last.revision === change.revision &&
          waited.has(`${adapter.collection.id}/${change.itemId}`)
        ) {
          planned.set(change.itemId, { ...last, revision: change.revision - 1 });
        }
      }
      const plan = planPull({
        local: new Map([...locals].map(([id, split]) => [id, split.hash])),
        synced: planned,
        remote,
      });
      for (const change of plan.apply) {
        if (change.deleted) {
          await adapter.remove(change.itemId);
          deps.db.setSynced(scope.id, adapter.collection.id, change.itemId, {
            revision: change.revision,
            hash: null,
          });
        } else {
          if (scope.teamId !== null && elsewhere.has(change.itemId)) {
            // A team record under the id of an item kept here outside that team (moved out of
            // it, or never in it). Writing it would pull that item, with this computer's own
            // fields, into the team. The person decides.
            const record = incoming.find(
              (r) => r.collection === adapter.collection.id && r.itemId === change.itemId,
            );
            if (record) conflict(record, true);
            continue;
          }
          const content = decoded.get(change.itemId) as Decoded;
          const value = joined(adapter, content, locals.get(change.itemId));
          await adapter.apply({ id: change.itemId, teamId: scope.teamId, value });
          deps.db.setSynced(scope.id, adapter.collection.id, change.itemId, {
            revision: change.revision,
            hash: splitLocal(adapter, sealing, value).hash,
          });
        }
        touched = true;
      }
      for (const settled of plan.settle) {
        deps.db.setSynced(scope.id, adapter.collection.id, settled.itemId, {
          revision: settled.revision,
          hash: settled.hash === null ? null : (locals.get(settled.itemId)?.hash ?? settled.hash),
        });
      }
      for (const clash of plan.conflicts) {
        const record = incoming.find(
          (r) => r.collection === adapter.collection.id && r.itemId === clash.itemId,
        );
        if (record) conflict(record, clash.localDeleted);
      }
      if (touched) deps.onApplied?.(adapter.area);
      touched = false;
    }
    deps.db.setCursor(scope.id, cursor);

    if (scope.canWrite) {
      // Sealing went up: send everything again, so records stored under the weaker policy are
      // sealed the new way too.
      if (raised) deps.db.markScopeChanged(scope.id);
      await pushScope(scope, key, adapters, sealingOf);
    }
    return { needsKey };
  }

  async function pushScope(
    scope: SyncScopeInfo,
    key: ScopeKey | null,
    adapters: SyncAdapter[],
    sealingOf: (collection: SyncCollection) => Sealing,
  ): Promise<void> {
    const held = new Set(
      deps.db
        .conflicts()
        .filter((c) => c.scopeId === scope.id)
        .map((c) => `${c.collection}/${c.itemId}`),
    );
    const records: (PushRecord & { hash: string | null })[] = [];
    for (const adapter of adapters) {
      const sealing = sealingOf(adapter.collection);
      if (sealing.mode === 'needs-key') continue;
      const { items, localOnly } = syncing(await localItems(adapter, scope));
      const locals = new Map(
        items.map((item) => [item.id, splitLocal(adapter, sealing, item.value)]),
      );
      for (const id of localOnly) held.add(`${adapter.collection.id}/${id}`);
      const plan = planPush({
        local: new Map([...locals].map(([id, split]) => [id, split.hash])),
        synced: deps.db.synced(scope.id, adapter.collection.id),
        held: new Set(
          [...held]
            .filter((h) => h.startsWith(`${adapter.collection.id}/`))
            .map((h) => h.slice(adapter.collection.id.length + 1)),
        ),
      });
      for (const item of plan) {
        const split = locals.get(item.itemId);
        if (item.deleted || !split) {
          records.push({
            collection: adapter.collection.id,
            itemId: item.itemId,
            baseRevision: item.baseRevision,
            deleted: true,
            encryption: 'none',
            keyVersion: null,
            payload: null,
            hash: null,
          });
          continue;
        }
        const encoded = encodeRecord({
          place: { scopeId: scope.id, collection: adapter.collection.id, itemId: item.itemId },
          sealing,
          key,
          shared: split.shared,
          secret: split.secret,
        });
        records.push({
          collection: adapter.collection.id,
          itemId: item.itemId,
          baseRevision: item.baseRevision,
          deleted: false,
          ...encoded,
          hash: split.hash,
        });
      }
    }

    const limit = deps.maxPushBytes ?? PUSH_BYTES;
    const batches: (typeof records)[] = [];
    let current: typeof records = [];
    let bytes = 0;
    for (const record of records) {
      const size = record.payload?.length ?? 0;
      if (current.length && (current.length >= PUSH_BATCH || bytes + size > limit)) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(record);
      bytes += size;
    }
    if (current.length) batches.push(current);

    for (const batch of batches) {
      const result = await deps.api.push(
        scope.id,
        batch.map(({ hash: _hash, ...record }) => record),
      );
      for (const accepted of result.accepted) {
        const sent = batch.find(
          (r) => r.collection === accepted.collection && r.itemId === accepted.itemId,
        );
        deps.db.setSynced(scope.id, accepted.collection, accepted.itemId, {
          revision: accepted.revision,
          hash: sent?.hash ?? null,
        });
      }
      for (const conflict of result.conflicts) {
        const sent = batch.find(
          (r) => r.collection === conflict.collection && r.itemId === conflict.itemId,
        );
        deps.db.addConflict({
          scopeId: scope.id,
          collection: conflict.collection,
          itemId: conflict.itemId,
          remote: conflict,
          localDeleted: sent?.deleted ?? false,
          detectedAt: now(),
        });
      }
    }
  }

  /** Items of teams the account can no longer see leave this computer too. */
  async function dropLostTeams(scopes: SyncScopeInfo[]): Promise<void> {
    const teams = new Set(scopes.map((s) => s.teamId).filter((t): t is number => t !== null));
    for (const adapter of deps.adapters) {
      if (!(adapter.ready?.() ?? true)) continue;
      const lost = (await adapter.list()).filter(
        (item) => item.teamId !== null && !teams.has(item.teamId),
      );
      for (const item of lost) await adapter.remove(item.id);
      if (lost.length) deps.onApplied?.(adapter.area);
    }
  }

  async function runOnce(): Promise<void> {
    setStatus({ phase: 'syncing', error: null });
    try {
      const scopes = await deps.api.scopes();
      const needsKey: number[] = [];
      for (const scope of scopes) {
        if ((await syncScope(scope)).needsKey) needsKey.push(scope.id);
      }
      await dropLostTeams(scopes);
      setStatus({ phase: 'idle', lastSyncedAt: now(), needsKey });
    } catch (error) {
      const offline =
        error instanceof TypeError || (error as { name?: string }).name === 'TimeoutError';
      setStatus({
        phase: offline ? 'offline' : 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    status: () => status,

    /** Runs a sync now, or once more after the one running. */
    sync(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await runOnce();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    },

    conflicts(): StoredConflict[] {
      return deps.db.conflicts();
    },

    /** The other computer's version of a conflicted item, opened, for the conflict view. */
    async theirs(conflict: StoredConflict): Promise<Record<string, unknown> | null> {
      const adapter = adapterFor(conflict.collection);
      if (!adapter || conflict.remote.deleted || !conflict.remote.payload) return null;
      const key = await deps.key(conflict.scopeId);
      const content = decodeRecord({
        place: {
          scopeId: conflict.scopeId,
          collection: conflict.collection,
          itemId: conflict.itemId,
        },
        encryption: conflict.remote.encryption,
        keyVersion: conflict.remote.keyVersion,
        payload: conflict.remote.payload,
        keyFor: (version) => (key && key.version === version ? key : null),
      });
      if (content === 'needs-key') return null;
      const local = (await adapter.list()).find((i) => i.id === conflict.itemId);
      const sealing = { mode: 'seal-secrets' } as const;
      return joined(
        adapter,
        content,
        local ? splitLocal(adapter, sealing, local.value) : undefined,
      );
    },

    /**
     * Settles a conflict. `theirs` writes the other computer's version here; `mine` pushes this
     * computer's version over it; `both` keeps this one and adds theirs as a copy.
     */
    async resolve(
      target: { scopeId: number; collection: string; itemId: string },
      choice: 'mine' | 'theirs' | 'both',
    ): Promise<void> {
      const conflict = deps.db
        .conflicts()
        .find(
          (c) =>
            c.scopeId === target.scopeId &&
            c.collection === target.collection &&
            c.itemId === target.itemId,
        );
      const adapter = adapterFor(target.collection);
      if (!conflict || !adapter) return;
      const scopes = await deps.api.scopes();
      const scope = scopes.find((s) => s.id === conflict.scopeId);
      const teamId = scope?.teamId ?? null;

      if (choice === 'theirs' || choice === 'both') {
        const value = await this.theirs(conflict);
        if (choice === 'theirs') {
          if (value === null) await adapter.remove(conflict.itemId);
          else await adapter.apply({ id: conflict.itemId, teamId, value });
          deps.db.setSynced(conflict.scopeId, conflict.collection, conflict.itemId, {
            revision: conflict.remote.revision,
            hash:
              value === null || !scope
                ? null
                : splitLocal(
                    adapter,
                    sealingFor(adapter.collection, scope.policy, scope.keyVersion !== null),
                    value,
                  ).hash,
          });
        } else if (value && adapter.duplicate) {
          await adapter.apply({ id: randomUUID(), teamId, value: adapter.duplicate(value) });
        }
        deps.onApplied?.(adapter.area);
      }
      if (choice === 'mine' || choice === 'both') {
        deps.db.setSynced(conflict.scopeId, conflict.collection, conflict.itemId, {
          revision: conflict.remote.revision,
          hash: KEEP_MINE,
        });
      }
      deps.db.dropConflict(conflict.scopeId, conflict.collection, conflict.itemId);
      setStatus({});
      await this.sync();
    },

    /** Signing out: forget every cursor, revision and conflict. Local data stays. */
    reset(): void {
      deps.db.clear();
      setStatus({ phase: 'signed-out', lastSyncedAt: null, error: null, needsKey: [] });
    },
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
