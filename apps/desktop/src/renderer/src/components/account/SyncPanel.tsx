import type { SyncConflictView, SyncPolicy, SyncScopeView } from '@shared/syncTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  Cloud,
  Copy,
  GitMerge,
  Key,
  Lock,
  LockOpen,
  RefreshCw,
  ShieldSolid,
  TriangleAlert,
  Wifi,
} from '@/components/icons';
import { Chip, Notice, SectionCard } from '@/components/pageKit';
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
import { errorText, relativeTime, useSyncOverview } from '@/hooks/useAccount';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * Sync and encryption (E48): what syncs, the key and policy of each scope (the person's own and
 * each team's), and the items that changed on two computers before they synced.
 */

/** One line under the account's name: synced when, or what is in the way. */
export function SyncStatusLine(): React.JSX.Element | null {
  const overview = useSyncOverview();
  const client = useQueryClient();
  const syncNow = useMutation({
    mutationFn: () => window.runova.sync.syncNow(),
    onSuccess: (next) => client.setQueryData(queryKeys.syncOverview, next),
    onError: (error) => toast.error(errorText(error)),
  });
  const o = overview.data;
  if (!o) return null;
  const words =
    o.phase === 'syncing' || syncNow.isPending
      ? 'Syncing…'
      : o.phase === 'offline'
        ? 'Offline. Changes wait here and go out when the connection is back.'
        : o.phase === 'error'
          ? `Sync stopped: ${o.error ?? 'the server refused it'}`
          : o.lastSyncedAt
            ? `Synced ${relativeTime(o.lastSyncedAt)}`
            : 'Not synced yet';
  const Icon = o.phase === 'offline' ? Wifi : o.phase === 'error' ? TriangleAlert : CircleCheck;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Icon
        className={cn(
          'size-3.5',
          o.phase === 'error' ? 'text-warning' : o.phase === 'idle' ? 'text-primary' : '',
        )}
      />
      <span role="status">{words}</span>
      <button
        type="button"
        className="ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground"
        onClick={() => syncNow.mutate()}
        disabled={syncNow.isPending}
      >
        <RefreshCw
          className={cn('size-3', syncNow.isPending && 'animate-spin motion-reduce:animate-none')}
        />
        Sync now
      </button>
    </p>
  );
}

export function SyncPanel(): React.JSX.Element {
  const overview = useSyncOverview();
  const o = overview.data;
  if (!o) return <SectionCard icon={<Cloud />} title="Sync" />;
  return (
    <div className="grid gap-4">
      {o.conflicts > 0 && <ConflictsCard />}
      <div className="grid gap-4 lg:grid-cols-2">
        {o.scopes.map((scope) => (
          <ScopeCard key={scope.id} scope={scope} needsKey={o.needsKey.includes(scope.id)} />
        ))}
      </div>
      <WhatSyncsCard />
    </div>
  );
}

function WhatSyncsCard() {
  const overview = useSyncOverview();
  const client = useQueryClient();
  const toggle = async (collection: string, enabled: boolean) => {
    await window.runova.sync.setCollectionEnabled(collection, enabled);
    void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
  };
  return (
    <SectionCard
      icon={<Cloud />}
      title="What syncs from this computer"
      description="Turn off what this computer should keep to itself. Your other computers keep their own choices."
    >
      <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {(overview.data?.collections ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5">
            <Label htmlFor={`sync-${c.id}`} className="flex flex-col gap-0.5 font-normal">
              <span className="text-sm font-medium">{c.label}</span>
              {c.needsKey && (
                <span className="text-xs text-muted-foreground">Needs an encryption key</span>
              )}
            </Label>
            <Switch
              id={`sync-${c.id}`}
              checked={c.enabled}
              onCheckedChange={(on) => toggle(c.id, on)}
            />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        A project’s folder, the pairing of a remote device and caches never sync.
      </p>
    </SectionCard>
  );
}

const POLICY_ROWS: { key: keyof SyncPolicy; label: string; hint: string }[] = [
  {
    key: 'servers',
    label: 'Server connections',
    hint: 'Hosts, users and ports of SSH, Remote Desktop, databases and error tracking',
  },
  {
    key: 'environments',
    label: 'Environments',
    hint: 'Every environment of every project, names included',
  },
  {
    key: 'everything',
    label: 'Everything',
    hint: 'Projects, monitors, settings and the rest too. The website can then show only counts.',
  },
];

function ScopeCard({ scope, needsKey }: { scope: SyncScopeView; needsKey: boolean }) {
  const client = useQueryClient();
  const [dialog, setDialog] = useState<'set' | 'unlock' | 'change' | 'rotate' | null>(null);
  const isTeam = scope.kind === 'team';
  const title = isTeam ? scope.name : 'Your own data';
  const state = !scope.hasKey ? 'none' : scope.unlockedHere ? 'open' : 'locked';
  const setPolicy = async (key: keyof SyncPolicy, on: boolean) => {
    try {
      await window.runova.sync.setPolicy(scope.id, { ...scope.policy, [key]: on });
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  const reset = async () => {
    const ok = await confirmDialog({
      title: `Reset the key of ${title}?`,
      description:
        'Only for a lost passphrase and recovery key. Everything sealed with it is deleted from the cloud (nobody can open it now), and each computer sends what it still has again.',
      confirmLabel: 'Continue on runovahq.com',
      variant: 'destructive',
    });
    if (ok) await window.runova.account.openWebsite('/account/sync');
  };
  return (
    <SectionCard
      icon={state === 'none' ? <LockOpen /> : <Lock />}
      tone={state === 'none' ? 'neutral' : 'primary'}
      title={title}
      extra={
        <>
          {isTeam && <Chip>Team</Chip>}
          {state === 'open' && <Chip tone="primary">Encrypted end to end</Chip>}
          {state === 'locked' && <Chip tone="warning">Locked on this computer</Chip>}
        </>
      }
      description={
        state === 'none'
          ? isTeam
            ? 'No team key yet. Passwords and keys shared with this team wait until an Owner or Admin sets one.'
            : 'No key yet. Passwords, private keys and environment values stay on this computer until you set one.'
          : state === 'locked'
            ? `Type the ${isTeam ? 'team key' : 'passphrase'} once on this computer to read and send what is sealed.`
            : 'Secrets are sealed with a key only your computers hold. The server can not read them.'
      }
      actions={
        state === 'none' ? (
          scope.canManage && (
            <Button shape="pill" size="sm" onClick={() => setDialog('set')}>
              <Key /> Set a key
            </Button>
          )
        ) : state === 'locked' ? (
          <Button shape="pill" size="sm" onClick={() => setDialog('unlock')}>
            <LockOpen /> Unlock here
          </Button>
        ) : null
      }
    >
      {needsKey && state !== 'open' && (
        <Notice tone="primary" size="sm" className="mb-3">
          Sealed items from your other computers are waiting for this key.
        </Notice>
      )}
      {scope.hasKey && (
        <div className={cn(SECTION_WELL, 'grid gap-2')}>
          <p className="text-xs font-semibold">Also seal</p>
          {POLICY_ROWS.map((row) => (
            <div key={row.key} className="flex items-start justify-between gap-3">
              <Label
                htmlFor={`policy-${scope.id}-${row.key}`}
                className="flex flex-col gap-0.5 font-normal"
              >
                <span className="text-sm">{row.label}</span>
                <span className="text-xs text-muted-foreground">{row.hint}</span>
              </Label>
              <Switch
                id={`policy-${scope.id}-${row.key}`}
                checked={scope.policy[row.key]}
                disabled={!scope.canManage || !scope.unlockedHere}
                onCheckedChange={(on) => setPolicy(row.key, on)}
              />
            </div>
          ))}
          {!scope.canManage && (
            <p className="text-xs text-muted-foreground">
              The team’s Owners and Admins choose this.
            </p>
          )}
        </div>
      )}
      {state === 'open' && scope.canManage && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button shape="pill" size="sm" variant="soft" onClick={() => setDialog('change')}>
            Change passphrase
          </Button>
          {isTeam && (
            <Button shape="pill" size="sm" variant="soft" onClick={() => setDialog('rotate')}>
              Replace the key
            </Button>
          )}
          <Button shape="pill" size="sm" variant="ghost" onClick={reset}>
            Lost it?
          </Button>
        </div>
      )}
      {dialog && <KeyDialog scope={scope} mode={dialog} onClose={() => setDialog(null)} />}
    </SectionCard>
  );
}

const STRENGTH = (value: string): number => {
  if (!value) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  const words = value.trim().split(/\s+/).length;
  const score =
    value.length >= 20 || (value.length >= 14 && (words >= 3 || kinds >= 3))
      ? 4
      : value.length >= 14
        ? 3
        : value.length >= 12
          ? 2
          : 1;
  return score;
};

/** Setting, unlocking, changing or replacing a scope's key, in one dialog. */
function KeyDialog({
  scope,
  mode,
  onClose,
}: {
  scope: SyncScopeView;
  mode: 'set' | 'unlock' | 'change' | 'rotate';
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isTeam = scope.kind === 'team';
  const what = isTeam ? 'team key' : 'passphrase';
  const creating = mode !== 'unlock';
  const strength = STRENGTH(passphrase);

  const submit = async () => {
    setError(null);
    if (creating && passphrase !== again) {
      setError('The two passphrases are not the same.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'set')
        setRecovery((await window.runova.sync.setKey(scope.id, passphrase)).recoveryKey);
      else if (mode === 'rotate')
        setRecovery((await window.runova.sync.rotateKey(scope.id, passphrase)).recoveryKey);
      else if (mode === 'change') {
        await window.runova.sync.changePassphrase(scope.id, passphrase);
        toast.success(
          `The ${what} is changed. Type the new one on your other computers when they ask.`,
        );
        onClose();
      } else {
        await window.runova.sync.unlock(
          scope.id,
          useRecovery ? { recoveryKey: passphrase } : { passphrase },
        );
        toast.success(`${isTeam ? scope.name : 'Your data'} is unlocked on this computer.`);
        onClose();
      }
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const titles = {
    set: isTeam ? `Set the key of ${scope.name}` : 'Set your encryption key',
    unlock: isTeam ? `Unlock ${scope.name}` : 'Unlock your data on this computer',
    change: `Change the ${what}`,
    rotate: `Replace the key of ${scope.name}`,
  } as const;
  const descriptions = {
    set: isTeam
      ? 'Pick a passphrase to give your team, the way you would share a Wi-Fi password: in person or through your password manager, never by plain email. Each member types it once on each computer.'
      : 'Your passwords, private keys and environment values are sealed with this before they leave the computer. Runova can not reset it for you, so you also get a recovery key.',
    unlock: `Type the ${what} you set on another computer, or the recovery key.`,
    change:
      'The key stays the same, so nothing needs sealing again. Your other computers keep working.',
    rotate:
      'Do this after someone left the team: the old key opens nothing new. Give the new passphrase to the members who stay.',
  } as const;

  return (
    <Dialog open onOpenChange={(open) => !open && !recovery && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldSolid className="size-4 text-primary" />
            {recovery ? 'Save your recovery key' : titles[mode]}
          </DialogTitle>
          <DialogDescription>
            {recovery
              ? 'If you ever lose the passphrase, this opens your data instead. It is shown only now. Keep it in your password manager or print it.'
              : descriptions[mode]}
          </DialogDescription>
        </DialogHeader>
        {recovery ? (
          <div className="grid gap-3">
            <code className="block select-all rounded-xl bg-foreground/[0.05] p-3 text-center font-mono text-[13px] leading-relaxed tracking-wider ring-1 ring-foreground/10">
              {recovery}
            </code>
            <Button
              shape="pill"
              variant="soft"
              onClick={() =>
                navigator.clipboard
                  .writeText(recovery)
                  .then(() => toast.success('Copied the recovery key'))
              }
            >
              <Copy /> Copy
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
                className="accent-[hsl(var(--primary))]"
              />
              I saved my recovery key somewhere safe
            </label>
            <DialogFooter>
              <Button shape="pill" disabled={!saved} onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="key-passphrase">
                {mode === 'unlock' && useRecovery
                  ? 'Recovery key'
                  : creating
                    ? `New ${what}`
                    : what[0]?.toUpperCase() + what.slice(1)}
              </Label>
              <Input
                id="key-passphrase"
                type={useRecovery ? 'text' : 'password'}
                autoComplete="off"
                autoFocus
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className={useRecovery ? 'font-mono tracking-wider' : undefined}
              />
              {creating && (
                <div className="flex items-center gap-2" aria-live="polite">
                  <div className="flex flex-1 gap-1">
                    {[1, 2, 3, 4].map((step) => (
                      <span
                        key={step}
                        className={cn(
                          'h-1 flex-1 rounded-full',
                          step <= strength
                            ? strength < 3
                              ? 'bg-warning'
                              : 'bg-primary'
                            : 'bg-foreground/10',
                        )}
                      />
                    ))}
                  </div>
                  <span className="w-28 text-right text-xs text-muted-foreground">
                    {passphrase.length < 12
                      ? `${12 - passphrase.length} more characters`
                      : strength >= 3
                        ? 'Strong'
                        : 'Add another word'}
                  </span>
                </div>
              )}
            </div>
            {creating && (
              <div className="grid gap-1.5">
                <Label htmlFor="key-again">Type it again</Label>
                <Input
                  id="key-again"
                  type="password"
                  autoComplete="off"
                  value={again}
                  onChange={(e) => setAgain(e.target.value)}
                />
              </div>
            )}
            {mode === 'unlock' && (
              <button
                type="button"
                className="justify-self-start text-xs font-medium text-primary"
                onClick={() => setUseRecovery((v) => !v)}
              >
                {useRecovery ? `Use the ${what} instead` : 'Use the recovery key instead'}
              </button>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" shape="pill" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" shape="pill" disabled={busy || !passphrase}>
                {busy
                  ? 'Working…'
                  : mode === 'unlock'
                    ? 'Unlock'
                    : mode === 'change'
                      ? 'Change it'
                      : 'Set the key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConflictsCard() {
  const conflicts = useQuery({
    queryKey: queryKeys.syncConflicts,
    queryFn: () => window.runova.sync.conflicts(),
  });
  const [open, setOpen] = useState<SyncConflictView | null>(null);
  return (
    <SectionCard
      icon={<GitMerge />}
      tone="destructive"
      title="Changed on two computers"
      description="These changed here and on another computer before they synced. Pick the version to keep; nothing is lost until you do."
      flush
    >
      <ul className="divide-y divide-foreground/[0.07]">
        {(conflicts.data ?? []).map((c) => (
          <li
            key={`${c.scopeId}/${c.collection}/${c.itemId}`}
            className="flex items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{c.title}</p>
              <p className="text-xs text-muted-foreground">
                {c.collectionLabel} · {c.scopeName} ·{' '}
                {c.mine === null
                  ? 'deleted here'
                  : c.theirs === null
                    ? 'deleted there'
                    : `${c.changedFields.length} ${c.changedFields.length === 1 ? 'field differs' : 'fields differ'}`}
              </p>
            </div>
            <Button shape="pill" size="sm" onClick={() => setOpen(c)}>
              Review
            </Button>
          </li>
        ))}
      </ul>
      {open && <ConflictDialog conflict={open} onClose={() => setOpen(null)} />}
    </SectionCard>
  );
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Both versions side by side, the differing fields first. */
export function ConflictDialog({
  conflict,
  onClose,
}: {
  conflict: SyncConflictView;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const resolve = async (choice: 'mine' | 'theirs' | 'both') => {
    setBusy(true);
    try {
      await window.runova.sync.resolve(
        { scopeId: conflict.scopeId, collection: conflict.collection, itemId: conflict.itemId },
        choice,
      );
      toast.success(
        choice === 'mine'
          ? 'Kept this computer’s version.'
          : choice === 'theirs'
            ? 'Took the other computer’s version.'
            : 'Kept both.',
      );
      void client.invalidateQueries({ queryKey: queryKeys.syncConflicts });
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
      onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const fields = [
    ...conflict.changedFields,
    ...Object.keys(conflict.mine ?? conflict.theirs ?? {}).filter(
      (f) => !conflict.changedFields.includes(f),
    ),
  ].filter((f) => !['id', 'createdAt', 'updatedAt'].includes(f));
  const side = (label: string, value: Record<string, unknown> | null, tone: string) => (
    <div className={cn(SECTION_WELL, 'min-w-0')}>
      <p className={cn('mb-2 text-xs font-semibold', tone)}>{label}</p>
      {value === null ? (
        <p className="text-sm text-muted-foreground">Deleted</p>
      ) : (
        <dl className="grid gap-1.5">
          {fields.slice(0, 12).map((f) => (
            <div
              key={f}
              className={cn(
                'rounded-md px-1.5 py-0.5',
                conflict.changedFields.includes(f) && 'bg-warning/10',
              )}
            >
              <dt className="text-[11px] text-muted-foreground">{f}</dt>
              <dd className="truncate text-sm">{show(value[f])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{conflict.title}</DialogTitle>
          <DialogDescription>
            {conflict.collectionLabel} in {conflict.scopeName}. Highlighted fields differ. Secrets
            are hidden here and travel with whichever version you keep.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          {side('This computer', conflict.mine, 'text-primary')}
          {side('The other computer', conflict.theirs, 'text-sky-400')}
        </div>
        <DialogFooter className="flex-wrap gap-2">
          {conflict.canKeepBoth && (
            <Button shape="pill" variant="ghost" disabled={busy} onClick={() => resolve('both')}>
              Keep both
            </Button>
          )}
          <Button shape="pill" variant="soft" disabled={busy} onClick={() => resolve('theirs')}>
            Use the other computer’s
          </Button>
          <Button shape="pill" disabled={busy} onClick={() => resolve('mine')}>
            Keep this computer’s
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
