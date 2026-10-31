import type { DatabaseSession, DbObjectKind, DbObjectRef } from '@shared/databaseTypes';
import { create } from 'zustand';

/**
 * The Database section's open connections and tabs, one set per place it is opened from (a
 * server, or "this computer"). Kept while the app runs, so leaving the section and coming back
 * finds the same tabs. Not saved: sessions end when the app quits.
 */

export type WorkbenchTabKind = 'data' | 'query' | 'structure' | 'settings' | 'users';

export interface WorkbenchTab {
  id: string;
  kind: WorkbenchTabKind;
  title: string;
  ref?: DbObjectRef;
  objectKind?: DbObjectKind;
  /** A query tab's text. */
  text?: string;
  /** The database a query tab runs in. */
  database?: string | null;
}

export interface WorkbenchScope {
  session: DatabaseSession;
  tabs: WorkbenchTab[];
  activeTabId: string | null;
}

interface DatabaseWorkbenchState {
  scopes: Record<string, WorkbenchScope>;
  open: (scope: string, session: DatabaseSession) => void;
  close: (scope: string) => void;
  /** Opens a tab, or shows the one already open for the same table and kind. */
  openTab: (scope: string, tab: Omit<WorkbenchTab, 'id'> & { id?: string }) => string;
  closeTab: (scope: string, tabId: string) => void;
  setActive: (scope: string, tabId: string) => void;
  updateTab: (scope: string, tabId: string, patch: Partial<Omit<WorkbenchTab, 'id'>>) => void;
}

let nextId = 0;
const newId = () => `tab-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

function sameObject(a: WorkbenchTab, b: Omit<WorkbenchTab, 'id'>): boolean {
  return (
    a.kind === b.kind &&
    a.kind !== 'query' &&
    // Settings and Users have one tab each.
    (a.kind === 'settings' ||
      a.kind === 'users' ||
      (a.ref?.name === b.ref?.name &&
        a.ref?.schema === b.ref?.schema &&
        a.ref?.database === b.ref?.database))
  );
}

export const useDatabaseWorkbenchStore = create<DatabaseWorkbenchState>((set, get) => ({
  scopes: {},

  open: (scope, session) =>
    set((state) => ({
      scopes: { ...state.scopes, [scope]: { session, tabs: [], activeTabId: null } },
    })),

  close: (scope) =>
    set((state) => {
      const { [scope]: _gone, ...rest } = state.scopes;
      return { scopes: rest };
    }),

  openTab: (scope, tab) => {
    const current = get().scopes[scope];
    if (!current) return '';
    const existing = current.tabs.find((one) => sameObject(one, tab));
    if (existing) {
      set((state) => ({
        scopes: { ...state.scopes, [scope]: { ...current, activeTabId: existing.id } },
      }));
      return existing.id;
    }
    const id = tab.id ?? newId();
    set((state) => ({
      scopes: {
        ...state.scopes,
        [scope]: { ...current, tabs: [...current.tabs, { ...tab, id }], activeTabId: id },
      },
    }));
    return id;
  },

  closeTab: (scope, tabId) =>
    set((state) => {
      const current = state.scopes[scope];
      if (!current) return state;
      const index = current.tabs.findIndex((tab) => tab.id === tabId);
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId =
        current.activeTabId === tabId
          ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
          : current.activeTabId;
      return { scopes: { ...state.scopes, [scope]: { ...current, tabs, activeTabId } } };
    }),

  setActive: (scope, tabId) =>
    set((state) => {
      const current = state.scopes[scope];
      if (!current) return state;
      return { scopes: { ...state.scopes, [scope]: { ...current, activeTabId: tabId } } };
    }),

  updateTab: (scope, tabId, patch) =>
    set((state) => {
      const current = state.scopes[scope];
      if (!current) return state;
      const tabs = current.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab));
      return { scopes: { ...state.scopes, [scope]: { ...current, tabs } } };
    }),
}));
