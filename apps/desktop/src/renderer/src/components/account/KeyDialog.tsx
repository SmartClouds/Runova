import { PHRASE_WORD_COUNT, splitPhraseText } from '@runova/protocol';
import type { PendingPhrase, PhraseRef } from '@shared/phraseTypes';
import type { SyncScopeView } from '@shared/syncTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, ShieldSolid } from '@/components/icons';
import { NewSecretField, type SecretMode } from '@/components/phrase/NewSecretField';
import { PhraseCheck } from '@/components/phrase/PhraseCheck';
import { PhraseInput } from '@/components/phrase/PhraseInput';
import { RecoveryPhraseCard } from '@/components/phrase/RecoveryPhraseCard';
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
import { errorText } from '@/hooks/useAccount';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

const STRENGTH = (value: string): number => {
  if (!value) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  const words = value.trim().split(/\s+/).length;
  const score =
    value.length >= 20 || (value.length >= 14 && (words >= 3 || kinds >= 3))
      ? 4
      : value.length >= 14
        ? 3
        : value.length >= 12
          ? 2
          : 1;
  return score;
};

type UnlockWith = 'typed' | 'phrase' | 'recovery' | 'legacy';
type Mode = 'set' | 'unlock' | 'change' | 'rotate';

/**
 * Setting, unlocking, changing or replacing a scope's key, in one dialog (E48). A new key can be a
 * recovery phrase Runova makes (E107), and the recovery key is shown as 24 words like it, with
 * copy, save and a QR code for the phone.
 */
export function KeyDialog({
  scope,
  mode,
  onClose,
}: {
  scope: SyncScopeView;
  mode: Mode;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [secretMode, setSecretMode] = useState<SecretMode>('phrase');
  const [phraseRef, setPhraseRef] = useState<PhraseRef | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [unlockWith, setUnlockWith] = useState<UnlockWith>('typed');
  const [pastedPhrase, setPastedPhrase] = useState<string | undefined>(undefined);
  const [recovery, setRecovery] = useState<PendingPhrase | null>(null);
  const [recoveryStep, setRecoveryStep] = useState<'show' | 'check' | 'done'>('show');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isTeam = scope.kind === 'team';
  const what = isTeam ? 'team key' : 'passphrase';
  const label = isTeam ? scope.name : 'Your own data';
  const creating = mode !== 'unlock';
  const typed = secretMode === 'typed';
  const byRecovery = unlockWith === 'recovery' || unlockWith === 'legacy';
  // A key set from a checked phrase already has a safe copy, so the recovery key needs only a
  // tick. After a typed passphrase the recovery key is the safe copy, so it gets the full check.
  const checkRecovery = typed;

  const close = () => {
    if (recovery) void window.runova.phrase.discard(recovery.id);
    onClose();
  };

  const secret = (): { passphrase: string } | PhraseRef =>
    !typed && phraseRef ? phraseRef : { passphrase };

  const submit = async () => {
    setError(null);
    if (creating && typed && passphrase !== again) {
      setError('The two passphrases are not the same.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'set') {
        setRecovery((await window.runova.sync.setKey(scope.id, secret(), label)).recovery);
      } else if (mode === 'rotate') {
        setRecovery((await window.runova.sync.rotateKey(scope.id, secret(), label)).recovery);
      } else if (mode === 'change') {
        await window.runova.sync.changePassphrase(scope.id, secret());
        toast.success(
          `The ${what} is changed. Enter the new one on your other computers when they ask.`,
        );
        onClose();
      } else {
        await window.runova.sync.unlock(
          scope.id,
          byRecovery ? { recoveryKey: passphrase } : { passphrase },
        );
        toast.success(`${isTeam ? scope.name : 'Your data'} is unlocked on this computer.`);
        onClose();
      }
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const titles = {
    set: isTeam ? `Set the key of ${scope.name}` : 'Set your encryption key',
    unlock: isTeam ? `Unlock ${scope.name}` : 'Unlock your data on this computer',
    change: `Change the ${what}`,
    rotate: `Replace the key of ${scope.name}`,
  } as const;
  const descriptions = {
    set: isTeam
      ? 'Give the key to your team the way you would share a Wi-Fi password: in person, as the QR code, or through your password manager, never by plain email. Each member enters it once on each computer.'
      : 'Your passwords, private keys and environment values are sealed with this before they leave the computer. Runova can not reset it for you, so you also get a recovery key.',
    unlock: `Enter the ${what} you set on another computer, or the recovery key.`,
    change:
      'The key stays the same, so nothing needs sealing again. Your other computers keep working.',
    rotate:
      'Do this after someone left the team: the old key opens nothing new. Give the new key to the members who stay.',
  } as const;

  const ready = !creating || typed ? passphrase.length > 0 : phraseRef !== null;
  const wide = creating
    ? !typed || !!recovery
    : unlockWith === 'phrase' || unlockWith === 'recovery';

  return (
    <Dialog open onOpenChange={(open) => !open && !recovery && close()}>
      <DialogContent className={cn('max-h-[92vh] overflow-y-auto', wide ? 'max-w-xl' : 'max-w-md')}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldSolid className="size-4 text-primary" />
            {recovery ? 'Save your recovery key' : titles[mode]}
          </DialogTitle>
          <DialogDescription>
            {recovery
              ? 'If you ever lose the key, these 24 words open your data instead. They are shown only now. Write them down, save them to a file, or scan the QR code with the Runova app on your phone.'
              : descriptions[mode]}
          </DialogDescription>
        </DialogHeader>
        {recovery ? (
          <div className="grid gap-3">
            {recoveryStep === 'check' ? (
              <PhraseCheck
                words={recovery.words}
                onBack={() => setRecoveryStep('show')}
                onPassed={() => setRecoveryStep('done')}
              />
            ) : (
              <RecoveryPhraseCard phrase={recovery} />
            )}
            {!checkRecovery && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                  className="accent-[hsl(var(--primary))]"
                />
                I saved my recovery key somewhere safe
              </label>
            )}
            <DialogFooter>
              {checkRecovery && recoveryStep === 'show' ? (
                <Button shape="pill" variant="tint" onClick={() => setRecoveryStep('check')}>
                  I saved it, check me <ArrowRight />
                </Button>
              ) : (
                <Button
                  shape="pill"
                  disabled={checkRecovery ? recoveryStep !== 'done' : !saved}
                  onClick={close}
                >
                  Done
                </Button>
              )}
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {creating ? (
              <NewSecretField
                purpose="sync"
                label={label}
                mode={secretMode}
                onModeChange={setSecretMode}
                onPhraseReady={setPhraseRef}
                typed={
                  <TypedPassphrase
                    what={what}
                    passphrase={passphrase}
                    again={again}
                    onPassphrase={setPassphrase}
                    onAgain={setAgain}
                  />
                }
              />
            ) : unlockWith === 'typed' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="key-passphrase">{what[0]?.toUpperCase() + what.slice(1)}</Label>
                <Input
                  id="key-passphrase"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onPaste={(e) => {
                    // A phrase pasted here opens the word boxes, which check it before trying.
                    const text = e.clipboardData.getData('text');
                    const words = splitPhraseText(text);
                    if (words.length !== PHRASE_WORD_COUNT) return;
                    e.preventDefault();
                    setPastedPhrase(text);
                    setPassphrase(words.join(' '));
                    setUnlockWith('phrase');
                  }}
                />
                <button
                  type="button"
                  className="justify-self-start text-xs font-medium text-primary"
                  onClick={() => {
                    setPassphrase('');
                    setUnlockWith('phrase');
                  }}
                >
                  {`My ${what} is a recovery phrase`}
                </button>
              </div>
            ) : unlockWith === 'legacy' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="key-passphrase">Recovery key</Label>
                <Input
                  id="key-passphrase"
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="font-mono tracking-wider"
                />
              </div>
            ) : (
              <div className="grid gap-2">
                <p className="text-xs font-medium">
                  {unlockWith === 'recovery' ? 'Recovery key' : `Your ${what}, as words`}
                </p>
                <PhraseInput autoFocus initial={pastedPhrase} onChange={setPassphrase} />
                {unlockWith === 'recovery' && (
                  <button
                    type="button"
                    className="justify-self-start text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setPassphrase('');
                      setUnlockWith('legacy');
                    }}
                  >
                    I have an older key in groups of characters
                  </button>
                )}
              </div>
            )}
            {mode === 'unlock' && (
              <button
                type="button"
                className="justify-self-start text-xs font-medium text-primary"
                onClick={() => {
                  setPassphrase('');
                  setPastedPhrase(undefined);
                  setUnlockWith(byRecovery ? 'typed' : 'recovery');
                }}
              >
                {byRecovery ? `Use the ${what} instead` : 'Use the recovery key instead'}
              </button>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" shape="pill" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" shape="pill" disabled={busy || !ready}>
                {busy
                  ? 'Working…'
                  : mode === 'unlock'
                    ? 'Unlock'
                    : mode === 'change'
                      ? 'Change it'
                      : 'Set the key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The typed way: the passphrase twice, with a strength meter. */
function TypedPassphrase({
  what,
  passphrase,
  again,
  onPassphrase,
  onAgain,
}: {
  what: string;
  passphrase: string;
  again: string;
  onPassphrase: (value: string) => void;
  onAgain: (value: string) => void;
}): React.JSX.Element {
  const strength = STRENGTH(passphrase);
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="key-passphrase">{`New ${what}`}</Label>
        <Input
          id="key-passphrase"
          type="password"
          autoComplete="off"
          autoFocus
          value={passphrase}
          onChange={(e) => onPassphrase(e.target.value)}
        />
        <div className="flex items-center gap-2" aria-live="polite">
          <div className="flex flex-1 gap-1">
            {[1, 2, 3, 4].map((step) => (
              <span
                key={step}
                className={cn(
                  'h-1 flex-1 rounded-full',
                  step <= strength
                    ? strength < 3
                      ? 'bg-warning'
                      : 'bg-primary'
                    : 'bg-foreground/10',
                )}
              />
            ))}
          </div>
          <span className="w-28 text-right text-xs text-muted-foreground">
            {passphrase.length < 12
              ? `${12 - passphrase.length} more characters`
              : strength >= 3
                ? 'Strong'
                : 'Add another word'}
          </span>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="key-again">Type it again</Label>
        <Input
          id="key-again"
          type="password"
          autoComplete="off"
          value={again}
          onChange={(e) => onAgain(e.target.value)}
        />
      </div>
    </div>
  );
}
