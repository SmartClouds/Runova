import type { ScenePicture } from '@runova/studio';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { studioPicturesClient } from '../client';
import { DIALOG_BODY } from '../format';
import {
  Button,
  Camera,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Monitor,
  RefreshCw,
  Skeleton,
} from '../kit';
import { studioKeys } from '../queryKeys';
import type { PicturesState } from './usePictures';

export interface WindowCaptureDialogProps {
  /** The window shots to take, in order; the dialog walks through them. */
  shots: ScenePicture[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pictures: PicturesState;
}

const COUNTDOWN = 3;

/**
 * Guided capture for a desktop app, which has no address to open: the user brings the app to the
 * screen a shot asks for, picks its window, and Studio takes it after a short countdown that
 * gives them time to let go of the mouse. It then moves on to the next shot.
 */
export function WindowCaptureDialog({
  shots,
  open,
  onOpenChange,
  pictures,
}: WindowCaptureDialogProps): React.JSX.Element {
  const [at, setAt] = useState(0);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const windows = useQuery({
    queryKey: studioKeys.captureWindows,
    queryFn: () => studioPicturesClient().windows(),
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (open) setAt(0);
    else setCount(null);
  }, [open]);

  const shot = shots[at];
  const next = () => {
    if (at + 1 >= shots.length) onOpenChange(false);
    else setAt(at + 1);
  };

  // The countdown: a second a step, then the picture.
  const { captureWindow } = pictures;
  useEffect(() => {
    if (count === null || !shot || !sourceId) return;
    if (count > 0) {
      const tick = setTimeout(() => setCount(count - 1), 1000);
      return () => clearTimeout(tick);
    }
    setCount(null);
    void captureWindow(shot.id, sourceId).then(() => {
      if (at + 1 >= shots.length) onOpenChange(false);
      else setAt(at + 1);
    });
  }, [count, shot, sourceId, captureWindow, at, shots.length, onOpenChange]);

  const start = () => {
    if (shot && sourceId) setCount(COUNTDOWN);
  };

  const instructions = shot?.shot?.target === 'window' ? shot.shot.instructions : '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Capture the app window{shots.length > 1 ? ` (${at + 1} of ${shots.length})` : ''}
          </DialogTitle>
          <DialogDescription>
            Bring your app to the screen below, pick its window, and Studio takes it.
          </DialogDescription>
        </DialogHeader>
        <div className={cn(DIALOG_BODY, 'space-y-3')}>
          {shot && (
            <div className="rounded-xl bg-primary/8 p-3 ring-1 ring-inset ring-primary/25">
              <p className="text-sm font-medium">{instructions || shot.purpose}</p>
              {instructions && (
                <p className="mt-1 text-xs text-muted-foreground">For: {shot.purpose}</p>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Which window</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void windows.refetch()}
              disabled={windows.isFetching}
            >
              <RefreshCw className={cn(windows.isFetching && 'animate-spin')} /> Refresh
            </Button>
          </div>
          {windows.isLoading ? (
            <div className="grid grid-cols-3 gap-2">
              <Skeleton className="aspect-video" />
              <Skeleton className="aspect-video" />
              <Skeleton className="aspect-video" />
            </div>
          ) : (windows.data ?? []).length === 0 ? (
            <EmptyState
              icon={Monitor}
              title="No windows to capture"
              description="Open your app, then refresh."
            />
          ) : (
            <div
              className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3"
              role="radiogroup"
              aria-label="Window to capture"
            >
              {(windows.data ?? []).map((win) => (
                <button
                  key={win.id}
                  type="button"
                  role="radio"
                  aria-checked={sourceId === win.id}
                  onClick={() => setSourceId(win.id)}
                  className={cn(
                    'flex flex-col gap-1 rounded-lg p-1.5 text-left ring-1 ring-inset ring-foreground/[0.08] transition hover:bg-foreground/[0.04]',
                    sourceId === win.id && 'bg-primary/8 ring-2 ring-primary',
                  )}
                >
                  <img
                    src={win.thumbnail}
                    alt=""
                    className="aspect-video w-full rounded object-contain bg-black/40"
                  />
                  <span className="truncate text-[11px]">{win.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={next} disabled={count !== null}>
            Skip
          </Button>
          <Button
            onClick={start}
            disabled={!sourceId || count !== null || pictures.pending?.startsWith('window-')}
            aria-live="polite"
          >
            <Camera />
            {count !== null ? `Capturing in ${count}...` : `Capture in ${COUNTDOWN} s`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
