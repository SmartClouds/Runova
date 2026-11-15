import type { DatabaseSession } from '@shared/databaseTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDatabaseWorkbenchStore } from './databaseWorkbenchStore';

const session = { sessionId: 's1', connection: { id: 'c1' } } as unknown as DatabaseSession;
const store = () => useDatabaseWorkbenchStore.getState();
const tabs = () => store().scopes.local?.tabs ?? [];

beforeEach(() => {
  store().open('local', session);
});

describe('databaseWorkbenchStore', () => {
  it('keeps one diagram tab per database and schema', () => {
    const first = store().openTab('local', {
      kind: 'diagram',
      title: 'Diagram',
      scope: { database: 'shop', schema: 'public' },
    });
    const again = store().openTab('local', {
      kind: 'diagram',
      title: 'Diagram',
      scope: { database: 'shop', schema: 'public' },
    });
    const other = store().openTab('local', {
      kind: 'diagram',
      title: 'Diagram',
      scope: { database: 'shop', schema: null },
    });
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(tabs().map((tab) => tab.kind)).toEqual(['diagram', 'diagram']);
  });

  it('keeps one health tab per database, apart from the diagram', () => {
    const health = store().openTab('local', {
      kind: 'health',
      title: 'Health',
      scope: { database: 'shop', schema: null },
    });
    const diagram = store().openTab('local', {
      kind: 'diagram',
      title: 'Diagram',
      scope: { database: 'shop', schema: null },
    });
    expect(health).not.toBe(diagram);
    expect(
      store().openTab('local', {
        kind: 'health',
        title: 'Health',
        scope: { database: 'shop', schema: null },
      }),
    ).toBe(health);
    expect(store().scopes.local?.activeTabId).toBe(health);
  });

  it('remembers where tables were dragged on a diagram', () => {
    const id = store().openTab('local', {
      kind: 'diagram',
      title: 'Diagram',
      scope: { database: 'shop', schema: null },
    });
    store().updateTab('local', id, {
      positions: { '["shop","public","orders"]': { x: 10, y: 20 } },
    });
    expect(tabs()[0]?.positions).toEqual({ '["shop","public","orders"]': { x: 10, y: 20 } });
  });
});
