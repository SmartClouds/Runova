import {
  type Aspect,
  buildBriefRewriteRequest,
  CUSTOM_STYLE_MAX,
  STYLE_PRESETS,
  styleById,
} from '@runova/studio';
import { useId, useRef, useState } from 'react';
import {
  AgentPromptField,
  Button,
  Combobox,
  Label,
  type RunSettings,
  RunSettingsFields,
  SEGMENT_TRACK,
  segmentClass,
  Textarea,
} from '../kit';
import { StylesDialog } from '../scenes/StylesDialog';

export interface BriefValue {
  brief: string;
  targetSeconds: number;
  styleId: string | null;
  /**
   * The look in the user's own words, for when none of the presets fits. A string (even an empty
   * one) means "Custom style" is picked; null or missing means it is not.
   */
  customStyle?: string | null;
  run: RunSettings;
}

export const LENGTHS: { seconds: number; label: string }[] = [
  { seconds: 15, label: '15 s' },
  { seconds: 30, label: '30 s' },
  { seconds: 60, label: '1 min' },
  { seconds: 90, label: '1.5 min' },
  { seconds: 180, label: '3 min' },
];

const NO_STYLE = '__none__';
const CUSTOM_STYLE = '__custom__';

/** The custom style to send with a run: the words if it is picked and says something. */
export function customStyleOf(value: BriefValue): string | null {
  return value.styleId === null ? value.customStyle?.trim() || null : null;
}

/** False while "Custom style" is picked but not described yet. */
export function styleReady(value: BriefValue): boolean {
  return value.styleId !== null || value.customStyle == null || customStyleOf(value) !== null;
}

/**
 * What the AI needs to write a scenario: the brief in the user's own words, about how long, the
 * look, and which CLI, model and effort to run. Used by the editor's brief card and the New video
 * dialog, so both ask the same way.
 */
export function BriefFields({
  value,
  onChange,
  aspect,
  language,
  autoFocus,
  onSubmit,
}: {
  value: BriefValue;
  onChange: (next: BriefValue) => void;
  /** The video's format, to point out the styles made for it. */
  aspect: Aspect;
  /** The video's language, for the style examples. */
  language: string;
  autoFocus?: boolean;
  /** Ctrl+Enter in the brief, to start without reaching for the button. */
  onSubmit?: () => void;
}): React.JSX.Element {
  const id = useId();
  const [browsing, setBrowsing] = useState(false);
  const customRef = useRef<HTMLTextAreaElement>(null);
  const style = styleById(value.styleId);
  const styles = [
    { value: NO_STYLE, label: 'Let the AI choose', keywords: ['none', 'any'] },
    { value: CUSTOM_STYLE, label: 'Custom style', keywords: ['own', 'describe', 'mine'] },
    ...STYLE_PRESETS.map((s) => ({
      value: s.id,
      label:
        s.formats.includes(aspect) && s.formats.length < 4
          ? `${s.name} (made for ${aspect})`
          : s.name,
      keywords: [s.summary],
    })),
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-brief`}>What is the video about?</Label>
        {/* The same box as Ask AI elsewhere: Persian, dictation in Persian or English, a
            translation to English, and an AI rewrite of a rough note into a brief. */}
        <AgentPromptField
          id={`${id}-brief`}
          value={value.brief}
          onChange={(brief) => onChange({ ...value, brief })}
          buildRequest={(note) => buildBriefRewriteRequest(note, language)}
          rewriteHint="The AI turns your note into a clear brief"
          ariaLabel="What is the video about?"
          autoFocus={autoFocus}
          maxLength={100_000}
          minHeight={120}
          maxHeight={320}
          textClassName="text-sm leading-6"
          placeholder="Who it is for, what they should feel or do, and anything it must say. Paste notes, a product description or a draft script if you have one."
          submitOn="mod-enter"
          onSubmit={() => onSubmit?.()}
        />
      </div>
      <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label id={`${id}-length`} className="block">
            Length
          </Label>
          <div className={SEGMENT_TRACK} role="radiogroup" aria-labelledby={`${id}-length`}>
            {LENGTHS.map((length) => (
              <button
                key={length.seconds}
                type="button"
                role="radio"
                aria-checked={value.targetSeconds === length.seconds}
                className={segmentClass(value.targetSeconds === length.seconds)}
                onClick={() => onChange({ ...value, targetSeconds: length.seconds })}
              >
                {length.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="block">Style</Label>
          <div className="flex gap-2">
            <Combobox
              ariaLabel="Style"
              className="min-w-0 flex-1"
              options={styles}
              value={value.styleId ?? (value.customStyle == null ? NO_STYLE : CUSTOM_STYLE)}
              onChange={(next) => {
                if (next !== CUSTOM_STYLE) {
                  onChange({
                    ...value,
                    styleId: next === NO_STYLE ? null : next,
                    customStyle: null,
                  });
                  return;
                }
                onChange({ ...value, styleId: null, customStyle: value.customStyle ?? '' });
                requestAnimationFrame(() => customRef.current?.focus());
              }}
            />
            <Button type="button" variant="outline" onClick={() => setBrowsing(true)}>
              See styles
            </Button>
          </div>
          <StylesDialog
            open={browsing}
            onOpenChange={setBrowsing}
            value={value.styleId}
            aspect={aspect}
            language={language}
            onPick={(styleId) => onChange({ ...value, styleId, customStyle: null })}
          />
        </div>
      </div>
      {style && <p className="text-xs text-muted-foreground">{style.summary}</p>}
      {!style && value.customStyle != null && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-custom-style`}>Describe your style</Label>
          <Textarea
            id={`${id}-custom-style`}
            ref={customRef}
            rows={3}
            maxLength={CUSTOM_STYLE_MAX}
            value={value.customStyle}
            onChange={(e) => onChange({ ...value, customStyle: e.target.value })}
            placeholder="Colors, shapes, type and how things move. Name exact colors and fonts for a look that holds across scenes, like: dark navy background, neon green lines, bold condensed type, quick snappy cuts."
          />
        </div>
      )}
      <RunSettingsFields
        labels="form"
        value={value.run}
        onChange={(run) => onChange({ ...value, run })}
      />
    </div>
  );
}
