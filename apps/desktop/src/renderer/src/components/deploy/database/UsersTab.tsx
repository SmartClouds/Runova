import {
  type AccessLevel,
  accessStatements,
  changePasswordStatement,
  createUserStatements,
  type DbEngine,
  dropUserStatement,
  engineInfo,
} from '@runova/core';
import type { DbUser } from '@shared/databaseTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Key, Plus, RefreshCw, ShieldSolid, Trash2, Users } from '@/components/icons';
import { EmptyState, Notice, SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
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
import { SecretInput } from '@/components/ui/secret-input';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { type PendingStatements, RunStatementsDialog } from './RunStatementsDialog';

/**
 * Who can sign in, and what they can reach, in plain levels per database: none, read, write or
 * admin. Every change shows its statements first, with the password starred out.
 */

const LEVELS: { value: AccessLevel; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'Cannot see this database.' },
  { value: 'read', label: 'Read', hint: 'Can read every table, change nothing.' },
  { value: 'write', label: 'Write', hint: 'Can read, add, change and delete rows.' },
  { value: 'admin', label: 'Admin', hint: 'Can do anything, including changing tables.' },
];

type FormMode =
  | { kind: 'create' }
  | { kind: 'access'; user: DbUser }
  | { kind: 'password'; user: DbUser };

/** A strong password made here, so nobody has to think one up. */
export function generatePassword(length = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function UsersTab({
  sessionId,
  engine,
  defaultDatabase,
}: {
  sessionId: string;
  engine: DbEngine;
  defaultDatabase: string | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormMode | null>(null);
  const [pending, setPending] = useState<PendingStatements | null>(null);
  const key = [...queryKeys.databaseSession(sessionId), 'users'];
  const users = useQuery({
    queryKey: key,
    queryFn: () => window.runova.database.users(sessionId),
    retry: false,
  });
  const info = engineInfo(engine);
  const hasHosts = engine === 'mysql' || engine === 'mariadb';
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-foreground/[0.06] px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {users.data ? `${users.data.length} ${users.data.length === 1 ? 'user' : 'users'}` : ''}
        </p>
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="Reload users"
          onClick={refresh}
        >
          <RefreshCw className={cn(users.isFetching && 'animate-spin')} />
        </Button>
        <Button size="sm" shape="pill" variant="tint" onClick={() => setForm({ kind: 'create' })}>
          <Plus /> New user
        </Button>
      </div>
      {users.isError ? (
        <Notice tone="destructive" size="sm" className="m-3">
          {users.error instanceof Error ? users.error.message : 'Could not read the users.'}
        </Notice>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {users.isPending ? (
          <div className="space-y-2 p-3" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : users.data && users.data.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Users}
            title="No users to show"
            description={`This ${info.label} has no users, or this sign-in cannot list them.`}
          />
        ) : (
          <ul aria-label="Users" className="divide-y divide-foreground/[0.05]">
            {(users.data ?? []).map((user) => (
              <li
                key={`${user.name}@${user.host ?? ''}`}
                className="flex flex-wrap items-center gap-3 px-3 py-2.5"
              >
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold uppercase text-primary"
                >
                  {user.name.slice(0, 1)}
                </span>
                <div className="min-w-[12rem] flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium">{user.name}</span>
                    {user.host ? (
                      <span className="text-xs text-muted-foreground">@{user.host}</span>
                    ) : null}
                    {user.superuser ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-1.5 text-[10px] text-warning">
                        <ShieldSolid className="h-2.5 w-2.5" /> superuser
                      </span>
                    ) : null}
                    {!user.canLogin ? (
                      <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] text-muted-foreground">
                        role, cannot sign in
                      </span>
                    ) : null}
                  </p>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {user.access?.map((entry) => (
                      <span
                        key={entry.database}
                        className="rounded-md bg-foreground/[0.05] px-1.5 text-[11px] text-muted-foreground"
                      >
                        {entry.database === '*' ? 'every database' : entry.database}: {entry.level}
                      </span>
                    ))}
                    {user.detail ? (
                      <span className="text-[11px] text-muted-foreground">{user.detail}</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="xs"
                    shape="pill"
                    variant="soft"
                    onClick={() => setForm({ kind: 'access', user })}
                  >
                    Access
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Change the password of ${user.name}`}
                    onClick={() => setForm({ kind: 'password', user })}
                  >
                    <Key />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${user.name}`}
                    onClick={() =>
                      setPending({
                        title: `Remove ${user.name}`,
                        description: 'The user can no longer sign in. Their tables stay.',
                        statements: [
                          dropUserStatement(engine, {
                            user: user.name,
                            host: user.host ?? undefined,
                          }),
                        ],
                        action: 'Remove user',
                        destructive: true,
                        onDone: refresh,
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <UserForm
        sessionId={sessionId}
        engine={engine}
        mode={form}
        hasHosts={hasHosts}
        defaultDatabase={defaultDatabase}
        onClose={() => setForm(null)}
        onReview={(next) => {
          setForm(null);
          setPending({ ...next, onDone: refresh });
        }}
      />
      <RunStatementsDialog
        sessionId={sessionId}
        pending={pending}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

function UserForm({
  sessionId,
  engine,
  mode,
  hasHosts,
  defaultDatabase,
  onClose,
  onReview,
}: {
  sessionId: string;
  engine: DbEngine;
  mode: FormMode | null;
  hasHosts: boolean;
  defaultDatabase: string | null;
  onClose: () => void;
  onReview: (pending: PendingStatements) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [host, setHost] = useState('%');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState(defaultDatabase ?? '');
  const [level, setLevel] = useState<AccessLevel>('read');
  const [problem, setProblem] = useState<string | null>(null);
  const info = engineInfo(engine);
  const needsDatabase = engine !== 'redis';
  const databases = useQuery({
    queryKey: queryKeys.databaseObjects(sessionId, ''),
    queryFn: () =>
      window.runova.database.listObjects({ sessionId, parent: null, parentKind: null }),
    enabled: mode !== null && needsDatabase && info.capabilities.databases,
  });

  useEffect(() => {
    if (!mode) return;
    setProblem(null);
    setName(mode.kind === 'create' ? '' : mode.user.name);
    setHost(mode.kind === 'create' ? '%' : (mode.user.host ?? '%'));
    setPassword(mode.kind === 'access' ? '' : generatePassword());
    setDatabase(defaultDatabase ?? '');
    setLevel('read');
  }, [mode, defaultDatabase]);

  const ref = { user: name.trim(), ...(hasHosts ? { host: host.trim() || '%' } : {}) };

  function review(event: React.FormEvent) {
    event.preventDefault();
    if (!mode) return;
    try {
      if (mode.kind === 'create') {
        onReview({
          title: `Create ${ref.user}`,
          description: 'Copy the password now: it is not shown again.',
          statements: createUserStatements(engine, {
            ...ref,
            password,
            ...(needsDatabase && database ? { database } : {}),
            level,
          }),
          secret: password,
          action: 'Create user',
        });
      } else if (mode.kind === 'password') {
        onReview({
          title: `New password for ${ref.user}`,
          statements: [changePasswordStatement(engine, ref, password)],
          secret: password,
          action: 'Change password',
        });
      } else {
        onReview({
          title: `Access for ${ref.user}`,
          description: `${ref.user} gets exactly this level in ${database || 'the database'}.`,
          statements: accessStatements(engine, {
            ...ref,
            ...(database ? { database } : {}),
            level,
          }),
          action: 'Change access',
        });
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  const title =
    mode?.kind === 'create'
      ? 'New user'
      : mode?.kind === 'password'
        ? `Password of ${name}`
        : `Access for ${name}`;
  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={review}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {mode?.kind === 'password'
                ? 'A strong password is filled in. Keep it, or type your own.'
                : `What the user can do in ${info.label}. You see the statements before they run.`}
            </DialogDescription>
          </DialogHeader>
          {mode?.kind === 'create' ? (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="user-name">User name</Label>
                <Input
                  id="user-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                />
              </div>
              {hasHosts ? (
                <div className="w-28 space-y-1.5">
                  <Label htmlFor="user-host">From host</Label>
                  <Input
                    id="user-host"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {mode?.kind !== 'access' ? (
            <div className="space-y-1.5">
              <Label htmlFor="user-password">Password</Label>
              <div className="flex gap-2">
                <SecretInput
                  id="user-password"
                  value={password}
                  onChange={setPassword}
                  className="flex-1"
                  autoComplete="new-password"
                />
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  onClick={() => setPassword(generatePassword())}
                >
                  New one
                </Button>
              </div>
            </div>
          ) : null}
          {mode?.kind !== 'password' ? (
            <>
              {needsDatabase ? (
                <div className="space-y-1.5">
                  <Label htmlFor="user-database">Database</Label>
                  <Input
                    id="user-database"
                    value={database}
                    list="user-databases"
                    onChange={(event) => setDatabase(event.target.value)}
                    placeholder="shop"
                  />
                  <datalist id="user-databases">
                    {(databases.data ?? []).map((node) => (
                      <option key={node.name} value={node.name} />
                    ))}
                  </datalist>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label>Access</Label>
                <div role="radiogroup" aria-label="Access" className={SEGMENT_TRACK}>
                  {LEVELS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={level === option.value}
                      onClick={() => setLevel(option.value)}
                      className={segmentClass(level === option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {LEVELS.find((option) => option.value === level)?.hint}
                </p>
              </div>
            </>
          ) : null}
          {problem ? (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Review</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
