import type { DatabaseConnection, DatabaseSession } from '@shared/databaseTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDatabaseWorkbenchStore } from '@/stores/databaseWorkbenchStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DatabasePanel } from './DatabasePanel';

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      aria-label="Query"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

/**
 * Ask AI: a question becomes a query with an explanation. The AI sees the schema, not rows,
 * unless sample rows are turned on. Reads run at once; a write waits for a yes.
 */

const connection: DatabaseConnection = {
  id: 'conn-1',
  name: 'shop-db',
  engine: 'postgres',
  target: { kind: 'localContainer', containerId: 'c1', containerName: 'shop-db', port: 5432 },
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

const context = {
  database: 'shop',
  schema: [
    {
      name: 'public.orders',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'total', type: 'numeric' },
      ],
    },
  ],
  samples: [{ table: 'public.orders', columns: ['id', 'total'], rows: [[1, 'SECRET-ROW-VALUE']] }],
};

const readAnswer =
  'This lists the biggest orders.\n\n```sql\nSELECT * FROM orders ORDER BY total DESC LIMIT 10;\n```';
const result = {
  columns: [{ name: 'id', type: 'integer' }],
  rows: [[7]],
  affectedRows: null,
  truncated: false,
  durationMs: 2,
  statement: '',
  notice: null,
};

function render(bridge: Record<string, unknown> = {}) {
  useDatabaseWorkbenchStore.getState().open('local', session);
  return renderWithProviders(<DatabasePanel server={null} />, {
    bridge: {
      'settings.get': { promptBuilderProvider: 'openai', openaiModel: 'gpt-5.1' },
      'database.listObjects': [],
      'database.aiContext': context,
      'ai.ask': { ok: true, text: readAnswer },
      'database.query': { status: 'done', results: [result] },
      ...bridge,
    },
  });
}

async function ask(view: ReturnType<typeof render>, question: string) {
  await view.user.click(await screen.findByRole('button', { name: /ask ai/i }));
  const panel = await screen.findByRole('complementary', { name: 'Ask AI' });
  await view.user.type(
    within(panel).getByRole('textbox', { name: /ask about this database/i }),
    `${question}{Enter}`,
  );
  return panel;
}

describe('AiPanel', () => {
  it('writes a query from a question, with the schema but no rows', async () => {
    const view = render();
    const panel = await ask(view, 'biggest orders');
    expect(await within(panel).findByText('This lists the biggest orders.')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Suggested query').textContent).toBe(
      'SELECT * FROM orders ORDER BY total DESC LIMIT 10;',
    );
    const sent = view.bridge.$fn('ai.ask').mock.calls[0]?.[0] as { prompt: string; model: string };
    expect(sent.model).toBe('gpt-5.1');
    expect(sent.prompt).toContain('public.orders(id integer PK, total numeric)');
    expect(sent.prompt).toContain('Question: biggest orders');
    expect(sent.prompt).not.toContain('SECRET-ROW-VALUE');
    expect(view.bridge.$fn('database.aiContext')).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      database: 'shop',
      includeSamples: false,
    });
  });

  it('sends sample rows only when they are turned on', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: /ask ai/i }));
    await view.user.click(screen.getByRole('switch', { name: /sample rows/i }));
    const panel = screen.getByRole('complementary', { name: 'Ask AI' });
    await view.user.type(
      within(panel).getByRole('textbox', { name: /ask about this database/i }),
      'q{Enter}',
    );
    await waitFor(() => expect(view.bridge.$fn('ai.ask')).toHaveBeenCalled());
    const sent = view.bridge.$fn('ai.ask').mock.calls[0]?.[0] as { prompt: string };
    expect(sent.prompt).toContain('SECRET-ROW-VALUE');
  });

  it('runs a read straight away and shows the rows', async () => {
    const view = render();
    const panel = await ask(view, 'biggest orders');
    await view.user.click(await within(panel).findByRole('button', { name: /^run$/i }));
    expect(
      await within(panel).findByRole('table', { name: 'AI query result' }),
    ).toBeInTheDocument();
    expect(view.bridge.$fn('database.query')).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'ai',
        text: 'SELECT * FROM orders ORDER BY total DESC LIMIT 10;',
      }),
    );
  });

  it('holds a write until the user says to run it', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'needsConfirmation',
        classification: { kind: 'write', destructive: false },
      })
      .mockResolvedValueOnce({
        status: 'done',
        results: [{ ...result, columns: [], rows: [], affectedRows: 3 }],
      });
    const view = render({
      'ai.ask': {
        ok: true,
        text: 'Raises prices.\n```sql\nUPDATE items SET price = price * 1.1 WHERE id < 4;\n```',
      },
      'database.query': query,
    });
    const panel = await ask(view, 'raise prices');
    await view.user.click(await within(panel).findByRole('button', { name: /^run$/i }));
    expect(
      await within(panel).findByText(/wrote a query that changes the database/),
    ).toBeInTheDocument();
    await view.user.click(within(panel).getByRole('button', { name: /review done, run it/i }));
    await waitFor(() =>
      expect(query).toHaveBeenLastCalledWith(
        expect.objectContaining({ confirmed: true, origin: 'ai' }),
      ),
    );
    expect(await within(panel).findByText(/3 rows changed/)).toBeInTheDocument();
  });

  it('opens a suggested query in a new editor tab', async () => {
    const view = render();
    const panel = await ask(view, 'biggest orders');
    await view.user.click(await within(panel).findByRole('button', { name: /open in editor/i }));
    expect(await screen.findByRole('tab', { name: /from ai/i })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Query' })).toHaveValue(
      'SELECT * FROM orders ORDER BY total DESC LIMIT 10;',
    );
  });

  it('asks the AI to fix a failed query, sending the query and the error', async () => {
    const view = render({
      'database.query': {
        status: 'failed',
        results: [],
        error: 'syntax error at "SELEC"',
        statementIndex: 0,
      },
    });
    await view.user.click(await screen.findByRole('button', { name: /new query/i }));
    const editor = await screen.findByRole('textbox', { name: 'Query' });
    await view.user.clear(editor);
    await view.user.type(editor, 'SELEC 1');
    await view.user.click(screen.getByRole('button', { name: 'Run query' }));
    await view.user.click(await screen.findByRole('button', { name: /fix with ai/i }));
    await waitFor(() => expect(view.bridge.$fn('ai.ask')).toHaveBeenCalled());
    const sent = view.bridge.$fn('ai.ask').mock.calls[0]?.[0] as { prompt: string };
    expect(sent.prompt).toContain('SELEC 1');
    expect(sent.prompt).toContain('syntax error at "SELEC"');
  });

  it('says where to pick a model when none is set', async () => {
    const view = render({ 'settings.get': { promptBuilderProvider: 'gemini', geminiModel: '' } });
    const panel = await ask(view, 'q');
    expect(await within(panel).findByText(/Pick a gemini model there first/)).toBeInTheDocument();
  });

  it('shows what went wrong when the AI fails', async () => {
    const view = render({ 'ai.ask': { ok: false, text: '', error: 'Invalid API key' } });
    const panel = await ask(view, 'q');
    expect(await within(panel).findByText('Invalid API key')).toBeInTheDocument();
  });
});
