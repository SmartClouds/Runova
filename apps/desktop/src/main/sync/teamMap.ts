import type { SyncDb } from './syncDb';
import type { SyncAdapter } from './types';

/**
 * Which team each shared item belongs to, kept by the sync layer itself (sync-state.db) rather
 * than on the stored record. The stores' own save paths rebuild their records from what the
 * screen sends, so a field of ours on the record would be lost at the first edit and the item
 * would quietly leave its team. The map wins over the record; a record's own field still counts
 * for an item the map has never seen.
 */
export function withTeamMap(adapter: SyncAdapter, db: SyncDb): SyncAdapter {
  const collection = adapter.collection.id;
  return {
    ...adapter,
    async list() {
      return (await adapter.list()).map((item) => {
        const team = db.teamOf(collection, item.id);
        return team === undefined ? item : { ...item, teamId: team };
      });
    },
    async apply(item) {
      db.setTeam(collection, item.id, item.teamId);
      await adapter.apply(item);
    },
    async remove(id) {
      db.dropTeam(collection, id);
      await adapter.remove(id);
    },
  };
}
