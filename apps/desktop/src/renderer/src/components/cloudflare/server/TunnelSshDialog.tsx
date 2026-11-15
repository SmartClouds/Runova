import type { CloudflareSshProbe } from '@shared/cloudflareTypes';
import type {
  CloudflareTunnelPreview,
  CloudflareTunnelStatus,
  FirewallChangeSetInfo,
  TunnelSshMode,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useId, useState } from 'react';
import { CircleCheck, CircleX, ExternalLink, Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { GuidedFix } from './GuidedFix';

/**
 * Who may open SSH while the tunnel is on. Each choice says plainly what it costs. Cloudflare
 * only and Mesh are applied over that route, and only after a test connection over it got in, so
 * the server's lockout check sees the way in that stays. Closed is the Owner's: it goes over the
 * core domain with the check's phrase and the password again, since no SSH remains to check.
 */

/** Cloudflare's guide for the Cloudflare One Client on a computer. */
export const ONE_CLIENT_DOCS =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/download-warp/';

const CHOICES: { mode: TunnelSshMode; title: string; line: string; risk: string }[] = [
  {
    mode: 'open',
    title: 'Open as the firewall has it',
    line: 'SSH works the way it does today, from wherever the firewall allows.',
    risk: 'The one port bots can still find.',
  },
  {
    mode: 'cloudflare',
    title: 'Cloudflare only',
    line: 'SSH goes through the tunnel behind Cloudflare Access. This app holds the only key.',
    risk: 'Other SSH tools need cloudflared and a token of their own.',
  },
  {
    mode: 'mesh',
    title: 'Cloudflare Mesh only',
    line: "Only your devices on Cloudflare Mesh reach SSH, at the server's Mesh address.",
    risk: 'Needs the Cloudflare One Client running on this computer.',
  },
  {
    mode: 'closed',
    title: 'Closed to everyone',
    line: 'No SSH at all. The app gets in through the core domain only.',
    risk: "If the tunnel fails, only your provider's console gets you in, unless break-glass is on.",
  },
];

function moveBetween(event: React.KeyboardEvent<HTMLDivElement>): void {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'),
  ];
  const at = radios.indexOf(event.target as HTMLButtonElement);
  if (at === -1) return;
  event.preventDefault();
  radios[(at + step + radios.length) % radios.length]?.focus();
}

export function TunnelSshDialog({
  open,
  serverId,
  status,
  canOwn,
  onOpenChange,
  onApplied,
  onProgress,
}: {
  open: boolean;
  serverId: string;
  status: CloudflareTunnelStatus;
  canOwn: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied: (change: FirewallChangeSetInfo | undefined) => void;
  onProgress: () => void;
}): React.JSX.Element {
  const id = useId();
  const [mode, setMode] = useState<TunnelSshMode>(status.sshMode);
  const [preview, setPreview] = useState<CloudflareTunnelPreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [probe, setProbe] = useState<CloudflareSshProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [meshAddress, setMeshAddress] = useState(status.meshAddress ?? null);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [applyError, setApplyError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(status.sshMode);
    setMeshAddress(status.meshAddress ?? null);
    setApplyError(null);
    setPhrase('');
    setPassword('');
  }, [open, status.sshMode, status.meshAddress]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPreview(null);
    setPreviewError(null);
    setProbe(null);
    // Until the server is a Mesh node the steps below say what comes first.
    if (mode === 'mesh' && !meshAddress) return;
    window.runova.cloudflareTunnel
      .previewSsh({ serverId, mode })
      .then((result) => current && setPreview(result))
      .catch((error: unknown) => current && setPreviewError(error));
    return () => {
      current = false;
    };
  }, [open, serverId, mode, meshAddress]);

  const unavailable = (choice: TunnelSshMode): string | null => {
    if (choice === 'cloudflare' && !status.sshHostname) {
      return 'Set the tunnel up again with an SSH name first.';
    }
    if (choice === 'closed' && !canOwn) return 'Only an Owner can close SSH to everyone.';
    return null;
  };

  async function test(route: 'cloudflare' | 'mesh'): Promise<void> {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await window.runova.cloudflareTunnel.probeSsh(serverId, route));
    } catch (error) {
      setProbe({ ok: false, client: null, message: (error as Error).message });
    } finally {
      setProbing(false);
    }
  }

  async function joinMesh(): Promise<void> {
    setJoining(true);
    setApplyError(null);
    try {
      await window.runova.cloudflareTunnel.joinMesh(serverId);
      for (let tries = 0; tries < 60; tries++) {
        const next = await window.runova.cloudflareTunnel.status(serverId);
        if (next.meshAddress) {
          setMeshAddress(next.meshAddress);
          onProgress();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      throw new Error(
        'The server did not get a Mesh address within two minutes. Its job log says why.',
      );
    } catch (error) {
      setApplyError(error);
    } finally {
      setJoining(false);
    }
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setApplyError(null);
    try {
      const result = await window.runova.cloudflareTunnel.applySsh({
        serverId,
        mode,
        ...(mode === 'closed' ? { overrideConfirmation: phrase, password } : {}),
      });
      onApplied(result.changeSet);
    } catch (error) {
      setApplyError(error);
    } finally {
      setBusy(false);
    }
  }

  const routed = mode === 'cloudflare' || mode === 'mesh';
  const commands = preview?.firewall?.commands ?? [];
  const confirmationPhrase = preview?.firewall?.guard.confirmationPhrase;
  const ready =
    !!preview &&
    !busy &&
    !unavailable(mode) &&
    (mode !== status.sshMode || commands.length > 0) &&
    (!routed || probe?.ok === true) &&
    (mode !== 'closed' || (phrase.trim().length > 0 && password.length > 0));

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <div className="flex max-h-[calc(85vh-3rem)] min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Who may open SSH</DialogTitle>
            <DialogDescription>
              The sites already come through the tunnel. This decides what happens to SSH, the one
              port the tunnel leaves alone until you choose.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
            <div
              role="radiogroup"
              aria-label="SSH access"
              onKeyDown={moveBetween}
              className="grid gap-2 sm:grid-cols-2"
            >
              {CHOICES.map((choice) => {
                const active = mode === choice.mode;
                const reason = unavailable(choice.mode);
                return (
                  <button
                    key={choice.mode}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    disabled={!!reason || busy}
                    onClick={() => setMode(choice.mode)}
                    className={cn(
                      'flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 text-left outline-none ring-1 ring-inset transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                      active
                        ? 'bg-primary/[0.06] ring-primary/40'
                        : 'ring-foreground/10 hover:bg-foreground/[0.04] hover:ring-foreground/20',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
                      {choice.title}
                      {status.sshMode === choice.mode && (
                        <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[11px] font-normal text-muted-foreground">
                          Now
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{choice.line}</span>
                    <span className="text-xs text-warning">{reason ?? choice.risk}</span>
                  </button>
                );
              })}
            </div>

            {mode === 'mesh' && (
              <ol className="space-y-2 rounded-xl px-3 py-2.5 text-sm ring-1 ring-inset ring-foreground/[0.08]">
                <li className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    1. Add the server to Mesh
                    {meshAddress && (
                      <span className="ml-2 font-mono text-xs text-success">{meshAddress}</span>
                    )}
                  </span>
                  {!meshAddress && (
                    <Button
                      size="sm"
                      variant="soft"
                      disabled={joining}
                      onClick={() => void joinMesh()}
                    >
                      {joining && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                      Add to Mesh
                    </Button>
                  )}
                </li>
                <li className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    2. On this computer, install the Cloudflare One Client and sign in to your
                    organization
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void window.runova.shell.openExternal(ONE_CLIENT_DOCS)}
                  >
                    How <ExternalLink className="h-3 w-3" />
                  </Button>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-2">
                  <span>3. Test SSH over Mesh</span>
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={!meshAddress || probing}
                    onClick={() => void test('mesh')}
                  >
                    {probing && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                    Test
                  </Button>
                </li>
              </ol>
            )}

            {mode === 'cloudflare' && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.08]">
                <span className="text-sm">
                  Test SSH through the tunnel at{' '}
                  <span className="font-mono text-xs">{status.sshHostname}</span>
                </span>
                <Button
                  size="sm"
                  variant="soft"
                  disabled={probing}
                  onClick={() => void test('cloudflare')}
                >
                  {probing && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                  Test
                </Button>
              </div>
            )}

            {probe && (
              <p
                role="status"
                className={cn(
                  'flex items-start gap-2 text-sm',
                  probe.ok ? 'text-success' : 'text-destructive',
                )}
              >
                {probe.ok ? (
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <CircleX className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                {probe.message}
              </p>
            )}

            {previewError ? (
              <GuidedFix error={previewError} />
            ) : (
              preview && (
                <section aria-label="Firewall commands" className="space-y-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {commands.length === 0
                      ? 'The firewall already matches'
                      : `${commands.length} firewall commands`}
                  </h4>
                  {commands.length > 0 && (
                    <pre className="max-h-32 overflow-auto rounded-xl bg-foreground/[0.03] p-2.5 font-mono text-xs ring-1 ring-inset ring-foreground/[0.08]">
                      {commands.join('\n')}
                    </pre>
                  )}
                  {routed && commands.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Applied over the {mode === 'mesh' ? 'Mesh' : 'tunnel'} connection, so the
                      server checks that this computer still gets in that way.
                    </p>
                  )}
                </section>
              )
            )}

            {mode === 'closed' && preview && (
              <div className="space-y-2 rounded-xl bg-destructive/[0.05] px-3 py-2.5 ring-1 ring-inset ring-destructive/20">
                <p className="flex items-start gap-2 text-xs text-destructive">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  No SSH connection will reach this server. Type the phrase to go ahead.
                </p>
                <Label htmlFor={`${id}-phrase`} className="text-xs text-muted-foreground">
                  Type <span className="font-mono text-foreground">{confirmationPhrase}</span>
                </Label>
                <Input
                  id={`${id}-phrase`}
                  value={phrase}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setPhrase(event.target.value)}
                  className="h-8 font-mono text-xs"
                />
                <Label htmlFor={`${id}-password`} className="text-xs text-muted-foreground">
                  Your password on the server core
                </Label>
                <Input
                  id={`${id}-password`}
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}
            {applyError ? <GuidedFix error={applyError} /> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={mode === 'closed' ? 'destructive' : 'default'}
              disabled={!ready}
              onClick={() => void apply()}
            >
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              Apply
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
