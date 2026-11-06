import {
  type EditOp,
  mediaUrl,
  type PictureSource,
  removePictureOp,
  type Scene,
  type ScenePicture,
  type Shot,
  updatePictureOp,
} from '@runova/studio';
import { useEffect, useId, useState } from 'react';
import { scriptClass } from '../format';
import {
  Button,
  Camera,
  Chip,
  type ChipTone,
  cn,
  FileText,
  Globe,
  ImageIcon,
  Input,
  Label,
  Monitor,
  Notice,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SEGMENT_TRACK,
  Sparkles,
  Spinner,
  segmentClass,
  Textarea,
  Trash2,
  Upload,
} from '../kit';
import type { PicturesState } from './usePictures';

export interface PictureTileProps {
  videoId: string;
  scene: Scene;
  picture: ScenePicture;
  /** The video's shape, as `16 / 9`. */
  aspect: string;
  /** A project is linked, so screenshots can be taken. */
  canCapture: boolean;
  /** What makes AI pictures ("GPT Image"), or null when that is off or has no key. */
  imageModel: string | null;
  /** This picture is being captured now. */
  capturing: boolean;
  pictures: PicturesState;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  /** Starts a guided window capture for this picture. */
  onCaptureWindow: (picture: ScenePicture) => void;
}

const SOURCE_ICON: Record<PictureSource, typeof Camera> = {
  screenshot: Camera,
  generate: Sparkles,
  file: FileText,
};

function sourceLabel(source: PictureSource, imageModel: string | null): string {
  if (source === 'screenshot') return 'Screenshot';
  if (source === 'generate') return imageModel ?? 'AI picture';
  return 'Your file';
}

function statusOf(
  picture: ScenePicture,
  capturing: boolean,
): { label: string; tone: ChipTone; busy: boolean } {
  if (capturing) return { label: 'Capturing', tone: 'primary', busy: true };
  if (picture.genJobId) return { label: 'Making', tone: 'primary', busy: true };
  if (picture.status === 'ready') return { label: 'Ready', tone: 'success', busy: false };
  if (picture.status === 'failed') return { label: 'Failed', tone: 'destructive', busy: false };
  return { label: 'To do', tone: 'neutral', busy: false };
}

/** What a picture says it needs, for the tile's caption. */
function brief(picture: ScenePicture): string {
  if (picture.shot?.target === 'route') return picture.shot.path || '/';
  if (picture.shot?.target === 'window') return 'App window';
  return picture.fileName;
}

/**
 * One picture of a scene as a tile at the video's shape: its picture once ready, or how it will
 * be made. Clicking it opens everything about it: what it is for, where it comes from, and the
 * ways to make it, change it or let it go.
 */
export function PictureTile(props: PictureTileProps): React.JSX.Element {
  const { picture, videoId, capturing, imageModel } = props;
  const status = statusOf(picture, capturing);
  const Icon = SOURCE_ICON[picture.source];
  const ready = picture.status === 'ready' && picture.mediaHash;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group flex w-44 flex-col gap-1.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={`Picture ${picture.fileName}: ${status.label}. ${picture.purpose}`}
        >
          <span
            className={cn(
              'relative block w-full overflow-hidden rounded-lg bg-foreground/[0.04] transition-shadow group-hover:shadow-md',
              !ready && 'outline-dashed outline-2 -outline-offset-2 outline-foreground/15',
              picture.status === 'failed' && 'outline-destructive/50',
            )}
            style={{ aspectRatio: props.aspect }}
          >
            {ready ? (
              <img
                src={mediaUrl(videoId, picture.mediaHash as string, 'original')}
                alt=""
                className="h-full w-full object-cover object-top"
                draggable={false}
              />
            ) : (
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center text-muted-foreground">
                {status.busy ? (
                  <Spinner className="h-4 w-4 animate-spin text-primary" aria-hidden />
                ) : (
                  <Icon className="h-4 w-4" aria-hidden />
                )}
                <span className="line-clamp-2 text-[11px] leading-tight">
                  {picture.purpose || brief(picture)}
                </span>
              </span>
            )}
            <span className="absolute left-1.5 top-1.5 flex gap-1">
              <Chip tone={status.tone} dot={status.busy} pulse={status.busy}>
                {status.label}
              </Chip>
            </span>
          </span>
          <span className="flex items-center gap-1 px-0.5 text-[11px] text-muted-foreground">
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{sourceLabel(picture.source, imageModel)}</span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono">{brief(picture)}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
        collisionPadding={16}
      >
        <PictureEditor {...props} />
      </PopoverContent>
    </Popover>
  );
}

function Segments<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly { value: T; label: string; disabled?: boolean; hint?: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className={SEGMENT_TRACK} role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={value === choice.value}
          disabled={choice.disabled}
          title={choice.hint}
          className={cn(segmentClass(value === choice.value), choice.disabled && 'opacity-50')}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

function PictureEditor({
  videoId,
  scene,
  picture,
  aspect,
  canCapture,
  imageModel,
  capturing,
  pictures,
  apply,
  onCaptureWindow,
}: PictureTileProps): React.JSX.Element {
  const id = useId();
  const [purpose, setPurpose] = useState(picture.purpose);
  const [prompt, setPrompt] = useState(picture.prompt ?? '');
  const [path, setPath] = useState(picture.shot?.target === 'route' ? picture.shot.path : '');
  const [waitFor, setWaitFor] = useState(
    picture.shot?.target === 'route' ? (picture.shot.waitFor ?? '') : '',
  );
  const [instructions, setInstructions] = useState(
    picture.shot?.target === 'window' ? picture.shot.instructions : '',
  );
  useEffect(() => setPurpose(picture.purpose), [picture.purpose]);
  useEffect(() => setPrompt(picture.prompt ?? ''), [picture.prompt]);

  const change = (patch: Partial<Omit<ScenePicture, 'id'>>, label: string) =>
    apply([updatePictureOp(scene, picture.id, patch)], label);
  const shot = picture.shot;
  const route = shot?.target === 'route' ? shot : null;
  const setShot = (next: Shot, label: string) => change({ shot: next }, label);
  const busy = capturing || !!picture.genJobId;
  const ready = picture.status === 'ready' && picture.mediaHash;
  const filePending = pictures.pending === `file-${picture.id}`;

  const switchSource = (source: PictureSource) => {
    if (source === picture.source) return;
    void change(
      {
        source,
        status: 'planned',
        mediaHash: null,
        error: null,
        genJobId: null,
        ...(source === 'screenshot' && !shot
          ? { shot: { target: 'route', path: '/', viewport: 'desktop' } as Shot }
          : {}),
        ...(source !== 'screenshot' && !picture.prompt ? { prompt: picture.purpose } : {}),
      },
      `Picture ${picture.fileName} is now ${sourceLabel(source, imageModel).toLowerCase()}`,
    );
  };

  return (
    <div className="flex max-h-[min(80vh,40rem)] flex-col">
      {ready && (
        <img
          src={mediaUrl(videoId, picture.mediaHash as string, 'original')}
          alt={picture.purpose}
          className="w-full rounded-t-[inherit] bg-black/60 object-contain"
          style={{ aspectRatio: aspect, maxHeight: '14rem' }}
        />
      )}
      <div className="space-y-3 overflow-y-auto p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-mono text-xs text-muted-foreground">{picture.fileName}</p>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove picture ${picture.fileName}`}
            onClick={() =>
              void apply(
                [removePictureOp(scene, picture.id)],
                `Removed picture ${picture.fileName}`,
              )
            }
          >
            <Trash2 />
          </Button>
        </div>

        {picture.status === 'failed' && picture.error && (
          <Notice tone="destructive" size="sm">
            {picture.error}
          </Notice>
        )}

        <div className="space-y-1">
          <Label htmlFor={`${id}-purpose`}>What it shows</Label>
          <Textarea
            id={`${id}-purpose`}
            value={purpose}
            dir="auto"
            rows={2}
            className={cn('min-h-0 text-sm', scriptClass(purpose))}
            onChange={(event) => setPurpose(event.target.value)}
            onBlur={() => {
              const next = purpose.trim();
              if (next && next !== picture.purpose)
                void change({ purpose: next }, `Described picture ${picture.fileName}`);
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            The animator reads this to know what to point at.
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium">Where it comes from</span>
          <Segments
            label="Where the picture comes from"
            value={picture.source}
            onChange={switchSource}
            choices={[
              {
                value: 'screenshot',
                label: 'Screenshot',
                disabled: !canCapture,
                hint: canCapture ? undefined : 'Link the video to a project to take screenshots.',
              },
              { value: 'generate', label: imageModel ?? 'AI picture' },
              { value: 'file', label: 'Your file' },
            ]}
          />
        </div>

        {picture.source === 'screenshot' && (
          <div className="space-y-2.5">
            <Segments
              label="What to capture"
              value={shot?.target ?? 'route'}
              onChange={(target) =>
                void setShot(
                  target === 'route'
                    ? { target: 'route', path: path || '/', viewport: 'desktop' }
                    : { target: 'window', instructions: instructions || picture.purpose },
                  `Picture ${picture.fileName} captures ${target === 'route' ? 'a page' : 'a window'}`,
                )
              }
              choices={[
                { value: 'route', label: 'A page of the app' },
                { value: 'window', label: 'An app window' },
              ]}
            />
            {route ? (
              <>
                <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-path`}>Page</Label>
                    <Input
                      id={`${id}-path`}
                      value={path}
                      placeholder="/settings"
                      className="h-8 font-mono text-xs"
                      onChange={(event) => setPath(event.target.value)}
                      onBlur={() => {
                        if (path !== route.path)
                          void setShot(
                            { ...route, path: path.trim() },
                            `Changed the page of ${picture.fileName}`,
                          );
                      }}
                    />
                  </div>
                  <Segments
                    label="Screen size"
                    value={route.viewport}
                    onChange={(viewport) =>
                      void setShot(
                        { ...route, viewport },
                        `Changed the screen size of ${picture.fileName}`,
                      )
                    }
                    choices={[
                      { value: 'desktop', label: 'Desktop' },
                      { value: 'mobile', label: 'Phone' },
                    ]}
                  />
                </div>
                <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-wait`}>Wait for (optional)</Label>
                    <Input
                      id={`${id}-wait`}
                      value={waitFor}
                      placeholder="#settings-form"
                      className="h-8 font-mono text-xs"
                      onChange={(event) => setWaitFor(event.target.value)}
                      onBlur={() => {
                        const next = waitFor.trim() || undefined;
                        if (next !== route.waitFor)
                          void setShot(
                            { ...route, waitFor: next },
                            `Changed what ${picture.fileName} waits for`,
                          );
                      }}
                    />
                  </div>
                  <Segments
                    label="Theme"
                    value={route.theme ?? 'auto'}
                    onChange={(theme) =>
                      void setShot(
                        { ...route, theme: theme === 'auto' ? undefined : theme },
                        `Changed the theme of ${picture.fileName}`,
                      )
                    }
                    choices={[
                      { value: 'auto', label: 'Auto' },
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                    ]}
                  />
                </div>
                {route.steps && route.steps.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-xs font-medium">Before the picture</span>
                    <ol className="list-decimal space-y-0.5 pl-5 font-mono text-[11px] text-muted-foreground">
                      {route.steps.map((step, at) => (
                        <li key={at}>
                          {step.do === 'wait'
                            ? `wait ${step.ms} ms`
                            : step.do === 'scroll'
                              ? `scroll ${step.selector ?? 'page'} to ${step.y}`
                              : `${step.do} ${step.selector}${step.do === 'type' ? ` "${step.text}"` : ''}`}
                        </li>
                      ))}
                    </ol>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void setShot(
                          { ...route, steps: [] },
                          `Cleared the steps of ${picture.fileName}`,
                        )
                      }
                    >
                      Clear the steps
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-1">
                <Label htmlFor={`${id}-steps`}>How to get to this screen</Label>
                <Textarea
                  id={`${id}-steps`}
                  value={instructions}
                  rows={2}
                  className="min-h-0 text-sm"
                  onChange={(event) => setInstructions(event.target.value)}
                  onBlur={() => {
                    if (shot?.target === 'window' && instructions.trim() !== shot.instructions)
                      void setShot(
                        { target: 'window', instructions: instructions.trim() },
                        `Changed how to reach ${picture.fileName}`,
                      );
                  }}
                />
              </div>
            )}
          </div>
        )}

        {picture.source !== 'screenshot' && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-prompt`}>
              {picture.source === 'generate' ? 'Prompt' : 'What to make (also in PICTURES.md)'}
            </Label>
            <Textarea
              id={`${id}-prompt`}
              value={prompt}
              dir="auto"
              rows={4}
              className={cn('min-h-0 text-sm', scriptClass(prompt))}
              onChange={(event) => setPrompt(event.target.value)}
              onBlur={() => {
                const next = prompt.trim();
                if (next !== (picture.prompt ?? ''))
                  void change({ prompt: next }, `Changed the prompt of ${picture.fileName}`);
              }}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {picture.source === 'screenshot' && route && (
            <Button
              size="sm"
              disabled={busy || !canCapture || pictures.view?.job?.running}
              onClick={() => void pictures.capture([picture.id])}
            >
              {capturing ? <Spinner className="animate-spin" /> : <Globe />}
              {capturing ? 'Capturing...' : ready ? 'Capture again' : 'Capture'}
            </Button>
          )}
          {picture.source === 'screenshot' && shot?.target === 'window' && (
            <Button size="sm" disabled={busy} onClick={() => onCaptureWindow(picture)}>
              <Monitor /> {ready ? 'Capture again' : 'Capture the window'}
            </Button>
          )}
          {picture.source === 'generate' && (
            <Button
              size="sm"
              disabled={busy || !imageModel}
              title={
                imageModel ? undefined : 'Turn on picture making in Settings > Agents > Studio.'
              }
              onClick={() => void pictures.generate([picture.id])}
            >
              {picture.genJobId ? <Spinner className="animate-spin" /> : <Sparkles />}
              {picture.genJobId
                ? 'Making...'
                : ready
                  ? 'Make again'
                  : `Make with ${imageModel ?? 'AI'}`}
            </Button>
          )}
          <Button
            size="sm"
            variant={picture.source === 'file' ? 'default' : 'soft'}
            disabled={busy || filePending}
            onClick={() => void pictures.pickFile(picture.id)}
          >
            {filePending ? <Spinner className="animate-spin" /> : <Upload />}
            {picture.source === 'file' ? 'Choose a picture' : 'Use a file instead'}
          </Button>
        </div>
        {!ready && picture.source !== 'screenshot' && (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <ImageIcon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            Or save it as {picture.fileName} in the pictures folder; it is picked up by itself.
          </p>
        )}
      </div>
    </div>
  );
}
