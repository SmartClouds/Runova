import { formatUsd, type PicturesView } from '@runova/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { studioPicturesClient } from '../client';
import { errorMessage } from '../format';
import { confirmDialog, toast } from '../kit';
import { studioKeys } from '../queryKeys';

/**
 * The Pictures step as the editor uses it: the project's app, the capture going on, and the
 * actions that make pictures. Every action reports its own failure as a toast, and the state
 * comes back through `pictures-changed` events, so nothing here waits on a long job.
 */
export function usePictures(videoId: string) {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: studioKeys.pictures(videoId),
    queryFn: () => studioPicturesClient().view(videoId),
  });
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: studioKeys.pictures(videoId) }),
    [queryClient, videoId],
  );

  /** Runs one action with its name as the busy marker, so its button can show it is working. */
  const act = useCallback(
    async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setPending(name);
      try {
        return await fn();
      } catch (error) {
        toast.error(errorMessage(error));
        return undefined;
      } finally {
        setPending(null);
        void refresh();
      }
    },
    [refresh],
  );

  const client = studioPicturesClient();
  return {
    view: view.data as PicturesView | undefined,
    loading: view.isLoading,
    pending,
    setApp: (patch: { runCommandId?: string | null; url?: string | null }) =>
      act('app', () => client.setApp({ videoId, ...patch })),
    startApp: () => act('start', () => client.startApp(videoId)),
    stopApp: () => act('stop', () => client.stopApp(videoId)),
    signIn: () => act('sign-in', () => client.signIn(videoId)),
    capture: (pictureIds?: string[]) => act('capture', () => client.capture(videoId, pictureIds)),
    cancelCapture: () => act('cancel', () => client.cancelCapture(videoId)),
    /** Shows the whole price, and sends the pictures only once the user agrees to it. */
    generate: (pictureIds?: string[]) =>
      act('generate', async () => {
        const price = await client.estimate(videoId, pictureIds);
        if (price.count === 0) {
          toast.info('There are no pictures left to make.');
          return false;
        }
        const ok = await confirmDialog({
          title: `Make ${price.count === 1 ? 'this picture' : `${price.count} pictures`} with ${price.label}?`,
          description: `This bills your ${price.provider} account about ${formatUsd(price.usd)}. ${price.basis}`,
          confirmLabel: price.count === 1 ? 'Make it' : `Make ${price.count}`,
        });
        if (!ok) return false;
        await client.generate(videoId, price.usd, pictureIds);
        toast.success(
          `${price.label} is making ${price.count === 1 ? 'the picture' : `${price.count} pictures`}. Each one lands on its scene when it is ready.`,
        );
        return true;
      }),
    writeMarkdown: () =>
      act('markdown', async () => {
        const result = await client.writeMarkdown(videoId);
        toast.success('PICTURES.md is ready in the pictures folder.', {
          action: { label: 'Open folder', onClick: () => void client.openFolder(videoId) },
        });
        return result;
      }),
    checkFolder: () =>
      act('folder', async () => {
        const result = await client.checkFolder(videoId);
        if (result.filled > 0) {
          toast.success(
            `${result.filled} ${result.filled === 1 ? 'picture' : 'pictures'} added from the folder.`,
          );
        } else if (result.unknown.length > 0) {
          toast.info(
            `No file matched a picture's name. Rename one of these to a name in PICTURES.md: ${result.unknown.slice(0, 3).join(', ')}.`,
          );
        } else {
          toast.info('Nothing new in the pictures folder yet.');
        }
        return result;
      }),
    openFolder: () => act('open-folder', () => client.openFolder(videoId)),
    pickFile: (pictureId: string) =>
      act(`file-${pictureId}`, () => client.pickFile(videoId, pictureId)),
    setFile: (pictureId: string, path: string) =>
      act(`file-${pictureId}`, () => client.setFile(videoId, pictureId, path)),
    captureWindow: (pictureId: string, sourceId: string) =>
      act(`window-${pictureId}`, () => client.captureWindow(videoId, pictureId, sourceId)),
  };
}

export type PicturesState = ReturnType<typeof usePictures>;
