import type { AiAccessClients, AiAccessMode, AiAccessPrompt } from '@runova/core';
import {
  Bolt,
  ExternalLink,
  Layers,
  Lock,
  Monitor,
  Plug,
  ShieldSolid,
  TerminalSquare,
  TriangleAlert,
} from '@/components/icons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { type ChoiceTile, ChoiceTiles } from './ChoiceTiles';
import { useAiAccessSettings } from './useAiAccessSettings';

/**
 * Settings > AI access (E46): whether AI agents may use Runova through its MCP server, which
 * agents may connect, how much they may do without asking, and where Runova asks. Everything saves
 * the moment it changes.
 */

const CLIENTS: ChoiceTile<AiAccessClients>[] = [
  {
    value: 'runova',
    label: 'Runova only',
    hint: "Agents in Runova's own terminal tabs.",
    icon: TerminalSquare,
  },
  {
    value: 'both',
    label: 'Runova and other apps',
    hint: 'Also CLIs and editors you run yourself.',
    icon: Layers,
  },
  {
    value: 'external',
    label: 'Other apps only',
    hint: 'Only CLIs and editors outside Runova.',
    icon: ExternalLink,
  },
];

function Example({ text }: { text: string }): React.JSX.Element {
  return <span className="mt-2 text-[11px] leading-relaxed text-foreground/70">{text}</span>;
}

const MODES: ChoiceTile<AiAccessMode>[] = [
  {
    value: 'full',
    label: 'Full access',
    hint: 'Agents do everything without asking.',
    icon: Bolt,
    caution: true,
    extra: <Example text="Never asks." />,
  },
  {
    value: 'sensitive',
    label: 'Ask for sensitive actions',
    hint: 'Reads and ordinary edits go through. Risky ones wait for you.',
    icon: ShieldSolid,
    badge: 'Recommended',
    extra: <Example text="Asks before: writing env files, sending requests, git push, deleting." />,
  },
  {
    value: 'all',
    label: 'Ask for everything',
    hint: 'Every call waits for you, reads included.',
    icon: Lock,
    extra: <Example text="Asks before every call. Allow for this session stops repeats." />,
  },
];

function ModalPreview(): React.JSX.Element {
  return (
    <span aria-hidden className="mt-2.5 block rounded-md border border-border/70 bg-popover/70 p-2">
      <span className="mb-1.5 block h-1.5 w-16 rounded-full bg-foreground/25" />
      <span className="mb-2 block h-1 w-24 rounded-full bg-foreground/10" />
      <span className="flex justify-end gap-1">
        <span className="h-2.5 w-7 rounded-full bg-foreground/10" />
        <span className="h-2.5 w-7 rounded-full bg-primary/70" />
      </span>
    </span>
  );
}

function CliPreview(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="mt-2.5 block rounded-md border border-border/70 bg-black/80 px-2 py-1.5 font-mono text-[10px] leading-snug text-white/80"
    >
      <span className="block text-white/50">Claude Code wants to: Save .env</span>
      <span className="block">
        <span className="text-emerald-300">›</span> Allow{' '}
        <span className="text-white/40">/ Deny</span>
      </span>
    </span>
  );
}

const PROMPTS: ChoiceTile<AiAccessPrompt>[] = [
  {
    value: 'modal',
    label: 'In this window',
    hint: 'A Runova dialog with the full details and a diff.',
    icon: Monitor,
    extra: <ModalPreview />,
  },
  {
    value: 'cli',
    label: "In the agent's session",
    hint: 'The question appears in the CLI chat you are already in.',
    icon: TerminalSquare,
    extra: <CliPreview />,
  },
];

const CLIENT_SUMMARY: Record<AiAccessClients, string> = {
  runova: "agents in Runova's tabs",
  both: 'agents in Runova and in other apps',
  external: 'agents in other apps',
};

const MODE_SUMMARY: Record<AiAccessMode, string> = {
  full: 'never asks',
  sensitive: 'asks before sensitive actions',
  all: 'asks before every call',
};

export function AiAccessSettings(): React.JSX.Element {
  const { values, save } = useAiAccessSettings();

  return (
    <Card className={cn('glass', values.enabled && 'ring-1 ring-primary/25')}>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Plug className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>AI access</CardTitle>
            <CardDescription>
              Let AI agents like Claude Code and Codex work with Runova over MCP: update env files,
              add API requests, check git and more, within the limits you set here.
            </CardDescription>
            <p className="flex items-center gap-1.5 pt-1 text-xs">
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  values.enabled
                    ? 'bg-success shadow-[0_0_6px] shadow-success'
                    : 'bg-foreground/30',
                )}
              />
              {values.enabled ? (
                <span className="text-foreground/80">
                  On for {CLIENT_SUMMARY[values.clients]}, {MODE_SUMMARY[values.mode]}.
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Agents can&apos;t use Runova until you turn this on.
                </span>
              )}
            </p>
          </div>
        </div>
        <Switch
          aria-label="Let AI agents use Runova"
          checked={values.enabled}
          onCheckedChange={(enabled) => save({ aiAccessEnabled: enabled })}
        />
      </CardHeader>

      <CardContent className={cn('space-y-6', !values.enabled && 'opacity-75')}>
        <ChoiceTiles
          label="Who can connect"
          options={CLIENTS}
          value={values.clients}
          onChange={(aiAccessClients) => save({ aiAccessClients })}
          className="sm:grid-cols-3"
        />

        {values.clients !== 'external' ? (
          <div className="flex items-start justify-between gap-6 rounded-lg border border-border bg-background/40 px-3.5 py-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Attach to agent tabs Runova opens</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                New Claude Code, Codex and Copilot tabs start with Runova&apos;s MCP server. Tabs
                already open keep what they started with.
              </p>
            </div>
            <Switch
              aria-label="Attach to agent tabs Runova opens"
              checked={values.attachToTabs}
              onCheckedChange={(aiAccessAttachToTabs) => save({ aiAccessAttachToTabs })}
            />
          </div>
        ) : null}

        <div className="space-y-2.5">
          <ChoiceTiles
            label="What agents may do without asking"
            options={MODES}
            value={values.mode}
            onChange={(aiAccessMode) => save({ aiAccessMode })}
            className="sm:grid-cols-3"
          />
          {values.mode === 'full' ? (
            <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-foreground/85">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              With full access, agents can change and delete things without asking you, including
              env files and remote servers. Use it only with agents you trust.
            </p>
          ) : null}
        </div>

        <div className="space-y-2.5">
          <ChoiceTiles
            label="Where Runova asks"
            options={PROMPTS}
            value={values.prompt}
            onChange={(aiAccessPrompt) => save({ aiAccessPrompt })}
            className="sm:grid-cols-2"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {values.prompt === 'cli'
              ? "If an agent's CLI can't show questions, Runova asks in this window instead. Secret values are masked in the CLI."
              : 'The dialog shows what will change before you allow it, and denies by itself after four minutes.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
