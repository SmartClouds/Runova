import { pictureCounts, type StudioDocument } from '@runova/studio';
import { Check, ChevronRight, cn } from '../kit';

export type StudioStep = 'scenario' | 'pictures' | 'animation';

interface Step {
  id: StudioStep;
  label: string;
  detail: string;
  done: boolean;
}

/** Where the video is in its making: the scenario, its pictures, then each scene's animation. */
export function videoSteps(doc: StudioDocument): Step[] {
  const scenes = doc.scenario.scenes;
  const pictures = pictureCounts(doc);
  const animated = scenes.filter((s) => s.code.treeHash !== null).length;
  return [
    {
      id: 'scenario',
      label: 'Scenario',
      detail: scenes.length === 0 ? 'Not written yet' : `${scenes.length} scenes`,
      done: scenes.length > 0,
    },
    {
      id: 'pictures',
      label: 'Pictures',
      detail:
        scenes.length === 0
          ? 'After the scenario'
          : pictures.total === 0
            ? 'Not planned yet'
            : `${pictures.ready} of ${pictures.total} ready`,
      done: pictures.total > 0 && pictures.ready === pictures.total,
    },
    {
      id: 'animation',
      label: 'Animation',
      detail: scenes.length === 0 ? 'After the scenario' : `${animated} of ${scenes.length} scenes`,
      done: scenes.length > 0 && animated === scenes.length,
    },
  ];
}

/**
 * The steps of making a video as a slim bar under the toolbar. Each one says how far it is and
 * opens its own view, so the way from a brief to a finished video is always in sight.
 */
export function StepBar({
  document,
  current,
  onOpen,
}: {
  document: StudioDocument;
  current: StudioStep | null;
  onOpen: (step: StudioStep) => void;
}): React.JSX.Element {
  const steps = videoSteps(document);
  return (
    <nav aria-label="Steps of the video">
      <ol className="flex flex-wrap items-center gap-1">
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" aria-hidden />}
            <button
              type="button"
              onClick={() => onOpen(step.id)}
              aria-label={`${step.label}: ${step.detail}${step.done ? ', done' : ''}`}
              aria-current={current === step.id ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full px-2.5 py-1 text-xs transition hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                current === step.id && 'bg-primary/10 text-primary hover:bg-primary/15',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums',
                  step.done
                    ? 'bg-success/15 text-success'
                    : 'bg-foreground/[0.08] text-muted-foreground',
                )}
                aria-hidden
              >
                {step.done ? <Check className="h-2.5 w-2.5" /> : index + 1}
              </span>
              <span className="font-medium">{step.label}</span>
              <span className="text-muted-foreground">{step.detail}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
