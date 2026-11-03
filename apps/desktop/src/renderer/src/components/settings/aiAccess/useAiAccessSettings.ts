import type { AppSettings } from '@runova/core';
import { aiAccessSettingsOf } from '@shared/aiAccessSettings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { refreshAiAccessLaunchArgs } from '@/lib/workspace/launch';

type AiAccessPatch = Partial<
  Pick<
    AppSettings,
    | 'aiAccessEnabled'
    | 'aiAccessMode'
    | 'aiAccessPrompt'
    | 'aiAccessClients'
    | 'aiAccessAttachToTabs'
  >
>;

/**
 * The AI access settings as the cards show them, with each change saved straight away and shown
 * before the save comes back. A change that decides whether new agent tabs get the server fetches
 * their flags again, so the next tab opened follows it.
 */
export function useAiAccessSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const mutation = useMutation({
    mutationFn: (patch: AiAccessPatch) => window.runova.settings.update(patch),
    meta: { silentLoading: true },
    onSuccess: (next: AppSettings, patch) => {
      queryClient.setQueryData(queryKeys.settings, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      if (
        'aiAccessEnabled' in patch ||
        'aiAccessClients' in patch ||
        'aiAccessAttachToTabs' in patch
      ) {
        void refreshAiAccessLaunchArgs();
      }
    },
  });
  const saved = settings.data ?? {};
  const shown = mutation.isPending ? { ...saved, ...mutation.variables } : saved;
  return {
    loaded: Boolean(settings.data),
    values: aiAccessSettingsOf(shown),
    save: (patch: AiAccessPatch) => mutation.mutate(patch),
  };
}
