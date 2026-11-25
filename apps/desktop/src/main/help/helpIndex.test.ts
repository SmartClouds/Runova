import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALWAYS_TRUE, dropTable, hostileSqlValues } from '../../test/main/hostileSqlInput';
import type { HelpChunk } from './chunker';
import { HelpIndex } from './helpIndex';

/**
 * The help chat's SQLite index, run twice: once with sqlite-vec loaded (what the app uses) and once
 * without it (the fallback when the extension cannot load), through the node:sqlite shim.
 */

function chunk(id: string, text: string, hash = `h-${id}-${text.length}`): HelpChunk {
  const [slug = id, anchor = ''] = id.split('#');
  return {
    id,
    slug,
    articleTitle: slug,
    heading: anchor,
    anchor,
    text,
    hash,
  };
}

function vec(...values: number[]): Float32Array {
  const v = Float32Array.from(values);
  const norm = Math.hypot(...values);
  return v.map((x) => x / norm);
}

const BASE = [
  chunk('vault#unlock#0', 'Vault > Unlock\n\nType your master password to unlock the vault.'),
  chunk('workspace#split#0', 'Workspace > Split\n\nDrag a terminal tab to split the pane.'),
  chunk('deploy#intro#0', 'Deploy\n\nManage your Linux servers and containers.'),
];

for (const vector of [true, false]) {
  describe(`HelpIndex (${vector ? 'sqlite-vec' : 'JavaScript vectors'})`, () => {
    let dir: string;
    let index: HelpIndex;

    function open(): HelpIndex {
      return new HelpIndex(
        join(dir, 'help.db'),
        vector ? undefined : { loadVectorExtension: () => false },
      );
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'runova-help-'));
      index = open();
    });

    afterEach(() => {
      index.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('reports which vector backend it runs on', () => {
      expect(index.vectorBackend).toBe(vector ? 'sqlite-vec' : 'js');
    });

    it('adds, updates and removes chunks to match the articles', () => {
      expect(index.sync(BASE)).toEqual({ added: 3, updated: 0, removed: 0 });
      expect(index.sync(BASE)).toEqual({ added: 0, updated: 0, removed: 0 });
      const next = [
        chunk('vault#unlock#0', 'Vault > Unlock\n\nUse your fingerprint.'),
        BASE[1]!,
        chunk('vault#lock#0', 'Vault > Lock\n\nLock it when you leave.'),
      ];
      expect(index.sync(next)).toEqual({ added: 1, updated: 1, removed: 1 });
      expect(index.count()).toBe(3);
      expect(index.getChunks(['vault#unlock#0'])[0]?.text).toContain('fingerprint');
    });

    it('finds chunks by keyword with prefixes and stemming, best first', () => {
      index.sync(BASE);
      expect(index.searchText('master password', 5)[0]).toBe('vault#unlock#0');
      expect(index.searchText('splitting panes', 5)[0]).toBe('workspace#split#0');
      expect(index.searchText('contain', 5)).toEqual(['deploy#intro#0']);
    });

    it('ignores filler words that would match almost every passage', () => {
      index.sync(BASE);
      expect(index.searchText('how do I unlock it', 5)).toEqual(['vault#unlock#0']);
    });

    it('ignores punctuation that would break the FTS query syntax', () => {
      index.sync(BASE);
      expect(() => index.searchText('"vault" AND (OR*', 5)).not.toThrow();
      expect(index.searchText('   ', 5)).toEqual([]);
    });

    it('drops the old text from the keyword index when a chunk changes', () => {
      index.sync(BASE);
      index.sync([
        chunk('vault#unlock#0', 'Vault > Unlock\n\nUse your fingerprint.'),
        ...BASE.slice(1),
      ]);
      expect(index.searchText('master', 5)).toEqual([]);
      expect(index.searchText('fingerprint', 5)).toEqual(['vault#unlock#0']);
    });

    it('tracks which chunks still need vectors for each embedder', () => {
      index.sync(BASE);
      expect(index.pendingEmbeddings('e1').map((c) => c.id)).toEqual(BASE.map((c) => c.id));
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      expect(index.pendingEmbeddings('e1')).toHaveLength(2);
      expect(index.pendingEmbeddings('e2')).toHaveLength(3);
      expect(index.embeddedCount('e1')).toBe(1);
    });

    it('finds the nearest chunks by cosine similarity', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [
        { id: 'vault#unlock#0', vector: vec(1, 0, 0) },
        { id: 'workspace#split#0', vector: vec(0, 1, 0) },
        { id: 'deploy#intro#0', vector: vec(0.7, 0.7, 0) },
      ]);
      expect(index.searchVector('e1', vec(0.9, 0.2, 0), 2)).toEqual([
        'vault#unlock#0',
        'deploy#intro#0',
      ]);
    });

    it('keeps each embedder in its own space and survives a dimension mismatch', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      index.storeEmbeddings('e2', [{ id: 'workspace#split#0', vector: vec(1, 0) }]);
      expect(index.searchVector('e2', vec(1, 0), 5)).toEqual(['workspace#split#0']);
      expect(index.searchVector('e1', vec(1, 0), 5)).toEqual([]);
      expect(index.searchVector('nobody', vec(1, 0, 0), 5)).toEqual([]);
    });

    it('forgets the vector of a chunk whose text changed', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      index.sync([chunk('vault#unlock#0', 'Vault > Unlock\n\nNew text.'), ...BASE.slice(1)]);
      expect(index.searchVector('e1', vec(1, 0, 0), 5)).toEqual([]);
      expect(index.pendingEmbeddings('e1').map((c) => c.id)).toContain('vault#unlock#0');
    });

    it('forgets the vectors of removed chunks', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'deploy#intro#0', vector: vec(1, 0, 0) }]);
      index.sync(BASE.slice(0, 2));
      expect(index.searchVector('e1', vec(1, 0, 0), 5)).toEqual([]);
      expect(index.embeddedCount('e1')).toBe(0);
    });

    it('keeps everything across a reopen', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      index.close();
      index = open();
      expect(index.count()).toBe(3);
      expect(index.searchVector('e1', vec(1, 0, 0), 1)).toEqual(['vault#unlock#0']);
      expect(index.searchText('vault', 1)).toEqual(['vault#unlock#0']);
    });

    it('returns chunks in the order asked for, skipping unknown ids', () => {
      index.sync(BASE);
      expect(
        index.getChunks(['deploy#intro#0', 'nope', 'vault#unlock#0']).map((c) => c.id),
      ).toEqual(['deploy#intro#0', 'vault#unlock#0']);
    });

    it('lists the embedders that have vectors, sorted, and none on a new index', () => {
      index.sync(BASE);
      expect(index.embedderIds()).toEqual([]);
      index.storeEmbeddings('openai:b', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      index.storeEmbeddings('ollama:a', [{ id: 'deploy#intro#0', vector: vec(1, 0) }]);
      expect(index.embedderIds()).toEqual(['ollama:a', 'openai:b']);
    });

    it('stops listing an embedder once its vectors are cleared', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      index.storeEmbeddings('e2', [{ id: 'vault#unlock#0', vector: vec(1, 0) }]);
      index.clearEmbeddings('e1');
      expect(index.embedderIds()).toEqual(['e2']);
    });

    it('clears one embedder and makes every passage pending for it again', () => {
      index.sync(BASE);
      index.storeEmbeddings(
        'e1',
        BASE.map((c, i) => ({ id: c.id, vector: vec(1, i, 0) })),
      );
      expect(index.pendingEmbeddings('e1')).toHaveLength(0);
      index.clearEmbeddings('e1');
      expect(index.embeddedCount('e1')).toBe(0);
      expect(index.pendingEmbeddings('e1').map((c) => c.id)).toEqual(BASE.map((c) => c.id));
    });

    it('finds nothing for a cleared embedder, even when asked with the old vector size', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      expect(index.searchVector('e1', vec(1, 0, 0), 5)).toEqual(['vault#unlock#0']);
      index.clearEmbeddings('e1');
      expect(index.searchVector('e1', vec(1, 0, 0), 5)).toEqual([]);
    });

    it('leaves the other embedders and the passages themselves alone', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      index.storeEmbeddings('e2', [
        { id: 'workspace#split#0', vector: vec(1, 0) },
        { id: 'deploy#intro#0', vector: vec(0, 1) },
      ]);
      index.clearEmbeddings('e1');
      expect(index.embeddedCount('e2')).toBe(2);
      expect(index.pendingEmbeddings('e2').map((c) => c.id)).toEqual(['vault#unlock#0']);
      expect(index.searchVector('e2', vec(1, 0), 5)[0]).toBe('workspace#split#0');
      expect(index.count()).toBe(3);
      expect(index.searchText('master password', 5)[0]).toBe('vault#unlock#0');
    });

    it('does nothing for an embedder it has never seen', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      expect(() => index.clearEmbeddings('nobody')).not.toThrow();
      expect(index.embeddedCount('e1')).toBe(1);
    });

    it('takes vectors of a different size after a clear', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      // Switching to a model with another vector size is the whole point of clearing: the old
      // table is tied to the old size, so it has to go before the new vectors can be stored.
      index.clearEmbeddings('e1');
      index.storeEmbeddings('e1', [
        { id: 'vault#unlock#0', vector: vec(1, 0) },
        { id: 'workspace#split#0', vector: vec(0, 1) },
      ]);
      expect(index.embeddedCount('e1')).toBe(2);
      expect(index.searchVector('e1', vec(0.1, 1), 1)).toEqual(['workspace#split#0']);
      expect(index.searchVector('e1', vec(1, 0, 0), 5)).toEqual([]);
    });

    describe('hostile input is data, never SQL', () => {
      const hostile = hostileSqlValues('chunks');

      it('stores passages with hostile ids and text verbatim and finds each by its own id', () => {
        index.sync([...BASE, ...hostile.map((text) => chunk(text, text, `h-${text}`))]);
        expect(index.getChunks(hostile).map((c) => [c.id, c.text])).toEqual(
          hostile.map((text) => [text, text]),
        );
        expect(index.getChunks([ALWAYS_TRUE]).map((c) => c.id)).toEqual([ALWAYS_TRUE]);
        expect(index.count()).toBe(BASE.length + hostile.length);

        index.sync(BASE);
        expect(index.getChunks(hostile)).toEqual([]);
        expect(index.getChunks(BASE.map((c) => c.id))).toEqual(BASE);
      });

      it('reads FTS operators and quotes in a search as plain words', () => {
        index.sync([...BASE, chunk('walk#river#0', 'Walk > River\n\nWalk near the river.')]);
        // NEAR, NOT, column filters, stars and quotes are FTS5 syntax. Each must be a word here.
        expect(index.searchText('NEAR', 5)).toEqual(['walk#river#0']);
        expect(index.searchText('NEAR(vault deploy)', 5).sort()).toEqual([
          'deploy#intro#0',
          'vault#unlock#0',
          'walk#river#0',
        ]);
        expect(index.searchText('NOT vault', 5)).toEqual(['vault#unlock#0']);
        expect(index.searchText('text:master', 5)).toEqual(['vault#unlock#0']);
        expect(index.searchText('"', 5)).toEqual([]);
        expect(index.searchText('*', 5)).toEqual([]);
        expect(index.searchText('^vault', 5)).toEqual(['vault#unlock#0']);
        // A probe that would match everything in SQL matches nothing as words.
        expect(index.searchText(ALWAYS_TRUE, 5)).toEqual([]);
        expect(index.searchText(dropTable('chunks'), 5)).toEqual([]);
        expect(index.count()).toBe(BASE.length + 1);
      });

      it('keeps vectors under hostile embedder names apart', () => {
        index.sync(BASE);
        for (const text of hostile) {
          index.storeEmbeddings(text, [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
        }
        index.storeEmbeddings('plain', [{ id: 'deploy#intro#0', vector: vec(1, 0, 0) }]);

        expect(index.embedderIds()).toEqual([...hostile, 'plain'].sort());
        for (const text of hostile) {
          expect(index.embeddedCount(text)).toBe(1);
          expect(index.searchVector(text, vec(1, 0, 0), 5)).toEqual(['vault#unlock#0']);
        }

        index.clearEmbeddings(ALWAYS_TRUE);
        expect(index.embeddedCount(ALWAYS_TRUE)).toBe(0);
        expect(index.embeddedCount('plain')).toBe(1);
        expect(index.embedderIds()).toHaveLength(hostile.length);
        expect(index.count()).toBe(BASE.length);
      });

      it('refuses a vector table name that was edited in the file into SQL', () => {
        index.sync(BASE);
        index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
        const file = new DatabaseSync(join(dir, 'help.db'));
        try {
          file
            .prepare('INSERT OR REPLACE INTO vec_tables (embedder, name, dim) VALUES (?, ?, ?)')
            .run('e1', 'vec_x; DROP TABLE chunks; --', 3);
        } finally {
          file.close();
        }

        // sqlite-vec reads the table by that name, so it finds nothing. The JavaScript fallback
        // never looks at vec_tables and still compares the stored blobs.
        expect(index.searchVector('e1', vec(1, 0, 0), 5)).toEqual(vector ? [] : ['vault#unlock#0']);
        index.storeEmbeddings('e1', [{ id: 'deploy#intro#0', vector: vec(1, 0, 0) }]);
        index.sync(BASE.slice(0, 2));
        index.clearEmbeddings('e1');

        expect(index.count()).toBe(2);
        expect(index.searchText('master password', 5)).toEqual(['vault#unlock#0']);
        expect(index.embedderIds()).toEqual([]);
      });
    });

    it('keeps a clear across a reopen', () => {
      index.sync(BASE);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0, 0) }]);
      index.clearEmbeddings('e1');
      index.close();
      index = open();
      expect(index.embedderIds()).toEqual([]);
      expect(index.searchVector('e1', vec(1, 0, 0), 5)).toEqual([]);
      index.storeEmbeddings('e1', [{ id: 'vault#unlock#0', vector: vec(1, 0) }]);
      expect(index.searchVector('e1', vec(1, 0), 5)).toEqual(['vault#unlock#0']);
    });
  });
}
