import { parseMongoShell, parseMongoValue } from '@runova/core';
import { BSON, MongoClient, type MongoClientOptions } from 'mongodb';
import type {
  DbColumn,
  DbIndex,
  DbObjectNode,
  DbObjectRef,
  DbReadRowsInput,
  DbRowsPage,
  DbSetting,
  DbTableDescription,
  DbUser,
} from '../../../shared/databaseTypes';
import { documentsToResult, type MongoClientLike, runMongoCommand } from './mongoRun';
import { describeError, EXACT_COUNT_LIMIT } from './shared';
import {
  type DbDriver,
  type DriverConnectOptions,
  DriverError,
  type DriverQueryOptions,
  type DriverQueryResult,
} from './types';

/** How many documents a collection's fields are read from. */
const SAMPLE = 200;
const LEVEL_BY_ROLE: Record<string, 'read' | 'write' | 'admin'> = {
  read: 'read',
  readWrite: 'write',
  dbAdmin: 'admin',
  dbOwner: 'admin',
  readAnyDatabase: 'read',
  readWriteAnyDatabase: 'write',
};
const SUPER_ROLES = new Set(['root', '__system', 'dbAdminAnyDatabase', 'userAdminAnyDatabase']);

function bsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') {
    const tag = (value as { _bsontype?: string })._bsontype;
    return tag ? tag.toLowerCase() : 'object';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  return typeof value;
}

export async function openMongo(options: DriverConnectOptions): Promise<DbDriver> {
  const host = options.srv ? options.host : `${options.host}:${options.port ?? 27017}`;
  const url = `${options.srv ? 'mongodb+srv' : 'mongodb'}://${host}/`;
  const clientOptions: MongoClientOptions = {
    serverSelectionTimeoutMS: options.connectTimeoutMs ?? 15_000,
    connectTimeoutMS: options.connectTimeoutMs ?? 15_000,
    appName: 'Runova',
    // Through a forward the driver must not go looking for the replica set's own addresses.
    ...(options.srv ? {} : { directConnection: true }),
    ...(options.tls ? { tls: true, tlsAllowInvalidCertificates: true } : {}),
    ...(options.user
      ? {
          auth: { username: options.user, password: options.password ?? '' },
          authSource: options.authDatabase ?? 'admin',
        }
      : {}),
  };
  const client = new MongoClient(url, clientOptions);
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } catch (error) {
    await client.close().catch(() => undefined);
    const code = (error as { code?: number }).code;
    throw new DriverError(describeError(error), code === 18 || /auth/i.test(describeError(error)));
  }
  let current = options.database || 'test';

  const describe = async (ref: DbObjectRef): Promise<DbTableDescription> => {
    const db = client.db(ref.database ?? current);
    const collection = db.collection(ref.name);
    const docs = await collection.aggregate([{ $sample: { size: SAMPLE } }]).toArray();
    const fields = new Map<string, { types: Set<string>; seen: number }>();
    for (const doc of docs) {
      for (const [key, value] of Object.entries(doc)) {
        const field = fields.get(key) ?? { types: new Set<string>(), seen: 0 };
        field.types.add(bsonTypeName(value));
        field.seen++;
        fields.set(key, field);
      }
    }
    const columns: DbColumn[] = [...fields.entries()]
      .sort(([a], [b]) => (a === '_id' ? -1 : b === '_id' ? 1 : 0))
      .map(([name, field]) => ({
        name,
        type: [...field.types].filter((type) => type !== 'null').join(' | ') || 'null',
        nullable: field.seen < docs.length || field.types.has('null'),
        defaultValue: null,
        primaryKey: name === '_id',
        generated: false,
      }));
    const indexes = (await collection.indexes().catch(() => [])).map(
      (index): DbIndex => ({
        name: String(index.name),
        columns: Object.keys(index.key ?? {}),
        unique: index.unique === true || index.name === '_id_',
        primary: index.name === '_id_',
      }),
    );
    const info = await db.listCollections({ name: ref.name }).toArray();
    const options = (info[0] as { options?: { validator?: unknown } } | undefined)?.options;
    return {
      ref: { database: ref.database ?? current, name: ref.name },
      kind: (info[0] as { type?: string } | undefined)?.type === 'view' ? 'view' : 'collection',
      columns,
      indexes,
      rowEstimate: await collection.estimatedDocumentCount().catch(() => null),
      definition: options?.validator ? JSON.stringify(options.validator, null, 2) : null,
    };
  };

  return {
    engine: 'mongodb',

    async serverVersion() {
      const info = await client.db('admin').command({ buildInfo: 1 });
      return String(info.version ?? '');
    },

    async listObjects(parent) {
      if (!parent) {
        try {
          const result = await client.db('admin').command({ listDatabases: 1 });
          return ((result.databases as { name: string; sizeOnDisk?: number }[]) ?? []).map(
            (database): DbObjectNode => ({
              kind: 'database',
              name: database.name,
              ref: { database: database.name, name: database.name },
              hasChildren: true,
              rowEstimate: null,
            }),
          );
        } catch {
          // A user with access to one database may not list the others.
          return [
            {
              kind: 'database',
              name: current,
              ref: { database: current, name: current },
              hasChildren: true,
              rowEstimate: null,
            },
          ];
        }
      }
      const database = parent.database ?? parent.name;
      const db = client.db(database);
      const collections = await db.listCollections({}, { nameOnly: false }).toArray();
      const nodes: DbObjectNode[] = [];
      for (const collection of collections
        .slice(0, 500)
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const isView = (collection as { type?: string }).type === 'view';
        nodes.push({
          kind: isView ? 'view' : 'collection',
          name: collection.name,
          ref: { database, name: collection.name },
          hasChildren: false,
          rowEstimate: isView
            ? null
            : await db
                .collection(collection.name)
                .estimatedDocumentCount()
                .catch(() => null),
        });
      }
      return nodes;
    },

    describe,

    async readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage> {
      const db = client.db(input.ref.database ?? current);
      const collection = db.collection(input.ref.name);
      const filterValue = input.filter?.trim() ? parseMongoValue(input.filter) : {};
      if (filterValue === null || typeof filterValue !== 'object' || Array.isArray(filterValue)) {
        throw new Error('The filter must be a document, like { status: "paid" }.');
      }
      const filter = BSON.EJSON.deserialize(filterValue as BSON.Document, { relaxed: true });
      const started = Date.now();
      let cursor = collection.find(filter).skip(input.offset).limit(input.limit);
      if (input.orderBy)
        cursor = cursor.sort({
          [input.orderBy.column]: input.orderBy.direction === 'desc' ? -1 : 1,
        });
      const docs = await cursor.toArray();
      const total = input.filter?.trim()
        ? await collection
            .countDocuments(filter, { limit: EXACT_COUNT_LIMIT + 1 })
            .then((count) => (count > EXACT_COUNT_LIMIT ? null : count))
        : await collection.estimatedDocumentCount();
      return {
        result: documentsToResult(
          docs,
          `db.${input.ref.name}.find(${input.filter?.trim() || '{}'})`,
          started,
          input.limit,
        ),
        total,
        keyColumns: ['_id'],
      };
    },

    async query(text: string, run: DriverQueryOptions): Promise<DriverQueryResult> {
      if (run.database) current = run.database;
      try {
        const command = parseMongoShell(text);
        const { result, database } = await runMongoCommand(
          client as unknown as MongoClientLike,
          command,
          text.trim(),
          {
            database: current,
            maxRows: run.maxRows,
            readOnly: run.readOnly,
            signal: run.signal,
          },
        );
        if (database) current = database;
        return run.signal.aborted ? { results: [result], cancelled: true } : { results: [result] };
      } catch (error) {
        if (run.signal.aborted) return { results: [], cancelled: true };
        return { results: [], error: { message: describeError(error), statementIndex: 0 } };
      }
    },

    async settings(): Promise<DbSetting[]> {
      const result = await client.db('admin').command({ getParameter: '*' });
      return Object.entries(result)
        .filter(([name]) => name !== 'ok' && !name.startsWith('$'))
        .map(([name, value]) => ({
          name,
          value:
            typeof value === 'object'
              ? JSON.stringify(BSON.EJSON.serialize(value as BSON.Document))
              : String(value),
          unit: null,
          description: null,
          category: null,
          restartRequired: false,
          editable: typeof value !== 'object',
          options: typeof value === 'boolean' ? ['true', 'false'] : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async users(): Promise<DbUser[]> {
      const result = await client.db('admin').command({ usersInfo: { forAllDBs: true } });
      return (
        (result.users as { user: string; db: string; roles: { role: string; db: string }[] }[]) ??
        []
      ).map((user) => {
        const access = user.roles
          .filter((role) => LEVEL_BY_ROLE[role.role])
          .map((role) => ({
            database: role.role.endsWith('AnyDatabase') ? '*' : role.db,
            level: LEVEL_BY_ROLE[role.role] as 'read' | 'write' | 'admin',
          }));
        return {
          name: user.user,
          host: null,
          superuser: user.roles.some((role) => SUPER_ROLES.has(role.role)),
          canLogin: true,
          access,
          detail: `defined in ${user.db}`,
        };
      });
    },

    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
