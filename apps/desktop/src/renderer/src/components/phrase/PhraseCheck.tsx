import { PHRASE_WORDS } from '@runova/protocol';
import { motion, useReducedMotion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { ArrowLeft, Check } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The check after a recovery phrase is shown (E107), like a wallet's: pick the right word for three
 * places. It proves the phrase was written down or saved before a key that only it opens is set.
 */

export interface CheckQuestion {
  /** Zero-based place in the phrase. */
  place: number;
  choices: string[];
}

const QUESTIONS = 3;
const CHOICES = 4;

function randomBelow(n: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] as number) % n;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Three places in order, each with the right word and three others from the word list. */
export function pickCheck(words: string[]): CheckQuestion[] {
  const places = shuffle(words.map((_, i) => i))
    .slice(0, QUESTIONS)
    .sort((a, b) => a - b);
  return places.map((place) => {
    const answer = words[place] as string;
    const decoys = new Set<string>();
    while (decoys.size < CHOICES - 1) {
      const word = PHRASE_WORDS[randomBelow(PHRASE_WORDS.length)] as string;
      if (word !== answer) decoys.add(word);
    }
    return { place, choices: shuffle([answer, ...decoys]) };
  });
}

export function PhraseCheck({
  words,
  questions: given,
  onPassed,
  onBack,
}: {
  words: string[];
  /** Fixed questions, for tests. Picked at random otherwise. */
  questions?: CheckQuestion[];
  onPassed: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const questions = useMemo(() => given ?? pickCheck(words), [given, words]);
  const [step, setStep] = useState(0);
  const [wrong, setWrong] = useState<string | null>(null);
  const question = questions[step] as CheckQuestion;

  const answer = (choice: string) => {
    if (choice !== words[question.place]) {
      setWrong(choice);
      return;
    }
    setWrong(null);
    if (step + 1 >= questions.length) onPassed();
    else setStep(step + 1);
  };

  return (
    <div className="grid gap-4 rounded-2xl bg-foreground/[0.03] p-4 ring-1 ring-foreground/10">
      <div className="flex items-center gap-1.5" aria-hidden>
        {questions.map((q, i) => (
          <span
            key={q.place}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors',
              i < step ? 'bg-primary' : i === step ? 'bg-primary/40' : 'bg-foreground/10',
            )}
          />
        ))}
      </div>
      <motion.div
        key={step}
        initial={reduceMotion ? false : { opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.18 }}
        className="grid gap-3"
      >
        <div className="grid gap-0.5">
          <p className="text-xs text-muted-foreground">
            Check {step + 1} of {questions.length}
          </p>
          <p className="text-base font-semibold">Which is word {question.place + 1}?</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {question.choices.map((choice) => (
            <motion.button
              key={choice}
              type="button"
              onClick={() => answer(choice)}
              animate={wrong === choice && !reduceMotion ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
              transition={{ duration: 0.32 }}
              className={cn(
                'h-10 cursor-pointer rounded-xl font-mono text-sm font-medium ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                wrong === choice
                  ? 'bg-destructive/10 text-destructive ring-destructive/30'
                  : 'bg-background/70 ring-foreground/10 hover:bg-primary/10 hover:text-primary hover:ring-primary/30',
              )}
            >
              {choice}
            </motion.button>
          ))}
        </div>
        <p role="alert" className="min-h-4 text-xs text-destructive">
          {wrong ? `That is not word ${question.place + 1}. Look at your copy and try again.` : ''}
        </p>
      </motion.div>
      <div className="flex items-center justify-between">
        <Button type="button" shape="pill" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft /> Show the words again
        </Button>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Check className="size-3" /> {step} of {questions.length} right
        </span>
      </div>
    </div>
  );
}
