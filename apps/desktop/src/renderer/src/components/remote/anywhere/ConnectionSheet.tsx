import { type AnywhereOutgoing, formatRemoteId } from '@shared/anywhere';
import { useEffect, useState } from 'react';
import {
  Check,
  Eye,
  EyeOff,
  Key,
  Lock,
  Route,
  ShieldSolid,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type StepState = 'done' | 'current' | 'todo';

/** Where each phase sits on the steps. `failed` and the questions stay on the step they stopped at. */
const STEP_OF: Record<AnywhereOutgoing['phase'], number> = {
  requesting: 0,
  'needs-password': 0,
  'key-changed': 0,
  waiting: 1,
  connecting: 2,
  securing: 2,
  connected: 3,
  failed: 0,
};

function steps(outgoing: AnywhereOutgoing): { label: string; state: StepState }[] {
  const labels =
    outgoing.mode === 'ask'
      ? ['Find the computer', 'Accepted', 'Secure the connection', 'Connected']
      : ['Find the computer', 'Secure the connection', 'Connected'];
  let at = STEP_OF[outgoing.phase];
  if (outgoing.mode === 'password' && at > 0) at -= 1;
  if (outgoing.phase === 'connected') at = labels.length;
  return labels.map((label, index) => ({
    label,
    state: index < at ? 'done' : index === at ? 'current' : 'todo',
  }));
}

/**
 * The connection as it happens (E61): finding the computer, someone accepting, securing the link,
 * connected. Every way it can stop has its own words and one clear next step.
 */
export function ConnectionSheet({ outgoing }: { outgoing: AnywhereOutgoing }): React.JSX.Element {
  const [hidden, setHidden] = useState(false);
  const name = outgoing.hostName || formatRemoteId(outgoing.remoteId);
  const api = window.runova.anywhere;

  // A new attempt brings the sheet back.
  useEffect(() => {
    if (outgoing.phase !== 'connected') setHidden(false);
  }, [outgoing.phase]);

  function close(): void {
    if (outgoing.phase === 'connected') setHidden(true);
    else void api.disconnect();
  }

  return (
    <Dialog open={!hidden} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {outgoing.phase === 'connected' ? `Connected to ${name}` : `Connecting to ${name}`}
          </DialogTitle>
          <DialogDescription>
            {outgoing.intent === 'files' ? 'Files only, no screen.' : 'Screen, mouse and keyboard.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto">
          <ol className="flex items-start gap-2 py-1" aria-label="Progress">
            {steps(outgoing).map((step) => (
              <li
                key={step.label}
                data-state={step.state}
                className="flex min-w-0 flex-1 flex-col gap-1.5"
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1 rounded-full transition-colors duration-300',
                    step.state === 'done' && 'bg-primary',
                    step.state === 'current' && 'bg-primary/40',
                    step.state === 'todo' && 'bg-foreground/10',
                    outgoing.phase === 'failed' && step.state === 'current' && 'bg-destructive/60',
                  )}
                />
                <span
                  className={cn(
                    'truncate text-[11px] font-medium',
                    step.state === 'todo' ? 'text-muted-foreground/70' : 'text-foreground/85',
                  )}
                >
                  {step.label}
                </span>
              </li>
            ))}
          </ol>

          <Body outgoing={outgoing} name={name} onHide={() => setHidden(true)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Body({
  outgoing,
  name,
  onHide,
}: {
  outgoing: AnywhereOutgoing;
  name: string;
  onHide: () => void;
}): React.JSX.Element {
  const api = window.runova.anywhere;
  switch (outgoing.phase) {
    case 'needs-password':
      return <PasswordForm outgoing={outgoing} name={name} />;
    case 'key-changed':
      return (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-xl bg-warning/10 p-3 text-[13px] ring-1 ring-warning/30">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p>
              The key changed since you last connected to {name}. That happens when Runova is
              reinstalled there, but it can also mean someone is pretending to be it. Check with the
              owner before you go on.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="soft" shape="pill" onClick={() => void api.disconnect()}>
              Cancel
            </Button>
            <Button shape="pill" onClick={() => void api.trustNewKey()}>
              Trust the new key and connect
            </Button>
          </div>
        </div>
      );
    case 'connected':
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Fact icon={outgoing.transport === 'relay' ? Route : ShieldSolid} label="Connection">
              {outgoing.transport === 'relay'
                ? 'Through the Runova relay'
                : 'Direct, computer to computer'}
            </Fact>
            <Fact icon={Lock} label="Safety code">
              <span aria-label="Safety code" className="font-mono tabular-nums tracking-widest">
                {outgoing.safetyCode
                  ? `${outgoing.safetyCode.slice(0, 3)} ${outgoing.safetyCode.slice(3)}`
                  : '------'}
              </span>
            </Fact>
          </div>
          <p className="text-xs text-muted-foreground">
            Encrypted end to end. If the person at {name} sees the same safety code, no one is in
            between.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="soft" shape="pill" onClick={onHide}>
              Hide
            </Button>
            <Button variant="danger" shape="pill" onClick={() => void api.disconnect()}>
              Disconnect
            </Button>
          </div>
        </div>
      );
    case 'failed':
      return (
        <div className="space-y-4">
          <p
            role="alert"
            className="rounded-xl bg-destructive/8 p-3 text-[13px] text-foreground ring-1 ring-destructive/25"
          >
            {outgoing.error}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="soft" shape="pill" onClick={() => void api.disconnect()}>
              Close
            </Button>
            <Button
              shape="pill"
              onClick={() =>
                void api.connect({ remoteId: outgoing.remoteId, intent: outgoing.intent })
              }
            >
              Try again
            </Button>
          </div>
        </div>
      );
    default:
      return <Progress outgoing={outgoing} name={name} />;
  }
}

function Progress({
  outgoing,
  name,
}: {
  outgoing: AnywhereOutgoing;
  name: string;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!outgoing.ringsUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [outgoing.ringsUntil]);
  const left = outgoing.ringsUntil
    ? Math.max(0, Math.ceil((outgoing.ringsUntil - now) / 1000))
    : null;
  const line =
    outgoing.phase === 'waiting'
      ? `Waiting for someone at ${name} to accept.`
      : outgoing.phase === 'securing'
        ? 'Checking it is really that computer and agreeing on keys.'
        : outgoing.phase === 'connecting'
          ? 'Looking for the fastest way through: direct first, then the Runova relay.'
          : 'Asking Runova where it is.';
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-[13px]">
        <Spinner className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
        <span className="flex-1">{line}</span>
        {left !== null ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{left} s</span>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button
          variant="soft"
          shape="pill"
          onClick={() => void window.runova.anywhere.disconnect()}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PasswordForm({
  outgoing,
  name,
}: {
  outgoing: AnywhereOutgoing;
  name: string;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!password) return;
        setBusy(true);
        void window.runova.anywhere.submitPassword(password, save).finally(() => setBusy(false));
      }}
    >
      <p className="text-[13px] text-muted-foreground">
        Type the unattended-access password set on {name}. It stays on this computer: Runova checks
        it with {name} directly and never sends it to anyone.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="anywhere-password">Password</Label>
        <div className="relative">
          <Key className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="anywhere-password"
            type={show ? 'text' : 'password'}
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="pl-9 pr-10"
          />
          <button
            type="button"
            onClick={() => setShow((value) => !value)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        {outgoing.wrongPassword ? (
          <p role="alert" className="text-xs text-destructive">
            That password did not work. Check it with the owner and try again.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="anywhere-save"
          checked={save}
          onCheckedChange={(value) => setSave(value === true)}
        />
        <Label htmlFor="anywhere-save" className="text-[13px] font-normal">
          Save it in Runova for next time
        </Label>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="soft"
          shape="pill"
          onClick={() => void window.runova.anywhere.disconnect()}
        >
          Cancel
        </Button>
        <Button type="submit" shape="pill" disabled={!password || busy}>
          {busy ? <Spinner className="animate-spin" /> : <Check />}
          Connect
        </Button>
      </div>
    </form>
  );
}

function Fact({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-xl bg-foreground/[0.04] p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 text-[13px] font-medium">{children}</div>
    </div>
  );
}
