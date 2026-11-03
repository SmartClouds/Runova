import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type {
  DbDriver,
  DriverConnectOptions,
  DriverQueryOptions,
} from '../../database/drivers/types';
import { DriverError } from '../../database/drivers/types';
import type { AiTool, ToolContext } from '../registry';

/**
 * Database tools on the real Database service and connection store, with a fake driver: the
 * saved connections without their passwords, a schema, and read-only queries. Anything that is
 * not a read, a locked password or a password Runova does not have is refused.
 */

const userData = useTempUserData();
const context: ToolContext = {
  projectId: null,
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};

beforeAll(async () => {
  await import('../../database/service');
  await import('../../database/connectionStore');
}, 120_000);

let tools: Map<string, AiTool>;
let opened: DriverConnectOptions[];
let driver: DbDriver;
let open: (options: DriverConnectOptions) => Promise<DbDriver>;

function fakeDriver(): DbDriver {
  return {
    engine: 'postgres',
    serverVersion: async () => '17.2',
    listObjects: vi.fn(async (parent) =>
      parent
        ? [
            {
              kind: 'table' as const,
              name: 'orders',
              ref: { database: 'shop', schema: 'public', name: 'orders' },
              hasChildren: false,
              rowEstimate: 12,
            },
          ]
        : [
            {
              kind: 'database' as const,
              name: 'shop',
              ref: { name: 'shop' },
              hasChildren: true,
              rowEstimate: null,
            },
          ],
    ),
    describe: vi.fn(async (ref) => ({
      ref,
      kind: 'table' as const,
      columns: [
        {
          name: 'id',
          type: 'integer',
          nullable: false,
          primaryKey: true,
          defaultValue: null,
        },
        { name: 'total', type: 'numeric', nullable: true, primaryKey: false, defaultValue: null },
      ],
      indexes: [],
      rowEstimate: 12,
      definition: null,
    })) as unknown as DbDriver['describe'],
    readRows: async () => {
      throw new Error('unused');
    },
    query: vi.fn(async (text: string, _options: DriverQueryOptions) => ({
      results: [
        {
          columns: [
            { name: 'id', type: 'integer' },
            { name: 'total', type: 'numeric' },
          ],
          rows: [
            [1, '9.50'],
            [2, '12.00'],
          ],
          affectedRows: null,
          truncated: false,
          durationMs: 3,
          statement: text,
          notice: null,
        },
      ],
    })),
    close: vi.fn(async () => undefined),
  };
}

beforeEach(async () => {
  opened = [];
  driver = fakeDriver();
  open = async () => driver;
  const { DatabaseService, setDatabaseService } = await import('../../database/service');
  const { DatabaseConnectionStore } = await import('../../database/connectionStore');
  const connections = new DatabaseConnectionStore(userData.dataFile('databases.json'));
  await connections.save({
    name: 'Shop DB',
    engine: 'postgres',
    target: { kind: 'direct', host: 'db.example.com', port: 5432 },
    user: 'shop',
    database: 'shop',
    password: 'hunter2-secret',
  });
  await connections.save({
    name: 'Notes',
    engine: 'sqlite',
    target: { kind: 'sqliteFile', path: 'C:/data/notes.db' },
  });
  setDatabaseService(
    new DatabaseService({
      connections,
      openDriver: async (options) => {
        opened.push(options);
        return open(options);
      },
      serverDocker: {} as never,
      serverStream: async () => {
        throw new Error('unused');
      },
      localDocker: {} as never,
      readEnvFile: async () => null,
      containerAddressesReachable: false,
    }),
  );
  const { databaseTools } = await import('./database');
  tools = new Map(databaseTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), context);
}

describe('database tools', () => {
  it('marks the query tool sensitive and the rest as reads', () => {
    expect(tools.get('database_list_connections')?.risk).toBe('read');
    expect(tools.get('database_schema')?.risk).toBe('read');
    expect(tools.get('database_query')?.risk).toBe('sensitive');
    for (const tool of tools.values()) expect(tool.area).toBe('database');
  });

  it('lists the saved connections without any password', async () => {
    const { data } = await run('database_list_connections');
    expect(data).toEqual([
      expect.objectContaining({
        name: 'Shop DB',
        engine: 'postgres',
        where: 'db.example.com:5432',
        user: 'shop',
        database: 'shop',
        hasPassword: true,
        locked: false,
      }),
      expect.objectContaining({ name: 'Notes', engine: 'sqlite', where: 'C:/data/notes.db' }),
    ]);
    const text = JSON.stringify(data);
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('passwordEnvelope');
    expect(opened).toEqual([]);
  });

  it('reads the tables and columns, and describes one table, closing the session after', async () => {
    const { data } = await run('database_schema', { connection: 'shop db' });
    expect(data).toEqual({
      connection: 'Shop DB',
      database: 'shop',
      databases: ['shop'],
      tables: [
        {
          name: 'public.orders',
          columns: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'total', type: 'numeric' },
          ],
        },
      ],
    });
    expect(opened[0]).toMatchObject({ host: 'db.example.com', password: 'hunter2-secret' });
    expect(driver.close).toHaveBeenCalledTimes(1);

    const table = (await run('database_schema', {
      connection: 'Shop DB',
      table: 'orders',
      schema: 'public',
    })) as { data: { columns: { name: string }[] } };
    expect(table.data.columns.map((column) => column.name)).toEqual(['id', 'total']);
    expect(driver.describe).toHaveBeenLastCalledWith({ name: 'orders', schema: 'public' });
    expect(driver.close).toHaveBeenCalledTimes(2);
  });

  it('runs a read as a read-only query, capped at 200 rows', async () => {
    const { data } = await run('database_query', {
      connection: 'Shop DB',
      sql: 'SELECT id, total FROM orders',
    });
    expect(data).toEqual([
      {
        statement: 'SELECT id, total FROM orders',
        columns: ['id', 'total'],
        rows: [
          [1, '9.50'],
          [2, '12.00'],
        ],
        truncated: false,
      },
    ]);
    const options = vi.mocked(driver.query).mock.calls[0]?.[1];
    expect(options).toMatchObject({ readOnly: true, maxRows: 200 });
    expect(driver.close).toHaveBeenCalled();

    await run('database_query', { connection: 'Shop DB', sql: 'SELECT 1', maxRows: 5 });
    expect(vi.mocked(driver.query).mock.calls[1]?.[1].maxRows).toBe(5);
    const tool = tools.get('database_query') as AiTool;
    expect(
      tool.input.safeParse({ connection: 'Shop DB', sql: 'SELECT 1', maxRows: 500 }).success,
    ).toBe(false);
  });

  it('allows SHOW, EXPLAIN and a WITH that only reads', async () => {
    for (const sql of [
      'SHOW search_path',
      'EXPLAIN SELECT * FROM orders',
      'WITH big AS (SELECT * FROM orders WHERE total > 10) SELECT count(*) FROM big',
    ]) {
      await expect(run('database_query', { connection: 'Shop DB', sql })).resolves.toBeDefined();
    }
  });

  it('refuses anything that is not a read, before connecting', async () => {
    for (const sql of [
      'INSERT INTO orders (total) VALUES (1)',
      'UPDATE orders SET total = 0',
      'DELETE FROM orders',
      'DROP TABLE orders',
      'CREATE TABLE t (id int)',
      'SELECT 1; DELETE FROM orders',
      'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone',
      'GRANT ALL ON orders TO public',
    ]) {
      await expect(run('database_query', { connection: 'Shop DB', sql }), sql).rejects.toThrow(
        /only runs reads/,
      );
    }
    expect(opened).toEqual([]);
    expect(driver.query).not.toHaveBeenCalled();
  });

  it('says so in the approval dialog, with the SQL in a mono field', async () => {
    const shown = await preview('database_query', { connection: 'shop db', sql: 'SELECT 1' });
    expect(shown.title).toBe('Run a read-only query on Shop DB');
    expect(shown.fields).toContainEqual({ label: 'Query', value: 'SELECT 1', mono: true });
    const refused = await preview('database_query', {
      connection: 'Shop DB',
      sql: 'DROP TABLE orders',
    });
    expect(refused.summary).toMatch(/refuse/);
  });

  it('passes on a failed query', async () => {
    vi.mocked(driver.query).mockResolvedValueOnce({
      results: [],
      error: { message: 'relation "nope" does not exist', statementIndex: 0 },
    });
    await expect(
      run('database_query', { connection: 'Shop DB', sql: 'SELECT * FROM nope' }),
    ).rejects.toThrow('relation "nope" does not exist');
    expect(driver.close).toHaveBeenCalled();
  });

  it('sends the agent to the Database page when the password is missing or refused', async () => {
    open = async () => {
      throw new DriverError('password authentication failed', true);
    };
    await expect(run('database_schema', { connection: 'Shop DB' })).rejects.toThrow(
      /Database page/,
    );
    await expect(run('database_query', { connection: 'Shop DB', sql: 'SELECT 1' })).rejects.toThrow(
      /Database page/,
    );
  });

  it('refuses a connection whose password is sealed with a locked passkey, without connecting', async () => {
    userData.writeData('databases.json', {
      connections: [
        {
          id: 'locked-1',
          name: 'Prod',
          engine: 'postgres',
          target: { kind: 'direct', host: 'prod.example.com', port: 5432 },
          user: 'app',
          database: 'app',
          authDatabase: null,
          tls: false,
          srv: false,
          readOnly: false,
          passwordEnvelope: { mode: 'passphrase', iv: 'aa', authTag: 'bb', ciphertext: 'cc' },
          sourceKey: null,
          createdAt: 1,
          lastUsedAt: null,
        },
      ],
    });
    const { data } = await run('database_list_connections');
    expect(data).toEqual([expect.objectContaining({ name: 'Prod', locked: true })]);
    await expect(run('database_query', { connection: 'Prod', sql: 'SELECT 1' })).rejects.toThrow(
      /locked.*Database page/s,
    );
    expect(opened).toEqual([]);
  });

  it('names the saved connections when it cannot find one', async () => {
    await expect(run('database_schema', { connection: 'Billing' })).rejects.toThrow(
      /Shop DB, Notes/,
    );
  });
});
