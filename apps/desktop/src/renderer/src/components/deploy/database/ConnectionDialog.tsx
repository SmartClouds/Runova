import { engineInfo, type ParsedConnectionUrl, parseConnectionUrl } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type { DatabaseConnection, DatabaseSaveInput } from '@shared/databaseTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Plug } from '@/components/icons';
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
import { queryKeys } from '@/lib/queryKeys';
import { EngineMark } from './EngineMark';

/**
 * Adding a database Runova did not find: one pasted URL is enough. The engine, host, port, user,
 * password and database all come out of it. On a server's page the database can be one the server
 * reaches (on its own loopback, or a private network), carried over its SSH connection.
 */

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
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [throughServer, setThroughServer] = useState(server !== null);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl('');
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
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" /> Add a connection
            </DialogTitle>
            <DialogDescription>
              Paste the database's connection URL. It is the same one your app uses.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="database-url">Connection URL</Label>
            <Input
              id="database-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="postgres://user:password@host:5432/database"
              className="font-mono text-xs"
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            {parsed.error ? (
              <p className="text-xs text-destructive">{parsed.error}</p>
            ) : value ? (
              <div className="flex items-center gap-2 rounded-xl bg-foreground/[0.03] p-2 ring-1 ring-inset ring-foreground/[0.07]">
                <EngineMark engine={value.engine} size="sm" />
                <p className="min-w-0 truncate text-xs">
                  <span className="font-medium">{engineInfo(value.engine).label}</span>
                  <span className="text-muted-foreground">
                    {value.engine === 'sqlite'
                      ? ` file ${value.file}`
                      : ` at ${value.host}${value.port ? `:${value.port}` : ''}${value.user ? ` as ${value.user}` : ''}`}
                  </span>
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Works for postgres://, mysql://, mariadb://, mongodb:// and mongodb+srv://, redis://
                and rediss://, sqlserver://, cassandra:// and sqlite:// (a file on this computer).
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="database-name">Name</Label>
            <Input
              id="database-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={value ? defaultName(value) : 'Shown in the list'}
            />
          </div>

          <div className="space-y-2.5">
            {server && value?.engine !== 'sqlite' ? (
              <ToggleRow
                id="database-via-server"
                label={`Reach it through ${server.nickname}`}
                hint="For a database only the server can reach, like one on its own 127.0.0.1. The connection travels inside the server's SSH connection."
                checked={throughServer}
                onChange={setThroughServer}
              />
            ) : null}
            <ToggleRow
              id="database-read-only"
              label="Read-only"
              hint="Anything that changes data asks again before it runs, and the AI can only read."
              checked={readOnly}
              onChange={setReadOnly}
            />
          </div>

          {problem ? (
            <p role="alert" className="text-xs text-destructive">
              {problem}
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
              Save and connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
