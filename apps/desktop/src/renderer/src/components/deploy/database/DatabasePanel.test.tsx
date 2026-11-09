import type {
  DatabaseCandidate,
  DatabaseConnection,
  DatabaseSession,
  DatabaseSignIns,
  DbObjectNode,
  DbRowsPage,
} from '@shared/databaseTypes';
import type { DeployServer } from '@shared/deployTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DatabasePanel } from './DatabasePanel';

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({
    value,
    language,
    onChange,
  }: {
    value: string;
    language: string;
    onChange?: (v: string) => void;
  }) => (
    <textarea
      aria-label="Query"
      data-language={language}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

/**
 * The Database section: the containers on a server as cards with one Connect button, the
 * password asked for only when it was not found, then the workbench with the object tree, a
 * table's rows and the query editor.
 */

const server = { id: 's1', nickname: 'Prod' } as DeployServer;

const candidate: DatabaseCandidate = {
  key: 'server:s1:shop-db',
  source: 'server',
  serverId: 's1',
  containerId: 'c-pg',
  containerName: 'shop-db',
  image: 'postgres:17',
  engine: 'postgres',
  running: true,
  project: 'shop',
  connectionId: null,
};

const connection: DatabaseConnection = {
  id: 'conn-1',
  name: 'shop-db',
  engine: 'postgres',
  target: {
    kind: 'server',
    serverId: 's1',
    host: '172.20.0.5',
    port: 5432,
    containerName: 'shop-db',
  },
  user: 'postgres',
  database: 'shop',
  authDatabase: null,
  tls: false,
  srv: false,
  readOnly: false,
  hasPassword: true,
  locked: false,
  createdAt: 1,
  lastUsedAt: null,
};

const session: DatabaseSession = { sessionId: 'sess-1', connection, serverVersion: '17.2' };

const databases: DbObjectNode[] = [
  {
    kind: 'database',
    name: 'shop',
    ref: { database: 'shop', name: 'shop' },
    hasChildren: true,
    rowEstimate: null,
  },
];
const schemas: DbObjectNode[] = [
  {
    kind: 'schema',
    name: 'public',
    ref: { database: 'shop', schema: 'public', name: 'public' },
    hasChildren: true,
    rowEstimate: null,
  },
];
const tables: DbObjectNode[] = [
  {
    kind: 'table',
    name: 'orders',
    ref: { database: 'shop', schema: 'public', name: 'orders' },
    hasChildren: false,
    rowEstimate: 2,
  },
];

const page: DbRowsPage = {
  result: {
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'customer', type: 'text' },
      { name: 'meta', type: 'jsonb' },
    ],
    rows: [
      [1, 'Ada', { vip: true }],
      [2, null, null],
    ],
    affectedRows: null,
    truncated: false,
    durationMs: 3,
    statement: 'SELECT * FROM "public"."orders" LIMIT 100 OFFSET 0',
    notice: null,
  },
  total: 2,
  keyColumns: ['id'],
};

function bridge(overrides: Record<string, unknown> = {}) {
  return {
    'database.discover': { candidates: [candidate], problems: [] },
    'database.listConnections': [],
    'database.connectCandidate': session,
    'database.listObjects': async (input: { parentKind: string | null }) =>
      input.parentKind === null ? databases : input.parentKind === 'database' ? schemas : tables,
    'database.describe': {
      ref: tables[0].ref,
      kind: 'table',
      columns: [],
      indexes: [],
      rowEstimate: 2,
      definition: null,
    },
    'database.readRows': page,
    'database.query': {
      status: 'done',
      results: [
        {
          columns: [{ name: 'n', type: 'integer' }],
          rows: [[42]],
          affectedRows: null,
          truncated: false,
          durationMs: 5,
          statement: 'SELECT 42 AS n',
          notice: null,
        },
      ],
    },
    ...overrides,
  };
}

async function connect(overrides: Record<string, unknown> = {}) {
  const view = renderWithProviders(<DatabasePanel server={server} />, {
    bridge: bridge(overrides),
  });
  const card = await screen.findByRole('group', { name: /shop-db/ });
  await view.user.click(within(card).getByRole('button', { name: 'Connect' }));
  return view;
}

describe('DatabasePanel', () => {
  it('shows each database container on the server as a card with one Connect button', async () => {
    renderWithProviders(<DatabasePanel server={server} />, { bridge: bridge() });
    const card = await screen.findByRole('group', { name: /shop-db/ });
    expect(within(card).getByText('PostgreSQL')).toBeInTheDocument();
    expect(within(card).getByText('shop')).toBeInTheDocument();
    expect(within(card).getByText(/running/i)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('says how to get a database when the server has none', async () => {
    renderWithProviders(<DatabasePanel server={server} />, {
      bridge: bridge({ 'database.discover': { candidates: [], problems: [] } }),
    });
    expect(await screen.findByText(/no database containers on prod/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a connection/i })).toBeInTheDocument();
  });

  it('connects in one click and opens the workbench with the object tree', async () => {
    const view = await connect();
    expect(view.bridge.$fn('database.connectCandidate')).toHaveBeenCalledWith({
      serverId: 's1',
      containerId: 'c-pg',
    });
    expect(await screen.findByRole('heading', { name: 'shop-db' })).toBeInTheDocument();
    expect(screen.getByText(/PostgreSQL 17\.2/)).toBeInTheDocument();
    expect(await screen.findByRole('treeitem', { name: /shop/ })).toBeInTheDocument();
  });

  it('asks only for the password when the container did not have one', async () => {
    const connectCandidate = vi
      .fn()
      .mockResolvedValueOnce({
        needsPassword: true,
        reason: 'missing',
        engine: 'postgres',
        user: 'postgres',
      })
      .mockResolvedValueOnce(session);
    const view = await connect({ 'database.connectCandidate': connectCandidate });
    const dialog = await screen.findByRole('dialog', { name: /password/i });
    expect(within(dialog).getByText(/postgres/)).toBeInTheDocument();
    await view.user.type(within(dialog).getByLabelText(/password/i), 'typed-pw');
    await view.user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(connectCandidate).toHaveBeenLastCalledWith({
        serverId: 's1',
        containerId: 'c-pg',
        databasePassword: 'typed-pw',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'shop-db' })).toBeInTheDocument();
  });

  it('shows a connect failure on the card, with the reason', async () => {
    await connect({
      'database.connectCandidate': async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
    });
    expect(await screen.findByText(/ECONNREFUSED/)).toBeInTheDocument();
  });

  it('opens a table from the tree and shows its rows, NULLs and JSON included', async () => {
    const view = await connect();
    await view.user.click(await screen.findByRole('button', { name: 'Expand shop' }));
    await view.user.click(await screen.findByRole('button', { name: 'Expand public' }));
    await view.user.click(await screen.findByRole('treeitem', { name: /orders/ }));

    const grid = await screen.findByRole('table', { name: /orders/ });
    expect(within(grid).getByRole('columnheader', { name: /customer/ })).toBeInTheDocument();
    expect(within(grid).getByText('Ada')).toBeInTheDocument();
    expect(within(grid).getAllByText('NULL')).toHaveLength(2);
    expect(within(grid).getByText('{"vip":true}')).toBeInTheDocument();
    expect(screen.getByText(/2 rows/)).toBeInTheDocument();
    expect(view.bridge.$fn('database.readRows')).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', limit: 100, offset: 0 }),
    );
  });

  it('sorts and filters the rows', async () => {
    const view = await connect();
    await view.user.click(await screen.findByRole('button', { name: 'Expand shop' }));
    await view.user.click(await screen.findByRole('button', { name: 'Expand public' }));
    await view.user.click(await screen.findByRole('treeitem', { name: /orders/ }));
    await screen.findByRole('table', { name: /orders/ });

    await view.user.click(screen.getByRole('button', { name: /sort by customer/i }));
    await waitFor(() =>
      expect(view.bridge.$fn('database.readRows')).toHaveBeenLastCalledWith(
        expect.objectContaining({ orderBy: { column: 'customer', direction: 'asc' } }),
      ),
    );
    await view.user.type(
      screen.getByRole('textbox', { name: /filter/i }),
      "customer = 'Ada'{Enter}",
    );
    await waitFor(() =>
      expect(view.bridge.$fn('database.readRows')).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: "customer = 'Ada'" }),
      ),
    );
  });

  it('runs a query from the editor and shows its result', async () => {
    const view = await connect();
    await view.user.click(await screen.findByRole('button', { name: /new query/i }));
    const editor = await screen.findByRole('textbox', { name: 'Query' });
    await view.user.clear(editor);
    await view.user.type(editor, 'SELECT 42 AS n');
    await view.user.click(screen.getByRole('button', { name: 'Run query' }));
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(view.bridge.$fn('database.query')).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', text: 'SELECT 42 AS n', origin: 'editor' }),
    );
    expect(screen.getByText(/1 row/)).toBeInTheDocument();
  });

  it('holds a destructive query until the user says run it anyway', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'needsConfirmation',
        classification: { kind: 'ddl', destructive: true },
      })
      .mockResolvedValueOnce({ status: 'done', results: [] });
    const view = await connect({ 'database.query': query });
    await view.user.click(await screen.findByRole('button', { name: /new query/i }));
    const editor = await screen.findByRole('textbox', { name: 'Query' });
    await view.user.clear(editor);
    await view.user.type(editor, 'DROP TABLE orders');
    await view.user.click(screen.getByRole('button', { name: 'Run query' }));

    expect(await screen.findByText(/deletes data or structure/i)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: /run anyway/i }));
    await waitFor(() =>
      expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ confirmed: true })),
    );
  });

  it('shows a failed statement with the reason', async () => {
    const view = await connect({
      'database.query': {
        status: 'failed',
        results: [],
        error: 'relation "nope" does not exist',
        statementIndex: 0,
      },
    });
    await view.user.click(await screen.findByRole('button', { name: /new query/i }));
    await view.user.click(screen.getByRole('button', { name: 'Run query' }));
    expect(await screen.findByText(/relation "nope" does not exist/)).toBeInTheDocument();
  });

  it('lists the sign-ins a project writes down, shows one on purpose, and connects with another', async () => {
    const signIns: DatabaseSignIns = {
      envFile: { path: '/opt/shop/.env', found: true },
      unread: ['shop-worker'],
      signIns: [
        {
          id: 'ownerid000001',
          user: 'postgres',
          database: 'shop',
          hasPassword: true,
          owner: true,
          origin: { kind: 'container', where: 'shop-db', key: 'POSTGRES_PASSWORD' },
          alsoIn: [{ kind: 'envFile', where: '/opt/shop/.env', key: 'POSTGRES_PASSWORD' }],
          connectionId: 'conn-1',
        },
        {
          id: 'appuserid0002',
          user: 'shop_app',
          database: 'shop',
          hasPassword: true,
          owner: false,
          origin: { kind: 'app', where: 'shop-api', key: 'DATABASE_URL_APP' },
          alsoIn: [],
          connectionId: null,
        },
      ],
    };
    const view = renderWithProviders(<DatabasePanel server={server} />, {
      bridge: bridge({
        'database.listSignIns': signIns,
        'database.revealSignIn': {
          url: 'postgres://shop_app:app-pw@db:5432/shop',
          password: 'app-pw',
        },
        'database.connectSignIn': session,
      }),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Sign-ins for shop-db' }));
    expect(view.bridge.$fn('database.listSignIns')).toHaveBeenCalledWith({
      serverId: 's1',
      containerId: 'c-pg',
    });
    const dialog = await screen.findByRole('dialog', { name: /sign-ins for shop-db/i });
    expect(within(dialog).getByText(/It read \/opt\/shop\/\.env/)).toBeInTheDocument();
    expect(within(dialog).getByText(/could not read shop-worker/i)).toBeInTheDocument();
    const owner = within(dialog).getByRole('listitem', { name: 'postgres on shop' });
    expect(within(owner).getByText('Owner')).toBeInTheDocument();
    expect(within(owner).getByText('Saved')).toBeInTheDocument();
    expect(within(owner).getByText(/and 1 more place/)).toBeInTheDocument();
    const app = within(dialog).getByRole('listitem', { name: 'shop_app on shop' });
    expect(within(app).getByText('DATABASE_URL_APP in shop-api')).toBeInTheDocument();
    // Nothing secret is on screen until Show is pressed.
    expect(within(dialog).queryByText(/app-pw/)).toBeNull();

    await view.user.click(
      within(app).getByRole('button', { name: 'Show the sign-in for shop_app' }),
    );
    expect(view.bridge.$fn('database.revealSignIn')).toHaveBeenCalledWith({
      serverId: 's1',
      containerId: 'c-pg',
      signInId: 'appuserid0002',
    });
    expect(
      await within(app).findByText('postgres://shop_app:app-pw@db:5432/shop'),
    ).toBeInTheDocument();
    expect(within(app).getByText('app-pw')).toBeInTheDocument();
    await view.user.click(
      within(app).getByRole('button', { name: 'Hide the sign-in for shop_app' }),
    );
    expect(within(dialog).queryByText(/app-pw/)).toBeNull();

    await view.user.click(within(app).getByRole('button', { name: 'Connect' }));
    expect(view.bridge.$fn('database.connectSignIn')).toHaveBeenCalledWith({
      serverId: 's1',
      containerId: 'c-pg',
      signInId: 'appuserid0002',
    });
    expect(await screen.findByRole('heading', { name: 'shop-db' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /sign-ins/i })).toBeNull();
  });

  it('shows on the card why the sign-ins could not be read', async () => {
    const view = renderWithProviders(<DatabasePanel server={server} />, {
      bridge: bridge({
        'database.listSignIns': async () => {
          throw new Error('The server could not be reached.');
        },
      }),
    });
    const card = await screen.findByRole('group', { name: /shop-db/ });
    await view.user.click(within(card).getByRole('button', { name: 'Sign-ins for shop-db' }));
    expect(await within(card).findByText(/could not be reached/)).toBeInTheDocument();
  });

  it('connects on its own to the container an Open database link names', async () => {
    const view = renderWithProviders(<DatabasePanel server={server} />, {
      bridge: bridge(),
      route: '/deploy?server=s1&view=database&connect=shop-db',
    });
    expect(await screen.findByRole('heading', { name: 'shop-db' })).toBeInTheDocument();
    expect(view.bridge.$fn('database.connectCandidate')).toHaveBeenCalledWith({
      serverId: 's1',
      containerId: 'c-pg',
    });
  });

  it('disconnects and goes back to the cards', async () => {
    const view = await connect();
    await view.user.click(await screen.findByRole('button', { name: /disconnect/i }));
    expect(view.bridge.$fn('database.disconnect')).toHaveBeenCalledWith('sess-1');
    expect(await screen.findByRole('group', { name: /shop-db/ })).toBeInTheDocument();
  });
});
