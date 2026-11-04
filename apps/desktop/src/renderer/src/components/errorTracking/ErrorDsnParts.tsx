import { buildSentrySetup, SENTRY_PLATFORMS } from '@runova/core';
import { useId, useState } from 'react';
import { Copy, ExternalLink } from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import { copyText, TextPane } from '../health/promptParts';

/**
 * The pieces that show a Sentry project's DSN (E47): the DSN itself with its copy buttons, and the
 * install command and init code for a platform with the DSN already in place. Shared by the new
 * project dialog and the DSN dialog of a linked project.
 */

const PLATFORM_OPTIONS = SENTRY_PLATFORMS.map((one) => ({ value: one.id, label: one.label }));

/** A link out of the app, in the accent color with no underline. */
export const OUT_LINK =
  'inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80';

export function DsnField({
  dsn,
  heading = 'DSN',
  className,
}: {
  dsn: string;
  /** Shown above the DSN; null leaves it to the caller. */
  heading?: React.ReactNode | null;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading !== null && <span className={SECTION_HEADING}>{heading}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="soft" onClick={() => copyText(dsn, 'DSN')}>
            <Copy />
            Copy DSN
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => copyText(`SENTRY_DSN=${dsn}`, 'Env var')}
          >
            Copy as env var
          </Button>
        </div>
      </div>
      <code
        aria-label="DSN"
        className="block select-all break-all rounded-lg bg-foreground/[0.04] px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.08)]"
      >
        {dsn}
      </code>
    </div>
  );
}

function Step({ n, title, hint }: { n: number; title: string; hint?: string }): React.JSX.Element {
  return (
    <p className="flex items-baseline gap-2 text-xs">
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[10px] font-semibold text-primary"
      >
        {n}
      </span>
      <span className="font-medium text-foreground">{title}</span>
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </p>
  );
}

/**
 * How to put the DSN to work: pick the platform, run the install command, add the init code.
 * Give it a `key` to start over when the project it shows changes.
 */
export function ErrorSetupSnippets({
  dsn,
  platformId,
  className,
}: {
  dsn: string;
  /** The platform to show first, a `SENTRY_PLATFORMS` id. */
  platformId: string;
  className?: string;
}): React.JSX.Element {
  const headingId = useId();
  const [platform, setPlatform] = useState(platformId);
  const setup = buildSentrySetup(platform, dsn);
  const other = setup.platform.id === 'other';

  return (
    <section aria-labelledby={headingId} className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold tracking-tight">
          Set it up in your app
        </h3>
        <Combobox
          ariaLabel="Snippet platform"
          value={setup.platform.id}
          onChange={(value) => setPlatform(value || 'other')}
          options={PLATFORM_OPTIONS}
          searchPlaceholder="Search platforms…"
          emptyText="No platform matches."
          className="h-8 w-48 text-xs"
        />
      </div>
      {setup.install && (
        <div className="space-y-1.5">
          <Step n={1} title="Install the SDK" />
          <TextPane
            label="Install"
            text={setup.install}
            copyLabel="Copy command"
            copyWhat="Command"
          />
        </div>
      )}
      <div className="space-y-1.5">
        <Step
          n={setup.install ? 2 : 1}
          title={other ? 'Set the DSN' : 'Start Sentry'}
          hint={setup.platform.where}
        />
        <TextPane label="Init code" text={setup.code} copyLabel="Copy code" copyWhat="Code" />
      </div>
      <a href={setup.platform.docsUrl} target="_blank" rel="noreferrer" className={OUT_LINK}>
        <ExternalLink className="h-3 w-3" />
        {other ? 'All platform guides' : `Full ${setup.platform.label} guide`}
      </a>
    </section>
  );
}
