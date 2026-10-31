import type { DatabaseConnection, DatabaseSession, DbSetting, DbUser } from '@shared/databaseTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDatabaseWorkbenchStore } from '@/stores/databaseWorkbenchStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DatabasePanel } from './DatabasePanel';

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: () => <textarea aria-label="Query" />,
}));

/** The Users and Settings tabs: plain levels and values, with the statements shown first. */

const connection: DatabaseConnection = {
  id: 'conn-1',
  name: 'shop-db',
  engine: 'mysql',
  target: { kind: 'direct', host: 'db', port: 3306 },
  user: 'root',
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
const session: DatabaseSession = { sessionId: 'sess-1', connection, serverVersion: '8.4.2' };

const users: DbUser[] = [
  {
    name: 'root',
    host: '%',
    superuser: true,
    canLogin: true,
    access: [{ database: '*', level: 'admin' }],
    detail: null,
  },
  {
    name: 'app',
    host: '%',
    superuser: false,
    canLogin: true,
    access: [{ database: 'shop', level: 'write' }],
    detail: null,
  },
];

const settings: DbSetting[] = [
  {
    name: 'max_connections',
    value: '151',
    unit: null,
    description: 'The most clients at once',
    category: 'max',
    restartRequired: false,
    editable: true,
    options: null,
  },
  {
    name: 'innodb_buffer_pool_size',
    value: '134217728',
    unit: null,
    description: 'Memory for caching tables',
    category: 'innodb',
    restartRequired: true,
    editable: true,
    options: null,
  },
];

function render() {
  useDatabaseWorkbenchStore.getState().open('local', session);
  return renderWithProviders(<DatabasePanel server={null} />, {
    bridge: {
      'database.listObjects': [
        {
          kind: 'database',
          name: 'shop',
          ref: { database: 'shop', name: 'shop' },
          hasChildren: true,
          rowEstimate: null,
        },
      ],
      'database.users': users,
      'database.settings': settings,
      'database.query': { status: 'done', results: [] },
    },
  });
}

describe('UsersTab', () => {
  it('lists users with what they can reach', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: 'Users and access' }));
    const list = await screen.findByRole('list', { name: 'Users' });
    expect(within(list).getByText('every database: admin')).toBeInTheDocument();
    expect(within(list).getByText('shop: write')).toBeInTheDocument();
    expect(within(list).getByText('superuser')).toBeInTheDocument();
  });

  it('creates a user with a generated password, starred out in the preview', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: 'Users and access' }));
    await view.user.click(await screen.findByRole('button', { name: /new user/i }));
    const dialog = await screen.findByRole('dialog', { name: 'New user' });
    await view.user.type(within(dialog).getByLabelText('User name'), 'reporter');
    await view.user.click(within(dialog).getByRole('radio', { name: 'Read' }));
    await view.user.click(within(dialog).getByRole('button', { name: 'Review' }));

    const review = await screen.findByRole('dialog', { name: 'Create reporter' });
    const preview = within(review).getByLabelText('Statements to run');
    expect(preview.textContent).toBe(
      "CREATE USER 'reporter'@'%' IDENTIFIED BY '********';\nGRANT SELECT ON `shop`.* TO 'reporter'@'%';",
    );
    await view.user.click(within(review).getByRole('button', { name: 'Create user' }));
    await waitFor(() => expect(view.bridge.$fn('database.query')).toHaveBeenCalled());
    const sent = view.bridge.$fn('database.query').mock.calls[0]?.[0] as {
      text: string;
      confirmed: boolean;
    };
    expect(sent.confirmed).toBe(true);
    expect(sent.text).toMatch(/IDENTIFIED BY '[A-Za-z0-9]{24}'/);
  });

  it('changes a user access to exactly one level', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: 'Users and access' }));
    const row = (await screen.findAllByRole('listitem')).find((item) =>
      item.textContent?.includes('app'),
    );
    if (!row) throw new Error('no app row');
    await view.user.click(within(row).getByRole('button', { name: 'Access' }));
    const dialog = await screen.findByRole('dialog', { name: 'Access for app' });
    await view.user.click(within(dialog).getByRole('radio', { name: 'None' }));
    await view.user.click(within(dialog).getByRole('button', { name: 'Review' }));
    const preview = await screen.findByLabelText('Statements to run');
    expect(preview.textContent).toBe("REVOKE ALL PRIVILEGES ON `shop`.* FROM 'app'@'%';");
  });

  it('removes a user after a red confirmation', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: 'Users and access' }));
    await view.user.click(await screen.findByRole('button', { name: 'Remove app' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove app' });
    expect(within(dialog).getByLabelText('Statements to run').textContent).toBe(
      "DROP USER 'app'@'%';",
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove user' }));
    await waitFor(() =>
      expect(view.bridge.$fn('database.query')).toHaveBeenCalledWith(
        expect.objectContaining({ text: "DROP USER 'app'@'%';", confirmed: true }),
      ),
    );
  });
});

describe('SettingsTab', () => {
  it('searches settings and changes one, saying when a restart is needed', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: 'Server settings' }));
    await screen.findByText('max_connections');
    expect(screen.getByText('needs restart')).toBeInTheDocument();

    await view.user.type(screen.getByRole('textbox', { name: 'Search settings' }), 'memory');
    expect(screen.queryByText('max_connections')).not.toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Change innodb_buffer_pool_size' }));
    const input = screen.getByRole('textbox', { name: 'New value for innodb_buffer_pool_size' });
    await view.user.clear(input);
    await view.user.type(input, '1073741824');
    await view.user.click(screen.getByRole('button', { name: 'Review' }));

    const dialog = await screen.findByRole('dialog', { name: /change innodb_buffer_pool_size/i });
    expect(within(dialog).getByText(/only takes effect after a restart/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Statements to run').textContent).toBe(
      'SET PERSIST `innodb_buffer_pool_size` = 1073741824;',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Change it' }));
    expect(
      await screen.findByText(/Restart the database for it to take effect/),
    ).toBeInTheDocument();
  });
});
