import { useEffect } from 'react';
import { useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/**
 * Shells that exit cleanly close their tab, like closing a terminal window. Agents and
 * failed commands keep theirs, so the last output stays readable until the user moves on.
 * Mounted with the app shell, since a tab can run before the Workspace page has been opened.
 */
export function useAutoCloseFinishedShells(): void {
  useEffect(() => {
    return useTerminalSessionStore.subscribe((state, previous) => {
      for (const [id, code] of Object.entries(state.ended)) {
        if (id in previous.ended || code !== 0) continue;
        const { workspaces, closeTab } = useWorkspaceStore.getState();
        for (const [projectId, ws] of Object.entries(workspaces)) {
          const tab = ws.tabs[id];
          if (tab?.kind === 'terminal' && !tab.cliId) closeTab(projectId, id);
        }
      }
    });
  }, []);
}
