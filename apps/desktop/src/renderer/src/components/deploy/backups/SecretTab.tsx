import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import type { PhraseRef } from '@shared/phraseTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Key, Spinner, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { ExistingSecretField } from '@/components/phrase/ExistingSecretField';
import { NewSecretField, type SecretMode } from '@/components/phrase/NewSecretField';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { CARD_BODY, LoadFailure, SecurityCard } from '../security/SecurityCard';
import type { StepUp } from '../security/useStepUp';
import { dateAndTime } from './format';
import { useBackupSecret, useRefreshBackups } from './hooks';

/**
 * The secret key every backup is encrypted under (E28). The core never stores it: it seals the
 * key ring's private half with it, so the secret alone opens a backup on a bare server, and
 * without it nothing does. Changing it needs the current one; older backups keep theirs. The
 * new key can be a recovery phrase Runova makes (E107).
 */

const MIN = 12;

export function secretIssue(secret: string, again: string): string | null {
  if (secret.length === 0) return null;
  if (secret.length < MIN) return `Use at least ${MIN} characters.`;
  if (/[\r\n]/.test(secret)) return 'Keep it to one line.';
  if (again.length > 0 && again !== secret) return 'The two do not match.';
  return null;
}

export function SecretTab({
  server,
  stepUp,
}: {
  server: DeployServer;
  stepUp: StepUp;
}): React.JSX.Element {
  const status = useBackupSecret(server.id);
  const refresh = useRefreshBackups(server.id);
  const [current, setCurrent] = useState('');
  const [mode, setMode] = useState<SecretMode>('phrase');
  const [phraseRef, setPhraseRef] = useState<PhraseRef | null>(null);
  const [round, setRound] = useState(0);
  const [secret, setSecret] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const isSet = status.data?.isSet ?? false;
  const typed = mode === 'typed';
  const issue = typed ? secretIssue(secret, again) : null;
  const newReady = typed
    ? secret.length >= MIN && again === secret && issue === null
    : phraseRef !== null;
  const ready = !busy && newReady && (!isSet || current.length > 0);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const done = await stepUp.run(() =>
        window.runova.deployServerBackups.setSecret({
          serverId: server.id,
          newSecret: typed || !phraseRef ? secret : phraseRef,
          ...(isSet ? { currentSecret: current } : {}),
        }),
      );
      if (!done) return;
      toast.success(isSet ? 'The secret key is changed.' : 'The secret key is set.');
      setCurrent('');
      setSecret('');
      setAgain('');
      // The phrase is set; the next change starts from a new one.
      setRound((r) => r + 1);
      refresh();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const id = (name: string) => `backup-secret-${name}-${server.id}`;
  return (
    <SecurityCard
      icon={<Key />}
      title="Secret key"
      description="Every backup is encrypted on the server with this key before it goes anywhere."
    >
      <div className={cn(CARD_BODY, 'space-y-3')}>
        <Notice tone="destructive" icon={TriangleAlert} className="text-xs">
          If you lose the secret key, no backup made with it can be restored, by you or anyone. It
          is never stored on the server, and Runova does not keep it either. Write it down somewhere
          safe, away from this server.
        </Notice>
        {status.isPending ? (
          <Skeleton className="h-4 w-56" />
        ) : status.isError ? (
          <LoadFailure
            message={coreErrorMessage(status.error)}
            onRetry={() => void status.refetch()}
          />
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            {isSet
              ? `A secret key is set${status.data.updatedAtUnixMs ? `, last changed ${dateAndTime(status.data.updatedAtUnixMs)}` : ''}. Backups made before a change still open with the key they were made under.`
              : 'No secret key yet. Set one before the first backup.'}
          </p>
        )}
        <form
          className={cn('space-y-3', typed ? 'max-w-md' : 'max-w-xl')}
          onSubmit={(event) => void save(event)}
        >
          {isSet && (
            <ExistingSecretField
              id={id('current')}
              label="Current secret key"
              value={current}
              onChange={setCurrent}
            />
          )}
          <NewSecretField
            key={round}
            purpose="server-backup"
            label={`Backups of ${server.nickname}`}
            mode={mode}
            onModeChange={setMode}
            onPhraseReady={setPhraseRef}
            typed={
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={id('new')}>New secret key</Label>
                  <SecretInput
                    id={id('new')}
                    value={secret}
                    onChange={setSecret}
                    placeholder="At least 12 characters"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={id('again')}>New secret key again</Label>
                  <SecretInput id={id('again')} value={again} onChange={setAgain} />
                </div>
              </div>
            }
          />
          {issue && (
            <p className="text-xs text-muted-foreground" role="status">
              {issue}
            </p>
          )}
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <Button type="submit" size="sm" disabled={!ready || status.isPending}>
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            {isSet ? 'Change the secret key' : 'Set the secret key'}
          </Button>
        </form>
      </div>
    </SecurityCard>
  );
}
