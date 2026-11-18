import {
  DESIGN_SIZES,
  flicksToSeconds,
  type Scene,
  type SceneBasisField,
  type SceneCheckView,
  type StudioDocument,
  sceneBasisChanges,
  sceneConfig,
  sceneUrl,
} from '@runova/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { runLabel } from '../ai/runSettings';
import { studioScenesClient } from '../client';
import { errorMessage, scriptClass } from '../format';
import {
  Button,
  ChevronDown,
  Chip,
  Code,
  cn,
  ImageIcon,
  Input,
  Notice,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RefreshCw,
  type RunSettings,
  RunSettingsFields,
  SimpleTooltip,
  Wand2,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { ScenePreview } from './ScenePreview';

export interface SceneMotionProps {
  videoId: string;
  document: StudioDocument;
  scene: Scene;
  index: number;
  /** An AI run is working on the video. */
  busy: boolean;
  run: RunSettings;
  onRunChange: (run: RunSettings) => void;
  /** Starts an AI run on this scene's code; resolves true once it started. */
  onAnimate: (instruction?: string) => Promise<boolean>;
  onOpenCode: () => void;
}

/** The scene card's own names for the fields an animation is made from. */
const FIELD_LABELS: Record<SceneBasisField, string> = {
  title: 'Title',
  narration: 'Narration',
  onScreenText: 'On screen',
  visualBrief: 'What the viewer sees',
  length: 'Length',
  pictures: 'Pictures',
};

/** "Narration", "Narration and Length", "Title, Narration and Length". */
function listed(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The motion graphics of one scene: its thumbnail and preview once it has code, and the ways to
 * get or change that code (animate with AI, ask for a change, open the code).
 */
export function SceneMotion({
  videoId,
  document,
  scene,
  index,
  busy,
  run,
  onRunChange,
  onAnimate,
  onOpenCode,
}: SceneMotionProps): React.JSX.Element {
  const treeHash = scene.code.treeHash;
  const [previewing, setPreviewing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [instruction, setInstruction] = useState('');
  // A check speaks for the code it ran on, so a new animation starts without one.
  const [checked, setChecked] = useState<{
    treeHash: string;
    result: SceneCheckView | null;
    error: string | null;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const check = checked?.treeHash === treeHash ? checked.result : null;
  const checkError = checked?.treeHash === treeHash ? checked.error : null;
  const number = index + 1;
  const queryClient = useQueryClient();
  const changesId = useId();
  const changed = sceneBasisChanges(scene);

  const thumbnail = useQuery({
    queryKey: studioKeys.thumbnail(videoId, treeHash),
    queryFn: () => studioScenesClient().thumbnail(videoId, treeHash as string),
    enabled: treeHash !== null,
  });

  const size = DESIGN_SIZES[document.renderSettings.aspect];
  const picker = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="max-w-[14rem]"
          aria-label={`AI for scene animations: ${runLabel(run)}`}
        >
          <span className="truncate">{runLabel(run)}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] max-w-[calc(100vw-2rem)] space-y-2 p-3">
        <p className="text-xs text-muted-foreground">Which AI animates the scenes</p>
        <RunSettingsFields value={run} onChange={onRunChange} />
      </PopoverContent>
    </Popover>
  );

  if (!treeHash) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.03] px-2.5 py-2">
        <ImageIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-xs text-muted-foreground">No animation yet.</span>
        <Button
          size="xs"
          className="ml-auto"
          disabled={busy}
          onClick={() => void onAnimate()}
          aria-label={`Animate scene ${number} with AI`}
        >
          <Wand2 /> {busy ? 'AI is busy' : 'Animate with AI'}
        </Button>
        {picker}
      </div>
    );
  }

  const runCheck = async () => {
    setChecking(true);
    setChecked(null);
    try {
      const result = await studioScenesClient().check(videoId, scene.id);
      setChecked({ treeHash, result, error: null });
      // A check makes a fresh thumbnail.
      void queryClient.invalidateQueries({ queryKey: studioKeys.thumbnail(videoId, treeHash) });
    } catch (error) {
      setChecked({ treeHash, result: null, error: errorMessage(error) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg bg-foreground/[0.03] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="relative h-12 overflow-hidden rounded-md bg-black/70"
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
        >
          {thumbnail.data ? (
            <img
              src={thumbnail.data}
              alt={`Scene ${number} animation`}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon className="absolute inset-0 m-auto h-4 w-4 text-white/50" aria-hidden />
          )}
        </div>
        <Button
          size="xs"
          variant={previewing ? 'tint' : 'ghost'}
          aria-pressed={previewing}
          onClick={() => setPreviewing((v) => !v)}
        >
          {previewing ? 'Hide preview' : 'Preview'}
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setChanging((v) => !v)}>
          <Wand2 /> Change
        </Button>
        <SimpleTooltip label="Make a new animation from the scene as it is now. The current one stays in the code's earlier versions.">
          <Button
            size="xs"
            // Tinted once the scene changed, so the way to catch the animation up stands out.
            variant={changed.length > 0 ? 'tint' : 'ghost'}
            disabled={busy}
            aria-label={`Animate scene ${number} again`}
            aria-describedby={changed.length > 0 ? changesId : undefined}
            onClick={() => void onAnimate()}
          >
            <RefreshCw /> Animate again
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Open the scene's code">
          <Button size="xs" variant="ghost" onClick={onOpenCode}>
            <Code /> Code
          </Button>
        </SimpleTooltip>
        <Button size="xs" variant="ghost" disabled={checking} onClick={() => void runCheck()}>
          {checking ? 'Checking...' : 'Check'}
        </Button>
        {check?.ok && <Chip tone="success">Checks pass</Chip>}
        <div className="ml-auto">{picker}</div>
      </div>
      {changed.length > 0 && (
        <p id={changesId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
          {listed(changed.map((field) => FIELD_LABELS[field]))} changed after this animation was
          made.
        </p>
      )}
      {changing && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = instruction.trim();
            if (!text || busy) return;
            void onAnimate(text).then((started) => {
              if (started) {
                setInstruction('');
                setChanging(false);
              }
            });
          }}
        >
          <Input
            aria-label={`What to change in scene ${number}'s animation`}
            value={instruction}
            dir="auto"
            autoFocus
            className={cn('h-8 min-w-[12rem] flex-1', scriptClass(instruction))}
            placeholder="Bigger title, slower motion, a darker background..."
            onChange={(event) => setInstruction(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!instruction.trim() || busy}>
            Ask
          </Button>
        </form>
      )}
      {check && !check.ok && (
        <Notice tone="destructive" size="sm">
          <p className="font-medium">The scene does not pass its checks:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {check.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <Button
            size="xs"
            variant="outline"
            className="mt-2"
            disabled={busy}
            onClick={() =>
              void onAnimate(
                `Fix these problems:\n${check.problems.map((p) => `- ${p}`).join('\n')}`,
              )
            }
          >
            <Wand2 /> Fix with AI
          </Button>
        </Notice>
      )}
      {checkError && (
        <Notice tone="destructive" size="sm">
          {checkError}
        </Notice>
      )}
      {previewing && (
        <ScenePreview
          url={sceneUrl(treeHash, sceneConfig(document, scene))}
          width={size.width}
          height={size.height}
          duration={flicksToSeconds(scene.targetDuration)}
          label={`Scene ${number} preview`}
          // Big enough to judge the motion, small enough to keep the scenario in view.
          className={size.width >= size.height ? 'max-w-xl' : 'max-w-[16rem]'}
        />
      )}
    </div>
  );
}
