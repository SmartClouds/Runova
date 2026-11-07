import { cloudUrlProblem, formatHealthInterval } from '@runova/core';
import type { HealthCloudPlan, HealthRunMode } from '@shared/healthTypes';
import { Cloud, Monitor, Spinner } from '@/components/icons';
import { Notice, SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * "Where it runs" (E56): this computer, or Runova Cloud's nodes day and night. The cloud side
 * shows the project's account type and how much of it is used, says why the monitor can not go
 * online when it can not (with the way forward), asks once for consent to send the address and
 * the key, and holds the online alerts.
 */

export interface CloudChoice {
  runMode: HealthRunMode;
  consent: boolean;
  notifyInApp: boolean;
  notifyTelegram: boolean;
  muted: boolean;
}

export const CONSENT_TEXT =
  "Runova Cloud keeps this monitor's address and access key so it can check it.";

/** Why the monitor can not go online with this draft, or null when it can. */
export function cloudBlock(
  choice: CloudChoice,
  plan: HealthCloudPlan | undefined,
  draft: { url: string; allowInsecure: boolean; intervalSec: number | null },
  alreadyOnline: boolean,
): string | null {
  if (choice.runMode !== 'cloud') return null;
  if (!plan) return 'Runova Cloud is not reachable right now. Try again in a moment.';
  if (plan.blocked) return plan.blocked;
  const urlProblem = cloudUrlProblem(draft.url, draft.allowInsecure);
  if (urlProblem) return urlProblem;
  if (draft.intervalSec !== null && draft.intervalSec < plan.minIntervalSec) {
    return `${plan.accountTypeName ?? 'This account type'} checks every ${formatHealthInterval(plan.minIntervalSec)} or slower. Choose a longer interval.`;
  }
  if (!alreadyOnline && !choice.consent)
    return 'Agree to send the address and key to Runova Cloud first.';
  return null;
}

function usageLine(plan: HealthCloudPlan): string | null {
  if (!plan.accountTypeName) return null;
  const used =
    plan.maxMonitors === null
      ? `${plan.active} online`
      : `${plan.active} of ${plan.maxMonitors} online`;
  return `${plan.accountTypeName} · ${used}`;
}

function SettingSwitch({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-description`} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-description`}
      />
    </div>
  );
}

export function HealthCloudSection({
  id,
  choice,
  onChange,
  plan,
  planLoading,
  draft,
  alreadyOnline,
}: {
  id: (name: string) => string;
  choice: CloudChoice;
  onChange: (next: CloudChoice) => void;
  plan: HealthCloudPlan | undefined;
  planLoading: boolean;
  draft: { url: string; allowInsecure: boolean; intervalSec: number | null };
  alreadyOnline: boolean;
}): React.JSX.Element {
  const cloud = choice.runMode === 'cloud';
  const set = (patch: Partial<CloudChoice>) => onChange({ ...choice, ...patch });
  const urlProblem = cloud ? cloudUrlProblem(draft.url, draft.allowInsecure) : null;
  const readOnly = cloud && plan !== undefined && plan.signedIn && !plan.canWrite;
  const blocked = cloud ? (plan?.blocked ?? urlProblem) : null;

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label="Where it runs"
        className={cn(SEGMENT_TRACK, 'w-fit gap-0.5 rounded-2xl')}
      >
        <button
          type="button"
          aria-pressed={!cloud}
          onClick={() => set({ runMode: 'local' })}
          className={cn(segmentClass(!cloud), 'gap-1.5')}
        >
          <Monitor className="h-3.5 w-3.5" />
          This computer
        </button>
        <button
          type="button"
          aria-pressed={cloud}
          onClick={() => set({ runMode: 'cloud' })}
          className={cn(segmentClass(cloud), 'gap-1.5')}
        >
          <Cloud className="h-3.5 w-3.5" />
          Runova Cloud
        </button>
      </div>

      {!cloud ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          This computer checks it while Runova is open. Switch to Runova Cloud to have it checked
          day and night, with alerts on Telegram too.
        </p>
      ) : planLoading && !plan ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5 animate-spin" />
          Reading your account type…
        </p>
      ) : (
        <div className="space-y-3">
          {plan && usageLine(plan) ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full bg-primary/12 px-2 py-0.5 font-medium text-primary">
                {usageLine(plan)}
              </span>
              <span>
                {plan.scopeName ? `${plan.scopeName} · ` : ''}checks every{' '}
                {formatHealthInterval(plan.minIntervalSec)} or slower
              </span>
            </p>
          ) : null}

          {blocked ? (
            <Notice
              tone="warning"
              size="sm"
              action={
                plan?.action === 'sign-in' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    onClick={() => void window.runova.account.signIn()}
                  >
                    Sign in
                  </Button>
                ) : plan?.action === 'upgrade' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    onClick={() => void window.runova.account.openWebsite('/account/plan')}
                  >
                    See account types
                  </Button>
                ) : null
              }
            >
              {blocked}
            </Notice>
          ) : null}

          {plan?.signedIn && !readOnly && !alreadyOnline ? (
            <div className="flex items-start gap-2.5 rounded-xl bg-foreground/[0.03] px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.08]">
              <Checkbox
                id={id('cloud-consent')}
                checked={choice.consent}
                onCheckedChange={(checked) => set({ consent: checked === true })}
                aria-describedby={`${id('cloud-consent')}-description`}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label htmlFor={id('cloud-consent')} className="leading-snug">
                  {CONSENT_TEXT}
                </Label>
                <p
                  id={`${id('cloud-consent')}-description`}
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  The key is sealed on the server and given only to the node that checks this
                  monitor. It is never shown again.
                </p>
              </div>
            </div>
          ) : null}

          {plan?.signedIn ? (
            <div className="space-y-3">
              <SettingSwitch
                id={id('cloud-in-app')}
                label="Alerts in the app"
                description="Everyone who can see the project hears when it goes down and comes back, here and on the website."
                checked={choice.notifyInApp}
                disabled={readOnly}
                onCheckedChange={(checked) => set({ notifyInApp: checked })}
              />
              <SettingSwitch
                id={id('cloud-telegram')}
                label="Alerts on Telegram"
                description={
                  plan.telegramLinked
                    ? 'Sent through the RunovaHQ bot to everyone who linked a chat.'
                    : 'Sent through the RunovaHQ bot. Your account has no chat linked yet.'
                }
                checked={choice.notifyTelegram}
                disabled={readOnly}
                onCheckedChange={(checked) => set({ notifyTelegram: checked })}
              />
              {!plan.telegramLinked && choice.notifyTelegram ? (
                <Button
                  type="button"
                  size="sm"
                  variant="soft"
                  onClick={() => void window.runova.dependencyAlerts.telegramConnect()}
                >
                  Link Telegram
                </Button>
              ) : null}
              {alreadyOnline ? (
                <SettingSwitch
                  id={id('cloud-mute')}
                  label="Mute for me"
                  description="You hear nothing about this monitor; the others still do."
                  checked={choice.muted}
                  onCheckedChange={(checked) => set({ muted: checked })}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
