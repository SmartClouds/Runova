import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { projectUiKey, useProjectUiStore } from '@/stores/projectUiStore';

/**
 * The project the page below belongs to. The details page provides it, so what its tabs remember
 * is filed under that project. Without it, `useProjectUiState` is plain `useState`.
 */
export const ProjectUiScope = createContext<string | null>(null);

/**
 * `useState` for something the user would expect to find again after leaving the project details
 * page and coming back: a selection, a filter, a search box, a draft. Inside a `ProjectUiScope` the
 * value is kept per project in `projectUiStore`; outside one it is ordinary component state, so a
 * component used on another page behaves as it always did.
 *
 * `key` names the value inside the project, for example `packages.filter`. Do not use it for
 * state that belongs to something running (progress, open dialogs): that should start over.
 */
export function useProjectUiState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const projectId = useContext(ProjectUiScope);
  // Holds the value when there is no project, and the starting value when nothing is stored yet.
  const [local, setLocal] = useState<T>(initial);
  const localRef = useRef(local);
  localRef.current = local;

  const stored = useProjectUiStore((state) =>
    projectId === null ? undefined : state.values[projectUiKey(projectId, key)],
  );
  const isStored = useProjectUiStore(
    (state) => projectId !== null && projectUiKey(projectId, key) in state.values,
  );

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      if (projectId === null) {
        setLocal(action);
        return;
      }
      const state = useProjectUiStore.getState();
      const name = projectUiKey(projectId, key);
      const has = name in state.values;
      const previous = (has ? state.values[name] : localRef.current) as T;
      const next = typeof action === 'function' ? (action as (value: T) => T)(previous) : action;
      if (has && Object.is(previous, next)) return;
      state.set(projectId, key, next);
    },
    [projectId, key],
  );

  if (projectId === null) return [local, set];
  return [isStored ? (stored as T) : local, set];
}
