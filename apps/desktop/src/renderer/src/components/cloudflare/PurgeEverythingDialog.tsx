import type { CloudflareZone } from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';

/**
 * A full purge, behind typing the domain's name (the ResetVaultDialog pattern). The Purge cache
 * card and the zone header's purge menu both open it.
 */
export function PurgeEverythingDialog({
  zone,
  open,
  onOpenChange,
}: {
  zone: CloudflareZone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function purge(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.cloudflare.purgeCache(zone.id, { everything: true });
      toast.success(`Purged everything for ${zone.name}.`);
      setTyped('');
      onOpenChange(false);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped('');
          setProblem(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Purge everything for {zone.name}?</DialogTitle>
          <DialogDescription>
            Every cached file goes at once, so the next visits all reach your server until the cache
            fills again. That can slow the site down or strain the server for a while.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={inputId} className="text-sm font-normal">
            Type <span className="font-mono font-semibold">{zone.name}</span> to confirm
          </Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={typed.trim() !== zone.name || busy}
            onClick={() => void purge()}
          >
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Purge everything
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
