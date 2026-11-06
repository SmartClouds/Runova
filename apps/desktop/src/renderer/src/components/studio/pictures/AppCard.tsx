import type { PicturesAppView } from '@runova/studio';
import { useEffect, useId, useState } from 'react';
import {
  Button,
  ChevronDown,
  ChevronUp,
  Chip,
  type ChipTone,
  Combobox,
  cn,
  ExternalLink,
  GLASS_CARD,
  Globe,
  Input,
  Label,
  Notice,
  Play,
  SignIn,
  Spinner,
  StopCircle,
} from '../kit';
import type { PicturesState } from './usePictures';

const STATUS: Record<PicturesAppView['status'], { label: string; tone: ChipTone }> = {
  stopped: { label: 'Not running', tone: 'neutral' },
  starting: { label: 'Starting', tone: 'primary' },
  running: { label: 'Running', tone: 'success' },
  failed: { label: 'Did not start', tone: 'destructive' },
};

/**
 * The linked project's app, which the screenshots are taken of: how it starts, where it answers,
 * and whether it is up. Studio starts it with the project's own run command, or uses one that is
 * already running at the address, and stops only what it started itself.
 */
export function AppCard({
  app,
  pictures,
}: {
  app: PicturesAppView;
  pictures: PicturesState;
}): React.JSX.Element | null {
  const id = useId();
  const [url, setUrl] = useState(app.url ?? '');
  const [showOutput, setShowOutput] = useState(false);
  useEffect(() => setUrl(app.url ?? ''), [app.url]);
  if (!app.project) return null;
  const status = STATUS[app.status];
  const busy = app.status === 'starting' || pictures.pending === 'start';
  const commands = app.project.runCommands;

  return (
    <section
      className={cn(GLASS_CARD, 'space-y-3 p-3')}
      aria-label={`The ${app.project.name} app for screenshots`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">{app.project.name}</h3>
        <Chip tone={status.tone} dot pulse={app.status === 'starting'} aria-live="polite">
          {status.label}
          {app.status === 'running' && app.url ? ` at ${app.url}` : ''}
        </Chip>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {app.status === 'running' ? (
            <>
              <Button
                size="sm"
                variant="soft"
                onClick={() => void pictures.signIn()}
                disabled={pictures.pending === 'sign-in'}
                title="Opens the app in a window that keeps its sign-in for the screenshots."
              >
                <SignIn /> Sign in first
              </Button>
              {app.startedByStudio && (
                <Button size="sm" variant="soft" onClick={() => void pictures.stopApp()}>
                  <StopCircle /> Stop
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="soft"
              disabled={busy}
              onClick={() => void pictures.startApp()}
            >
              {busy ? <Spinner className="animate-spin" /> : <Play />}
              {busy ? 'Starting...' : 'Start the app'}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-cmd`}>Run command</Label>
          {commands.length > 0 ? (
            <Combobox
              id={`${id}-cmd`}
              value={app.runCommandId ?? ''}
              options={commands.map((c) => ({
                value: c.id,
                label: c.label ? `${c.label}: ${c.command}` : c.command,
              }))}
              onChange={(value) => void pictures.setApp({ runCommandId: value || null })}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              The project has no run command. Add one in the project, or start the app yourself and
              enter its address.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-url`}>Address</Label>
          <Input
            id={`${id}-url`}
            value={url}
            placeholder="Found when the app starts, like http://localhost:5173"
            className="h-8 font-mono text-xs"
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => {
              const next = url.trim();
              if (next !== (app.url ?? '')) void pictures.setApp({ url: next || null });
            }}
          />
        </div>
      </div>

      {app.status === 'failed' && app.error && (
        <Notice tone="destructive" size="sm">
          {app.error}
        </Notice>
      )}
      {app.output.length > 0 && (
        <div>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showOutput}
            onClick={() => setShowOutput((v) => !v)}
          >
            {showOutput ? <ChevronUp /> : <ChevronDown />} What the app printed
          </Button>
          {showOutput && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/70 p-2 font-mono text-[11px] leading-relaxed text-white/80">
              {app.output.join('\n')}
            </pre>
          )}
        </div>
      )}
      {app.status === 'running' && app.url && (
        <a
          href={app.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:brightness-110"
        >
          <ExternalLink className="h-3 w-3" aria-hidden /> Open it in the browser
        </a>
      )}
    </section>
  );
}
