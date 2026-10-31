import { type DbEngine, settingStatement } from '@runova/core';
import type { DbSetting } from '@shared/databaseTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pencil, Search } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { type PendingStatements, RunStatementsDialog } from './RunStatementsDialog';

/**
 * The server's settings, searchable by name or description. A change shows the statement it
 * turns into before it runs, and says when the server has to restart for it to count.
 */
export function SettingsTab({
  sessionId,
  engine,
}: {
  sessionId: string;
  engine: DbEngine;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null);
  const [pending, setPending] = useState<PendingStatements | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const key = [...queryKeys.databaseSession(sessionId), 'settings'];
  const settings = useQuery({
    queryKey: key,
    queryFn: () => window.runova.database.settings(sessionId),
    retry: false,
  });

  const shown = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (settings.data ?? []).filter((setting) =>
      words.every((word) =>
        `${setting.name} ${setting.description ?? ''} ${setting.category ?? ''}`
          .toLowerCase()
          .includes(word),
      ),
    );
  }, [settings.data, search]);

  const change = (setting: DbSetting, value: string) => {
    setProblem(null);
    try {
      setPending({
        title: `Change ${setting.name}`,
        description: setting.restartRequired
          ? 'The server keeps the new value, but it only takes effect after a restart.'
          : 'It takes effect right away and is kept across restarts.',
        statements: [settingStatement(engine, setting.name, value)],
        action: 'Change it',
        onDone: () => {
          setEditing(null);
          setSaved(
            setting.restartRequired
              ? `${setting.name} is saved. Restart the database for it to take effect.`
              : `${setting.name} is now ${value}.`,
          );
          void queryClient.invalidateQueries({ queryKey: key });
        },
      });
    } catch (error) {
      setSaved(null);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-foreground/[0.06] px-3 py-2">
        <div className="flex flex-1 items-center gap-2 rounded-lg bg-foreground/[0.04] px-2.5 ring-1 ring-inset ring-foreground/[0.06]">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            aria-label="Search settings"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="memory, connections, timeout..."
            className="h-8 flex-1 bg-transparent text-xs outline-none"
          />
        </div>
        <span className="text-[11px] text-muted-foreground">
          {settings.data ? `${shown.length} of ${settings.data.length}` : ''}
        </span>
      </div>
      {saved ? (
        <Notice tone="success" size="sm" className="m-3 mb-0">
          {saved}
        </Notice>
      ) : null}
      {problem ? (
        <Notice tone="warning" size="sm" className="m-3 mb-0">
          {problem}
        </Notice>
      ) : null}
      {settings.isError ? (
        <Notice tone="destructive" size="sm" className="m-3">
          {settings.error instanceof Error
            ? settings.error.message
            : 'Could not read the settings.'}
        </Notice>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {settings.isPending ? (
          <div className="space-y-2 p-3" aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <ul aria-label="Settings" className="divide-y divide-foreground/[0.05]">
            {shown.slice(0, 400).map((setting) => (
              <li
                key={setting.name}
                className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2"
              >
                <div className="min-w-[14rem] flex-1">
                  <p className="font-mono text-xs font-medium">{setting.name}</p>
                  {setting.description ? (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {setting.description}
                    </p>
                  ) : null}
                </div>
                {editing?.name === setting.name ? (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      change(setting, editing.value);
                    }}
                  >
                    {setting.options ? (
                      <select
                        aria-label={`New value for ${setting.name}`}
                        value={editing.value}
                        onChange={(event) =>
                          setEditing({ name: setting.name, value: event.target.value })
                        }
                        className="h-7 rounded-md bg-foreground/[0.06] px-2 text-xs"
                      >
                        {setting.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        aria-label={`New value for ${setting.name}`}
                        value={editing.value}
                        onChange={(event) =>
                          setEditing({ name: setting.name, value: event.target.value })
                        }
                        className="h-7 w-44 font-mono text-xs"
                        autoFocus
                      />
                    )}
                    <Button type="submit" size="xs" shape="pill">
                      Review
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      shape="pill"
                      variant="ghost"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    {setting.restartRequired ? (
                      <span className="rounded-full bg-warning/12 px-1.5 py-0.5 text-[10px] text-warning">
                        needs restart
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        'max-w-[16rem] truncate font-mono text-xs',
                        !setting.value && 'text-muted-foreground',
                      )}
                    >
                      {setting.value || '(empty)'}
                      {setting.unit ? (
                        <span className="ml-1 text-muted-foreground">{setting.unit}</span>
                      ) : null}
                    </span>
                    {setting.editable ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Change ${setting.name}`}
                        onClick={() => {
                          setSaved(null);
                          setEditing({ name: setting.name, value: setting.value });
                        }}
                      >
                        <Pencil />
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {shown.length > 400 ? (
          <p className="px-3 py-3 text-center text-xs text-muted-foreground">
            Showing the first 400. Search to find the rest.
          </p>
        ) : null}
        {settings.data && settings.data.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            This database has no settings to show.
          </p>
        ) : null}
      </div>
      <RunStatementsDialog
        sessionId={sessionId}
        pending={pending}
        onClose={() => setPending(null)}
      />
    </div>
  );
}
