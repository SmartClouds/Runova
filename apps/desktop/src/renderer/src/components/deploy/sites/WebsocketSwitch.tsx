import { coreErrorMessage } from '@shared/coreErrors';
import type { SiteInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { withWebsockets } from '@/lib/deploy/sites/websocket';
import { cn } from '@/lib/utils';

/**
 * WebSockets on or off for one site, right on its row, so a live app (chat, dashboards, hot
 * reload) can be let through without opening the editor. The change is saved at once and goes
 * live with the next Apply, like any other saved change. The switch holds its new place while
 * the save runs and goes back if the core refuses it.
 */

// No "live" in the words: the row's Live chip owns it, and e2e finds text by substring.
const HINT =
  'Lets real-time connections (chat, dashboards, hot reload) through to the app. Saved at once, in effect after Apply.';
const ADMIN_ONLY = 'Only an Admin can change this.';

export function WebsocketSwitch({
  serverId,
  site,
  admin,
  onSaved,
}: {
  serverId: string;
  site: SiteInfo;
  admin: boolean;
  /** Reads the sites again; the switch lets go of its own state once that is done. */
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const hintId = useId();
  const [saving, setSaving] = useState<boolean | null>(null);
  const domain = site.settings.domains[0] ?? site.settings.id;
  const busy = saving !== null;
  const checked = saving ?? site.settings.websocket;
  const hint = admin ? HINT : ADMIN_ONLY;

  async function change(websocket: boolean): Promise<void> {
    setSaving(websocket);
    try {
      const result = await window.runova.deploySites.save(
        serverId,
        withWebsockets(site, websocket),
      );
      if (!result.site) {
        toast.error(
          result.problems.map((problem) => problem.message).join(' ') ||
            'nginx refused the change.',
        );
        return;
      }
      toast.success(`WebSockets ${websocket ? 'on' : 'off'} for ${domain}. Apply to put it live.`);
      await onSaved();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setSaving(null);
    }
  }

  return (
    <SimpleTooltip label={hint} className="max-w-64">
      {/* The whole label is the click target, not just the small switch. */}
      <label
        className={cn(
          'flex shrink-0 select-none items-center gap-2 rounded-full py-1 pr-1 pl-2.5 text-xs transition-colors',
          admin && !busy
            ? 'cursor-pointer text-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground'
            : 'text-muted-foreground',
        )}
      >
        <span aria-hidden>WebSockets</span>
        <Switch
          aria-label={`WebSockets for ${domain}`}
          aria-describedby={hintId}
          aria-busy={busy || undefined}
          checked={checked}
          onCheckedChange={(next) => void change(next)}
          disabled={!admin || busy}
        />
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      </label>
    </SimpleTooltip>
  );
}
