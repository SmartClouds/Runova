import {
  buildDatabaseAiPrompt,
  engineInfo,
  parseAiAnswer,
  type StatementClass,
} from '@runova/core';
import type { AskAiHistoryMessage } from '@shared/apiTypes';
import type { DatabaseSession, DbQueryOutcome } from '@shared/databaseTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AnglesRight, Code, Play, Send, Sparkles, Spinner, StopCircle } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { promptProviderModel } from '@/lib/promptProvider';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CODE_WELL } from '../security/SecurityCard';
import { confirmationText } from './QueryTab';
import { ResultGrid } from './ResultGrid';

/**
 * Ask in plain words, get a query with a short explanation. The AI sees the tables and their
 * columns; rows only when the user turns sample rows on. A query that reads can run right here;
 * one that changes anything waits for a yes, with what it changes spelled out.
 */

export interface AiSeed {
  question: string;
  lastQuery?: string;
  lastError?: string;
  /** Changes on every request, so the same question can be asked twice. */
  nonce: number;
}

type Message =
  | { id: number; role: 'user'; text: string }
  | {
      id: number;
      role: 'ai';
      explanation: string;
      query: string | null;
      run?:
        | { status: 'running' }
        | { status: 'held'; classification: StatementClass }
        | { status: 'done'; outcome: DbQueryOutcome };
    }
  | { id: number; role: 'error'; text: string };

let messageId = 0;

const SUGGESTIONS: Record<string, string[]> = {
  sql: [
    'Which tables are the biggest?',
    'Show the 20 newest rows of the busiest table',
    'Find duplicate values in a column that should be unique',
    'Which columns would an index help?',
  ],
  cql: ['List the tables in this keyspace with their keys', 'Show 20 rows of the first table'],
  mongo: [
    'Which collections hold the most documents?',
    'Show 10 documents from the biggest collection',
  ],
  redis: ['How much memory is in use?', 'Which keys use the most memory?'],
};

export function AiPanel({
  session,
  database,
  seed,
  onInsert,
  onClose,
}: {
  session: DatabaseSession;
  database: string | null;
  seed: AiSeed | null;
  onInsert: (query: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { connection } = session;
  const info = engineInfo(connection.engine);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [samples, setSamples] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });
  const choice = settings.data ? promptProviderModel(settings.data) : null;

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  // A seed (Fix with AI) asks once, as soon as the AI settings have loaded.
  const handledSeed = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ask reads the latest state itself
  useEffect(() => {
    if (!seed || !settings.data || handledSeed.current === seed.nonce) return;
    handledSeed.current = seed.nonce;
    void ask(seed.question, seed);
  }, [seed?.nonce, settings.data]);

  async function ask(question: string, extra: Partial<AiSeed> = {}) {
    const text = question.trim();
    if (!text || asking) return;
    if (!choice?.model.trim()) {
      setMessages((current) => [
        ...current,
        {
          id: messageId++,
          role: 'error',
          text: `Ask AI uses the Prompt Builder provider from Settings. Pick a ${choice?.provider ?? 'AI'} model there first.`,
        },
      ]);
      return;
    }
    const requestId = crypto.randomUUID();
    setAsking(requestId);
    setDraft('');
    const history: AskAiHistoryMessage[] = messages.flatMap((message): AskAiHistoryMessage[] => {
      if (message.role === 'user') return [{ role: 'user', content: message.text }];
      if (message.role === 'ai') {
        return [
          {
            role: 'assistant',
            content: message.query
              ? `${message.explanation}\n\n\`\`\`\n${message.query}\n\`\`\``
              : message.explanation,
          },
        ];
      }
      return [];
    });
    setMessages((current) => [...current, { id: messageId++, role: 'user', text }]);
    try {
      const context = await window.runova.database.aiContext({
        sessionId: session.sessionId,
        database,
        includeSamples: samples,
      });
      const prompt = buildDatabaseAiPrompt({
        engine: connection.engine,
        serverVersion: session.serverVersion,
        database: context.database,
        schema: context.schema,
        question: text,
        readOnly: connection.readOnly,
        ...(samples ? { samples: context.samples } : {}),
        ...(extra.lastQuery ? { lastQuery: extra.lastQuery } : {}),
        ...(extra.lastError ? { lastError: extra.lastError } : {}),
      });
      const result = await window.runova.ai.ask({
        provider: choice.provider,
        model: choice.model,
        prompt,
        history,
        requestId,
      });
      if (result.cancelled) return;
      if (!result.ok) throw new Error(result.error ?? 'The AI did not answer.');
      const answer = parseAiAnswer(result.text);
      setMessages((current) => [...current, { id: messageId++, role: 'ai', ...answer }]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: messageId++,
          role: 'error',
          text: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setAsking(null);
    }
  }

  async function run(message: Extract<Message, { role: 'ai' }>, confirmed = false) {
    if (!message.query) return;
    const update = (run: Extract<Message, { role: 'ai' }>['run']) =>
      setMessages((current) =>
        current.map((one) => (one.id === message.id ? { ...one, run } : one)),
      );
    update({ status: 'running' });
    try {
      const outcome = await window.runova.database.query({
        sessionId: session.sessionId,
        queryId: `ai-${message.id}`,
        text: message.query,
        database,
        origin: 'ai',
        maxRows: 200,
        ...(confirmed ? { confirmed: true } : {}),
      });
      update(
        outcome.status === 'needsConfirmation'
          ? { status: 'held', classification: outcome.classification }
          : { status: 'done', outcome },
      );
    } catch (error) {
      update({
        status: 'done',
        outcome: {
          status: 'failed',
          results: [],
          error: error instanceof Error ? error.message : String(error),
          statementIndex: null,
        },
      });
    }
  }

  return (
    <aside aria-label="Ask AI" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-foreground/[0.06] px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <p className="text-sm font-semibold">Ask AI</p>
        {choice?.model ? (
          <span className="truncate text-[11px] text-muted-foreground">{choice.model}</span>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="Hide Ask AI"
          onClick={onClose}
        >
          <AnglesRight />
        </Button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {messages.length === 0 ? (
          <div className="space-y-3 pt-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ask in plain words. The AI sees the tables and columns of{' '}
              {database ?? 'this database'}
              {samples ? ' and a few rows of each' : ', not the rows'}. It writes {info.label}{' '}
              {info.queryLanguage === 'mongo' ? 'shell commands' : 'queries'}; you choose what runs.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(SUGGESTIONS[info.queryLanguage] ?? SUGGESTIONS.sql ?? []).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void ask(suggestion)}
                  className="rounded-full bg-foreground/[0.05] px-2.5 py-1 text-left text-[11px] hover:bg-primary/10 hover:text-primary"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) =>
          message.role === 'user' ? (
            <div
              key={message.id}
              className="ml-6 rounded-2xl rounded-br-md bg-primary/12 px-3 py-2 text-xs"
            >
              {message.text}
            </div>
          ) : message.role === 'error' ? (
            <Notice key={message.id} tone="destructive" size="sm">
              {message.text}
            </Notice>
          ) : (
            <AiAnswer
              key={message.id}
              message={message}
              readOnly={connection.readOnly}
              onRun={(confirmed) => void run(message, confirmed)}
              onInsert={() => message.query && onInsert(message.query)}
            />
          ),
        )}
        {asking ? (
          <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3 w-3 animate-spin" /> Writing a query
          </div>
        ) : null}
      </div>

      <form
        className="space-y-2 border-t border-foreground/[0.06] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl bg-foreground/[0.04] p-1.5 ring-1 ring-inset ring-foreground/[0.06] focus-within:ring-primary/40">
          <textarea
            aria-label="Ask about this database"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask(draft);
              }
            }}
            rows={2}
            placeholder="Orders over 100 from last week, newest first"
            className="max-h-32 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-xs outline-none"
          />
          {asking ? (
            <Button
              type="button"
              size="icon-sm"
              variant="danger"
              aria-label="Stop"
              onClick={() => void window.runova.ai.cancel(asking)}
            >
              <StopCircle />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" aria-label="Ask" disabled={!draft.trim()}>
              <Send />
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Switch
            checked={samples}
            onCheckedChange={setSamples}
            aria-label="Let the AI see a few sample rows"
          />
          Let the AI see a few sample rows
        </label>
      </form>
    </aside>
  );
}

function AiAnswer({
  message,
  readOnly,
  onRun,
  onInsert,
}: {
  message: Extract<Message, { role: 'ai' }>;
  readOnly: boolean;
  onRun: (confirmed: boolean) => void;
  onInsert: () => void;
}): React.JSX.Element {
  const run = message.run;
  const done = run?.status === 'done' ? run.outcome : null;
  const first =
    done && done.status !== 'needsConfirmation' ? done.results[done.results.length - 1] : undefined;
  return (
    <div className="space-y-2">
      {message.explanation ? (
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{message.explanation}</p>
      ) : null}
      {message.query ? (
        <>
          <pre
            aria-label="Suggested query"
            className={cn(CODE_WELL, 'max-h-56 whitespace-pre-wrap text-[11px]')}
          >
            {message.query}
          </pre>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="xs"
              shape="pill"
              onClick={() => onRun(false)}
              disabled={run?.status === 'running'}
            >
              {run?.status === 'running' ? <Spinner className="animate-spin" /> : <Play />} Run
            </Button>
            <Button size="xs" shape="pill" variant="soft" onClick={onInsert}>
              <Code /> Open in editor
            </Button>
          </div>
        </>
      ) : null}
      {run?.status === 'held' ? (
        <Notice
          tone={run.classification.destructive ? 'destructive' : 'warning'}
          size="sm"
          action={
            <Button
              size="xs"
              shape="pill"
              variant={run.classification.destructive ? 'destructive' : 'default'}
              onClick={() => onRun(true)}
            >
              Review done, run it
            </Button>
          }
        >
          The AI wrote a query that changes the database.{' '}
          {confirmationText(run.classification, readOnly)} Read it above before you run it.
        </Notice>
      ) : null}
      {done?.status === 'failed' ? (
        <Notice tone="destructive" size="sm">
          {done.error}
        </Notice>
      ) : null}
      {done?.status === 'cancelled' ? <Notice size="sm">Stopped.</Notice> : null}
      {first ? (
        first.columns.length > 0 ? (
          <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-foreground/[0.07]">
            <ResultGrid label="AI query result" result={first} className="max-h-56" />
            <p className="border-t border-foreground/[0.06] px-2 py-1 text-[10px] text-muted-foreground">
              {first.rows.length} {first.rows.length === 1 ? 'row' : 'rows'}
              {first.truncated ? ', more not shown' : ''}
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Done{first.affectedRows !== null ? `: ${first.affectedRows} rows changed` : ''}.
          </p>
        )
      ) : null}
    </div>
  );
}
