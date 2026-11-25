import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { searchTerms } from '../../shared/help/search';
import type { HelpChunk } from './chunker';

/**
 * The help chat's retrieval index: the Help articles' passages in SQLite, searchable two ways.
 *
 * - Keywords, through an FTS5 table (BM25 ranking, porter stemming, prefix matches).
 * - Meaning, through vectors. Every vector is kept as a blob in `embeddings`, and with the
 *   sqlite-vec extension loaded each embedder also gets a vec0 table for nearest-neighbour search.
 *   When the extension cannot load, the same blobs are compared in JavaScript instead, which for a
 *   few hundred passages is still instant.
 *
 * Vectors are tied to the passage's text hash, so editing an article re-embeds only what changed,
 * and to the embedder, so switching providers never mixes two vector spaces.
 */

export type VectorBackend = 'sqlite-vec' | 'js';

export interface HelpIndexOptions {
  /** Loads sqlite-vec into the connection and says whether it worked. Tests pass a stub. */
  loadVectorExtension?: (db: Database.Database) => boolean;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
}

interface ChunkRow {
  rowid: number;
  id: string;
  slug: string;
  article_title: string;
  heading: string;
  anchor: string;
  text: string;
  hash: string;
}

/** Loads sqlite-vec, reading it from outside the asar archive in a packaged build. */
export function loadSqliteVec(db: Database.Database): boolean {
  try {
    db.loadExtension(getLoadablePath().replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'));
    return true;
  } catch {
    return false;
  }
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  // Copied so the floats are aligned whatever offset the driver handed the bytes at.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function rowToChunk(row: ChunkRow): HelpChunk {
  return {
    id: row.id,
    slug: row.slug,
    articleTitle: row.article_title,
    heading: row.heading,
    anchor: row.anchor,
    text: row.text,
    hash: row.hash,
  };
}

const VEC_TABLE_NAME = /^vec_[0-9a-f]{12}$/;

/**
 * A vec0 table's name goes into SQL text (identifiers cannot be parameters), and it is read back
 * from the file, which anything on the machine can edit. Only the shape `vecTable` makes is let
 * through. Anything else is treated as no table at all.
 */
function checkedVecName(name: unknown): string | null {
  return typeof name === 'string' && VEC_TABLE_NAME.test(name) ? name : null;
}

/** One quoted prefix term per meaningful word, OR-ed together, so no user text can break FTS5's syntax. */
function ftsQuery(query: string): string {
  return searchTerms(query)
    .map((t) => `"${t.replace(/"/g, '')}"*`)
    .join(' OR ');
}

export class HelpIndex {
  readonly vectorBackend: VectorBackend;
  private readonly db: Database.Database;

  constructor(file: string, options: HelpIndexOptions = {}) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.vectorBackend = (options.loadVectorExtension ?? loadSqliteVec)(this.db)
      ? 'sqlite-vec'
      : 'js';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        article_title TEXT NOT NULL,
        heading TEXT NOT NULL,
        anchor TEXT NOT NULL,
        text TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        article_title, heading, text,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_rowid INTEGER NOT NULL,
        embedder TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (chunk_rowid, embedder)
      );
      CREATE TABLE IF NOT EXISTS vec_tables (
        embedder TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dim INTEGER NOT NULL
      );
    `);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  }

  /** Makes the stored passages match `chunks` exactly. */
  sync(chunks: HelpChunk[]): SyncResult {
    const result: SyncResult = { added: 0, updated: 0, removed: 0 };
    const existing = new Map(
      (this.db.prepare('SELECT rowid, id, hash FROM chunks').all() as ChunkRow[]).map((r) => [
        r.id,
        r,
      ]),
    );
    const insert = this.db.prepare(
      `INSERT INTO chunks (id, slug, article_title, heading, anchor, text, hash)
       VALUES (@id, @slug, @articleTitle, @heading, @anchor, @text, @hash)`,
    );
    const update = this.db.prepare(
      `UPDATE chunks SET slug = @slug, article_title = @articleTitle, heading = @heading,
       anchor = @anchor, text = @text, hash = @hash WHERE rowid = @rowid`,
    );
    const insertFts = this.db.prepare(
      'INSERT INTO chunks_fts (rowid, article_title, heading, text) VALUES (?, ?, ?, ?)',
    );

    this.db.transaction(() => {
      const keep = new Set<string>();
      for (const chunk of chunks) {
        keep.add(chunk.id);
        const row = existing.get(chunk.id);
        if (!row) {
          const rowid = Number(insert.run(chunk).lastInsertRowid);
          insertFts.run(rowid, chunk.articleTitle, chunk.heading, chunk.text);
          result.added++;
        } else if (row.hash !== chunk.hash) {
          update.run({ ...chunk, rowid: row.rowid });
          this.forgetRow(row.rowid, { keepChunk: true });
          insertFts.run(row.rowid, chunk.articleTitle, chunk.heading, chunk.text);
          result.updated++;
        }
      }
      for (const [id, row] of existing) {
        if (keep.has(id)) continue;
        this.forgetRow(row.rowid, { keepChunk: false });
        result.removed++;
      }
    })();
    return result;
  }

  /** Drops a passage's keyword entry and vectors, and the passage itself unless it is being rewritten. */
  private forgetRow(rowid: number, { keepChunk }: { keepChunk: boolean }): void {
    this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?').run(rowid);
    this.db.prepare('DELETE FROM embeddings WHERE chunk_rowid = ?').run(rowid);
    if (this.vectorBackend === 'sqlite-vec') {
      for (const { name } of this.vecTables()) {
        this.db.prepare(`DELETE FROM ${name} WHERE rowid = ?`).run(BigInt(rowid));
      }
    }
    if (!keepChunk) this.db.prepare('DELETE FROM chunks WHERE rowid = ?').run(rowid);
  }

  private vecTables(): Array<{ embedder: string; name: string; dim: number }> {
    const rows = this.db.prepare('SELECT embedder, name, dim FROM vec_tables').all() as Array<{
      embedder: string;
      name: unknown;
      dim: number;
    }>;
    return rows.flatMap((row) => {
      const name = checkedVecName(row.name);
      return name ? [{ ...row, name }] : [];
    });
  }

  /** The vec0 table for an embedder, created on first use. Its name is derived, never user text. */
  private vecTable(embedder: string, dim: number): string | null {
    const row = this.db
      .prepare('SELECT name, dim FROM vec_tables WHERE embedder = ?')
      .get(embedder) as { name: unknown; dim: number } | undefined;
    if (row) return row.dim === dim ? checkedVecName(row.name) : null;
    // The size goes into the table's definition, so it has to be a plain positive integer.
    if (!Number.isSafeInteger(dim) || dim <= 0) return null;
    const name = `vec_${createHash('sha1').update(embedder).digest('hex').slice(0, 12)}`;
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    );
    this.db
      .prepare('INSERT INTO vec_tables (embedder, name, dim) VALUES (?, ?, ?)')
      .run(embedder, name, dim);
    return name;
  }

  /** Passages with no vector from `embedder` for their current text. */
  pendingEmbeddings(embedder: string): HelpChunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM chunks c
         LEFT JOIN embeddings e ON e.chunk_rowid = c.rowid AND e.embedder = ?
         WHERE e.chunk_rowid IS NULL ORDER BY c.rowid`,
      )
      .all(embedder) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /** Every embedder that has vectors stored, so models no longer in use can be dropped. */
  embedderIds(): string[] {
    const rows = this.db
      .prepare(
        'SELECT embedder FROM embeddings UNION SELECT embedder FROM vec_tables ORDER BY embedder',
      )
      .all() as Array<{ embedder: string }>;
    return rows.map((r) => r.embedder);
  }

  /** Forgets every vector from `embedder`, so the next run embeds all passages again. */
  clearEmbeddings(embedder: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM embeddings WHERE embedder = ?').run(embedder);
      const row = this.db.prepare('SELECT name FROM vec_tables WHERE embedder = ?').get(embedder) as
        | { name: unknown }
        | undefined;
      if (row) {
        const name = checkedVecName(row.name);
        if (name && this.vectorBackend === 'sqlite-vec') {
          this.db.exec(`DROP TABLE IF EXISTS ${name}`);
        }
        this.db.prepare('DELETE FROM vec_tables WHERE embedder = ?').run(embedder);
      }
    })();
  }

  embeddedCount(embedder: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE embedder = ?').get(embedder) as {
        n: number;
      }
    ).n;
  }

  storeEmbeddings(embedder: string, items: Array<{ id: string; vector: Float32Array }>): void {
    if (items.length === 0) return;
    const rowidOf = this.db.prepare('SELECT rowid FROM chunks WHERE id = ?');
    const save = this.db.prepare(
      `INSERT OR REPLACE INTO embeddings (chunk_rowid, embedder, dim, vector) VALUES (?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const { id, vector } of items) {
        const row = rowidOf.get(id) as { rowid: number } | undefined;
        if (!row) continue;
        save.run(row.rowid, embedder, vector.length, toBlob(vector));
        if (this.vectorBackend !== 'sqlite-vec') continue;
        const table = this.vecTable(embedder, vector.length);
        if (!table) continue;
        // vec0 has no upsert, so a replaced vector is deleted first.
        this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(row.rowid));
        this.db
          .prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(row.rowid), toBlob(vector));
      }
    })();
  }

  /** Passage ids for a keyword query, best BM25 match first. Title hits weigh most. */
  searchText(query: string, limit: number): string[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
         WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 4.0, 2.5, 1.0) LIMIT ?`,
      )
      .all(match, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Passage ids nearest to `vector` in `embedder`'s space, closest first. */
  searchVector(embedder: string, vector: Float32Array, limit: number): string[] {
    if (this.vectorBackend === 'sqlite-vec') {
      const row = this.db
        .prepare('SELECT name, dim FROM vec_tables WHERE embedder = ?')
        .get(embedder) as { name: unknown; dim: number } | undefined;
      const name = row ? checkedVecName(row.name) : null;
      if (!row || !name || row.dim !== vector.length) return [];
      const rows = this.db
        .prepare(
          `SELECT c.id FROM ${name} v JOIN chunks c ON c.rowid = v.rowid
           WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`,
        )
        .all(toBlob(vector), limit) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    const rows = this.db
      .prepare(
        `SELECT c.id, e.vector FROM embeddings e JOIN chunks c ON c.rowid = e.chunk_rowid
         WHERE e.embedder = ? AND e.dim = ?`,
      )
      .all(embedder, vector.length) as Array<{ id: string; vector: Uint8Array }>;
    return rows
      .map((r) => {
        const other = fromBlob(r.vector);
        let dot = 0;
        for (let i = 0; i < vector.length; i++) dot += vector[i]! * other[i]!;
        return { id: r.id, dot };
      })
      .sort((a, b) => b.dot - a.dot)
      .slice(0, limit)
      .map((r) => r.id);
  }

  getChunks(ids: string[]): HelpChunk[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as ChunkRow[];
    const byId = new Map(rows.map((r) => [r.id, rowToChunk(r)]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  close(): void {
    this.db.close();
  }
}
