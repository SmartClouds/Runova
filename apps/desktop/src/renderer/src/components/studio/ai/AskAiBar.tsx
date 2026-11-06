import { buildEditRewriteRequest } from '@runova/studio';
import { useState } from 'react';
import { scriptClass } from '../format';
import {
  AgentPromptField,
  Button,
  ChevronDown,
  cn,
  GLASS_CARD,
  Popover,
  PopoverContent,
  PopoverTrigger,
  type RunSettings,
  RunSettingsFields,
  Send,
} from '../kit';
import { runLabel } from './runSettings';

export interface AskAiBarProps {
  run: RunSettings;
  onRunChange: (run: RunSettings) => void;
  /** The video's language, so "Write it for me" knows what the scenario is written in. */
  language: string;
  /** An AI run is already working on the video. */
  busy: boolean;
  /** Resolves to true once the request is on its way, which clears the field. */
  onAsk: (instruction: string) => Promise<boolean>;
}

/**
 * Edit by typing: say what to change, and the AI proposes the edit for the user to approve. It is
 * the same box as the SSH task prompt, so the note can be dictated, translated to English, or
 * turned into a clear instruction by "Write it for me". Enter asks, Shift+Enter starts a new line.
 */
export function AskAiBar({
  run,
  onRunChange,
  language,
  busy,
  onAsk,
}: AskAiBarProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ready = text.trim().length > 0 && !busy && !sending;

  const submit = async () => {
    if (!ready) return;
    setSending(true);
    try {
      if (await onAsk(text.trim())) setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className={cn(GLASS_CARD, 'p-2')}
      aria-label="Ask AI"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <AgentPromptField
        value={text}
        onChange={setText}
        buildRequest={(note) => buildEditRewriteRequest(note, language)}
        rewriteHint="The AI turns your note into a clear instruction for the edit"
        ariaLabel="What should change"
        maxLength={20_000}
        readOnly={sending}
        minHeight={56}
        maxHeight={200}
        textClassName={cn('text-sm leading-6', scriptClass(text))}
        placeholder="Ask AI to change the scenario: a shorter opening, a scene about pricing, a warmer tone..."
        onSubmit={() => void submit()}
        trailing={
          <>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 max-w-[16rem] text-[11px]"
                >
                  <span className="truncate">{runLabel(run)}</span>
                  <ChevronDown />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-[26rem] max-w-[calc(100vw-2rem)] space-y-2 p-3"
              >
                <p className="text-xs text-muted-foreground">Which AI makes the change</p>
                <RunSettingsFields value={run} onChange={onRunChange} />
              </PopoverContent>
            </Popover>
            <Button type="submit" size="sm" className="h-7 shrink-0" disabled={!ready}>
              <Send /> {busy ? 'AI is busy' : 'Ask'}
            </Button>
          </>
        }
      />
    </form>
  );
}
