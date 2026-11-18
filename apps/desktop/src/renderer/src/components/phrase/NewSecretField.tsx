import type { PendingPhrase, PhrasePurpose, PhraseRef } from '@shared/phraseTypes';
import { useEffect, useState } from 'react';
import { ArrowRight, CircleCheck, Keyboard, RefreshCw, Sparkles } from '@/components/icons';
import { PillTabs } from '@/components/pageKit/PillTabs';
import { Button } from '@/components/ui/button';
import { errorText } from '@/hooks/useAccount';
import { PhraseCheck } from './PhraseCheck';
import { RecoveryPhraseCard } from './RecoveryPhraseCard';

/**
 * Choosing a new secret (E107): a recovery phrase Runova makes, or one the person types. A made
 * phrase is shown, then checked, and only then handed to the form as `{ phraseId }`. The typed
 * way is the form's own fields, passed in as `typed`.
 */

export type SecretMode = 'phrase' | 'typed';

type Step = 'show' | 'check' | 'done';

/** A phrase made in the main process for as long as the component is on screen. */
export function usePendingPhrase(purpose: PhrasePurpose, label: string, enabled: boolean) {
  const [round, setRound] = useState(0);
  const [phrase, setPhrase] = useState<PendingPhrase | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round makes a new phrase
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let id: string | null = null;
    setPhrase(null);
    setError(null);
    window.runova.phrase
      .create(purpose, label)
      .then((made) => {
        id = made.id;
        if (live) setPhrase(made);
        else void window.runova.phrase.discard(made.id);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
      if (id) void window.runova.phrase.discard(id);
    };
  }, [purpose, label, enabled, round]);

  return { phrase, error, renew: () => setRound((r) => r + 1) };
}

export function NewSecretField({
  purpose,
  label,
  mode,
  onModeChange,
  onPhraseReady,
  typed,
  typedLabel = 'Type my own',
}: {
  purpose: PhrasePurpose;
  /** Names the phrase in its saved file and on the phone. */
  label: string;
  mode: SecretMode;
  onModeChange: (mode: SecretMode) => void;
  /** The phrase once it is checked, or null while it is not. */
  onPhraseReady: (ready: PhraseRef | null) => void;
  typed: React.ReactNode;
  typedLabel?: string;
}): React.JSX.Element {
  const { phrase, error, renew } = usePendingPhrase(purpose, label, mode === 'phrase');
  const [step, setStep] = useState<Step>('show');

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new phrase starts over
  useEffect(() => {
    setStep('show');
    onPhraseReady(null);
  }, [phrase?.id, mode]);

  return (
    <div className="grid gap-3">
      <PillTabs<SecretMode>
        id={`secret-mode-${purpose}`}
        label="How to lock it"
        kind="toggle"
        value={mode}
        onChange={onModeChange}
        className="justify-self-start"
        items={[
          { value: 'phrase', label: 'Create a phrase for me', icon: <Sparkles /> },
          { value: 'typed', label: typedLabel, icon: <Keyboard /> },
        ]}
      />

      {mode === 'typed' ? (
        typed
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !phrase ? (
        <div className="h-56 animate-pulse rounded-2xl bg-foreground/[0.04]" />
      ) : step === 'show' ? (
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            24 random words from this computer’s secure random source, not something anyone could
            guess. Write them down in order, or save them where only you can reach them.
          </p>
          <RecoveryPhraseCard phrase={phrase} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" shape="pill" size="sm" variant="ghost" onClick={renew}>
              <RefreshCw /> Make a different phrase
            </Button>
            <Button
              type="button"
              shape="pill"
              size="sm"
              variant="tint"
              onClick={() => setStep('check')}
            >
              I saved it, check me <ArrowRight />
            </Button>
          </div>
        </div>
      ) : step === 'check' ? (
        <PhraseCheck
          words={phrase.words}
          onBack={() => setStep('show')}
          onPassed={() => {
            setStep('done');
            onPhraseReady({ phraseId: phrase.id });
          }}
        />
      ) : (
        <div className="flex items-center gap-3 rounded-2xl bg-primary/[0.07] p-3 ring-1 ring-primary/20">
          <CircleCheck className="size-5 shrink-0 text-primary" />
          <div className="grid flex-1 gap-0.5">
            <p className="text-sm font-medium">Your phrase is checked</p>
            <p className="text-xs text-muted-foreground">
              Keep your copy safe. Runova can not show it again once this closes.
            </p>
          </div>
          <Button
            type="button"
            shape="pill"
            size="xs"
            variant="ghost"
            onClick={() => {
              setStep('show');
              onPhraseReady(null);
            }}
          >
            See it again
          </Button>
        </div>
      )}
    </div>
  );
}
