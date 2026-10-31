import type { MongoCall, MongoCommand } from '@runova/core';
import { BSON } from 'mongodb';
import type { DbCell, DbResultSet } from '../../../shared/databaseTypes';
import { toCell } from '../cells';

/**
 * Runs a parsed mongosh command with the Node driver. Only the methods listed here can run, each
 * mapped to the driver call it means; the arguments are plain values with Extended JSON turned
 * into BSON. Results come back as grid rows: documents as columns, anything else as one value.
 */

/** The part of the driver this needs, so tests can stand in for it. */
export interface MongoCursorLike {
  sort(spec: unknown): MongoCursorLike;
  limit(count: number): MongoCursorLike;
  skip(count: number): MongoCursorLike;
  project(spec: unknown): MongoCursorLike;
  hint(spec: unknown): MongoCursorLike;
  toArray(): Promise<unknown[]>;
  close(): Promise<void>;
}

export interface MongoCollectionLike {
  find(filter?: unknown, options?: unknown): MongoCursorLike;
  aggregate(pipeline: unknown[], options?: unknown): MongoCursorLike;
  [method: string]: unknown;
}

export interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
  command(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  listCollections(
    filter?: unknown,
    options?: unknown,
  ): { toArray(): Promise<Record<string, unknown>[]> };
  createCollection(name: string, options?: unknown): Promise<unknown>;
  dropDatabase(): Promise<unknown>;
}

export interface MongoClientLike {
  db(name?: string): MongoDbLike;
}

export interface MongoRunOptions {
  database: string;
  maxRows: number;
  readOnly: boolean;
  signal: AbortSignal;
}

const READ_COLLECTION = new Set([
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'count',
  'distinct',
  'getIndexes',
  'stats',
]);
const READ_DATABASE = new Set([
  'getCollectionNames',
  'getCollectionInfos',
  'stats',
  'version',
  'serverStatus',
  'getUsers',
  'getName',
  'hello',
  'isMaster',
]);
const CURSOR_STEPS = new Set([
  'sort',
  'limit',
  'skip',
  'project',
  'projection',
  'hint',
  'toArray',
  'pretty',
]);

function bson(value: unknown): unknown {
  return value === undefined
    ? undefined
    : BSON.EJSON.deserialize(value as BSON.Document, { relaxed: true });
}

function plain(value: unknown): DbCell {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return toCell(value);
  return toCell(BSON.EJSON.serialize(value as BSON.Document, { relaxed: true }));
}

/** Documents as a grid: _id first, then every key in the order it was first seen. */
export function documentsToResult(
  docs: unknown[],
  statement: string,
  started: number,
  maxRows: number,
): DbResultSet {
  const shown = docs.slice(0, maxRows);
  const keys: string[] = [];
  const seen = new Set<string>();
  const allObjects = shown.every(
    (doc) => doc !== null && typeof doc === 'object' && !Array.isArray(doc),
  );
  if (!allObjects) {
    return {
      columns: [{ name: 'value', type: null }],
      rows: shown.map((doc) => [plain(doc)]),
      affectedRows: null,
      truncated: docs.length > maxRows,
      durationMs: Date.now() - started,
      statement,
      notice: null,
    };
  }
  for (const doc of shown as Record<string, unknown>[]) {
    for (const key of Object.keys(doc)) {
      if (!seen.has(key)) {
        seen.add(key);
        if (key === '_id') keys.unshift(key);
        else keys.push(key);
      }
    }
  }
  return {
    columns: keys.map((name) => ({ name, type: null })),
    rows: (shown as Record<string, unknown>[]).map((doc) =>
      keys.map((key) => (key in doc ? plain(doc[key]) : null)),
    ),
    affectedRows: null,
    truncated: docs.length > maxRows,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

function valueResult(
  value: unknown,
  statement: string,
  started: number,
  affected: number | null = null,
): DbResultSet {
  if (Array.isArray(value))
    return documentsToResult(value, statement, started, Number.MAX_SAFE_INTEGER);
  return {
    columns: affected === null ? [{ name: 'result', type: null }] : [],
    rows: affected === null ? [[plain(value)]] : [],
    affectedRows: affected,
    truncated: false,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

function writeCount(result: Record<string, unknown>): number | null {
  for (const key of ['modifiedCount', 'deletedCount', 'insertedCount', 'upsertedCount']) {
    if (typeof result[key] === 'number') return result[key] as number;
  }
  if (result.insertedId !== undefined) return 1;
  return null;
}

async function drain(
  cursor: MongoCursorLike,
  steps: MongoCall[],
  maxRows: number,
  signal: AbortSignal,
) {
  let current = cursor;
  let limit: number | null = null;
  for (const step of steps) {
    const [arg] = step.args;
    switch (step.method) {
      case 'sort':
        current = current.sort(bson(arg));
        break;
      case 'limit':
        limit = Number(arg);
        break;
      case 'skip':
        current = current.skip(Number(arg));
        break;
      case 'project':
      case 'projection':
        current = current.project(bson(arg));
        break;
      case 'hint':
        current = current.hint(bson(arg));
        break;
      default:
        break;
    }
  }
  // One more than shown, so the grid can say there is more.
  current = current.limit(Math.min(limit ?? maxRows + 1, maxRows + 1));
  const onAbort = () => void current.close();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await current.toArray();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function runCollection(
  db: MongoDbLike,
  name: string,
  calls: MongoCall[],
  statement: string,
  options: MongoRunOptions,
): Promise<DbResultSet> {
  const started = Date.now();
  const [first, ...rest] = calls as [MongoCall, ...MongoCall[]];
  const method = first.method;
  if (options.readOnly && !READ_COLLECTION.has(method)) {
    throw new Error(`${method} changes the database, and this run is read-only.`);
  }
  const collection = db.collection(name);
  const args = first.args.map(bson);
  const unknownStep = rest.find(
    (step) => !CURSOR_STEPS.has(step.method) && step.method !== 'count',
  );
  if (unknownStep) throw new Error(`.${unknownStep.method}() is not supported after ${method}().`);
  const call = (fn: string, ...callArgs: unknown[]) => {
    const target = collection[fn];
    if (typeof target !== 'function') throw new Error(`${fn}() is not something Runova can run.`);
    return (target as (...a: unknown[]) => Promise<unknown>).apply(collection, callArgs);
  };

  switch (method) {
    case 'find': {
      if (rest.some((step) => step.method === 'count')) {
        return valueResult(await call('countDocuments', args[0] ?? {}), statement, started);
      }
      const docs = await drain(
        collection.find(args[0] ?? {}, args[1] ? { projection: args[1] } : undefined),
        rest,
        options.maxRows,
        options.signal,
      );
      return documentsToResult(docs, statement, started, options.maxRows);
    }
    case 'aggregate': {
      const docs = await drain(
        collection.aggregate((args[0] as unknown[]) ?? [], args[1]),
        rest,
        options.maxRows,
        options.signal,
      );
      return documentsToResult(docs, statement, started, options.maxRows);
    }
    case 'findOne': {
      const doc = await call(
        'findOne',
        args[0] ?? {},
        args[1] ? { projection: args[1] } : undefined,
      );
      return documentsToResult(doc ? [doc] : [], statement, started, options.maxRows);
    }
    case 'count':
      return valueResult(await call('countDocuments', args[0] ?? {}), statement, started);
    case 'getIndexes':
      return valueResult(await call('indexes'), statement, started);
    case 'stats':
      return valueResult(await db.command({ collStats: name }), statement, started);
    case 'countDocuments':
    case 'estimatedDocumentCount':
    case 'distinct':
      return valueResult(await call(method, ...args), statement, started);
    case 'insertOne':
    case 'insertMany':
    case 'updateOne':
    case 'updateMany':
    case 'replaceOne':
    case 'deleteOne':
    case 'deleteMany':
    case 'bulkWrite': {
      const result = (await call(method, ...args)) as Record<string, unknown>;
      return valueResult(result, statement, started, writeCount(result) ?? 0);
    }
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
    case 'findOneAndDelete': {
      const doc = await call(method, ...args);
      return documentsToResult(doc ? [doc] : [], statement, started, options.maxRows);
    }
    case 'createIndex':
    case 'createIndexes':
    case 'dropIndex':
    case 'dropIndexes':
    case 'drop':
    case 'rename':
      return valueResult(await call(method, ...args), statement, started);
    case 'renameCollection':
      return valueResult(await call('rename', ...args), statement, started);
    default:
      throw new Error(
        `${method}() is not something Runova can run. Try find, aggregate, insertOne, updateMany and the like.`,
      );
  }
}

async function runDatabase(
  client: MongoClientLike,
  database: string,
  calls: MongoCall[],
  statement: string,
  options: MongoRunOptions,
): Promise<DbResultSet> {
  const started = Date.now();
  if (calls.length !== 1) throw new Error('Database commands cannot be chained.');
  const { method, args: raw } = calls[0] as MongoCall;
  if (options.readOnly && !READ_DATABASE.has(method)) {
    throw new Error(`${method} changes the database, and this run is read-only.`);
  }
  const args = raw.map(bson);
  const db = client.db(database);
  const admin = client.db('admin');
  const command = (target: MongoDbLike, body: Record<string, unknown>) =>
    target.command(body).then((result) => valueResult(result, statement, started));
  switch (method) {
    case 'getCollectionNames': {
      const list = await db.listCollections({}, { nameOnly: true }).toArray();
      return valueResult(list.map((one) => one.name).sort(), statement, started);
    }
    case 'getCollectionInfos':
      return valueResult(await db.listCollections(args[0] ?? {}).toArray(), statement, started);
    case 'stats':
      return command(db, { dbStats: 1 });
    case 'version': {
      const info = await admin.command({ buildInfo: 1 });
      return valueResult(info.version, statement, started);
    }
    case 'serverStatus':
      return command(admin, { serverStatus: 1 });
    case 'hello':
    case 'isMaster':
      return command(admin, { hello: 1 });
    case 'getName':
      return valueResult(database, statement, started);
    case 'getUsers':
      return command(db, { usersInfo: 1 });
    case 'runCommand':
      return command(db, args[0] as Record<string, unknown>);
    case 'adminCommand':
      return command(admin, args[0] as Record<string, unknown>);
    case 'createCollection':
      await db.createCollection(String(args[0]), args[1]);
      return valueResult({ ok: 1 }, statement, started);
    case 'dropDatabase':
      return valueResult(await db.dropDatabase(), statement, started);
    case 'createUser': {
      const { user, ...rest } = (args[0] ?? {}) as Record<string, unknown>;
      return command(db, { createUser: user, ...rest });
    }
    case 'updateUser':
      return command(db, { updateUser: args[0], ...((args[1] as Record<string, unknown>) ?? {}) });
    case 'dropUser':
      return command(db, { dropUser: args[0] });
    case 'changeUserPassword':
      return command(db, { updateUser: args[0], pwd: args[1] });
    case 'grantRolesToUser':
      return command(db, { grantRolesToUser: args[0], roles: args[1] });
    case 'revokeRolesFromUser':
      return command(db, { revokeRolesFromUser: args[0], roles: args[1] });
    default:
      throw new Error(`db.${method}() is not something Runova can run.`);
  }
}

/** Runs one parsed command. `use` moves the session's database, which the caller keeps. */
export async function runMongoCommand(
  client: MongoClientLike,
  command: MongoCommand,
  statement: string,
  options: MongoRunOptions,
): Promise<{ result: DbResultSet; database?: string }> {
  const started = Date.now();
  switch (command.kind) {
    case 'use':
      return {
        result: valueResult(`Now using ${command.database}`, statement, started),
        database: command.database,
      };
    case 'show': {
      if (command.what === 'databases') {
        const result = await client.db('admin').command({ listDatabases: 1, nameOnly: true });
        const names = ((result.databases as { name: string }[]) ?? []).map((one) => one.name);
        return { result: valueResult(names, statement, started) };
      }
      if (command.what === 'collections') {
        const list = await client
          .db(options.database)
          .listCollections({}, { nameOnly: true })
          .toArray();
        return { result: valueResult(list.map((one) => one.name).sort(), statement, started) };
      }
      const key = command.what === 'users' ? 'usersInfo' : 'rolesInfo';
      return {
        result: valueResult(
          await client.db(options.database).command({ [key]: 1 }),
          statement,
          started,
        ),
      };
    }
    case 'database':
      return {
        result: await runDatabase(
          client,
          command.database ?? options.database,
          command.calls,
          statement,
          options,
        ),
      };
    case 'collection':
      return {
        result: await runCollection(
          client.db(command.database ?? options.database),
          command.collection,
          command.calls,
          statement,
          options,
        ),
      };
  }
}
