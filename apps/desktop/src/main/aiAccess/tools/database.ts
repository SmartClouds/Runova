import { randomUUID } from 'node:crypto';
import { classifyStatement, engineInfo } from '@runova/core';
import { z } from 'zod';
import type {
  DatabaseConnection,
  DatabaseTarget,
  DbResultSet,
} from '../../../shared/databaseTypes';
import { type DatabaseService, getDatabaseService } from '../../database/service';
import { defineTool } from '../registry';

/**
 * Database tools: the connections saved on the Database page, the tables in one, and read-only
 * queries. They go through the same service as the Database page and connect with what is saved
 * there, so a connection only works here once it works there without typing anything: a password
 * Runova does not have, or one sealed with a locked Servers passkey, sends the agent back to the
 * user. Queries are checked with the same classifier the page uses, and anything that is not a
 * read is refused before Runova connects.
 */

/** The most rows an agent gets back from one statement. */
const MAX_ROWS = 200;

const connectionArg = z
  .string()
  .min(1)
  .describe('The saved connection, by name or id. database_list_connections lists them.');

const databaseArg = z
  .string()
  .min(1)
  .optional()
  .describe('The database on that server to use. Leave it out for the one the connection opens.');

function service(): DatabaseService {
  const running = getDatabaseService();
  if (!running) throw new Error('The Database page has not started yet. Try again in a moment.');
  return running;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function findConnection(ref: string): Promise<DatabaseConnection> {
  const all = await service().listConnections();
  const found = all.find((one) => one.id === ref) ?? all.find((one) => same(one.name, ref));
  if (found) return found;
  if (all.length === 0) {
    throw new Error(
      'There are no saved database connections. The user adds them on the Database page.',
    );
  }
  throw new Error(
    `No saved connection named ${ref}. The saved ones are: ${all.map((one) => one.name).join(', ')}.`,
  );
}

/** Where a connection points, in a few words. */
function whereOf(target: DatabaseTarget): string {
  switch (target.kind) {
    case 'direct':
      return target.port === null ? target.host : `${target.host}:${target.port}`;
    case 'server':
      return target.containerName
        ? `container ${target.containerName} on server ${target.serverId}`
        : `${target.host}:${target.port} on server ${target.serverId}`;
    case 'localContainer':
      return `container ${target.containerName} on this computer`;
    case 'sqliteFile':
      return target.path;
  }
}

const ASK_USER = 'Ask the user to connect to it on the Database page first, then try again.';

/**
 * Opens a session on a saved connection with what is saved, does the work and closes it again.
 * Nothing is typed in for the user: a missing or locked password is refused.
 */
async function withSession<T>(
  connection: DatabaseConnection,
  work: (sessionId: string) => Promise<T>,
): Promise<T> {
  if (connection.locked) {
    throw new Error(
      `The password for ${connection.name} is sealed with the Servers passkey, which is locked. ${ASK_USER}`,
    );
  }
  const db = service();
  const result = await db.connect(connection.id);
  if ('needsPassword' in result) {
    const why =
      result.reason === 'refused'
        ? `${connection.name} refused the saved sign-in.`
        : `Runova has no saved password for ${connection.name}.`;
    throw new Error(`${why} ${ASK_USER}`);
  }
  try {
    return await work(result.sessionId);
  } finally {
    await db.disconnect(result.sessionId);
  }
}

/** Whether a statement only reads, by the classifier the Database page uses. */
function isRead(connection: DatabaseConnection, sql: string): boolean {
  return classifyStatement(connection.engine, sql).kind === 'read';
}

const READS_ONLY =
  'Runova only runs reads here (SELECT, SHOW, EXPLAIN, or WITH that ends in a SELECT). Changes to data or tables are for the user to make on the Database page.';

function resultShape(result: DbResultSet) {
  return {
    statement: result.statement,
    columns: result.columns.map((column) => column.name),
    rows: result.rows,
    truncated: result.truncated,
    ...(result.notice ? { notice: result.notice } : {}),
  };
}

export const databaseTools = [
  defineTool({
    name: 'database_list_connections',
    area: 'database',
    title: 'Saved database connections',
    description:
      'The database connections saved on the Database page: name, engine, where it points, user and default database, and whether a password is saved. Passwords are never shown.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List the saved database connections' }),
    async run() {
      const all = await service().listConnections();
      return {
        data: all.map((connection) => ({
          id: connection.id,
          name: connection.name,
          engine: connection.engine,
          engineLabel: engineInfo(connection.engine).label,
          where: whereOf(connection.target),
          user: connection.user,
          database: connection.database,
          readOnly: connection.readOnly,
          hasPassword: connection.hasPassword,
          locked: connection.locked,
          lastUsedAt: connection.lastUsedAt,
        })),
      };
    },
  }),

  defineTool({
    name: 'database_schema',
    area: 'database',
    title: 'Database tables and columns',
    description:
      'The tables in a saved connection with their columns and types, the way the Database page shows them to its AI. Pass table to get one table in full, with its indexes.',
    risk: 'read',
    input: z.object({
      connection: connectionArg,
      database: databaseArg,
      table: z.string().min(1).optional().describe('One table, view or collection to describe.'),
      schema: z
        .string()
        .min(1)
        .optional()
        .describe('The schema the table is in, like public. Only used with table.'),
    }),
    async preview(args) {
      const name = await findConnection(args.connection).then(
        (one) => one.name,
        () => args.connection,
      );
      return {
        title: args.table
          ? `Read the columns of ${args.table} in ${name}`
          : `Read the tables in ${name}`,
      };
    },
    async run(args) {
      const connection = await findConnection(args.connection);
      const db = service();
      return withSession(connection, async (sessionId) => {
        if (args.table) {
          const description = await db.describe(sessionId, {
            name: args.table,
            ...(args.schema ? { schema: args.schema } : {}),
            ...(args.database ? { database: args.database } : {}),
          });
          return { data: description };
        }
        const top = await db.listObjects({ sessionId, parent: null, parentKind: null });
        const context = await db.aiContext({
          sessionId,
          ...(args.database ? { database: args.database } : {}),
          includeSamples: false,
        });
        return {
          data: {
            connection: connection.name,
            database: context.database,
            databases: top.filter((node) => node.kind === 'database').map((node) => node.name),
            tables: context.schema,
          },
        };
      });
    },
  }),

  defineTool({
    name: 'database_query',
    area: 'database',
    title: 'Run a read-only query',
    description: `Runs a read-only query on a saved connection and returns the rows, at most ${MAX_ROWS} per statement. SQL for SQL databases, the shell syntax for MongoDB and commands for Redis. Anything that changes data or tables is refused.`,
    risk: 'sensitive',
    input: z.object({
      connection: connectionArg,
      sql: z.string().min(1).max(100_000).describe('The query to run. It must only read.'),
      database: databaseArg,
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROWS)
        .optional()
        .describe(`The most rows to return per statement, up to ${MAX_ROWS}.`),
    }),
    async preview(args) {
      const connection = await findConnection(args.connection).catch(() => null);
      const name = connection?.name ?? args.connection;
      return {
        title: `Run a read-only query on ${name}`,
        ...(connection && !isRead(connection, args.sql)
          ? { summary: 'This does not only read, so Runova will refuse it even if you allow it.' }
          : {}),
        fields: [
          ...(connection
            ? [{ label: 'Connection', value: `${name} (${whereOf(connection.target)})` }]
            : []),
          ...(args.database ? [{ label: 'Database', value: args.database, mono: true }] : []),
          { label: 'Query', value: args.sql, mono: true },
        ],
      };
    },
    async run(args) {
      const connection = await findConnection(args.connection);
      if (!isRead(connection, args.sql)) throw new Error(READS_ONLY);
      const db = service();
      return withSession(connection, async (sessionId) => {
        const outcome = await db.query({
          sessionId,
          queryId: randomUUID(),
          text: args.sql,
          database: args.database ?? null,
          maxRows: args.maxRows ?? MAX_ROWS,
          origin: 'ai',
        });
        switch (outcome.status) {
          case 'done':
            return { data: outcome.results.map(resultShape) };
          case 'failed':
            throw new Error(outcome.error);
          case 'cancelled':
            throw new Error('The query was cancelled.');
          case 'needsConfirmation':
            throw new Error(READS_ONLY);
        }
      });
    },
  }),
];
