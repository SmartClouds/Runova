import type { ShareableGroup, TeamRole, TeamView } from '@shared/syncTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, Key, Plus, Search, UserPlus, Users } from '@/components/icons';
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
import { errorText, relativeTime, useSyncOverview } from '@/hooks/useAccount';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * Teams (E48): the teams of the account, invitations waiting for it, the people in a team, and
 * what this computer shares with each. Role changes and removals need the password, so they live
 * on the account panel on runovahq.com, one click away.
 */

const ROLE_LABEL: Record<TeamRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export function TeamsPanel(): React.JSX.Element {
  const client = useQueryClient();
  const teams = useQuery({ queryKey: queryKeys.teams, queryFn: () => window.runova.teams.list() });
  const invitations = useQuery({
    queryKey: queryKeys.myInvitations,
    queryFn: () => window.runova.teams.myInvitations(),
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState('');
  const team = teams.data?.find((t) => t.id === selected) ?? teams.data?.[0] ?? null;

  const create = async () => {
    try {
      const made = await window.runova.teams.create(name.trim());
      setName('');
      setSelected(made.id);
      toast.success(`Made ${made.name}. Set its key next, then invite people.`);
      void client.invalidateQueries({ queryKey: queryKeys.teams });
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const answer = async (id: number, accept: boolean) => {
    try {
      if (accept) {
        const joined = await window.runova.teams.accept(id);
        setSelected(joined.id);
        toast.success(`You joined ${joined.name}. Type its team key to read what it shares.`);
      } else await window.runova.teams.decline(id);
      void client.invalidateQueries({ queryKey: ['teams'] });
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <div className="grid gap-4">
      {(invitations.data ?? []).length > 0 && (
        <SectionCard icon={<UserPlus />} title="Invitations for you" flush>
          <ul className="divide-y divide-foreground/[0.07]">
            {(invitations.data ?? []).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{i.teamName}</p>
                  <p className="text-xs text-muted-foreground">
                    {i.invitedBy} invited you as {ROLE_LABEL[i.role]} · ends{' '}
                    {relativeTime(i.expiresAt)}
                  </p>
                </div>
                <Button size="sm" shape="pill" variant="ghost" onClick={() => answer(i.id, false)}>
                  Decline
                </Button>
                <Button size="sm" shape="pill" onClick={() => answer(i.id, true)}>
                  Join
                </Button>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <SectionCard icon={<Users />} title="Your teams" flush>
          <ul className="grid gap-px p-2">
            {(teams.data ?? []).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setSelected(t.id)}
                  aria-current={team?.id === t.id ? true : undefined}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    team?.id === t.id
                      ? 'bg-primary/12 font-semibold text-primary'
                      : 'hover:bg-foreground/[0.06]',
                  )}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground/[0.06] text-xs font-semibold text-foreground">
                    {t.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">{t.memberCount}</span>
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2 border-t border-foreground/[0.07] p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <Input
              aria-label="New team name"
              placeholder="New team name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
            <Button
              type="submit"
              shape="pill"
              size="icon"
              disabled={!name.trim()}
              title="Make the team"
            >
              <Plus />
            </Button>
          </form>
        </SectionCard>
        {team ? (
          <TeamDetail team={team} />
        ) : (
          <SectionCard
            icon={<Users />}
            title="Share with the people you work with"
            description="Make a team, set its key, invite people by email, then share servers, passwords, environments and monitors with it."
          />
        )}
      </div>
    </div>
  );
}

function TeamDetail({ team }: { team: TeamView }) {
  const client = useQueryClient();
  const overview = useSyncOverview();
  const members = useQuery({
    queryKey: queryKeys.teamMembers(team.id),
    queryFn: () => window.runova.teams.members(team.id),
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [sharing, setSharing] = useState(false);
  const scope = overview.data?.scopes.find((s) => s.teamId === team.id);
  const manager = team.role === 'owner' || team.role === 'admin';

  const invite = async () => {
    try {
      await window.runova.teams.invite(team.id, email.trim(), role);
      toast.success(
        `Invited ${email.trim()}. Give them the team key yourself, not by plain email.`,
      );
      setEmail('');
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const leave = async () => {
    const ok = await confirmDialog({
      title: `Leave ${team.name}?`,
      description:
        'What the team shares leaves this computer at the next sync. An Owner or Admin can invite you back.',
      confirmLabel: 'Leave team',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      const status = await window.runova.account.status();
      if (status.state !== 'signed-in') return;
      await window.runova.teams.removeMember(team.id, status.account.id);
      void client.invalidateQueries({ queryKey: ['teams'] });
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <SectionCard
      icon={<Users />}
      title={team.name}
      extra={
        <Chip tone={team.role === 'owner' ? 'primary' : 'neutral'}>{ROLE_LABEL[team.role]}</Chip>
      }
      description={`${team.memberCount} ${team.memberCount === 1 ? 'person' : 'people'} · made ${relativeTime(team.createdAt)}`}
      actions={
        <>
          <Button
            shape="pill"
            size="sm"
            variant="soft"
            onClick={() => window.runova.account.openWebsite(`/account/teams/${team.id}`)}
          >
            <ExternalLink /> Manage people
          </Button>
          {team.role !== 'owner' && (
            <Button shape="pill" size="sm" variant="ghost" onClick={leave}>
              Leave
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4">
        {scope && !scope.hasKey && (
          <Notice tone="warning" size="sm">
            {manager
              ? 'Set the team key in Sync and encryption before sharing passwords and keys.'
              : 'An Owner or Admin has not set the team key yet. Passwords and keys can not be shared until they do.'}
          </Notice>
        )}
        {scope && scope.hasKey && !scope.unlockedHere && (
          <Notice tone="primary" size="sm" icon={Key}>
            Type the team key on this computer (Sync and encryption, {team.name}, Unlock here) to
            read what the team shares.
          </Notice>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Shared items</p>
          {scope?.canWrite && (
            <Button shape="pill" size="sm" onClick={() => setSharing(true)}>
              Share something
            </Button>
          )}
        </div>
        <SharedList teamId={team.id} />
        <div>
          <p className="mb-2 text-sm font-medium">People</p>
          <ul className="grid gap-1">
            {(members.data ?? []).map((m) => (
              <li key={m.userId} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary/35 to-sky-400/20 text-[11px] font-semibold ring-1 ring-foreground/10">
                  {m.displayName
                    .split(/\s+/)
                    .map((p) => p[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.displayName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                </span>
                <Chip>{ROLE_LABEL[m.role]}</Chip>
              </li>
            ))}
          </ul>
        </div>
        {manager && (
          <form
            className={cn(SECTION_WELL, 'grid gap-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end')}
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) void invite();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="invite-email">Invite by email</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="kim@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as TeamRole)}
                className="field-surface h-9 rounded-lg px-2 text-sm"
              >
                {(team.role === 'owner'
                  ? (['admin', 'member', 'viewer'] as TeamRole[])
                  : (['member', 'viewer'] as TeamRole[])
                ).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" shape="pill" disabled={!email.trim()}>
              <UserPlus /> Invite
            </Button>
          </form>
        )}
      </div>
      {sharing && <ShareDialog team={team} onClose={() => setSharing(false)} />}
    </SectionCard>
  );
}

function SharedList({ teamId }: { teamId: number }) {
  const shareable = useQuery({
    queryKey: queryKeys.syncShareable,
    queryFn: () => window.runova.sync.shareable(),
  });
  const client = useQueryClient();
  const shared = (shareable.data ?? []).flatMap((g) =>
    g.items.filter((i) => i.teamId === teamId).map((i) => ({ ...i, group: g })),
  );
  const unshare = async (collection: string, itemId: string) => {
    await window.runova.sync.share({ collection, itemId, teamId: null });
    void client.invalidateQueries({ queryKey: queryKeys.syncShareable });
  };
  if (shared.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing shared yet. Shared items show up on every member’s computer.
      </p>
    );
  }
  return (
    <ul className="grid gap-1">
      {shared.map((item) => (
        <li
          key={`${item.group.collection}/${item.id}`}
          className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-foreground/[0.03]"
        >
          <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
          <Chip>{item.group.label}</Chip>
          <Button
            size="xs"
            shape="pill"
            variant="ghost"
            onClick={() => unshare(item.group.collection, item.id)}
          >
            Stop sharing
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Pick items from any shareable collection and move them into the team. */
function ShareDialog({ team, onClose }: { team: TeamView; onClose: () => void }) {
  const client = useQueryClient();
  const shareable = useQuery({
    queryKey: queryKeys.syncShareable,
    queryFn: () => window.runova.sync.shareable(),
  });
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const groups = useMemo<ShareableGroup[]>(
    () =>
      (shareable.data ?? [])
        .map((g) => ({
          ...g,
          items: g.items.filter(
            (i) => i.teamId === null && i.title.toLowerCase().includes(filter.toLowerCase()),
          ),
        }))
        .filter((g) => g.items.length > 0),
    [shareable.data, filter],
  );
  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const share = async () => {
    setBusy(true);
    try {
      for (const key of picked) {
        const [collection, itemId] = key.split('\u0000') as [string, string];
        await window.runova.sync.share({ collection, itemId, teamId: team.id });
      }
      toast.success(
        `Shared ${picked.size} ${picked.size === 1 ? 'item' : 'items'} with ${team.name}.`,
      );
      void client.invalidateQueries({ queryKey: queryKeys.syncShareable });
      onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share with {team.name}</DialogTitle>
          <DialogDescription>
            Shared items move into the team: every member gets them, and they leave your own list.
            Stop sharing to bring one back.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Find"
            placeholder="Find"
            className="pl-8"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="max-h-80 overflow-y-auto">
          {groups.map((g) => (
            <fieldset key={g.collection} className="mb-3">
              <legend className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                {g.label}
              </legend>
              {g.items.map((i) => {
                const key = `${g.collection}\u0000${i.id}`;
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-foreground/[0.04]"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(key)}
                      onChange={() => toggle(key)}
                      className="accent-[hsl(var(--primary))]"
                    />
                    <span className="truncate">{i.title}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
          {groups.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing left to share here.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button shape="pill" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button shape="pill" disabled={busy || picked.size === 0} onClick={share}>
            {busy ? 'Sharing…' : `Share ${picked.size || ''}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
