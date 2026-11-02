import type { CloudflareZone } from '@shared/cloudflareTypes';
import { Bolt, Robot, Shield } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRemaining, SECURITY_LEVEL_LABELS } from '@/lib/cloudflare/labels';
import { cn } from '@/lib/utils';
import { aiBotsWhenOn, type BotSettings, useBotSettings } from './useBotSettings';
import { levelBeforeAttack, useZoneSettings, type ZoneSettings } from './useZoneSettings';

const TONES = {
  primary: {
    pill: 'bg-primary/10 text-primary ring-primary/30 hover:bg-primary/15',
    icon: 'bg-primary/15 text-primary',
    dot: 'bg-primary',
  },
  warning: {
    pill: 'bg-warning/10 text-warning ring-warning/30 hover:bg-warning/15',
    icon: 'bg-warning/15 text-warning',
    dot: 'bg-warning',
  },
  destructive: {
    pill: 'bg-destructive/10 text-destructive ring-destructive/35 hover:bg-destructive/15',
    icon: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
  },
} as const;

/**
 * One header switch: an icon, its name and what it is set to, tinted while it is on. The state is
 * written out, so it never rests on the colour alone.
 */
function QuickSwitch({
  label,
  state,
  icon,
  on,
  tone,
  pulse = true,
  disabled,
  onToggle,
}: {
  label: string;
  state: string;
  icon: React.ReactNode;
  on: boolean;
  tone: keyof typeof TONES;
  /** Pings the dot while on, for a state meant to be temporary; a lasting one keeps it still. */
  pulse?: boolean;
  disabled: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const colours = TONES[tone];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-full py-1 pl-1 pr-3 text-left outline-none ring-1 ring-inset transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        on
          ? colours.pill
          : 'bg-foreground/[0.03] text-foreground ring-foreground/10 hover:bg-foreground/[0.06]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5',
          on ? colours.icon : 'bg-foreground/[0.06] text-muted-foreground',
        )}
      >
        {icon}
        {on && (
          <span className="absolute right-0 top-0 flex h-2 w-2">
            {pulse && (
              <span
                className={cn(
                  'absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping',
                  colours.dot,
                )}
              />
            )}
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', colours.dot)} />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium">{label}</span>
        <span
          className={cn(
            'truncate text-[11px] tabular-nums',
            on ? 'opacity-85' : 'text-muted-foreground',
          )}
        >
          {state}
        </span>
      </span>
    </button>
  );
}

function PillSkeleton(): React.JSX.Element {
  return <Skeleton className="h-9 w-36 rounded-full" />;
}

/**
 * Development mode, I'm Under Attack and Block AI bots, in the zone's header so they are one
 * click away from every tab. They read the same settings as the tabs. Turning an attack off goes
 * back to the security level from before it, and turning AI bots back on blocks them where they
 * were blocked before, not a guess. Bot settings need their own permission, so they load apart:
 * a token without it keeps the other two switches.
 */
export function ZoneQuickToggles({ zone }: { zone: CloudflareZone }): React.JSX.Element | null {
  const settings = useZoneSettings(zone);
  const bots = useBotSettings(zone);
  // The open tab shows the problem; the header just leaves the switches out.
  if (settings.query.isError && bots.query.isError) return null;
  const loading = settings.query.isPending || bots.query.isPending;

  return (
    <div
      role="group"
      aria-label="Quick switches"
      aria-busy={loading || undefined}
      className="flex flex-wrap items-center gap-2"
    >
      <SettingSwitches zone={zone} settings={settings} />
      <AiBotsSwitch zone={zone} bots={bots} />
    </div>
  );
}

function SettingSwitches({
  zone,
  settings: { query, saving, change },
}: {
  zone: CloudflareZone;
  settings: ZoneSettings;
}): React.JSX.Element | null {
  if (query.isPending) {
    return (
      <>
        <PillSkeleton />
        <PillSkeleton />
      </>
    );
  }
  if (query.isError) return null;

  const { developmentMode, securityLevel } = query.data;
  const developmentOn = developmentMode.value === 'on';
  const attackOn = securityLevel.value === 'under_attack';
  const remaining = formatRemaining(developmentMode.secondsRemaining);

  return (
    <>
      <QuickSwitch
        label="Development mode"
        state={developmentOn ? (remaining ? `On, ${remaining}` : 'On') : 'Off'}
        icon={<Bolt />}
        on={developmentOn}
        tone="warning"
        disabled={!developmentMode.editable || saving === 'developmentMode'}
        onToggle={() =>
          void change(
            { setting: 'developmentMode', value: developmentOn ? 'off' : 'on' },
            developmentOn ? 'Development mode is off.' : 'Development mode is on for three hours.',
          )
        }
      />
      <QuickSwitch
        label="I'm Under Attack"
        state={attackOn ? 'On, visitors are checked' : 'Off'}
        icon={<Shield />}
        on={attackOn}
        tone="destructive"
        disabled={!securityLevel.editable || saving === 'securityLevel'}
        onToggle={() => {
          if (attackOn) {
            const level = levelBeforeAttack(zone.id);
            void change(
              { setting: 'securityLevel', value: level },
              `I'm Under Attack is off. Security level is ${SECURITY_LEVEL_LABELS[level]} again.`,
            );
          } else {
            void change(
              { setting: 'securityLevel', value: 'under_attack' },
              "I'm Under Attack is on. Every visitor gets a short check first.",
            );
          }
        }}
      />
    </>
  );
}

/** Block AI bots. Blocking is a lasting choice, not an emergency, so its dot stays still. */
function AiBotsSwitch({
  zone,
  bots: { query, saving, change },
}: {
  zone: CloudflareZone;
  bots: BotSettings;
}): React.JSX.Element | null {
  if (query.isPending) return <PillSkeleton />;
  if (query.isError) return null;
  const { aiBots } = query.data;
  const on = aiBots !== 'disabled';
  return (
    <QuickSwitch
      label="Block AI bots"
      state={on ? `On, ${aiBots === 'block' ? 'everywhere' : 'ad pages'}` : 'Off'}
      icon={<Robot />}
      on={on}
      tone="primary"
      pulse={false}
      disabled={saving === 'aiBots'}
      onToggle={() =>
        void change({ setting: 'aiBots', value: on ? 'disabled' : aiBotsWhenOn(zone.id) })
      }
    />
  );
}
