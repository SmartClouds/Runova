import {
  DESIGN_SIZES,
  type EditOp,
  pictureCounts,
  type ScenePicture,
  type StudioDocument,
  scenePictures,
} from '@runova/studio';
import { useState } from 'react';
import { runLabel } from '../ai/runSettings';
import { scriptClass } from '../format';
import {
  Button,
  Camera,
  ChevronDown,
  Chip,
  cn,
  EmptyState,
  FileText,
  FolderOpen,
  GLASS_CARD,
  ImageIcon,
  Input,
  Monitor,
  Notice,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RefreshCw,
  type RunSettings,
  RunSettingsFields,
  Skeleton,
  Sparkles,
  Spinner,
  StopCircle,
  Wand2,
} from '../kit';
import { AppCard } from './AppCard';
import { PictureTile } from './PictureTile';
import type { PicturesState } from './usePictures';
import { WindowCaptureDialog } from './WindowCaptureDialog';

export interface PicturesViewProps {
  videoId: string;
  document: StudioDocument;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  pictures: PicturesState;
  /** An AI run is working on the video. */
  busy: boolean;
  /** The Pictures run is the one working. */
  planning: boolean;
  run: RunSettings;
  onRunChange: (run: RunSettings) => void;
  /** Starts the AI run that plans the pictures; resolves true once it started. */
  onPlan: (instruction?: string) => Promise<boolean>;
  onOpenSettings: (tab: 'agents' | 'ai') => void;
}

/**
 * The Pictures step: what each scene shows besides drawn graphics, and getting it. The AI plans
 * the pictures from the scenario (reading the linked project for its real screens), then each one
 * is captured from the running app, made by the image model, or made by the user from the prompts
 * in PICTURES.md. Every ready picture goes into its scene's files for the animator.
 */
export function PicturesView({
  videoId,
  document,
  apply,
  pictures,
  busy,
  planning,
  run,
  onRunChange,
  onPlan,
  onOpenSettings,
}: PicturesViewProps): React.JSX.Element {
  const [instruction, setInstruction] = useState('');
  const [windowShots, setWindowShots] = useState<ScenePicture[] | null>(null);
  const counts = pictureCounts(document);
  const view = pictures.view;
  const size = DESIGN_SIZES[document.renderSettings.aspect];
  const aspect = `${size.width} / ${size.height}`;
  const hasScenes = document.scenario.scenes.length > 0;
  const canCapture = !!view?.app.project;
  const imageModel = view?.engineReady ? view.engineLabel : null;
  const job = view?.job;
  const capturingId = job?.running ? job.current?.pictureId : undefined;
  const pendingWindows = document.scenario.scenes.flatMap((s) =>
    scenePictures(s).filter(
      (p) => p.status !== 'ready' && p.source === 'screenshot' && p.shot?.target === 'window',
    ),
  );

  if (!hasScenes) {
    return (
      <EmptyState
        card
        icon={ImageIcon}
        title="Write the scenario first"
        description="Pictures are planned scene by scene, once the video has scenes."
      />
    );
  }

  const picker = (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="max-w-[14rem]">
          <span className="truncate">{runLabel(run)}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] max-w-[calc(100vw-2rem)] space-y-2 p-3">
        <p className="text-xs text-muted-foreground">Which AI plans the pictures</p>
        <RunSettingsFields value={run} onChange={onRunChange} />
      </PopoverContent>
    </Popover>
  );

  const plan = (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        void onPlan(instruction.trim() || undefined).then((started) => {
          if (started) setInstruction('');
        });
      }}
    >
      <Input
        aria-label="Anything particular to show (optional)"
        value={instruction}
        dir="auto"
        className={cn('h-8 min-w-[14rem] flex-1', scriptClass(instruction))}
        placeholder="Anything particular to show? (optional)"
        onChange={(event) => setInstruction(event.target.value)}
      />
      {picker}
      <Button
        type="submit"
        size="sm"
        variant={counts.total === 0 ? 'default' : 'soft'}
        disabled={busy}
      >
        {planning ? <Spinner className="animate-spin" /> : <Wand2 />}
        {planning ? 'Planning...' : counts.total === 0 ? 'Plan pictures with AI' : 'Plan again'}
      </Button>
    </form>
  );

  return (
    <div className="space-y-2">
      <section className={cn(GLASS_CARD, 'space-y-3 p-3')} aria-label="Pictures">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Pictures</h2>
          {counts.total > 0 && (
            <Chip tone={counts.ready === counts.total ? 'success' : 'neutral'}>
              {counts.ready} of {counts.total} ready
            </Chip>
          )}
          {counts.failed > 0 && <Chip tone="destructive">{counts.failed} failed</Chip>}
        </div>
        <p className="text-xs text-muted-foreground">
          {canCapture
            ? `The AI reads ${view?.app.project?.name ?? 'the project'} to pick its real screens, Studio captures them from the running app, and the animator builds each scene around its pictures.`
            : 'The AI plans a picture for each scene that needs one. This video has no project, so pictures come from the image model or from your own files.'}
        </p>
        {plan}
        {counts.total > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {counts.routeShots > 0 && canCapture && (
              <Button
                size="sm"
                disabled={!!job?.running || pictures.pending === 'capture'}
                onClick={() => void pictures.capture()}
              >
                <Camera /> Capture {counts.routeShots}{' '}
                {counts.routeShots === 1 ? 'screenshot' : 'screenshots'}
              </Button>
            )}
            {counts.windowShots > 0 && canCapture && (
              <Button size="sm" variant="soft" onClick={() => setWindowShots(pendingWindows)}>
                <Monitor /> Capture {counts.windowShots} app{' '}
                {counts.windowShots === 1 ? 'window' : 'windows'}
              </Button>
            )}
            {counts.generate > 0 && imageModel && (
              <Button
                size="sm"
                variant="soft"
                disabled={pictures.pending === 'generate'}
                onClick={() => void pictures.generate()}
              >
                <Sparkles /> Make {counts.generate} with {imageModel}
              </Button>
            )}
            {counts.ready < counts.total && (
              <Button
                size="sm"
                variant="soft"
                disabled={pictures.pending === 'markdown'}
                onClick={() => void pictures.writeMarkdown()}
              >
                <FileText /> Write PICTURES.md
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void pictures.openFolder()}>
              <FolderOpen /> Pictures folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pictures.pending === 'folder'}
              onClick={() => void pictures.checkFolder()}
            >
              <RefreshCw className={cn(pictures.pending === 'folder' && 'animate-spin')} /> Check
              the folder
            </Button>
          </div>
        )}
        {counts.generate > 0 && view && !imageModel && (
          <Notice
            tone="neutral"
            size="sm"
            action={
              <Button
                size="xs"
                variant="soft"
                onClick={() => onOpenSettings(view.engine === 'off' ? 'agents' : 'ai')}
              >
                {view.engine === 'off' ? 'Open Studio settings' : 'Add the key'}
              </Button>
            }
          >
            {view.engine === 'off'
              ? `Picture making is off, so ${counts.generate === 1 ? 'the AI picture is' : `${counts.generate} AI pictures are`} left for you: write PICTURES.md and paste its prompts into any image tool, or turn on GPT Image in Settings.`
              : `${view.engineLabel ?? 'The image model'} needs its API key in Settings > AI before it can make pictures. Until then, PICTURES.md has the prompts.`}
          </Notice>
        )}
        {job?.running && (
          <div
            className="flex items-center gap-2 rounded-lg bg-primary/8 px-2.5 py-1.5 text-xs"
            role="status"
            aria-live="polite"
          >
            <Spinner className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
            <span>
              {view?.app.status === 'starting'
                ? 'Starting the app...'
                : `Capturing ${Math.min(job.done + 1, job.total)} of ${job.total}${job.current ? `: ${job.current.label}` : ''}`}
            </span>
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={() => void pictures.cancelCapture()}
            >
              <StopCircle /> Cancel
            </Button>
          </div>
        )}
        {job && !job.running && job.failed > 0 && (
          <Notice tone="warning" size="sm">
            {job.failed} of {job.total} screenshots did not work. Open a failed picture to see why,
            fix its page or steps, and capture it again.
          </Notice>
        )}
      </section>

      {view ? <AppCard app={view.app} pictures={pictures} /> : <Skeleton className="h-24 w-full" />}

      <div className="space-y-2">
        {document.scenario.scenes.map((scene, index) => {
          const list = scenePictures(scene);
          return (
            <section
              key={scene.id}
              id={`pictures-${scene.id}`}
              className={cn(GLASS_CARD, 'scroll-mt-4 space-y-2 p-3')}
              aria-label={`Scene ${index + 1} pictures`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <h3
                  className={cn('truncate text-sm font-medium', scriptClass(scene.title))}
                  dir="auto"
                >
                  {scene.title || 'Untitled scene'}
                </h3>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {list.length === 0
                    ? 'No pictures, drawn graphics only'
                    : `${list.filter((p) => p.status === 'ready').length} of ${list.length} ready`}
                </span>
              </div>
              {list.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {list.map((picture) => (
                    <PictureTile
                      key={picture.id}
                      videoId={videoId}
                      scene={scene}
                      picture={picture}
                      aspect={aspect}
                      canCapture={canCapture}
                      imageModel={imageModel}
                      capturing={capturingId === picture.id}
                      pictures={pictures}
                      apply={apply}
                      onCaptureWindow={(p) => setWindowShots([p])}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <WindowCaptureDialog
        shots={windowShots ?? []}
        open={windowShots !== null && windowShots.length > 0}
        onOpenChange={(open) => !open && setWindowShots(null)}
        pictures={pictures}
      />
    </div>
  );
}
