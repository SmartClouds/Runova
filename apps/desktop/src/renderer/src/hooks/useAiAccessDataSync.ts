import type { AiAccessDataChange } from '@shared/aiAccessTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Keeps the screens current while an AI agent changes things through AI access (E46): each change
 * Runova announces refetches the queries showing that area, so a change made from a CLI shows up
 * without a reload. An area with no list here refetches everything, which is rare enough to be
 * cheap and never leaves a stale screen.
 */

type Key = readonly unknown[];

export function queryKeysForChange(change: AiAccessDataChange): Key[] | null {
  const project = change.projectId;
  switch (change.area) {
    case 'runova':
      return [];
    case 'projects':
      return [queryKeys.projects];
    case 'environments':
      return project
        ? [queryKeys.projectEnvironments(project), ['env-file-history']]
        : [['project-environments'], ['env-file-history']];
    case 'apiClient':
      return [queryKeys.apiCollections];
    case 'scheduledTasks':
      return [queryKeys.scheduledTasksAll];
    case 'docker':
      return [queryKeys.dockerList];
    case 'git':
    case 'worktrees':
      return project
        ? [
            queryKeys.gitStatus(project),
            queryKeys.worktrees(project),
            ['git-workspace-state', project],
          ]
        : null;
    default:
      return null;
  }
}

export function useAiAccessDataSync(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.runova.aiAccess.onDataChanged((change) => {
        const keys = queryKeysForChange(change);
        if (!keys) {
          void queryClient.invalidateQueries();
          return;
        }
        for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
      }),
    [queryClient],
  );
}
