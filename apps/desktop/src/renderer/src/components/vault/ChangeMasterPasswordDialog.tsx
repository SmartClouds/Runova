import { masterPasswordProblem } from '@runova/core';
import type { PhraseRef } from '@shared/phraseTypes';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/icons';
import { NewSecretField, type SecretMode } from '@/components/phrase/NewSecretField';
import { PhraseInput, pastedPhrase } from '@/components/phrase/PhraseInput';
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
import { PasswordStrengthMeter } from './PasswordStrengthMeter';

/** A new master password: one the person types, or a recovery phrase Runova makes (E107). */
export function ChangeMasterPasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const ids = { current: useId(), next: useId(), again: useId() };
  const [current, setCurrent] = useState('');
  const [currentByPhrase, setCurrentByPhrase] = useState(false);
  const [pasted, setPasted] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<SecretMode>('phrase');
  const [phraseRef, setPhraseRef] = useState<PhraseRef | null>(null);
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typed = mode === 'typed';
  const problem = next ? masterPasswordProblem(next) : null;
  const mismatch = again !== '' && again !== next;
  const nextReady = typed ? next !== '' && !problem && again === next : phraseRef !== null;
  const ready = current !== '' && nextReady && !busy;

  function reset(): void {
    setCurrent('');
    setCurrentByPhrase(false);
    setPasted(undefined);
    setNext('');
    setAgain('');
    setError(null);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (
        await window.runova.vault.changePassword(current, typed || !phraseRef ? next : phraseRef)
      ) {
        toast.success('Master password changed', {
          description: typed
            ? 'Use the new password the next time you unlock the vault.'
            : 'Use your new recovery phrase the next time you unlock the vault.',
        });
        reset();
        onOpenChange(false);
      } else {
        setError('Your current password is wrong.');
      }
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <DialogContent
        className={cn(
          'max-h-[92vh] overflow-y-auto',
          typed && !currentByPhrase ? 'max-w-md' : 'max-w-xl',
        )}
      >
        <DialogHeader>
          <DialogTitle>Change master password</DialogTitle>
          <DialogDescription>
            The vault is encrypted again with a fresh key. Old copies of the vault file keep the old
            password.
          </DialogDescription>
        </DialogHeader>
        <form id="vault-change-password" className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            {currentByPhrase ? (
              <>
                <p className="text-sm font-medium">Current recovery phrase</p>
                <PhraseInput initial={pasted} onChange={setCurrent} />
              </>
            ) : (
              <>
                <Label htmlFor={ids.current}>Current password</Label>
                <SecretInput
                  id={ids.current}
                  value={current}
                  onChange={setCurrent}
                  autoFocus
                  onPaste={(event) => {
                    const phrase = pastedPhrase(event);
                    if (!phrase) return;
                    event.preventDefault();
                    setPasted(phrase);
                    setCurrentByPhrase(true);
                  }}
                />
              </>
            )}
            <button
              type="button"
              className="text-xs font-medium text-primary"
              onClick={() => {
                setCurrent('');
                setPasted(undefined);
                setCurrentByPhrase((on) => !on);
              }}
            >
              {currentByPhrase ? 'Type the current password instead' : 'It is a recovery phrase'}
            </button>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">New master password</p>
            <NewSecretField
              purpose="vault"
              label="Vault"
              mode={mode}
              onModeChange={setMode}
              onPhraseReady={setPhraseRef}
              typedLabel="Type my own password"
              typed={
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.next}>New password</Label>
                    <SecretInput id={ids.next} value={next} onChange={setNext} />
                    <PasswordStrengthMeter password={next} showWarning={!problem} />
                    {problem && <p className="text-xs text-destructive">{problem}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.again}>Type the new password again</Label>
                    <SecretInput id={ids.again} value={again} onChange={setAgain} />
                    {mismatch && (
                      <p className="text-xs text-destructive">The passwords don't match.</p>
                    )}
                  </div>
                </div>
              }
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="vault-change-password" disabled={!ready}>
            {busy && <Spinner className="h-3.5 w-3.5 animate-spin" />}
            Change password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
