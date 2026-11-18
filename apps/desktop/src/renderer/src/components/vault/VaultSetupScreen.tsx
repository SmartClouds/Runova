import { MASTER_PASSWORD_MIN_LENGTH, masterPasswordProblem } from '@runova/core';
import type { PhraseRef } from '@shared/phraseTypes';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Shield, Spinner } from '@/components/icons';
import { NewSecretField, type SecretMode } from '@/components/phrase/NewSecretField';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { queryKeys } from '@/lib/queryKeys';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { VaultAccessCard } from './VaultAccessCard';

/**
 * Making the vault. The master password is a recovery phrase Runova makes (E107), or one the
 * person types.
 */
export function VaultSetupScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const passwordId = useId();
  const confirmId = useId();
  const ackId = useId();
  const [mode, setMode] = useState<SecretMode>('phrase');
  const [phraseRef, setPhraseRef] = useState<PhraseRef | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typed = mode === 'typed';
  const problem = password ? masterPasswordProblem(password) : null;
  const mismatch = confirm !== '' && confirm !== password;
  const secretReady = typed
    ? password !== '' && !problem && confirm === password
    : phraseRef !== null;
  const ready = secretReady && acknowledged && !busy;

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await window.runova.vault.create(typed || !phraseRef ? password : phraseRef);
      await queryClient.invalidateQueries({ queryKey: queryKeys.vaultStatus });
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <VaultAccessCard
      icon={Shield}
      title="Create your vault"
      description="Keep logins, API keys and private notes in one place, encrypted on this computer with a master password only you know."
      wide={!typed}
    >
      <form className="space-y-4" onSubmit={create}>
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
                <Label htmlFor={passwordId}>Master password</Label>
                <SecretInput
                  id={passwordId}
                  value={password}
                  onChange={setPassword}
                  placeholder={`At least ${MASTER_PASSWORD_MIN_LENGTH} characters`}
                  className="h-10 pl-4"
                  autoFocus
                  aria-invalid={problem ? true : undefined}
                />
                <PasswordStrengthMeter password={password} showWarning={!problem} />
                {problem && <p className="text-xs text-destructive">{problem}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={confirmId}>Type it again</Label>
                <SecretInput
                  id={confirmId}
                  value={confirm}
                  onChange={setConfirm}
                  className="h-10 pl-4"
                  aria-invalid={mismatch ? true : undefined}
                />
                {mismatch && <p className="text-xs text-destructive">The passwords don't match.</p>}
              </div>
            </div>
          }
        />

        {/* A ring, not a border: the theme's global border colour would win over a tinted one. */}
        <div className="flex items-start gap-2.5 rounded-xl bg-warning/10 p-3 ring-1 ring-inset ring-warning/30">
          <Checkbox
            id={ackId}
            checked={acknowledged}
            onCheckedChange={(checked) => setAcknowledged(checked === true)}
            className="mt-0.5"
          />
          <Label htmlFor={ackId} className="text-xs font-normal leading-relaxed">
            I understand Runova can't recover this {typed ? 'password' : 'phrase'}. If I lose it,
            the vault can only be reset, and everything in it is lost.
          </Label>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" className="h-10 w-full" disabled={!ready}>
          {busy && <Spinner className="h-3.5 w-3.5 animate-spin" />}
          Create vault
        </Button>
      </form>
    </VaultAccessCard>
  );
}
