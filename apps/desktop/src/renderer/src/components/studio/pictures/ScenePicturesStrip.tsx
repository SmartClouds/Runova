import { mediaUrl, type Scene, scenePictures } from '@runova/studio';
import { Camera, cn, FileText, Sparkles } from '../kit';

const ICON = { screenshot: Camera, generate: Sparkles, file: FileText } as const;

/**
 * A scene's pictures in one line above its animation, so the scenario shows what the animator
 * will get. A click opens the scene in the Pictures tab.
 */
export function ScenePicturesStrip({
  videoId,
  scene,
  index,
  aspect,
  onOpen,
}: {
  videoId: string;
  scene: Scene;
  index: number;
  aspect: string;
  onOpen: () => void;
}): React.JSX.Element | null {
  const pictures = scenePictures(scene);
  if (pictures.length === 0) return null;
  const ready = pictures.filter((p) => p.status === 'ready').length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      aria-label={`Scene ${index + 1} pictures: ${ready} of ${pictures.length} ready. Open them.`}
    >
      <span className="flex gap-1">
        {pictures.map((p) => {
          const Icon = ICON[p.source];
          return (
            <span
              key={p.id}
              className={cn(
                'relative h-8 overflow-hidden rounded bg-foreground/[0.05]',
                p.status !== 'ready' &&
                  'outline-dashed outline-1 -outline-offset-1 outline-foreground/20',
                p.status === 'failed' && 'outline-destructive/60',
              )}
              style={{ aspectRatio: aspect }}
            >
              {p.status === 'ready' && p.mediaHash ? (
                <img
                  src={mediaUrl(videoId, p.mediaHash, 'original')}
                  alt=""
                  className="h-full w-full object-cover object-top"
                />
              ) : (
                <Icon
                  className="absolute inset-0 m-auto h-3 w-3 text-muted-foreground"
                  aria-hidden
                />
              )}
            </span>
          );
        })}
      </span>
      <span className="text-xs text-muted-foreground">
        {ready === pictures.length
          ? `${pictures.length} ${pictures.length === 1 ? 'picture' : 'pictures'} for the animator`
          : `${ready} of ${pictures.length} pictures ready`}
      </span>
    </button>
  );
}
