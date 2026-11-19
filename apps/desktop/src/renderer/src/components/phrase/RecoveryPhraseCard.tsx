import type { PendingPhrase } from '@shared/phraseTypes';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Eye, EyeOff, QrCode, Save, ShieldSolid } from '@/components/icons';
import { PillTabs } from '@/components/pageKit/PillTabs';
import { Button } from '@/components/ui/button';
import { errorText } from '@/hooks/useAccount';
import { cn } from '@/lib/utils';

/**
 * A recovery phrase on screen (E107): 24 numbered words, or the same phrase as a QR code for the
 * Runova app on a phone. Both stay hidden until asked for and hide again when the window loses
 * focus, and the window is kept out of screenshots and screen sharing while this is mounted.
 *
 * The words are only for reading. Copy, save and the QR code go to the main process by id, so the
 * clipboard is cleared again later and the saved file is written there.
 */

type View = 'words' | 'qr';

export function RecoveryPhraseCard({
  phrase,
  className,
}: {
  phrase: PendingPhrase;
  className?: string;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const [view, setView] = useState<View>('words');
  // Both belong to one phrase, so a different phrase starts hidden in the same render. Resetting
  // them in an effect instead let a click on "Show the words" land before it, which then undid it.
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<{ phraseId: string; dataUrl: string } | null>(null);
  const shown = shownFor === phrase.id;
  const setShown = (on: boolean) => setShownFor(on ? phrase.id : null);
  const qr = qrFor?.phraseId === phrase.id ? qrFor.dataUrl : null;

  useEffect(() => {
    void window.runova.phrase.protect(true);
    return () => {
      void window.runova.phrase.protect(false);
    };
  }, []);

  useEffect(() => {
    const hide = () => setShownFor(null);
    window.addEventListener('blur', hide);
    return () => window.removeEventListener('blur', hide);
  }, []);

  useEffect(() => {
    if (view !== 'qr' || !shown || qr) return;
    let live = true;
    const phraseId = phrase.id;
    window.runova.phrase
      .qr(phraseId)
      .then((result) => live && setQrFor({ phraseId, dataUrl: result.dataUrl }))
      .catch((error) => toast.error(errorText(error)));
    return () => {
      live = false;
    };
  }, [view, shown, qr, phrase.id]);

  const copy = async () => {
    try {
      const { clearsAt } = await window.runova.phrase.copy(phrase.id);
      const seconds = clearsAt ? Math.max(1, Math.round((clearsAt - Date.now()) / 1000)) : null;
      toast.success(
        seconds
          ? `Copied. The clipboard clears in ${seconds} seconds.`
          : 'Copied the recovery phrase.',
      );
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const save = async () => {
    try {
      const saved = await window.runova.phrase.save(phrase.id);
      if (saved) toast.success(`Saved to ${saved.path}`);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <div
      className={cn(
        'grid gap-3 rounded-2xl bg-foreground/[0.03] p-3 ring-1 ring-foreground/10',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <PillTabs<View>
          id={`phrase-view-${phrase.id}`}
          label="Show the phrase as"
          kind="toggle"
          size="xs"
          value={view}
          onChange={setView}
          items={[
            { value: 'words', label: 'Words' },
            { value: 'qr', label: 'QR code', icon: <QrCode /> },
          ]}
        />
        {shown && (
          <Button
            type="button"
            shape="pill"
            size="xs"
            variant="ghost"
            onClick={() => setShown(false)}
          >
            <EyeOff /> Hide
          </Button>
        )}
      </div>

      <div className="relative min-h-[13.5rem]">
        {view === 'words' ? (
          shown ? (
            <ol
              aria-label="Recovery phrase"
              className="grid select-none grid-cols-2 gap-1.5 min-[420px]:grid-cols-3 sm:grid-cols-4"
            >
              {phrase.words.map((word, index) => (
                <motion.li
                  key={index}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: reduceMotion ? 0 : index * 0.018, duration: 0.18 }}
                  className="flex items-baseline gap-1.5 rounded-lg bg-background/70 px-2 py-1.5 ring-1 ring-foreground/[0.07]"
                >
                  <span className="w-4 shrink-0 text-right text-[10px] font-medium tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="truncate font-mono text-[13px] font-medium tracking-wide">
                    {word}
                  </span>
                </motion.li>
              ))}
            </ol>
          ) : (
            <Veiled label="Show the words" onShow={() => setShown(true)} rows />
          )
        ) : shown ? (
          <div className="grid justify-items-center gap-2 py-1">
            <div className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5">
              {qr ? (
                <img
                  src={qr}
                  alt="QR code of your recovery phrase"
                  className="size-44"
                  draggable={false}
                />
              ) : (
                <div className="size-44 animate-pulse rounded-lg bg-black/5" />
              )}
            </div>
            <p className="max-w-xs text-center text-xs text-muted-foreground">
              Scan it with the Runova app on your phone (Account, then Recovery phrases). The phone
              keeps it behind its lock.
            </p>
          </div>
        ) : (
          <Veiled label="Show the QR code" onShow={() => setShown(true)} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" shape="pill" size="sm" variant="soft" onClick={copy}>
          <Copy /> Copy
        </Button>
        <Button type="button" shape="pill" size="sm" variant="soft" onClick={save}>
          <Save /> Save to a file
        </Button>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldSolid className="size-3 text-primary" /> Hidden from screenshots
        </span>
      </div>
    </div>
  );
}

/** What sits in place of the words until the person asks to see them. */
function Veiled({
  label,
  onShow,
  rows,
}: {
  label: string;
  onShow: () => void;
  rows?: boolean;
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 overflow-hidden rounded-xl">
      {rows && (
        <div aria-hidden className="grid grid-cols-4 gap-1.5 p-0.5 opacity-60 blur-[3px]">
          {Array.from({ length: 24 }, (_, i) => (
            <span
              key={i}
              className="h-[1.9rem] rounded-lg bg-foreground/[0.07]"
              style={{ width: `${62 + ((i * 37) % 38)}%` }}
            />
          ))}
        </div>
      )}
      <div className="absolute inset-0 grid place-items-center bg-background/40 backdrop-blur-[2px]">
        <div className="grid justify-items-center gap-2 text-center">
          <Button type="button" shape="pill" size="sm" variant="tint" onClick={onShow}>
            <Eye /> {label}
          </Button>
          <p className="max-w-[16rem] text-[11px] text-muted-foreground">
            Make sure nobody can see your screen.
          </p>
        </div>
      </div>
    </div>
  );
}
