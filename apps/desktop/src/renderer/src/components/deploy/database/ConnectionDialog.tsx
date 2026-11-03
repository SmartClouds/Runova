import {
  DB_ENGINES,
  type DbEngine,
  engineInfo,
  type ParsedConnectionUrl,
  parseConnectionUrl,
} from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type { DatabaseConnection, DatabaseSaveInput } from '@shared/databaseTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleAlert, Lock, Plug, Server, Spinner, TriangleAlert } from '@/components/icons';
import { SECTION_WELL } from '@/components/pageKit/styles';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { EngineMark } from './EngineMark';

/**
 * Adding a database Runova did not find: one pasted URL is enough. The engine, host, port, user,
 * password and database all come out of it. On a server's page the database can be one the server
 * reaches (on its own loopback, or a private network), carried over its SSH connection.
 */

/** What each engine's URL looks like, shown as the field's placeholder when its mark is picked. */
const EXAMPLE_URLS: Record<DbEngine, string> = {
  postgres: 'postgres://user:password@host:5432/database',
  mysql: 'mysql://user:password@host:3306/database',
  mariadb: 'mariadb://user:password@host:3306/database',
  mongodb: 'mongodb+srv://user:password@cluster.example.net/database',
  redis: 'redis://:password@host:6379',
  sqlite: 'sqlite:///path/to/app.db',
  cassandra: 'cassandra://user:password@host:9042/keyspace',
  mssql: 'sqlserver://user:password@host:1433/database',
};

function defaultName(parsed: ParsedConnectionUrl): string {
  if (parsed.engine === 'sqlite') return parsed.file.split(/[\\/]/).pop() || 'SQLite';
  return parsed.database ? `${parsed.database} on ${parsed.host}` : parsed.host;
}

export function ConnectionDialog({
  open,
  server,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  server: DeployServer | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (connection: DatabaseConnection) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const urlRef = useRef<HTMLInputElement>(null);
  const urlHelpId = useId();
  const [url, setUrl] = useState('');
  const [example, setExample] = useState<DbEngine>('postgres');
  const [name, setName] = useState('');
  const [throughServer, setThroughServer] = useState(server !== null);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl('');
    setExample('postgres');
    setName('');
    setThroughServer(server !== null);
    setReadOnly(false);
    setProblem(null);
  }, [open, server]);

  const parsed = useMemo((): { value: ParsedConnectionUrl | null; error: string | null } => {
    if (!url.trim()) return { value: null, error: null };
    try {
      return { value: parseConnectionUrl(url), error: null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [url]);

  const value = parsed.value;
  const viaServer = server !== null && throughServer && value !== null && value.engine !== 'sqlite';

  function pickExample(engine: DbEngine) {
    setExample(engine);
    urlRef.current?.focus();
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!value) return;
    setBusy(true);
    setProblem(null);
    try {
      const input: DatabaseSaveInput =
        value.engine === 'sqlite'
          ? {
              name: name.trim() || defaultName(value),
              engine: 'sqlite',
              target: { kind: 'sqliteFile', path: value.file },
              readOnly,
            }
          : {
              name: name.trim() || defaultName(value),
              engine: value.engine,
              target:
                viaServer && server
                  ? {
                      kind: 'server',
                      serverId: server.id,
                      host: value.host,
                      port: value.port ?? engineInfo(value.engine).defaultPort ?? 1,
                    }
                  : { kind: 'direct', host: value.host, port: value.port },
              user: value.user ?? null,
              database: value.database ?? null,
              authDatabase: value.authDatabase ?? null,
              tls: value.tls,
              srv: value.srv ?? false,
              readOnly,
              ...(value.password !== undefined ? { password: value.password } : {}),
            };
      const saved = await window.runova.database.saveConnection(input);
      await queryClient.invalidateQueries({ queryKey: queryKeys.databaseConnections() });
      onSaved(saved);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <form className="space-y-5" onSubmit={(event) => void save(event)}>
          <DialogHeader className="flex-row items-start gap-3 pr-8">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
              <Plug className="h-4 w-4" />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle>Add a connection</DialogTitle>
              <DialogDescription>
                Paste the database's connection URL, the same one your app uses.
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="database-url">Connection URL</Label>
            <Input
              ref={urlRef}
              id="database-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={EXAMPLE_URLS[example]}
              className="font-mono text-xs"
              aria-invalid={parsed.error ? true : undefined}
              aria-describedby={urlHelpId}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <div id={urlHelpId}>
              {parsed.error ? (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <CircleAlert className="mt-px h-3 w-3 shrink-0" />
                  {parsed.error}
                </p>
              ) : value ? (
                <ParsedSummary value={value} />
              ) : (
                <EnginePicker selected={example} onPick={pickExample} />
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="database-name">Name</Label>
              <span className="text-xs text-muted-foreground">Optional</span>
            </div>
            <Input
              id="database-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={value ? defaultName(value) : 'Shown in the list'}
            />
          </div>

          <div className={cn(SECTION_WELL, 'divide-y divide-foreground/[0.07] p-0')}>
            {server && value?.engine !== 'sqlite' ? (
              <ToggleRow
                id="database-via-server"
                icon={<Server className="h-3.5 w-3.5" />}
                label={`Reach it through ${server.nickname}`}
                hint="For a database only the server can reach, like one on its own 127.0.0.1. The connection travels inside the server's SSH connection."
                checked={throughServer}
                onChange={setThroughServer}
              />
            ) : null}
            <ToggleRow
              id="database-read-only"
              icon={<Lock className="h-3.5 w-3.5" />}
              label="Read-only"
              hint="Anything that changes data asks again before it runs, and the AI can only read."
              checked={readOnly}
              onChange={setReadOnly}
            />
          </div>

          {problem ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive ring-1 ring-inset ring-destructive/20"
            >
              <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{problem}</span>
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value}>
              {busy ? <Spinner className="animate-spin" /> : null}
              {busy ? 'Connecting' : 'Save and connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The engines a URL can name, as marks. Picking one shows its URL shape in the field. */
function EnginePicker({
  selected,
  onPick,
}: {
  selected: DbEngine;
  onPick: (engine: DbEngine) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-xs text-muted-foreground">Works with</span>
      <div className="flex flex-wrap items-center gap-1">
        {DB_ENGINES.map((info) => (
          <SimpleTooltip
            key={info.engine}
            label={info.engine === 'sqlite' ? 'SQLite (a file on this computer)' : info.label}
          >
            <button
              type="button"
              aria-label={`Show a ${info.label} example`}
              aria-pressed={selected === info.engine}
              onClick={() => onPick(info.engine)}
              className={cn(
                'cursor-pointer rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected === info.engine
                  ? 'ring-1 ring-foreground/30'
                  : 'opacity-60 hover:opacity-100',
              )}
            >
              <EngineMark engine={info.engine} size="sm" />
            </button>
          </SimpleTooltip>
        ))}
      </div>
    </div>
  );
}

/** What Runova read from the URL, so a typo shows up before anything connects. */
function ParsedSummary({ value }: { value: ParsedConnectionUrl }): React.JSX.Element {
  const info = engineInfo(value.engine);
  if (value.engine === 'sqlite') {
    return (
      <div className={cn(SECTION_WELL, 'flex items-center gap-3 p-2.5')}>
        <EngineMark engine="sqlite" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{info.label}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{value.file}</p>
        </div>
      </div>
    );
  }

  const address = `${value.host}${value.port ? `:${value.port}` : ''}`;
  const missingPassword = info.passwordRequired && value.password === undefined;
  const details: Array<[string, string]> = [
    ['User', value.user ?? 'None'],
    [info.engine === 'cassandra' ? 'Keyspace' : 'Database', value.database ?? 'Default'],
    ['Password', value.password !== undefined ? 'Included' : 'None'],
  ];

  return (
    <div className="space-y-2">
      <div className={cn(SECTION_WELL, 'space-y-2.5 p-2.5')}>
        <div className="flex items-center gap-3">
          <EngineMark engine={value.engine} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{info.label}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{address}</p>
          </div>
          {value.tls ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              <Lock className="h-2.5 w-2.5" /> Encrypted
            </span>
          ) : null}
        </div>
        <dl className="grid grid-cols-3 gap-2 border-t border-foreground/[0.07] pt-2.5">
          {details.map(([term, detail]) => (
            <div key={term} className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">{term}</dt>
              <dd className="truncate text-xs font-medium">{detail}</dd>
            </div>
          ))}
        </dl>
      </div>
      {missingPassword ? (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
          {info.label} usually needs a password. Put it after the user, like user:password@host.
        </p>
      ) : null}
    </div>
  );
}

function ToggleRow({
  id,
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 p-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-1" />
    </div>
  );
}
