import {
  type PiperLibraryView,
  type PiperVoiceModelView,
  parsePiperVoice,
  parseVoiceRef,
  qualityLabel,
} from '@runova/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { studioAudioClient } from '../client';
import { DIALOG_BODY, errorMessage, formatBytes } from '../format';
import {
  Button,
  Checkbox,
  Chip,
  cn,
  confirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Download,
  EmptyState,
  Input,
  Label,
  LoadFailure,
  Microphone,
  Notice,
  Skeleton,
  Trash2,
  toast,
  X,
} from '../kit';
import { studioKeys } from '../queryKeys';

export interface PiperVoiceLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The video's language, whose voices are shown first. */
  lang: string;
  /** The voices the video's scenes were spoken with, to warn before one is removed. */
  usedVoiceRefs: readonly (string | null)[];
  onOpenDevSetup: () => void;
}

/** Whether a voice matches what was typed: its name, id, language or locale. */
function matches(voice: PiperVoiceModelView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [voice.label, voice.id, voice.language, voice.locale].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/**
 * Every Piper voice Studio offers, to download or remove one at a time. A voice downloads in the
 * background (closing this keeps it going) and is checked against its pinned hash before Studio
 * uses it. A model with several speakers brings all of them, each a voice in the list.
 */
export function PiperVoiceLibraryDialog({
  open,
  onOpenChange,
  lang,
  usedVoiceRefs,
  onOpenDevSetup,
}: PiperVoiceLibraryDialogProps): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const library = useQuery({
    queryKey: studioKeys.piperLibrary,
    queryFn: () => studioAudioClient().piperLibrary(),
    enabled: open,
  });
  const [query, setQuery] = useState('');
  const [everyLanguage, setEveryLanguage] = useState(false);
  const primary = lang.split('-')[0]?.toLowerCase() ?? '';

  const groups = useMemo(() => {
    const voices = (library.data?.voices ?? []).filter(
      (v) =>
        (everyLanguage || query.trim() || v.locale.toLowerCase().split('-')[0] === primary) &&
        matches(v, query),
    );
    const byLanguage = new Map<string, PiperVoiceModelView[]>();
    for (const voice of voices) {
      const key = `${voice.language} (${voice.locale})`;
      byLanguage.set(key, [...(byLanguage.get(key) ?? []), voice]);
    }
    // The video's language first, then the rest by name.
    return [...byLanguage.entries()].sort(([a, av], [b, bv]) => {
      const ours = (v: PiperVoiceModelView[]) =>
        v[0]?.locale.toLowerCase().split('-')[0] === primary ? 0 : 1;
      return ours(av) - ours(bv) || a.localeCompare(b);
    });
  }, [library.data, everyLanguage, query, primary]);

  /** Shows what a call answered, and refreshes the voice lists that depend on it. */
  function adopt(view: PiperLibraryView): void {
    queryClient.setQueryData(studioKeys.piperLibrary, view);
    void queryClient.invalidateQueries({ queryKey: studioKeys.voiceEngines });
    void queryClient.invalidateQueries({ queryKey: ['studio', 'voices'] });
  }

  async function run(work: () => Promise<PiperLibraryView>): Promise<void> {
    try {
      adopt(await work());
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove(voice: PiperVoiceModelView): Promise<void> {
    const used = usedVoiceRefs.some((value) => {
      const ref = parseVoiceRef(value);
      return ref?.engine === 'piper' && parsePiperVoice(ref.voice)?.model.id === voice.id;
    });
    const ok = await confirmDialog({
      title: `Remove ${voice.label}?`,
      description: used
        ? 'Scenes in this video were spoken with it. What they say stays, but speaking them again needs the voice downloaded again.'
        : `Its files are deleted from this computer (${formatBytes(voice.size)}). You can download it again any time.`,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (ok) await run(() => studioAudioClient().removePiperVoice(voice.id));
  }

  const shown = groups.reduce((sum, [, voices]) => sum + voices.length, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Piper voices</DialogTitle>
          <DialogDescription>
            Voices that speak on this computer, offline. Download the ones you want; each is checked
            before Studio uses it, and a voice with several speakers brings all of them.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id={`${id}-search`}
            aria-label="Search voices"
            placeholder="Search by name or language"
            className="h-8 w-64"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-every`}
              checked={everyLanguage}
              onCheckedChange={(checked) => setEveryLanguage(checked === true)}
            />
            <Label htmlFor={`${id}-every`} className="text-sm font-normal">
              Every language
            </Label>
          </div>
        </div>
        <div className={cn(DIALOG_BODY, 'space-y-4')}>
          {library.data && !library.data.engineInstalled && (
            <Notice
              tone="warning"
              size="sm"
              action={
                <Button size="sm" variant="soft" onClick={onOpenDevSetup}>
                  Open Dev Setup
                </Button>
              }
            >
              Install Piper first, from Agent Tools, Dev Setup (Studio). Then download voices here.
            </Notice>
          )}
          {library.isError ? (
            <LoadFailure
              message="Studio could not list the Piper voices."
              retry={() => void library.refetch()}
            />
          ) : library.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : shown === 0 ? (
            <EmptyState
              icon={Microphone}
              size="sm"
              title="No voices match"
              description={
                everyLanguage || query
                  ? 'Try another name or language.'
                  : 'Piper has no voice for this language yet. Tick Every language to see the rest.'
              }
            />
          ) : (
            groups.map(([language, voices]) => (
              <section key={language} aria-label={language} className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">{language}</h3>
                <ul className="space-y-1">
                  {voices.map((voice) => (
                    <VoiceRow
                      key={voice.id}
                      voice={voice}
                      canDownload={library.data?.engineInstalled === true}
                      onDownload={() =>
                        void run(() => studioAudioClient().downloadPiperVoice(voice.id))
                      }
                      onCancel={() =>
                        void run(() => studioAudioClient().cancelPiperVoice(voice.id))
                      }
                      onRemove={() => void remove(voice)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VoiceRow({
  voice,
  canDownload,
  onDownload,
  onCancel,
  onRemove,
}: {
  voice: PiperVoiceModelView;
  canDownload: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const percent = voice.fraction === null ? null : Math.round(voice.fraction * 100);
  return (
    <li
      aria-label={`${voice.label}, ${qualityLabel(voice.quality)}`}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 hover:bg-foreground/[0.03]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{voice.label}</span>
          <Chip>{qualityLabel(voice.quality)}</Chip>
          {voice.speakers > 1 && <Chip>{voice.speakers} speakers</Chip>}
          {voice.nonCommercial && (
            <Chip tone="warning">
              Non-commercial
              {voice.license === 'Unknown' ? ', license not stated' : ` (${voice.license})`}
            </Chip>
          )}
          {voice.state === 'installed' && (
            <Chip tone="success" dot>
              On this computer
            </Chip>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatBytes(voice.size)}
          {!voice.nonCommercial && `, ${voice.license}`}
          {voice.source && (
            <>
              {', '}
              <a
                href={voice.source}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary hover:text-primary/80"
              >
                where it comes from
              </a>
            </>
          )}
        </p>
        {voice.error && <p className="text-xs text-destructive">{voice.error}</p>}
      </div>
      {voice.state === 'downloading' ? (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={`Downloading ${voice.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 w-24 overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className={cn(
                'h-full bg-primary transition-[width]',
                percent === null && 'animate-pulse',
              )}
              style={{ width: `${percent ?? 100}%` }}
            />
          </div>
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
            {percent === null ? '' : `${percent}%`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            aria-label={`Stop downloading ${voice.label}`}
          >
            <X /> Stop
          </Button>
        </div>
      ) : voice.state === 'installed' ? (
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${voice.label}`}>
          <Trash2 /> Remove
        </Button>
      ) : (
        <Button
          size="sm"
          variant="soft"
          disabled={!canDownload}
          onClick={onDownload}
          aria-label={`Download ${voice.label}, ${qualityLabel(voice.quality)}`}
        >
          <Download /> {voice.error ? 'Try again' : 'Download'}
        </Button>
      )}
    </li>
  );
}
