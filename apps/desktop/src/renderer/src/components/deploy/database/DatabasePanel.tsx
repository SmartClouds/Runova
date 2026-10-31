import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { useDatabaseWorkbenchStore } from '@/stores/databaseWorkbenchStore';
import { DatabaseHome } from './DatabaseHome';
import { DatabaseWorkbench } from './DatabaseWorkbench';
import { useDatabaseConnect } from './useDatabaseConnect';

/**
 * A server's Database section (E44), or this computer's for null: the database containers as
 * one-click cards until a connection is open, then the workbench.
 */
export function DatabasePanel({ server }: { server: DeployServer | null }): React.JSX.Element {
  const scope = server?.id ?? 'local';
  const state = useDatabaseWorkbenchStore((store) => store.scopes[scope]);
  const open = useDatabaseWorkbenchStore((store) => store.open);
  const close = useDatabaseWorkbenchStore((store) => store.close);
  const connector = useDatabaseConnect(server);
  const queryClient = useQueryClient();

  if (state) {
    return (
      <DatabaseWorkbench
        scope={scope}
        state={state}
        onDisconnect={() => {
          const { sessionId } = state.session;
          close(scope);
          queryClient.removeQueries({ queryKey: queryKeys.databaseSession(sessionId) });
          void window.runova.database.disconnect(sessionId);
        }}
      />
    );
  }
  return (
    <DatabaseHome
      server={server}
      connector={connector}
      onConnected={(session) => open(scope, session)}
    />
  );
}
