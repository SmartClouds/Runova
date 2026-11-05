import type { EditResponse, GenerationView } from '@runova/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { studioAiClient, studioScenesClient } from '../client';
import { errorMessage } from '../format';
import { type RunSettings, toast, useStudioAiOutputStore } from '../kit';
import { studioKeys } from '../queryKeys';
import { useStudioEvents } from '../useStudioEvents';
import { type ScenarioRequest, toRunInput } from './runSettings';

const NO_OUTPUT: Record<string, string[] | undefined> = {};

export interface StudioAi {
  generations: GenerationView[];
  loading: boolean;
  /** Live output of runs while they work, by generation id. */
  output: Record<string, string[] | undefined>;
  /** The run working on the video right now, if any. */
  running: GenerationView | null;
  startScenario: (request: ScenarioRequest) => Promise<boolean>;
  startEdit: (instruction: string, run: RunSettings) => Promise<boolean>;
  /** Animates a scene, or changes its animation when given what to change. */
  startScene: (sceneId: string, run: RunSettings, instruction?: string) => Promise<boolean>;
  cancel: (generationId: string) => Promise<void>;
  retry: (generationId: string) => Promise<void>;
  applyProposal: (generationId: string) => Promise<boolean>;
  discardProposal: (generationId: string) => Promise<boolean>;
}

/**
 * One video's AI runs: their records, their live output, and the actions on them. The runs go on
 * in the service when the editor goes away; the app-wide Studio events keep the list fresh and
 * collect the output meanwhile (`useStudioEvents`).
 */
export function useStudioAi(
  videoId: string,
  adopt: (result: EditResponse) => Promise<void>,
): StudioAi {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: studioKeys.generations(videoId),
    queryFn: () => studioAiClient().generations(videoId, 50),
  });
  const generations = list.data ?? [];
  // The editor holds the Studio events too, so it works on its own; the app shell shares them.
  useStudioEvents();
  const output = useStudioAiOutputStore((state) => state.output[videoId]) ?? NO_OUTPUT;
  const observe = useStudioAiOutputStore((state) => state.observe);

  // A scenario that lands gets a word, since the whole scenario changed. What the editor saw is
  // kept outside it, so one that finished while the user was on another page is told on return.
  useEffect(() => {
    if (observe(generations).length > 0) {
      toast.success('The scenario is written. Undo brings back the one before.');
    }
  }, [generations, observe]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: studioKeys.generations(videoId) }),
    [queryClient, videoId],
  );

  const attempt = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | null> => {
      try {
        const result = await work();
        await refresh();
        return result;
      } catch (error) {
        toast.error(errorMessage(error));
        return null;
      }
    },
    [refresh],
  );

  const client = studioAiClient;
  return {
    generations,
    loading: list.isPending,
    output,
    running: generations.find((g) => g.status === 'running') ?? null,
    startScenario: async (request) =>
      (await attempt(() => client().startScenario({ videoId, ...request }))) !== null,
    startEdit: async (instruction, run) =>
      (await attempt(() => client().startEdit({ videoId, instruction, run: toRunInput(run) }))) !==
      null,
    startScene: async (sceneId, runSettings, instruction) =>
      (await attempt(() =>
        studioScenesClient().animate({
          videoId,
          sceneId,
          instruction,
          run: toRunInput(runSettings),
        }),
      )) !== null,
    cancel: async (id) => {
      await attempt(() => client().cancel(videoId, id));
    },
    retry: async (id) => {
      await attempt(() => client().retry(videoId, id));
    },
    applyProposal: async (id) => {
      const result = await attempt(() => client().applyProposal(videoId, id));
      if (result) await adopt(result);
      return result !== null;
    },
    discardProposal: async (id) =>
      (await attempt(async () => {
        await client().discardProposal(videoId, id);
        return true;
      })) !== null,
  };
}
