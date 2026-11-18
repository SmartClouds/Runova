import type { PhraseRef } from '@shared/phraseTypes';
import { useEffect, useState } from 'react';
import { Lock, Spinner } from '@/components/icons';
import { ExistingSecretField } from '@/components/phrase/ExistingSecretField';
import { NewSecretField, type SecretMode } from '@/components/phrase/NewSecretField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { cn } from '@/lib/utils';

export interface SshVaultUnlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'unlock' asks for the existing passkey; 'set' creates (or replaces) it. */
  mode: 'unlock' | 'set';
  /** Called once the vault is confirmed unlocked under the (possibly new) passkey. */
  onUnlocked: () => void;
}

export function SshVaultUnlockDialog({
  open,
  onOpenChange,
  mode,
  onUnlocked,
}: SshVaultUnlockDialogProps): React.JSX.Element {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  // A new passkey can be a recovery phrase Runova makes (E107).
  const [secretMode, setSecretMode] = useState<SecretMode>('phrase');
  const [phraseRef, setPhraseRef] = useState<PhraseRef | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPassphrase('');
    setConfirmPassphrase('');
    setSubmitting(false);
    setError(null);
  }, [open]);

  const byPhrase = mode === 'set' && secretMode === 'phrase';
  const canSubmit =
    mode === 'unlock'
      ? passphrase.length > 0
      : byPhrase
        ? phraseRef !== null
        : passphrase.length > 0 && passphrase === confirmPassphrase;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'unlock') {
        const ok = await window.runova.ssh.unlockVault(passphrase);
        if (!ok) {
          setError('Wrong passkey.');
          return;
        }
      } else {
        const result = await window.runova.ssh.setPasskey(
          byPhrase && phraseRef ? phraseRef : passphrase,
        );
        if (!result.ok) {
          setError(result.error ?? 'Could not set the passkey.');
          return;
        }
      }
      onOpenChange(false);
      onUnlocked();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(byPhrase ? 'max-h-[92vh] max-w-xl overflow-y-auto' : 'max-w-sm')}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-primary" />
            {mode === 'unlock' ? 'Unlock the vault' : 'Protect the vault with a passkey'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'unlock'
              ? 'Enter your vault passkey to use saved servers and project environments this session.'
              : 'Encrypts saved server passwords, key passphrases and project environment secrets with this passkey instead of just the OS keychain. If you forget it, those secrets cannot be recovered.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {mode === 'unlock' ? (
            <ExistingSecretField
              id="ssh-vault-passphrase"
              label="Passkey"
              value={passphrase}
              onChange={setPassphrase}
            />
          ) : (
            open && (
              <NewSecretField
                purpose="servers-passkey"
                label="Servers passkey"
                mode={secretMode}
                onModeChange={setSecretMode}
                onPhraseReady={setPhraseRef}
                typed={
                  <div className="flex flex-col gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="ssh-vault-passphrase">Passkey</Label>
                      <SecretInput
                        id="ssh-vault-passphrase"
                        value={passphrase}
                        onChange={setPassphrase}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ssh-vault-passphrase-confirm">Confirm passkey</Label>
                      <SecretInput
                        id="ssh-vault-passphrase-confirm"
                        value={confirmPassphrase}
                        onChange={setConfirmPassphrase}
                      />
                    </div>
                  </div>
                }
              />
            )
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit || submitting} onClick={() => void handleSubmit()}>
            {submitting && <Spinner className="h-4 w-4 animate-spin" />}
            {mode === 'unlock' ? 'Unlock' : 'Set passkey'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
