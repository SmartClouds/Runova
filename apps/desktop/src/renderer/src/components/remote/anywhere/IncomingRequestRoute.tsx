import type { AnywhereIncoming, AnywherePermissions } from '@shared/anywhere';
import { useEffect, useId, useState } from 'react';
import { Check, Folder, Monitor, ShieldSolid, X } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAnywhere } from '@/stores/anywhereStore';
import { PermissionToggles } from './AccessSettingsDialog';

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}

/**
 * The window that asks the person at this computer (E61). It names the account, the computer it
 * asks from and how the server found them related, and lets the person narrow what the session
 * may do before saying yes. Saying nothing declines on its own after a minute.
 */
export function IncomingRequestRoute(): React.JSX.Element | null {
  const state = useAnywhere();
  const request = state.incoming[0];
  if (!request) return null;
  return (
    <Request
      key={request.sessionId}
      request={request}
      defaults={state.settings.defaultPermissions}
      more={state.incoming.length - 1}
    />
  );
}

function Request({
  request,
  defaults,
  more,
}: {
  request: AnywhereIncoming;
  defaults: AnywherePermissions;
  more: number;
}): React.JSX.Element {
  const [permissions, setPermissions] = useState(defaults);
  const [always, setAlways] = useState(false);
  const [now, setNow] = useState(Date.now());
  const alwaysId = useId();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const name = request.controller.displayName || request.controller.email;
  const answer = (accept: boolean) =>
    void window.runova.anywhere.respondIncoming(request.sessionId, {
      accept,
      permissions,
      alwaysAllow: accept && always,
    });

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-9 shrink-0 items-center justify-between px-4 [-webkit-app-region:drag]">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <ShieldSolid className="h-3 w-3 text-primary" />
          Runova Anywhere
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{left} s</span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
            {initials(name)}
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="text-[15px] font-semibold leading-snug">
              {request.intent === 'files'
                ? `${name} wants to open your files`
                : `${name} wants to control this computer`}
            </h1>
            <p className="truncate text-xs text-muted-foreground">{request.controller.email}</p>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <Chip tone={request.relation === 'own' ? 'primary' : 'neutral'}>
                {request.relation === 'own'
                  ? 'Your account'
                  : request.relation === 'teammate'
                    ? `Teammate in ${request.teams.join(', ')}`
                    : 'Not in your teams'}
              </Chip>
              {request.controller.deviceName ? (
                <Chip tone="neutral">
                  {request.intent === 'files' ? <Folder /> : <Monitor />}
                  From {request.controller.deviceName}
                </Chip>
              ) : null}
            </div>
          </div>
        </div>

        <div className="space-y-2.5 rounded-xl bg-foreground/[0.04] p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            They may
          </div>
          <PermissionToggles value={permissions} onChange={setPermissions} />
        </div>

        {request.relation === 'teammate' ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={alwaysId}
              checked={always}
              onCheckedChange={(value) => setAlways(value === true)}
            />
            <Label htmlFor={alwaysId} className="text-[13px] font-normal">
              Always let {name} in without asking
            </Label>
          </div>
        ) : null}
      </main>

      <footer className="flex shrink-0 items-center gap-2 border-t border-foreground/[0.06] px-5 py-3">
        {more > 0 ? (
          <span className="text-xs text-muted-foreground">{more} more waiting</span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="soft" shape="pill" onClick={() => answer(false)}>
            <X />
            Decline
          </Button>
          <Button shape="pill" autoFocus onClick={() => answer(true)}>
            <Check />
            Accept
          </Button>
        </div>
      </footer>
    </div>
  );
}
