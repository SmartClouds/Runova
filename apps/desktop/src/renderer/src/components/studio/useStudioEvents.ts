import type { RenderJobView } from '@runova/studio';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { studioClient } from './client';
import { useStudioAiOutputStore } from './kit';
import { studioKeys } from './queryKeys';

/** The one subscription every mounted `useStudioEvents` shares, and how many hold it. */
let shared: { holders: number; stop: () => void } | null = null;

function listen(queryClient: QueryClient): () => void {
  return studioClient().onEvent((event) => {
    if (event.type === 'library-changed') {
      void queryClient.invalidateQueries({ queryKey: studioKeys.videos });
    } else if (event.type === 'video-changed') {
      void queryClient.invalidateQueries({ queryKey: studioKeys.history(event.videoId) });
    } else if (event.type === 'generation-changed') {
      void queryClient.invalidateQueries({ queryKey: studioKeys.generations(event.videoId) });
    } else if (event.type === 'gen-changed') {
      void queryClient.invalidateQueries({ queryKey: studioKeys.genJobs(event.videoId) });
      void queryClient.invalidateQueries({ queryKey: studioKeys.media(event.videoId) });
    } else if (event.type === 'narration-changed') {
      void queryClient.invalidateQueries({ queryKey: studioKeys.narrationJobs(event.videoId) });
    } else if (event.type === 'media-changed') {
      void queryClient.invalidateQueries({ queryKey: studioKeys.media(event.videoId) });
    } else if (event.type === 'piper-voices-changed') {
      // A Piper voice downloading, downloaded or removed: the library and the voices to pick.
      void queryClient.invalidateQueries({ queryKey: studioKeys.piperLibrary });
      void queryClient.invalidateQueries({ queryKey: studioKeys.voiceEngines });
      void queryClient.invalidateQueries({ queryKey: ['studio', 'voices', 'piper'] });
    } else if (event.type === 'render-changed') {
      void queryClient.invalidateQueries({ queryKey: studioKeys.renders });
    } else if (event.type === 'render-progress') {
      // Progress comes a few times a second: patched into the lists instead of refetching them.
      queryClient.setQueriesData<RenderJobView[]>({ queryKey: studioKeys.renders }, (jobs) =>
        jobs?.map((job) =>
          job.id === event.jobId
            ? { ...job, phase: event.phase, done: event.done, total: event.total }
            : job,
        ),
      );
    } else if (event.type === 'generation-output') {
      // Collected outside the editor, so a run's output keeps coming while the user is away.
      useStudioAiOutputStore.getState().append(event.videoId, event.generationId, event.lines);
    }
  });
}

/**
 * Keeps Studio's lists fresh when the service reports a change (another window, an AI edit, a
 * narration or render going on in the background). The app shell holds it for every page, so work
 * that goes on while the user is elsewhere is up to date when they come back; Studio's own views
 * hold it too, which costs nothing, since every holder shares one subscription.
 */
export function useStudioEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (shared) shared.holders += 1;
    else shared = { holders: 1, stop: listen(queryClient) };
    return () => {
      if (!shared) return;
      shared.holders -= 1;
      if (shared.holders > 0) return;
      shared.stop();
      shared = null;
    };
  }, [queryClient]);
}
