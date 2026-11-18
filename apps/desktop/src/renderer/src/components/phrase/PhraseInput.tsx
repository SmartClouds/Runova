import {
  isValidPhrase,
  PHRASE_WORD_COUNT,
  PHRASE_WORDS,
  splitPhraseText,
  suggestWords,
} from '@runova/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, FolderOpen, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { errorText } from '@/hooks/useAccount';
import { cn } from '@/lib/utils';

/**
 * Typing a recovery phrase to unlock something (E107): 24 numbered boxes. Pasting the phrase, or a
 * numbered list of it, fills them all; each box suggests the word as it is typed, and Tab or space
 * takes the suggestion. The checksum in the last word catches a typo or two words swapped before
 * anything is tried. A saved phrase file can fill the boxes too.
 */

const KNOWN = new Set(PHRASE_WORDS);

/**
 * The pasted text when it is a whole phrase (24 words, numbered or not), else null. A password
 * field uses it to switch to the word boxes, which check the phrase before anything is tried.
 */
export function pastedPhrase(event: React.ClipboardEvent): string | null {
  const text = event.clipboardData.getData('text');
  return splitPhraseText(text).length === PHRASE_WORD_COUNT ? text : null;
}
const empty = () => Array.from({ length: PHRASE_WORD_COUNT }, () => '');

function fill(from: string[], start: number, words: string[]): string[] {
  const next = [...from];
  words.slice(0, PHRASE_WORD_COUNT - start).forEach((word, i) => {
    next[start + i] = word;
  });
  return next;
}

export function PhraseInput({
  onChange,
  initial,
  autoFocus,
}: {
  /** The words so far, joined by single spaces. */
  onChange: (phrase: string) => void;
  initial?: string;
  autoFocus?: boolean;
}): React.JSX.Element {
  const [words, setWords] = useState(() =>
    initial ? fill(empty(), 0, splitPhraseText(initial)) : empty(),
  );
  const [touched, setTouched] = useState<Set<number>>(() => new Set());
  const [focused, setFocused] = useState<number | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  // A phrase handed in (pasted in a password field) counts as typed from the start.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the words it started with
  useEffect(() => {
    if (initial) onChange(words.filter(Boolean).join(' '));
  }, []);

  const update = (next: string[]) => {
    setWords(next);
    onChange(next.filter(Boolean).join(' '));
  };

  const focus = (index: number) => boxes.current[index]?.focus();

  const filled = words.filter(Boolean).length;
  const phrase = words.join(' ');
  const allKnown = words.every((w) => KNOWN.has(w));
  const status =
    filled < PHRASE_WORD_COUNT
      ? { tone: 'muted', text: `${filled} of ${PHRASE_WORD_COUNT} words` }
      : !allKnown
        ? { tone: 'error', text: 'A word is not on the list. The red box shows which.' }
        : isValidPhrase(phrase)
          ? { tone: 'ok', text: 'The words check out' }
          : {
              tone: 'error',
              text: 'These words are not a recovery phrase. Check each one, and their order.',
            };

  const suggestion = useMemo(() => {
    if (focused === null) return null;
    const typed = words[focused] ?? '';
    if (typed.length < 2 || KNOWN.has(typed)) return null;
    const found = suggestWords(typed, 2);
    return found.length === 1 ? (found[0] as string) : null;
  }, [focused, words]);

  const take = (index: number, value: string) => {
    const next = [...words];
    next[index] = value;
    update(next);
    setTouched((t) => new Set(t).add(index));
    if (index + 1 < PHRASE_WORD_COUNT) focus(index + 1);
  };

  const openFile = async () => {
    try {
      const opened = await window.runova.phrase.open();
      if (opened) update(fill(empty(), 0, splitPhraseText(opened.phrase)));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-2 gap-1.5 min-[420px]:grid-cols-3 sm:grid-cols-4">
        {words.map((word, index) => {
          const invalid = touched.has(index) && word !== '' && !KNOWN.has(word);
          const ghost = focused === index && suggestion ? suggestion : null;
          return (
            <label
              key={index}
              className={cn(
                'relative flex h-8 items-center gap-1.5 rounded-lg bg-background/70 px-2 ring-1 transition-colors focus-within:ring-2',
                invalid
                  ? 'ring-destructive/50 focus-within:ring-destructive/60'
                  : 'ring-foreground/10 focus-within:ring-primary/50',
              )}
            >
              <span className="w-4 shrink-0 text-right text-[10px] font-medium tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span className="relative min-w-0 flex-1">
                {ghost && (
                  <span
                    data-suggestion
                    aria-hidden
                    className="pointer-events-none absolute inset-0 font-mono text-[13px] leading-8 text-muted-foreground/50"
                  >
                    {ghost}
                  </span>
                )}
                <input
                  ref={(node) => {
                    boxes.current[index] = node;
                  }}
                  aria-label={`Word ${index + 1}`}
                  aria-invalid={invalid || undefined}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus={autoFocus && index === 0}
                  value={word}
                  onFocus={() => setFocused(index)}
                  onBlur={() => {
                    setFocused((f) => (f === index ? null : f));
                    setTouched((t) => new Set(t).add(index));
                  }}
                  onChange={(e) => {
                    const typed = splitPhraseText(e.target.value);
                    if (typed.length > 1) {
                      update(fill(words, index, typed));
                      return;
                    }
                    const next = [...words];
                    next[index] = e.target.value.toLowerCase().replace(/[^a-z]/g, '');
                    update(next);
                  }}
                  onPaste={(e) => {
                    const pasted = splitPhraseText(e.clipboardData.getData('text'));
                    if (pasted.length < 2) return;
                    e.preventDefault();
                    const next = fill(words, index, pasted);
                    update(next);
                    setTouched((t) => {
                      const all = new Set(t);
                      for (let i = index; i < index + pasted.length; i++) all.add(i);
                      return all;
                    });
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === 'Tab' || e.key === ' ' || e.key === 'Enter') && ghost) {
                      e.preventDefault();
                      take(index, ghost);
                    } else if (e.key === ' ') {
                      e.preventDefault();
                      if (index + 1 < PHRASE_WORD_COUNT) focus(index + 1);
                    } else if (e.key === 'Backspace' && word === '' && index > 0) {
                      e.preventDefault();
                      focus(index - 1);
                    }
                  }}
                  className="relative w-full bg-transparent font-mono text-[13px] leading-8 outline-none"
                />
              </span>
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          aria-live="polite"
          className={cn(
            'flex items-center gap-1.5 text-xs',
            status.tone === 'ok'
              ? 'text-primary'
              : status.tone === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
          )}
        >
          {status.tone === 'ok' && <CircleCheck className="size-3.5" />}
          {status.tone === 'error' && <TriangleAlert className="size-3.5" />}
          {status.text}
        </p>
        <Button type="button" shape="pill" size="xs" variant="ghost" onClick={openFile}>
          <FolderOpen /> Open a saved file
        </Button>
      </div>
    </div>
  );
}
