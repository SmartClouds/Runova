import { useEffect, useState } from 'react';
import { ExternalLink, Pause, Play, Power, Route, ShieldSolid } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useAnywhere } from '@/stores/anywhereStore';

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The bar at the top of the host's screen while anyone is connected (E61): who, for how long, and
 * one click to pause their input or end it. It is there the whole time, so no one is ever watched
 * without knowing it.
 */
export function HostBarRoute(): React.JSX.Element | null {
  const state = useAnywhere();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const root = document.documentElement;
    const previous = [root.style.background, document.body.style.background];
    root.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      clearInterval(timer);
      [root.style.background, document.body.style.background] = previous;
    };
  }, []);

  const sessions = state.hosted;
  if (sessions.length === 0) return null;
  const first = sessions[0];
  const oldest = Math.min(...sessions.map((s) => s.startedAt));
  const api = window.runova.anywhere;
  const label =
    sessions.length > 1
      ? `${sessions.length} people are connected`
      : first.intent === 'files'
        ? `${first.controllerName} is browsing your files`
        : first.permissions.control
          ? `${first.controllerName} is controlling this computer`
          : `${first.controllerName} is viewing this screen`;

  return (
    <div className="flex h-screen items-center justify-center p-1">
      <div className="flex h-12 w-full items-center gap-3 rounded-full bg-[hsl(var(--background)/0.92)] pl-4 pr-1.5 shadow-[0_8px_30px_-8px_rgb(0_0_0/0.45)] ring-1 ring-primary/40 backdrop-blur [-webkit-app-region:drag]">
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-semibold">{label}</div>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {first.transport === 'relay' ? (
              <Route className="h-2.5 w-2.5" />
            ) : (
              <ShieldSolid className="h-2.5 w-2.5" />
            )}
            <span className="font-mono tabular-nums">{elapsed(now - oldest)}</span>
            {state.inputPaused ? <span className="text-warning">· input paused</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <SimpleTooltip label="Open Runova">
            <Button
              size="icon-sm"
              variant="ghost"
              shape="pill"
              aria-label="Open Runova"
              onClick={() => void api.openApp()}
            >
              <ExternalLink />
            </Button>
          </SimpleTooltip>
          {first.permissions.control || sessions.some((s) => s.permissions.control) ? (
            <Button
              size="sm"
              variant="soft"
              shape="pill"
              onClick={() => void api.pauseInput(!state.inputPaused)}
            >
              {state.inputPaused ? <Play /> : <Pause />}
              {state.inputPaused ? 'Resume input' : 'Pause input'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="destructive"
            shape="pill"
            onClick={() => {
              for (const session of sessions) void api.endHosted(session.sessionId);
            }}
          >
            <Power />
            {sessions.length > 1 ? 'End all' : 'End session'}
          </Button>
        </div>
      </div>
    </div>
  );
}
