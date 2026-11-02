import { create } from 'zustand';

/**
 * What the project details page had open or selected, kept per project while the app runs. The
 * page is unmounted whenever the user leaves it (for the Workspace, say), so a tab that held its
 * selection, filters or a half-typed commit message in component state would start over on the
 * way back. Values live only in memory, so a restart begins clean.
 */

interface ProjectUiState {
  /** Keyed by `<projectId>:<key>`. Any value a component wants back, a Set included. */
  values: Record<string, unknown>;
  set: (projectId: string, key: string, value: unknown) => void;
  /** Forgets everything remembered for one project. */
  clear: (projectId: string) => void;
}

export function projectUiKey(projectId: string, key: string): string {
  return `${projectId}:${key}`;
}

export const useProjectUiStore = create<ProjectUiState>()((set) => ({
  values: {},
  set: (projectId, key, value) =>
    set((state) => ({ values: { ...state.values, [projectUiKey(projectId, key)]: value } })),
  clear: (projectId) =>
    set((state) => {
      const prefix = `${projectId}:`;
      const values: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(state.values)) {
        if (!name.startsWith(prefix)) values[name] = value;
      }
      return { values };
    }),
}));
