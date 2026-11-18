import { useEffect, useState } from 'react';
import { Lock, Spinner } from '@/components/icons';
import { ExistingSecretField } from '@/components/phrase/ExistingSecretField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface BackupEnvironmentsPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentCount: number;
  /**
   * Restores with the password, or without the environments when it is null. Resolves to
   * 'wrong-password' to keep the dialog open and ask again.
   */
  onRestore: (password: string | null) => Promise<'done' | 'wrong-password'>;
}

export function BackupEnvironmentsPasswordDialog({
  open,
  onOpenChange,
  environmentCount,
  onRestore,
}: BackupEnvironmentsPasswordDialogProps): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'restore' | 'skip' | null>(null);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setError(null);
    setBusy(null);
  }, [open]);

  async function submit(withPassword: boolean): Promise<void> {
    if (busy || (withPassword && !password)) return;
    setBusy(withPassword ? 'restore' : 'skip');
    setError(null);
    try {
      const outcome = await onRestore(withPassword ? password : null);
      if (outcome === 'wrong-password') {
        setError('That password does not open this backup.');
        return;
      }
      onOpenChange(false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit(true);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-primary" /> Backup password
          </DialogTitle>
          <DialogDescription>
            This backup has {environmentCount} project{' '}
            {environmentCount === 1 ? 'environment' : 'environments'} with env files and
            credentials, protected by the password chosen when it was exported. Enter it to restore
            them, or restore everything else without them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <ExistingSecretField
            id="backup-environments-password"
            label="Password"
            value={password}
            onChange={setPassword}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="soft" disabled={busy !== null} onClick={() => void submit(false)}>
            {busy === 'skip' && <Spinner className="h-4 w-4 animate-spin" />}
            Restore without them
          </Button>
          <Button disabled={!password || busy !== null} onClick={() => void submit(true)}>
            {busy === 'restore' && <Spinner className="h-4 w-4 animate-spin" />}
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
