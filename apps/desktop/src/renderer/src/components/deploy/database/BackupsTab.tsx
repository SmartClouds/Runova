import { engineInfo } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type { DatabaseBackupFile, DatabaseConnection } from '@shared/databaseTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Archive, FolderOpen, History, Spinner, Trash2, Upload } from '@/components/icons';
import { EmptyState, Notice } from '@/components/pageKit';
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
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Backups with the engine's own tool (pg_dump, mysqldump, mongodump and the rest), run inside
 * the database's container, saved on this computer. A restore replaces what is in the database,
 * so it asks for the database's name typed out first.
 */

const TOOLS: Record<string, string> = {
  postgres: 'pg_dump',
  mysql: 'mysqldump',
  mariadb: 'mariadb-dump',
  mongodb: 'mongodump',
  redis: 'redis-cli --rdb',
  mssql: 'BACKUP DATABASE',
  cassandra: 'cqlsh DESCRIBE',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function runsWhere(connection: DatabaseConnection): string | null {
  const target = connection.target;
  if (target.kind === 'localContainer') return `inside ${target.containerName} in Docker here`;
  if (target.kind === 'server') {
    return target.containerName ? `inside ${target.containerName} on the server` : 'on the server';
  }
  return null;
}

export function BackupsTab({ connection }: { connection: DatabaseConnection }): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = ['database', 'backups', connection.id];
  const [progress, setProgress] = useState<{ kind: 'backup' | 'restore'; bytes: number } | null>(
    null,
  );
  const [restoring, setRestoring] = useState<DatabaseBackupFile | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'destructive'; text: string } | null>(
    null,
  );
  const where = runsWhere(connection);
  const info = engineInfo(connection.engine);
  const tool = TOOLS[connection.engine] ?? 'the database tools';

  const files = useQuery({
    queryKey: key,
    queryFn: () => window.runova.database.listBackups(connection.id),
    enabled: where !== null,
  });

  useEffect(
    () =>
      window.runova.database.onBackupProgress((event) => {
        if (event.connectionId !== connection.id) return;
        setProgress(event.done ? null : { kind: event.kind, bytes: event.bytes });
      }),
    [connection.id],
  );

  const backup = useMutation({
    mutationFn: () => window.runova.database.backup(connection.id),
    onMutate: () => {
      setNotice(null);
      setProgress({ kind: 'backup', bytes: 0 });
    },
    onSuccess: (file) => {
      setNotice({ tone: 'success', text: `Saved ${file.name} (${formatBytes(file.size)}).` });
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => setNotice({ tone: 'destructive', text: coreErrorMessage(error) }),
    onSettled: () => setProgress(null),
  });

  const fromFile = useMutation({
    mutationFn: () => window.runova.database.restoreFromFile(connection.id),
    onMutate: () => setNotice(null),
    onSuccess: (done) => {
      if (done) setNotice({ tone: 'success', text: 'Restored from the file.' });
      void queryClient.invalidateQueries({ queryKey: ['database', 'session'] });
    },
    onError: (error) => setNotice({ tone: 'destructive', text: coreErrorMessage(error) }),
    onSettled: () => setProgress(null),
  });

  const remove = useMutation({
    mutationFn: (name: string) => window.runova.database.removeBackup(connection.id, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  if (!where) {
    return (
      <EmptyState
        icon={Archive}
        title="Backups need the database in a container or on a server"
        description={`Runova backs up with ${tool}, run where the database lives. For this connection, export what you need with a query instead.`}
      />
    );
  }

  const busy = backup.isPending || fromFile.isPending || progress !== null;
  return (
    <div className="h-full space-y-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-primary/[0.06] p-4 ring-1 ring-inset ring-primary/15">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Archive className="h-4 w-4" />
        </span>
        <div className="min-w-[14rem] flex-1">
          <p className="text-sm font-semibold">Back up {connection.database ?? connection.name}</p>
          <p className="text-xs text-muted-foreground">
            Runs {tool} {where} and saves the file on this computer.
            {connection.engine === 'cassandra' ? ' Cassandra backups keep the schema only.' : ''}
          </p>
        </div>
        <Button shape="pill" onClick={() => backup.mutate()} disabled={busy}>
          {backup.isPending ? <Spinner className="animate-spin" /> : <Archive />}
          {backup.isPending ? 'Backing up' : 'Back up now'}
        </Button>
      </div>

      {progress ? (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3 w-3 animate-spin" />
          {progress.kind === 'backup' ? 'Saved' : 'Sent'} {formatBytes(progress.bytes)} so far
        </div>
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} size="sm">
          {notice.text}
        </Notice>
      ) : null}

      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-muted-foreground">Saved backups</h4>
        {connection.engine !== 'redis' ? (
          <Button
            size="xs"
            shape="pill"
            variant="ghost"
            onClick={() => fromFile.mutate()}
            disabled={busy}
          >
            <Upload /> Restore from a file
          </Button>
        ) : null}
      </div>

      {files.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </div>
      ) : files.data && files.data.length === 0 ? (
        <p className="rounded-xl bg-foreground/[0.03] px-3 py-6 text-center text-xs text-muted-foreground">
          No backups yet. The first one is a click away.
        </p>
      ) : (
        <ul
          aria-label="Backups"
          className="divide-y divide-foreground/[0.05] rounded-xl ring-1 ring-inset ring-foreground/[0.07]"
        >
          {(files.data ?? []).map((file) => (
            <li key={file.name} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <div className="min-w-[12rem] flex-1">
                <p className="truncate font-mono text-xs">{file.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(file.createdAt).toLocaleString()} · {formatBytes(file.size)}
                  {file.complete ? '' : ' · schema only'}
                </p>
              </div>
              {connection.engine !== 'redis' ? (
                <Button
                  size="xs"
                  shape="pill"
                  variant="soft"
                  onClick={() => setRestoring(file)}
                  disabled={busy}
                >
                  <History /> Restore
                </Button>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Show ${file.name} in its folder`}
                onClick={() => void window.runova.database.revealBackup(connection.id, file.name)}
              >
                <FolderOpen />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${file.name}`}
                onClick={() => remove.mutate(file.name)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {connection.engine === 'redis' ? (
        <Notice size="sm">
          Redis loads a snapshot only when it starts. To restore, copy the file into its data folder
          as dump.rdb and restart the container.
        </Notice>
      ) : null}

      <RestoreDialog
        file={restoring}
        confirmWord={connection.database ?? connection.name}
        engineLabel={info.label}
        onClose={() => setRestoring(null)}
        onRestore={async (file) => {
          setNotice(null);
          setProgress({ kind: 'restore', bytes: 0 });
          try {
            await window.runova.database.restore(connection.id, file.name);
            setNotice({ tone: 'success', text: `Restored ${file.name}.` });
            void queryClient.invalidateQueries({ queryKey: ['database', 'session'] });
          } catch (error) {
            setNotice({ tone: 'destructive', text: coreErrorMessage(error) });
          } finally {
            setProgress(null);
          }
        }}
      />
    </div>
  );
}

function RestoreDialog({
  file,
  confirmWord,
  engineLabel,
  onClose,
  onRestore,
}: {
  file: DatabaseBackupFile | null;
  confirmWord: string;
  engineLabel: string;
  onClose: () => void;
  onRestore: (file: DatabaseBackupFile) => Promise<void>;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (file) setTyped('');
  }, [file]);
  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!file || typed !== confirmWord) return;
            setBusy(true);
            onClose();
            try {
              await onRestore(file);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <History className="h-4 w-4" /> Restore {file?.name}
            </DialogTitle>
            <DialogDescription>
              This replaces what is in the {engineLabel} database {confirmWord} with the backup.
              Anything written since the backup was made is lost. Back up first if you are not sure.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="restore-confirm">
              Type <span className="font-mono font-semibold">{confirmWord}</span> to restore
            </Label>
            <Input
              id="restore-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={typed !== confirmWord}>
              Restore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
