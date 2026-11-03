import type { ServiceLimits } from '@runova/core';
import { useState } from 'react';
import { Spinner } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { type LimitsHostFacts, sameLimits } from '@/lib/deploy/limits/editor';
import { ResourceLimitsEditor } from './ResourceLimitsEditor';

/**
 * Changing the limits of something already running. For an app the caps go into a new revision
 * and the services whose caps changed restart; for a standalone container (`cpuOnlyLive`) Docker
 * applies CPU and memory at once, and they last only as long as that container does.
 */

export interface EditLimitsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: readonly string[];
  /** The limits saved now. */
  initial: readonly ServiceLimits[];
  host: LimitsHostFacts;
  /** What each service uses now, for the warning before a cap that would stop it. */
  usage?: Readonly<Record<string, { memoryMb?: number }>>;
  /** The service the dialog was opened for. */
  focus?: string;
  cpuOnlyLive?: boolean;
  busy: boolean;
  error?: string | null;
  onSave: (limits: ServiceLimits[]) => void;
}

const STACK_NOTE = 'The services whose limits change restart to apply them.';
const LIVE_NOTE =
  'These apply right away without a restart. Whatever recreates this container drops them.';

export function EditLimitsDialog({
  open,
  onOpenChange,
  services,
  initial,
  host,
  usage,
  focus,
  cpuOnlyLive = false,
  busy,
  error = null,
  onSave,
}: EditLimitsDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<ServiceLimits[]>(() => [...initial]);
  const [shownOpen, setShownOpen] = useState(open);
  // Each opening starts from what is saved, not from an edit that was cancelled.
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) setDraft([...initial]);
  }
  const unchanged = sameLimits(draft, initial);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit resource limits</DialogTitle>
          <DialogDescription>
            Choose how much of the server each container may use.
          </DialogDescription>
        </DialogHeader>
        <ResourceLimitsEditor
          services={services}
          value={draft}
          onChange={setDraft}
          host={host}
          usage={usage}
          focus={focus}
          cpuOnlyLive={cpuOnlyLive}
        />
        {error && (
          <Notice tone="destructive" size="sm" role="alert">
            {error}
          </Notice>
        )}
        <p className="text-xs text-muted-foreground">{cpuOnlyLive ? LIVE_NOTE : STACK_NOTE}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || unchanged} onClick={() => onSave(draft)}>
            {busy && <Spinner className="motion-safe:animate-spin" />}
            {busy ? 'Saving' : 'Save limits'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
