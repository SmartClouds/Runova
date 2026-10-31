import { type DbEngine, engineInfo, type StatementClass } from '@runova/core';
import type { DbQueryOutcome } from '@shared/databaseTypes';
import { lazy, Suspense, useRef, useState } from 'react';
import { Play, Spinner, StopCircle } from '@/components/icons';
import { Notice, PillTabs } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { cn } from '@/lib/utils';
import { ResultGrid } from './ResultGrid';

/**
 * The query editor: write, press Run (or Ctrl+Enter), and see one result per statement. A query
 * that drops, truncates or changes every row waits for a second yes, as does any write on a
 * read-only connection.
 */

let runCounter = 0;

/** Monaco is big, so it loads with the first query tab rather than with the Deploy page. */
const MonacoEditor = lazy(() =>
  import('@/components/editor/MonacoEditor').then((module) => ({ default: module.MonacoEditor })),
);

export function confirmationText(classification: StatementClass, readOnly: boolean): string {
  if (classification.destructive) {
    return 'This query deletes data or structure, or changes every row. It cannot be undone.';
  }
  if (readOnly) return 'This connection is read-only, and this query changes the database.';
  return 'This query changes the database.';
}

export function QueryTab({
  sessionId,
  engine,
  readOnly,
  text,
  database,
  onTextChange,
  onAskAi,
}: {
  sessionId: string;
  engine: DbEngine;
  readOnly: boolean;
  text: string;
  database: string | null;
  onTextChange: (text: string) => void;
  /** Hands the query and its error to the AI panel. */
  onAskAi?: (prompt: string) => void;
}): React.JSX.Element {
  const [outcome, setOutcome] = useState<DbQueryOutcome | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [resultIndex, setResultIndex] = useState(0);
  const [editorHeight, setEditorHeight] = useState(220);
  const textRef = useRef(text);
  textRef.current = text;
  const info = engineInfo(engine);

  async function run(confirmed = false) {
    if (running) return;
    const queryId = `q-${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
    setRunning(queryId);
    try {
      const next = await window.runova.database.query({
        sessionId,
        queryId,
        text: textRef.current,
        database,
        origin: 'editor',
        ...(confirmed ? { confirmed: true } : {}),
      });
      setOutcome(next);
      // The last statement is usually the one the query was written for.
      setResultIndex(
        next.status === 'needsConfirmation' ? 0 : Math.max(0, next.results.length - 1),
      );
    } catch (error) {
      setOutcome({
        status: 'failed',
        results: [],
        error: error instanceof Error ? error.message : String(error),
        statementIndex: null,
      });
    } finally {
      setRunning(null);
    }
  }

  const results = outcome && outcome.status !== 'needsConfirmation' ? outcome.results : [];
  const shown = results[Math.min(resultIndex, results.length - 1)];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-foreground/[0.06] px-3 py-2">
        <Button
          size="sm"
          shape="pill"
          onClick={() => void run()}
          disabled={running !== null}
          aria-label="Run query"
          title="Run query (Ctrl+Enter)"
        >
          {running ? <Spinner className="animate-spin" /> : <Play />}
          Run
          <kbd
            aria-hidden
            className="ml-1 rounded bg-primary-foreground/15 px-1 text-[10px] font-normal"
          >
            Ctrl+Enter
          </kbd>
        </Button>
        {running ? (
          <Button
            size="sm"
            shape="pill"
            variant="danger"
            onClick={() => void window.runova.database.cancelQuery(sessionId, running)}
          >
            <StopCircle /> Stop
          </Button>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {info.label}
          {database ? ` · ${database}` : ''}
        </span>
      </div>

      <div
        className="relative shrink-0 overflow-hidden"
        style={{ height: editorHeight }}
        onKeyDownCapture={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void run();
          }
        }}
      >
        <Suspense
          fallback={<div className="h-full animate-pulse bg-foreground/[0.02]" aria-busy="true" />}
        >
          <MonacoEditor
            value={text}
            onChange={onTextChange}
            language={info.editorLanguage}
            className="absolute inset-0 min-h-0 rounded-none border-0"
          />
        </Suspense>
      </div>
      <ResizeHandle
        orientation="horizontal"
        label="Resize the editor"
        size={editorHeight}
        min={96}
        max={640}
        defaultSize={220}
        onSizeChange={setEditorHeight}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {outcome?.status === 'needsConfirmation' ? (
          <Notice
            tone={outcome.classification.destructive ? 'destructive' : 'warning'}
            className="m-3"
            action={
              <div className="flex gap-1.5">
                <Button size="sm" shape="pill" variant="ghost" onClick={() => setOutcome(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  shape="pill"
                  variant={outcome.classification.destructive ? 'destructive' : 'default'}
                  onClick={() => void run(true)}
                >
                  Run anyway
                </Button>
              </div>
            }
          >
            {confirmationText(outcome.classification, readOnly)}
          </Notice>
        ) : null}

        {outcome?.status === 'failed' ? (
          <Notice
            tone="destructive"
            size="sm"
            className="m-3"
            action={
              onAskAi ? (
                <Button
                  size="xs"
                  shape="pill"
                  variant="tint"
                  onClick={() =>
                    onAskAi(
                      `This query failed with: ${outcome.error}\n\nFix it:\n${textRef.current}`,
                    )
                  }
                >
                  Fix with AI
                </Button>
              ) : undefined
            }
          >
            {outcome.statementIndex !== null && outcome.statementIndex > 0
              ? `Statement ${outcome.statementIndex + 1} failed: `
              : ''}
            {outcome.error}
          </Notice>
        ) : null}

        {outcome?.status === 'cancelled' ? (
          <Notice size="sm" className="m-3">
            Stopped.
          </Notice>
        ) : null}

        {results.length > 1 ? (
          <PillTabs
            id={`results-${sessionId}`}
            label="Results"
            size="xs"
            className="mx-3 mt-2"
            items={results.map((_, index) => ({
              value: String(index),
              label: `Result ${index + 1}`,
            }))}
            value={String(Math.min(resultIndex, results.length - 1))}
            onChange={(value) => setResultIndex(Number(value))}
          />
        ) : null}

        {shown ? (
          shown.columns.length > 0 ? (
            <ResultGrid label="Query result" result={shown} className="flex-1" />
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {shown.affectedRows !== null
                ? `${shown.affectedRows.toLocaleString()} ${shown.affectedRows === 1 ? 'row' : 'rows'} changed.`
                : 'Done.'}
              {shown.notice ? ` ${shown.notice}` : ''}
            </p>
          )
        ) : !outcome ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Results show here. Ctrl+Enter runs the query.
          </p>
        ) : null}

        {shown ? (
          <div
            className={cn(
              'flex items-center gap-3 border-t border-foreground/[0.06] px-3 py-1.5 text-[11px] text-muted-foreground',
            )}
          >
            {shown.columns.length > 0 ? (
              <span>
                {shown.rows.length.toLocaleString()} {shown.rows.length === 1 ? 'row' : 'rows'}
                {shown.truncated ? ', more not shown' : ''}
              </span>
            ) : null}
            <span className="ml-auto tabular-nums">{shown.durationMs} ms</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
