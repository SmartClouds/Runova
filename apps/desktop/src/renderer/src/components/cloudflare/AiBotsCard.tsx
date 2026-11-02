import type { CloudflareZone } from '@shared/cloudflareTypes';
import { useId } from 'react';
import { ExternalLink, Robot } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Switch } from '@/components/ui/switch';
import { AI_BOTS_CHOICES, AI_BOTS_DESCRIPTIONS, AI_BOTS_LABELS } from '@/lib/cloudflare/labels';
import { cn } from '@/lib/utils';
import {
  CardBody,
  CloudflareCard,
  Problem,
  SegmentedChoice,
  SettingRow,
  SettingsSkeleton,
} from './fields';
import { useBotSettings } from './useBotSettings';

/** Cloudflare's page on the robots.txt it writes for a zone. */
export const PREFERENCE_SYNC_DOCS =
  'https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/';

function OnOff({ on }: { on: boolean }): React.JSX.Element {
  return <Chip tone={on ? 'primary' : 'neutral'}>{on ? 'On' : 'Off'}</Chip>;
}

/**
 * Which AI crawlers reach the zone, the way Cloudflare's "Manage AI bot access" section has it:
 * blocking them, a maze for the ones that ignore the rules, the choices written into robots.txt,
 * and Bot Fight Mode where the plan has it.
 */
export function AiBotsCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const id = useId();
  const { query, loadError, saving, change } = useBotSettings(zone);

  let body: React.ReactNode;
  if (query.isPending) {
    body = <SettingsSkeleton rows={4} />;
  } else if (query.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void query.refetch()} />
      </CardBody>
    );
  } else {
    const { aiBots, aiLabyrinth, preferenceSync, fightMode } = query.data;
    body = (
      <div className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        <SettingRow
          title="Block AI bots"
          titleId={`${id}-ai-bots`}
          description="Stops known AI scrapers and crawlers before they reach the site."
          below={<p className="text-xs text-muted-foreground">{AI_BOTS_DESCRIPTIONS[aiBots]}</p>}
        >
          <SegmentedChoice
            labelledBy={`${id}-ai-bots`}
            layoutId={`${id}-ai-bots-active`}
            options={AI_BOTS_CHOICES.map((choice) => ({
              value: choice,
              label: AI_BOTS_LABELS[choice],
            }))}
            value={aiBots}
            disabled={saving === 'aiBots'}
            onChange={(value) => void change({ setting: 'aiBots', value })}
          />
        </SettingRow>
        <SettingRow
          title="AI Labyrinth"
          titleId={`${id}-labyrinth`}
          description="Sends AI crawlers that ignore your rules into a maze of decoy pages."
        >
          <OnOff on={aiLabyrinth} />
          <Switch
            checked={aiLabyrinth}
            disabled={saving === 'aiLabyrinth'}
            aria-labelledby={`${id}-labyrinth`}
            onCheckedChange={(value) => void change({ setting: 'aiLabyrinth', value })}
          />
        </SettingRow>
        <SettingRow
          title="Bot Preference Sync"
          titleId={`${id}-sync`}
          description="Puts your AI bot choices at the top of the site's robots.txt."
          below={
            <button
              type="button"
              onClick={() => void window.runova.shell.openExternal(PREFERENCE_SYNC_DOCS)}
              className="inline-flex cursor-pointer items-center gap-1 rounded text-xs font-medium text-primary outline-none hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Learn more <ExternalLink className="h-3 w-3" />
            </button>
          }
        >
          <OnOff on={preferenceSync} />
          <Switch
            checked={preferenceSync}
            disabled={saving === 'preferenceSync'}
            aria-labelledby={`${id}-sync`}
            onCheckedChange={(value) => void change({ setting: 'preferenceSync', value })}
          />
        </SettingRow>
        {fightMode === null ? (
          <div className="px-4 py-3">
            <p className="text-sm font-medium text-foreground">Bot Fight Mode</p>
            <p className="text-xs text-muted-foreground">
              This plan uses Super Bot Fight Mode instead. Change it on Cloudflare.
            </p>
          </div>
        ) : (
          <SettingRow
            title="Bot Fight Mode"
            titleId={`${id}-fight`}
            description="Challenges traffic that looks like a known bot, on every request."
          >
            <OnOff on={fightMode} />
            <Switch
              checked={fightMode}
              disabled={saving === 'fightMode'}
              aria-labelledby={`${id}-fight`}
              onCheckedChange={(value) => void change({ setting: 'fightMode', value })}
            />
          </SettingRow>
        )}
      </div>
    );
  }

  return (
    <CloudflareCard
      icon={<Robot />}
      title="AI bots"
      description={`Which AI crawlers can reach ${zone.name}, and what robots.txt tells them.`}
    >
      {body}
    </CloudflareCard>
  );
}
