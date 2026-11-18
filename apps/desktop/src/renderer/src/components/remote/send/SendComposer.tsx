import { type StageResult, sendButtonLabel } from '@shared/fileSend';
import { useState } from 'react';
import { toast } from 'sonner';
import { Send } from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useFileSend, useFileSendStore } from '@/stores/fileSendStore';
import { REMOTE_CARD, RemoteCardHeader } from '../remoteCard';
import { RecipientPicker } from './RecipientPicker';
import { SendDropZone } from './SendDropZone';

const NOTE_MAX = 500;

/** Says what was left out of a pick, if anything was. */
function reportProblems(result: StageResult | null): void {
  if (!result || result.problems.length === 0) return;
  toast.warning('Some of what you picked was left out', {
    description: result.problems.join('\n'),
  });
}

/**
 * Putting a send together (E112), in the order it is thought of: what, to whom, a word with it,
 * and one button that says exactly what it does. Ctrl+Enter sends from anywhere in the card.
 */
export function SendComposer(): React.JSX.Element {
  const state = useFileSend();
  const picked = useFileSendStore((s) => s.picked);
  const pick = useFileSendStore((s) => s.pick);
  const note = useFileSendStore((s) => s.note);
  const setNote = useFileSendStore((s) => s.setNote);
  const [sending, setSending] = useState(false);
  const api = window.runova.fileSend;

  const recipient =
    state.recipients.find((r) => r.remoteId === picked && r.unavailable === null) ?? null;
  const fileCount = state.staged.reduce((sum, item) => sum + item.fileCount, 0);
  const missing = !state.available
    ? 'Runova Anywhere is not connected right now.'
    : fileCount === 0
      ? 'Add files or a folder first.'
      : !recipient
        ? 'Pick who to send them to.'
        : null;

  const stage = (run: () => Promise<StageResult | null>) =>
    void run()
      .then(reportProblems)
      .catch((error: unknown) => toast.error(ipcErrorMessage(error, 'That could not be added.')));

  async function send(): Promise<void> {
    if (missing || sending || !recipient) return;
    setSending(true);
    try {
      const text = note.trim();
      await api.send({ remoteId: recipient.remoteId, ...(text ? { note: text } : {}) });
      setNote('');
    } catch (error) {
      toast.error(ipcErrorMessage(error, 'The send could not start.'));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      aria-label="Send files"
      className={cn(REMOTE_CARD, '@container/send')}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void send();
        }
      }}
    >
      <RemoteCardHeader
        icon={Send}
        title="Send files"
        description="To your other computers and your teammates. They go straight from this computer to theirs, encrypted the whole way."
      />
      <div className="space-y-5 px-5 pb-5">
        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Files</h3>
          <SendDropZone
            staged={state.staged}
            onPaths={(paths) => stage(() => api.stagePaths(paths))}
            onPickFiles={() => stage(() => api.pickFiles())}
            onPickFolder={() => stage(() => api.pickFolder())}
            onRemove={(id) => void api.unstage([id])}
            onClear={() => void api.unstage('all')}
          />
        </div>

        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Send to</h3>
          <RecipientPicker
            recipients={state.recipients}
            value={recipient?.remoteId ?? null}
            onChange={pick}
            websiteOutdated={state.websiteOutdated}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="send-note" className={SECTION_HEADING}>
            Note
          </label>
          <input
            id="send-note"
            type="text"
            autoComplete="off"
            maxLength={NOTE_MAX}
            placeholder="Add a line about the files, if you like"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="field-surface h-9 w-full rounded-xl px-3 text-[13px] placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          {missing ? (
            <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              {missing}
            </p>
          ) : (
            <p className="mr-auto hidden text-xs text-muted-foreground @md/send:block">
              Ctrl+Enter sends
            </p>
          )}
          <Button
            type="button"
            shape="pill"
            size="lg"
            disabled={missing !== null || sending}
            onClick={() => void send()}
          >
            <Send />
            {sendButtonLabel(fileCount, recipient?.name ?? null)}
          </Button>
        </div>
      </div>
    </section>
  );
}
