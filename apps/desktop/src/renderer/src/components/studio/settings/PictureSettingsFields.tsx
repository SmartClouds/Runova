import { STUDIO_GEN } from '@runova/core';
import { formatUsd, type StudioSettingsPatch, type StudioSettingsView } from '@runova/studio';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { studioAudioClient } from '../client';
import { Button, cn, Notice, SEGMENT_TRACK, Sparkles, segmentClass } from '../kit';
import { studioKeys } from '../queryKeys';

const ENGINES = [
  { value: 'openai', label: 'GPT Image', provider: 'OpenAI' },
  { value: 'gemini', label: 'Gemini', provider: 'Gemini' },
  { value: 'off', label: 'Off', provider: null },
] as const;

const QUALITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

function Segments<T extends string | number>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className={SEGMENT_TRACK} role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={String(choice.value)}
          type="button"
          role="radio"
          aria-checked={value === choice.value}
          className={segmentClass(value === choice.value)}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The Pictures step's settings: what makes the pictures a project cannot show (GPT Image by
 * default), at what quality, and how sharp the screenshots are. Nothing is ever made without the
 * price being shown and agreed to first.
 */
export function PictureSettingsFields({
  data,
  onChange,
  onOpenKeys,
}: {
  data: StudioSettingsView;
  onChange: (patch: StudioSettingsPatch) => void;
  /** Opens Settings > AI, where the OpenAI and Gemini keys are. */
  onOpenKeys?: () => void;
}): React.JSX.Element {
  const id = useId();
  const engines = useQuery({
    queryKey: studioKeys.voiceEngines,
    queryFn: () => studioAudioClient().engines(),
  });
  const engine = ENGINES.find((e) => e.value === data.pictureEngine) ?? ENGINES[0];
  const keyMissing =
    data.pictureEngine !== 'off' &&
    engines.data?.find((e) => e.id === data.pictureEngine)?.problem != null;
  const price =
    data.pictureEngine === 'openai'
      ? STUDIO_GEN.image.openai.estimatePerImage[data.pictureQuality]
      : data.pictureEngine === 'gemini'
        ? STUDIO_GEN.image.gemini.pricePerImage['1K']
        : null;

  return (
    <div className="space-y-3 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.07]">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Pictures</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Screenshots of a video&apos;s project are taken from the running app. Pictures the app
        cannot show are made by an image model, or written to PICTURES.md for you to make.
      </p>

      <div className="space-y-1.5" id={`${id}-engine`}>
        <span className="block text-sm font-medium">Make the other pictures with</span>
        <Segments
          label="Make the other pictures with"
          value={data.pictureEngine}
          choices={ENGINES}
          onChange={(pictureEngine) => onChange({ pictureEngine })}
        />
        <span className="block text-xs text-muted-foreground">
          {data.pictureEngine === 'off'
            ? 'No image model: each picture gets a prompt in PICTURES.md to paste into any image tool.'
            : `Uses your ${engine.provider} key from Settings > AI. Studio shows the price and asks before anything is sent.`}
        </span>
      </div>

      {keyMissing && (
        <Notice
          tone="warning"
          size="sm"
          action={
            onOpenKeys ? (
              <Button size="xs" variant="soft" onClick={onOpenKeys}>
                Add the key
              </Button>
            ) : undefined
          }
        >
          There is no {engine.provider} API key yet. Add it in Settings &gt; AI; until then the
          prompts go to PICTURES.md.
        </Notice>
      )}

      {data.pictureEngine === 'openai' && (
        <div className="space-y-1.5">
          <span className="block text-sm font-medium">Quality</span>
          <Segments
            label="Picture quality"
            value={data.pictureQuality}
            choices={QUALITIES}
            onChange={(pictureQuality) => onChange({ pictureQuality })}
          />
        </div>
      )}
      {price !== null && (
        <p className={cn('text-xs text-muted-foreground')}>About {formatUsd(price)} a picture.</p>
      )}

      <div className="space-y-1.5">
        <span className="block text-sm font-medium">Screenshot sharpness</span>
        <Segments
          label="Screenshot sharpness"
          value={data.captureScale}
          choices={[
            { value: 1, label: 'Standard' },
            { value: 2, label: 'Sharp (2x)' },
          ]}
          onChange={(captureScale) => onChange({ captureScale })}
        />
        <span className="block text-xs text-muted-foreground">
          Sharp screenshots stay crisp when a scene zooms in on them.
        </span>
      </div>
    </div>
  );
}
