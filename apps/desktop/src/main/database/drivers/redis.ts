import { classifyStatement, parseRedisAcl, parseRedisLine, splitStatements } from '@runova/core';
import { Redis, type RedisOptions } from 'ioredis';
import type {
  DbCell,
  DbColumn,
  DbObjectNode,
  DbObjectRef,
  DbReadRowsInput,
  DbResultSet,
  DbRowsPage,
  DbSetting,
  DbTableDescription,
  DbUser,
} from '../../../shared/databaseTypes';
import { toCell } from '../cells';
import { describeError } from './shared';
import {
  type DbDriver,
  type DriverConnectOptions,
  DriverError,
  type DriverQueryOptions,
  type DriverQueryResult,
} from './types';

/**
 * Redis as the Database section shows it: each database (db0, db1...) holds its keys, and a key
 * opens as rows that fit its type: one value, hash fields, list items, set members, scored
 * members or stream entries.
 */

/** The most keys one database lists in the tree; a search narrows past that. */
const KEY_LIMIT = 500;

const COLUMNS_BY_TYPE: Record<string, string[]> = {
  string: ['value'],
  hash: ['field', 'value'],
  list: ['index', 'value'],
  set: ['member'],
  zset: ['member', 'score'],
  stream: ['id', 'fields'],
};

function rows(
  columns: string[],
  data: DbCell[][],
  statement: string,
  started: number,
  truncated = false,
): DbResultSet {
  return {
    columns: columns.map((name) => ({ name, type: null })),
    rows: data,
    affectedRows: null,
    truncated,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

/** A flat [a, 1, b, 2] reply, or the nested [[a, 1], [b, 2]] one newer servers send, as pairs. */
function pairs(reply: unknown[]): [string, string][] {
  if (reply.length > 0 && Array.isArray(reply[0])) {
    return (reply as unknown[][]).map((pair) => [String(pair[0]), String(pair[1])]);
  }
  const flat = reply as string[];
  const out: [string, string][] = [];
  for (let index = 0; index + 1 < flat.length; index += 2)
    out.push([flat[index] as string, flat[index + 1] as string]);
  return out;
}

/** A reply as grid rows: a list becomes one row per item, anything else one value. */
function replyToResult(
  reply: unknown,
  statement: string,
  started: number,
  maxRows: number,
): DbResultSet {
  if (Array.isArray(reply)) {
    const shown = reply.slice(0, maxRows);
    return rows(
      ['#', 'value'],
      shown.map((item, index) => [index + 1, toCell(item)]),
      statement,
      started,
      reply.length > maxRows,
    );
  }
  return rows(['value'], [[toCell(reply)]], statement, started);
}

export async function openRedis(options: DriverConnectOptions): Promise<DbDriver> {
  const base: RedisOptions = {
    host: options.host,
    port: options.port ?? 6379,
    ...(options.user ? { username: options.user } : {}),
    ...(options.password ? { password: options.password } : {}),
    ...(options.tls ? { tls: { rejectUnauthorized: false } } : {}),
    connectTimeout: options.connectTimeoutMs ?? 15_000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  };
  const clients = new Map<number, Redis>();
  const open = async (db: number): Promise<Redis> => {
    const existing = clients.get(db);
    if (existing) return existing;
    const client = new Redis({ ...base, db });
    // The reason a connection closes (WRONGPASS, say) only arrives as an error event.
    let reason: unknown = null;
    client.on('error', (error) => {
      reason = error;
    });
    try {
      await client.connect();
    } catch (error) {
      client.disconnect();
      const message = describeError(reason ?? error);
      throw new DriverError(message, /WRONGPASS|NOAUTH|invalid password|AUTH/i.test(message));
    }
    clients.set(db, client);
    return client;
  };
  let current = Number(options.database) || 0;
  const main = await open(current);
  const dbOf = (ref: DbObjectRef | null | undefined) => {
    const value = Number(ref?.database ?? current);
    return Number.isInteger(value) && value >= 0 ? value : current;
  };

  const describe = async (ref: DbObjectRef): Promise<DbTableDescription> => {
    const client = await open(dbOf(ref));
    const type = await client.type(ref.name);
    if (type === 'none') throw new DriverError(`There is no key ${ref.name}.`);
    const lengths: Record<string, () => Promise<number>> = {
      string: async () => 1,
      hash: () => client.hlen(ref.name),
      list: () => client.llen(ref.name),
      set: () => client.scard(ref.name),
      zset: () => client.zcard(ref.name),
      stream: () => client.xlen(ref.name),
    };
    const ttl = await client.ttl(ref.name);
    return {
      ref: { database: String(dbOf(ref)), name: ref.name },
      kind: 'key',
      columns: (COLUMNS_BY_TYPE[type] ?? ['value']).map(
        (name): DbColumn => ({
          name,
          type,
          nullable: false,
          defaultValue: null,
          primaryKey: false,
          generated: false,
        }),
      ),
      indexes: [],
      rowEstimate: await (lengths[type] ?? (async () => 1))(),
      definition: ttl > 0 ? `${type}, expires in ${ttl} seconds` : `${type}, no expiry`,
    };
  };

  return {
    engine: 'redis',

    async serverVersion() {
      const info = await main.info('server');
      return /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? '';
    },

    async listObjects(parent, _kind, search) {
      if (!parent) {
        const info = await main.info('keyspace');
        const counts = new Map<number, number>();
        for (const match of info.matchAll(/^db(\d+):keys=(\d+)/gm))
          counts.set(Number(match[1]), Number(match[2]));
        if (!counts.has(current)) counts.set(current, 0);
        return [...counts.entries()]
          .sort(([a], [b]) => a - b)
          .map(
            ([db, keys]): DbObjectNode => ({
              kind: 'database',
              name: `db${db}`,
              ref: { database: String(db), name: `db${db}` },
              hasChildren: true,
              rowEstimate: keys,
            }),
          );
      }
      const client = await open(dbOf(parent));
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await client.scan(
          cursor,
          'MATCH',
          search?.trim() || '*',
          'COUNT',
          500,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0' && keys.length < KEY_LIMIT);
      const shown = keys.slice(0, KEY_LIMIT).sort();
      const pipeline = client.pipeline();
      for (const key of shown) pipeline.type(key);
      const types = ((await pipeline.exec()) ?? []).map(([, value]) => String(value ?? ''));
      return shown.map(
        (key, index): DbObjectNode => ({
          kind: 'key',
          name: key,
          ref: { database: String(dbOf(parent)), name: key },
          hasChildren: false,
          rowEstimate: null,
          detail: types[index] ?? undefined,
        }),
      );
    },

    describe,

    async readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage> {
      const client = await open(dbOf(input.ref));
      const key = input.ref.name;
      const started = Date.now();
      const type = await client.type(key);
      const { offset, limit } = input;
      let data: DbCell[][] = [];
      let total: number | null = null;
      switch (type) {
        case 'string':
          data = [[toCell(await client.get(key))]];
          total = 1;
          break;
        case 'hash': {
          const all = pairs(await client.hgetall(key).then((map) => Object.entries(map).flat()));
          total = all.length;
          data = all.slice(offset, offset + limit).map(([field, value]) => [field, value]);
          break;
        }
        case 'list':
          total = await client.llen(key);
          data = (await client.lrange(key, offset, offset + limit - 1)).map((value, index) => [
            offset + index,
            value,
          ]);
          break;
        case 'set': {
          const members = (await client.smembers(key)).sort();
          total = members.length;
          data = members.slice(offset, offset + limit).map((member) => [member]);
          break;
        }
        case 'zset':
          total = await client.zcard(key);
          data = pairs(
            (await client.call(
              'ZRANGE',
              key,
              String(offset),
              String(offset + limit - 1),
              'WITHSCORES',
            )) as string[],
          ).map(([member, score]) => [member, Number(score)]);
          break;
        case 'stream': {
          total = await client.xlen(key);
          const entries = (
            await client.xrange(key, '-', '+', 'COUNT', String(offset + limit))
          ).slice(offset);
          data = entries.map(([id, fields]) => [id, toCell(Object.fromEntries(pairs(fields)))]);
          break;
        }
        default:
          throw new DriverError(`The key ${key} is gone, or of a type Runova cannot show.`);
      }
      return {
        result: rows(COLUMNS_BY_TYPE[type] ?? ['value'], data, `${type} ${key}`, started),
        total,
        keyColumns: [],
      };
    },

    async query(text: string, run: DriverQueryOptions): Promise<DriverQueryResult> {
      if (run.database !== undefined && run.database !== null) {
        const value = Number(run.database);
        if (Number.isInteger(value) && value >= 0) current = value;
      }
      const client = await open(current);
      const results: DbResultSet[] = [];
      for (const [index, line] of splitStatements('redis', text).entries()) {
        if (run.signal.aborted) return { results, cancelled: true };
        const started = Date.now();
        try {
          if (run.readOnly && classifyStatement('redis', line).kind !== 'read') {
            throw new Error('That command changes the database, and this run is read-only.');
          }
          const [command, ...args] = parseRedisLine(line);
          if (!command) continue;
          if (command.toLowerCase() === 'select') {
            current = Number(args[0]) || 0;
            await open(current);
            results.push(rows(['value'], [['OK']], line, started));
            continue;
          }
          const reply = await client.call(command, ...args);
          results.push(replyToResult(reply, line, started, run.maxRows));
        } catch (error) {
          return { results, error: { message: describeError(error), statementIndex: index } };
        }
      }
      return { results };
    },

    async settings(): Promise<DbSetting[]> {
      const flat = (await main.call('CONFIG', 'GET', '*')) as string[];
      return pairs(flat)
        .map(([name, value]) => ({
          name,
          value,
          unit: null,
          description: null,
          category: null,
          restartRequired: false,
          editable: true,
          options: value === 'yes' || value === 'no' ? ['yes', 'no'] : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async users(): Promise<DbUser[]> {
      const lines = (await main.call('ACL', 'LIST')) as string[];
      return lines.map((line) => {
        const acl = parseRedisAcl(line);
        return {
          name: acl.name,
          host: null,
          superuser: acl.superuser,
          canLogin: acl.enabled,
          access: acl.level === 'none' ? [] : [{ database: '*', level: acl.level }],
          detail: null,
        };
      });
    },

    async close() {
      for (const client of clients.values()) client.disconnect();
      clients.clear();
    },
  };
}
