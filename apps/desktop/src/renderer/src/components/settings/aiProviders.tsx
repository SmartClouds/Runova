import type { AiProvider } from '@runova/core';
import type { ReactNode } from 'react';
import { CliLogo } from '@/components/cliLogos';
import { CircleCheck, ExternalLink, TerminalSquare } from '@/components/icons';
import { ProviderLogo } from '@/components/providerLogos';
import { cn } from '@/lib/utils';

/** What Prompt Builder can write with: one of the API providers, or the default AI CLI. */
export type PromptWriter = AiProvider | 'cli';

export type ProviderTone = 'ready' | 'warning' | 'muted' | 'checking';

/** A short readiness line for a provider, shown on its tile and as a dot on its tab. */
export interface ProviderStatus {
  tone: ProviderTone;
  label: string;
}

const TONE_DOT: Record<ProviderTone, string> = {
  ready: 'bg-success',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground/40',
  checking: 'bg-muted-foreground/60 animate-pulse',
};

const TONE_TEXT: Record<ProviderTone, string> = {
  ready: 'text-success',
  warning: 'text-warning',
  muted: 'text-muted-foreground',
  checking: 'text-muted-foreground',
};

export function StatusDot({ tone, className }: { tone: ProviderTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone], className)}
    />
  );
}

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

interface WriterOption {
  value: PromptWriter;
  label: string;
  status: ProviderStatus;
}

/**
 * The tiles that pick what writes prompts. Each one carries its provider's readiness, so the
 * choice and whether it will work are read in one place instead of across the whole card.
 */
export function PromptWriterPicker({
  value,
  onChange,
  statuses,
  cliId,
}: {
  value: PromptWriter;
  onChange: (next: PromptWriter) => void;
  statuses: Record<PromptWriter, ProviderStatus>;
  /** The default CLI, for its logo on the Default CLI tile. */
  cliId: string | null;
}): React.JSX.Element {
  const options: WriterOption[] = [
    { value: 'openai', label: PROVIDER_LABELS.openai, status: statuses.openai },
    { value: 'gemini', label: PROVIDER_LABELS.gemini, status: statuses.gemini },
    { value: 'ollama', label: PROVIDER_LABELS.ollama, status: statuses.ollama },
    { value: 'cli', label: 'Default CLI', status: statuses.cli },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Prompt Builder provider"
      className="grid grid-cols-2 gap-2 lg:grid-cols-4"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-lg border p-3 text-left transition-all duration-150',
              active
                ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/40'
                : 'border-border bg-background/40 hover:border-foreground/20 hover:bg-accent/40',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-background/60">
                <WriterLogo value={option.value} cliId={cliId} />
              </span>
              {active ? (
                <CircleCheck aria-hidden className="h-4 w-4 text-primary" />
              ) : (
                <span aria-hidden className="h-4 w-4 rounded-full border border-border" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span
                className={cn(
                  'mt-0.5 flex min-w-0 items-center gap-1.5 text-xs',
                  TONE_TEXT[option.status.tone],
                )}
              >
                <StatusDot tone={option.status.tone} />
                <span className="truncate">{option.status.label}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function WriterLogo({ value, cliId }: { value: PromptWriter; cliId: string | null }) {
  if (value !== 'cli') return <ProviderLogo providerId={value} className="h-4 w-4" />;
  if (cliId) return <CliLogo cliId={cliId} className="h-4 w-4" />;
  return <TerminalSquare className="h-4 w-4 text-muted-foreground" />;
}

/** A tab label for one provider's connection settings: its logo, name and readiness dot. */
export function ProviderTabLabel({
  provider,
  status,
}: {
  provider: AiProvider;
  status: ProviderStatus;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <ProviderLogo providerId={provider} className="h-3.5 w-3.5" />
      {PROVIDER_LABELS[provider]}
      <StatusDot tone={status.tone} />
      <span className="sr-only">({status.label})</span>
    </span>
  );
}

/** A field label with an optional link on its right edge, such as where to get an API key. */
export function LabelRow({
  label,
  htmlFor,
  linkLabel,
  href,
}: {
  label: ReactNode;
  htmlFor?: string;
  linkLabel?: string;
  href?: string;
}): React.JSX.Element {
  return (
    // A plain Label is inline, so its row is one 20px line of text-sm; matching that keeps this
    // label level with the field beside it.
    <div className="flex h-5 items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium leading-none">
        {label}
      </label>
      {href && linkLabel ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          onClick={() => void window.runova.shell.openExternal(href)}
        >
          {linkLabel}
          <ExternalLink className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

/** The notice under the tiles when the chosen option can't write a prompt yet, or needs a word. */
export function WriterNotice({
  tone,
  children,
  action,
}: {
  tone: 'warning' | 'info';
  children: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      role={tone === 'warning' ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
        tone === 'warning'
          ? 'border-warning/30 bg-warning/10 text-foreground'
          : 'border-border/60 bg-background/40 text-muted-foreground',
      )}
    >
      <p className="min-w-0 flex-1">{children}</p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
