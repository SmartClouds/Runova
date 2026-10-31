import {
  CLAUDE_MODELS,
  type CliLaunchModelOption,
  catalogModelForApiId,
  cliLaunchOptions,
  cliLiveSwitch,
  EFFORT_LABELS,
  type EffortLevel,
} from '@runova/core';
import type { AgentRunInfo } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import { SHORT_EFFORT_LABELS } from '@/components/cli/RunSettingsFields';
import { Check, ChevronDown } from '@/components/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { modelDisplayName, noteRunSwitch } from '@/stores/agentStatusStore';
import type { ChatTheme } from './chatThemes';
import { typeIntoCli } from './typeIntoCli';

/**
 * Long enough for one switch to be pasted and submitted before the next is typed, so two quick
 * picks don't land in the CLI's input box as one line.
 */
const SWITCH_GAP_MS = 400;

function isEffort(value: string | undefined): value is EffortLevel {
  return !!value && Object.hasOwn(EFFORT_LABELS, value);
}

/** The model a CLI reports (an API id like `claude-opus-5-5`) as one of its `--model` choices. */
function currentModel(
  models: readonly CliLaunchModelOption[],
  model: string | undefined,
): CliLaunchModelOption | undefined {
  if (!model) return undefined;
  const cliArg = catalogModelForApiId(model)?.cliArg;
  return models.find((m) => m.value === model || m.value === cliArg);
}

/** The API id for a `--model` value, so a switch shows the same name a report would. */
function apiIdFor(value: string): string {
  return Object.values(CLAUDE_MODELS).find((m) => m.cliArg === value)?.apiId ?? value;
}

export interface ChatRunPickerProps {
  sessionId: string;
  cliId: string;
  theme: ChatTheme;
  /** What the agent runs on now, with the launch effort filled in. */
  runInfo: AgentRunInfo | undefined;
  /** Shown when the agent reports no model, e.g. the tab's launch label. */
  fallbackLabel: string | null;
  /** Why a switch can't be sent right now (the agent is working, or waiting on the user). */
  blockedReason: string | null;
  /** Called when the CLI isn't ready to take a command. */
  onNotReady: () => void;
}

/**
 * The model and effort the chat's agent runs on, as a small pill next to Send. For a CLI that can
 * switch in place (Claude Code's `/model` and `/effort`), it opens a picker that types the switch
 * into the CLI. Other CLIs only show what they run on.
 */
export function ChatRunPicker({
  sessionId,
  cliId,
  theme,
  runInfo,
  fallbackLabel,
  blockedReason,
  onNotReady,
}: ChatRunPickerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const live = cliLiveSwitch(cliId);
  const models = cliLaunchOptions(cliId)?.models ?? [];
  const model = currentModel(models, runInfo?.model);
  const effort = isEffort(runInfo?.effort) ? runInfo.effort : undefined;
  const modelLabel = model?.label ?? (runInfo?.model ? modelDisplayName(runInfo.model) : null);
  const efforts: readonly EffortLevel[] =
    model?.efforts ?? (live?.effort ? (Object.keys(EFFORT_LABELS) as EffortLevel[]) : []);

  const pillText = modelLabel
    ? [modelLabel, effort ? SHORT_EFFORT_LABELS[effort] : null].filter(Boolean).join(' · ')
    : fallbackLabel;
  const canSwitch = Boolean(live && (live.model || live.effort));
  if (!pillText && !canSwitch) return null;

  const pillClass =
    'flex h-8 max-w-[14rem] items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-muted-foreground';

  if (!canSwitch) {
    return <span className={cn(pillClass, 'truncate')}>{pillText}</span>;
  }

  function send(command: string, change: AgentRunInfo): void {
    if (!typeIntoCli(sessionId, command)) {
      onNotReady();
      return;
    }
    noteRunSwitch(sessionId, change);
    setSettling(true);
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettling(false), SWITCH_GAP_MS);
  }

  function pickModel(next: CliLaunchModelOption): void {
    if (!live?.model || next.value === model?.value) return;
    // An effort the new model can't take is dropped, the same as the CLI does.
    const keepEffort = effort && (!next.efforts || next.efforts.includes(effort));
    send(live.model(next.value), {
      model: apiIdFor(next.value),
      ...(keepEffort ? {} : { effort: undefined }),
    });
  }

  function pickEffort(level: EffortLevel): void {
    if (!live?.effort || level === effort) return;
    send(live.effort(level), { effort: level });
  }

  const busy = settling || Boolean(blockedReason);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SimpleTooltip
        label={blockedReason ?? 'Model and effort'}
        wrapTrigger={Boolean(blockedReason)}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Model and effort: ${pillText ?? 'not known yet'}`}
            disabled={Boolean(blockedReason)}
            className={cn(
              pillClass,
              'cursor-pointer transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
            )}
          >
            <span className="truncate">{pillText ?? 'Model'}</span>
            <ChevronDown className="h-2.5 w-2.5 shrink-0" />
          </button>
        </PopoverTrigger>
      </SimpleTooltip>
      <PopoverContent side="top" align="end" className="w-64 space-y-3 p-2">
        {live?.model && models.length > 0 ? (
          <div role="radiogroup" aria-label="Model" className="space-y-0.5">
            <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">Model</p>
            {models.map((option) => {
              const selected = option.value === model?.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  onClick={() => pickModel(option)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.06] disabled:pointer-events-none disabled:opacity-50',
                    selected && 'font-medium',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected ? <Check className={cn('h-3 w-3 shrink-0', theme.accentText)} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {live?.effort && efforts.length > 0 ? (
          <div className="space-y-1.5 px-1">
            <p className="px-1 text-[11px] font-medium text-muted-foreground">
              Effort
              {effort ? null : <span className="font-normal"> (CLI default)</span>}
            </p>
            <div
              role="radiogroup"
              aria-label="Effort"
              className="flex items-stretch gap-0.5 rounded-full bg-foreground/[0.05] p-0.5"
            >
              {efforts.map((level) => {
                const selected = level === effort;
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={EFFORT_LABELS[level]}
                    disabled={busy}
                    onClick={() => pickEffort(level)}
                    className={cn(
                      'h-7 min-w-0 flex-1 cursor-pointer truncate rounded-full px-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
                      selected
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {SHORT_EFFORT_LABELS[level]}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
