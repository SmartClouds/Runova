import type { AiAccessApproval, AiApprovalDecision, AiToolRisk } from '@shared/aiAccessTypes';
import { useEffect, useRef, useState } from 'react';
import { CircleInfo, Eye, EyeOff, FolderKanban, Robot } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ApprovalPreview, hasSecrets } from './ApprovalPreview';

/**
 * Asks the user about each thing an AI agent wants to do in Runova (E46), when their AI access
 * settings say to ask in the Runova window. One approval shows at a time, in the order they
 * arrived. Deny has the focus, so a stray Enter allows nothing; Ctrl+Enter (Cmd+Enter on a Mac)
 * allows. Closing the window counts as Deny, and so does letting the timer run out.
 */

const RISK: Record<AiToolRisk, { label: string; variant: 'secondary' | 'default' | 'warning' }> = {
  read: { label: 'Read only', variant: 'secondary' },
  write: { label: 'Makes changes', variant: 'secondary' },
  sensitive: { label: 'Sensitive', variant: 'warning' },
};

function formatLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Ticks once a second while an approval is open, for the countdown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function AiAccessApprovalHost(): React.JSX.Element | null {
  const [pending, setPending] = useState<AiAccessApproval[]>([]);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void window.runova.aiAccess.pendingApprovals().then((list) => {
      if (active && Array.isArray(list)) setPending(list);
    });
    const unsubscribe = window.runova.aiAccess.onApprovalsChanged((list) => {
      if (active) setPending(list);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const current = pending[0];
  const now = useNow(Boolean(current));

  // Values are hidden again for every new approval.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the approval changes
  useEffect(() => setReveal(false), [current?.id]);

  async function decide(decision: AiApprovalDecision): Promise<void> {
    if (busy || !current) return;
    const id = current.id;
    setBusy(true);
    try {
      await window.runova.aiAccess.decide(id, decision);
    } finally {
      // Runova announces the new list too; dropping it here keeps the dialog from lingering.
      setPending((list) => list.filter((one) => one.id !== id));
      setBusy(false);
    }
  }

  if (!current) return null;

  const risk = RISK[current.risk];
  const total = current.expiresAt - current.createdAt;
  const left = current.expiresAt - now;
  const share = total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
  const secrets = hasSecrets(current.preview);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void decide('deny');
      }}
    >
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          denyRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void decide('allow');
          }
        }}
      >
        <DialogHeader className="gap-3 border-b border-border/70 px-6 pb-5 pt-6">
          <div className="flex items-center gap-2.5 pr-8">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary ring-1 ring-inset ring-primary/25">
              <Robot className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 text-xs leading-tight">
              <p className="truncate font-medium text-foreground">{current.agent}</p>
              <p className="text-muted-foreground">
                {current.callerKind === 'runova' ? 'in a Runova tab' : 'in another app'}
              </p>
            </div>
            <Badge variant={risk.variant}>{risk.label}</Badge>
          </div>
          <DialogTitle className="text-base leading-snug">{current.preview.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {current.projectName ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-foreground/80">
                  <FolderKanban className="h-3 w-3" />
                  {current.projectName}
                </span>
              ) : null}
              <span>{current.toolTitle}</span>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto px-6 py-5">
          {secrets ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={() => setReveal((value) => !value)}
              >
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {reveal ? 'Hide values' : 'Show values'}
              </Button>
            </div>
          ) : null}
          <ApprovalPreview preview={current.preview} reveal={reveal} />
          {current.cliFallback ? (
            <p className="flex items-start gap-2 rounded-lg bg-primary/8 px-3 py-2.5 text-xs leading-relaxed text-foreground/80">
              <CircleInfo className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              You chose to answer in the CLI, but {current.agent} can&apos;t show approvals, so
              Runova is asking here.
            </p>
          ) : null}
        </div>

        <div className="h-0.5 bg-border/40" aria-hidden>
          <div
            className={cn(
              'h-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none',
              share < 0.2 ? 'bg-destructive/70' : 'bg-primary/60',
            )}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <DialogFooter className="items-center gap-2 bg-muted/20 px-6 py-3.5 sm:justify-between">
          <p className="text-xs text-muted-foreground" aria-live="off">
            {pending.length > 1 ? <span className="mr-2">1 of {pending.length}</span> : null}
            <span>Denies itself in {formatLeft(left)}</span>
          </p>
          <div className="flex items-center gap-2">
            <Button
              ref={denyRef}
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void decide('deny')}
            >
              Deny
            </Button>
            <Button
              type="button"
              variant="soft"
              size="sm"
              disabled={busy}
              onClick={() => void decide('allow_session')}
            >
              Allow for this session
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              title="Ctrl+Enter"
              onClick={() => void decide('allow')}
            >
              Allow
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
