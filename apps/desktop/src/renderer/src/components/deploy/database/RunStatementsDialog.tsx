import { maskSecret } from '@runova/core';
import { useState } from 'react';
import { Spinner } from '@/components/icons';
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
import { CODE_WELL } from '../security/SecurityCard';

/**
 * Shows the statements an action turns into, with any password starred out, and runs them on
 * the user's yes. Used by the Users and Settings tabs, so nothing there runs unseen.
 */

export interface PendingStatements {
  title: string;
  description?: string;
  statements: string[];
  /** Hidden in the preview, still sent in the statements. */
  secret?: string;
  action: string;
  destructive?: boolean;
  database?: string | null;
  /** Says, while it runs, that it may take a while (index rebuilds, vacuums). */
  longRunning?: boolean;
  onDone?: () => void;
}

export function RunStatementsDialog({
  sessionId,
  pending,
  onClose,
  children,
}: {
  sessionId: string;
  pending: PendingStatements | null;
  onClose: () => void;
  /** Options that change the statements, shown above them. The caller rebuilds `pending`. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const text = pending?.statements.join('\n') ?? '';

  async function run() {
    if (!pending) return;
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await window.runova.database.query({
        sessionId,
        queryId: `admin-${Date.now().toString(36)}`,
        text,
        database: pending.database ?? null,
        confirmed: true,
      });
      if (outcome.status === 'failed') {
        setProblem(pending.secret ? maskSecret(outcome.error, pending.secret) : outcome.error);
        return;
      }
      pending.onDone?.();
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setProblem(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{pending?.title}</DialogTitle>
          {pending?.description ? (
            <DialogDescription>{pending.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
        <pre
          aria-label="Statements to run"
          className={cn(CODE_WELL, 'max-h-64 whitespace-pre-wrap')}
        >
          {pending?.secret ? maskSecret(text, pending.secret) : text}
        </pre>
        {busy && pending?.longRunning ? (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3 w-3 animate-spin" /> Running. On a big table this can take a
            while.
          </p>
        ) : null}
        {problem ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={pending?.destructive ? 'destructive' : 'default'}
            onClick={() => void run()}
            disabled={busy || !pending || pending.statements.length === 0}
          >
            {pending?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
