import { filesLabel, type SendOfferView } from '@shared/fileSend';
import { formatBytes } from '@shared/remoteProtocol';
import { useCallback, useEffect, useId, useState } from 'react';
import { Check, FolderOpen, Inbox, Monitor, Quote, Smartphone, X } from '@/components/icons';
import { Chip, Notice } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { useFileSend } from '@/stores/fileSendStore';
import { fileKind, initials, KIND_LOOK } from './fileKinds';

/**
 * The window that asks the person here about files offered to them (E112). It names who sends
 * and from which device, lists what comes with its sizes, and says where it goes, with the
 * chance to pick another folder first. Accept is never the focused button, so a key pressed by
 * chance only ever declines (Escape). Saying nothing declines on its own after a minute.
 */
export function IncomingFilesRoute(): React.JSX.Element | null {
  const state = useFileSend();
  const offer = state.offers[0];
  if (!offer) return null;
  return <Offer key={offer.batchId} offer={offer} more={state.offers.length - 1} />;
}

function Offer({ offer, more }: { offer: SendOfferView; more: number }): React.JSX.Element {
  const api = window.runova.fileSend;
  const [now, setNow] = useState(Date.now());
  const [folder, setFolder] = useState(offer.folder);
  const [pickedFolder, setPickedFolder] = useState(false);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alwaysId = useId();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const answer = useCallback(
    async (accept: boolean) => {
      setBusy(true);
      setError(null);
      try {
        await api.respond(
          offer.batchId,
          accept ? { accept: true, alwaysAcceptOwn: always } : { accept: false },
        );
      } catch (problem) {
        setError(ipcErrorMessage(problem, 'The files could not be accepted.'));
      } finally {
        setBusy(false);
      }
    },
    [api, always, offer.batchId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void answer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer]);

  const left = Math.max(0, Math.ceil((offer.expiresAt - now) / 1000));
  const noRoom = !pickedFolder && offer.freeBytes !== null && offer.freeBytes < offer.totalBytes;
  const own = offer.peer.relation === 'own';
  const who = offer.peer.name || offer.peer.deviceName;
  const DeviceIcon = offer.peer.kind === 'phone' ? Smartphone : Monitor;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-9 shrink-0 items-center justify-between px-4 [-webkit-app-region:drag]">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Inbox className="h-3 w-3 text-primary" />
          Incoming files
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{`${left} s`}</span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
            {initials(who)}
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="text-[15px] font-semibold leading-snug" {...persianTextProps(who)}>
              {`${who} wants to send you ${filesLabel(offer.fileCount)}`}
            </h1>
            {offer.peer.email ? (
              <p className="truncate text-xs text-muted-foreground">{offer.peer.email}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <Chip tone={own ? 'primary' : 'neutral'}>{own ? 'Your device' : 'Teammate'}</Chip>
              <Chip tone="neutral">
                <DeviceIcon />
                {`From ${offer.peer.deviceName}`}
              </Chip>
            </div>
          </div>
        </div>

        {offer.note ? (
          <blockquote className="flex gap-2 rounded-xl bg-foreground/[0.04] px-3 py-2.5 text-[13px] leading-relaxed">
            <Quote aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-primary/70" />
            <span {...persianTextProps(offer.note)}>{offer.note}</span>
          </blockquote>
        ) : null}

        <div className="overflow-hidden rounded-xl bg-foreground/[0.025] ring-1 ring-inset ring-foreground/[0.07]">
          <ul aria-label="Files" className="settings-rows rail-scroll max-h-44 overflow-y-auto">
            {offer.entries.map((entry) => {
              const look = KIND_LOOK[entry.kind === 'folder' ? 'folder' : fileKind(entry.name)];
              return (
                <li
                  key={`${entry.kind}:${entry.name}`}
                  className="flex items-center gap-2.5 px-3 py-2"
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                      look.tile,
                    )}
                  >
                    <look.Icon className="h-3 w-3" />
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[13px] font-medium"
                    {...persianTextProps(entry.name)}
                  >
                    {entry.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {entry.kind === 'folder'
                      ? `${filesLabel(entry.fileCount)}, ${formatBytes(entry.size)}`
                      : formatBytes(entry.size)}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
            <span>In all</span>
            <span className="tabular-nums">{`${filesLabel(offer.fileCount)}, ${formatBytes(offer.totalBytes)}`}</span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted-foreground">Save to</div>
            <div className="truncate text-[13px] font-medium" dir="ltr">
              {folder}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="soft"
            shape="pill"
            disabled={busy}
            onClick={() =>
              void api.chooseFolder(offer.batchId).then((chosen) => {
                if (!chosen) return;
                setFolder(chosen);
                setPickedFolder(true);
              })
            }
          >
            Change
          </Button>
        </div>

        {noRoom ? (
          <Notice tone="warning" size="sm">
            {`There is not enough room there: these files need ${formatBytes(offer.totalBytes)} and ${formatBytes(offer.freeBytes ?? 0)} is free. Pick another folder.`}
          </Notice>
        ) : null}

        {own ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={alwaysId}
              checked={always}
              onCheckedChange={(value) => setAlways(value === true)}
            />
            <Label htmlFor={alwaysId} className="text-[13px] font-normal">
              Always accept files from my own devices
            </Label>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </main>

      <footer className="flex shrink-0 items-center gap-2 border-t border-foreground/[0.06] px-5 py-3">
        {more > 0 ? (
          <span className="text-xs text-muted-foreground">{`${more} more waiting`}</span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="soft" shape="pill" disabled={busy} onClick={() => void answer(false)}>
            <X />
            Decline
          </Button>
          <Button shape="pill" disabled={busy || noRoom} onClick={() => void answer(true)}>
            <Check />
            Accept
          </Button>
        </div>
      </footer>
    </div>
  );
}
