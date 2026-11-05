import {
  CloudCog,
  Lock,
  LockOpen,
  Mail,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Field } from '@/components/admin/Field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  type Account,
  type Activity,
  apiRequest,
  COLLECTION_LABELS,
  type MyInvitation,
  type Page,
  ROLE_HINTS,
  ROLE_LABELS,
  type SyncScope,
  type SyncUsage,
  type Team,
  type TeamInvitation,
  type TeamMember,
  type TeamRole,
} from '@/lib/account/api';
import { ActivityList } from './Panel';
import {
  bytes,
  Card,
  CardHeader,
  LoadFailure,
  Notice,
  PageHeader,
  Pill,
  Rows,
  relativeTime,
  Shimmer,
  StepUpDialog,
  useLoad,
} from './ui';

function ScopeCard({ scope, account }: { scope: SyncScope; account: Account | null }) {
  const usage = useLoad<SyncUsage>(`/sync-scopes/${scope.id}/usage`);
  const [wiping, setWiping] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [reset, setReset] = useState(false);
  const [wiped, setWiped] = useState(false);
  const encrypted = scope.keyVersion !== null;
  const sealed = [
    scope.policy.everything && 'everything',
    scope.policy.servers && 'server connections',
    scope.policy.environments && 'environments',
  ].filter(Boolean);
  const share = usage.value ? Math.min(100, (usage.value.bytes / usage.value.quotaBytes) * 100) : 0;
  return (
    <Card>
      <CardHeader
        icon={encrypted ? <Lock /> : <LockOpen />}
        tone={encrypted ? 'primary' : 'neutral'}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {scope.kind === 'personal' ? 'Your own data' : scope.name}
            {scope.kind === 'team' && <Pill>Team</Pill>}
            {encrypted ? (
              <Pill tone="success">
                <ShieldCheck className="size-3" aria-hidden />
                End-to-end encrypted
              </Pill>
            ) : (
              <Pill tone="warning">No key yet</Pill>
            )}
          </span>
        }
        description={
          encrypted
            ? `Passwords and keys are sealed with a key only your computers hold${sealed.length ? `, and so are ${sealed.join(', ')}` : ''}. This page can not read them.`
            : 'Passwords, keys and environment values stay on each computer until you set a key in the Runova app (Account, then Sync and encryption).'
        }
        actions={
          scope.canManage && (
            <>
              {encrypted && (
                <Button size="sm" variant="ghost" onClick={() => setResetting(true)}>
                  Reset the key
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setWiping(true)}>
                <Trash2 />
                Wipe the cloud copy
              </Button>
            </>
          )
        }
      />
      {wiped && (
        <div className="px-5 pb-3">
          <Notice tone="success">
            The cloud copy is gone. Each computer sends what it still has at its next sync.
          </Notice>
        </div>
      )}
      {usage.value ? (
        <div className="px-5 pb-5">
          <div className="mb-2 flex justify-between text-muted-foreground text-xs">
            <span>
              {usage.value.records} items · {bytes(usage.value.bytes)}
            </span>
            <span>{bytes(usage.value.quotaBytes)} space</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max(share, usage.value.bytes ? 1 : 0)}%` }}
            />
          </div>
          {Object.keys(usage.value.collections).length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2">
              {Object.entries(usage.value.collections).map(([name, count]) => (
                <li
                  key={name}
                  className="rounded-full bg-foreground/[0.05] px-3 py-1 text-xs ring-1 ring-foreground/[0.07] ring-inset"
                >
                  {COLLECTION_LABELS[name] ?? name}{' '}
                  <span className="text-muted-foreground">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : usage.problem ? (
        <LoadFailure problem={usage.problem} retry={usage.reload} />
      ) : (
        <Shimmer lines={2} />
      )}
      {reset && (
        <div className="px-5 pb-3">
          <Notice tone="success">
            The key is reset. Set a new one in the Runova app; each computer then seals and sends
            what it holds again.
          </Notice>
        </div>
      )}
      <StepUpDialog
        open={resetting}
        title="Reset the encryption key?"
        description="Only for a lost passphrase and recovery key. Everything sealed with it is deleted here, because nobody can open it any more. Your computers keep their own copies and send them again once a new key is set."
        confirm="Reset the key"
        destructive
        hasPassword={account?.hasPassword ?? true}
        twoFactor={account?.twoFactorEnabled ?? false}
        onClose={() => setResetting(false)}
        onConfirm={async (stepUp) => {
          const response = await apiRequest(`/sync-scopes/${scope.id}/keys/current`, {
            method: 'DELETE',
            body: stepUp,
          });
          if (!response.ok)
            return Object.keys(response.problem.errors).length
              ? response.problem.errors
              : { error: [response.problem.detail] };
          setResetting(false);
          setReset(true);
          void usage.reload();
          return null;
        }}
      />
      <StepUpDialog
        open={wiping}
        title="Wipe the cloud copy?"
        description="Everything stored here for this space is deleted. Data on your computers stays, and each computer sends it again at its next sync."
        confirm="Wipe it"
        destructive
        hasPassword={account?.hasPassword ?? true}
        twoFactor={account?.twoFactorEnabled ?? false}
        onClose={() => setWiping(false)}
        onConfirm={async (stepUp) => {
          const response = await apiRequest(`/sync-scopes/${scope.id}/records`, {
            method: 'DELETE',
            body: stepUp,
          });
          if (!response.ok)
            return Object.keys(response.problem.errors).length
              ? response.problem.errors
              : { error: [response.problem.detail] };
          setWiping(false);
          setWiped(true);
          void usage.reload();
          return null;
        }}
      />
    </Card>
  );
}

export function SyncPage() {
  const scopes = useLoad<{ items: SyncScope[] }>('/sync-scopes');
  const account = useLoad<Account>('/accounts/me');
  return (
    <>
      <PageHeader
        title="Sync"
        description="What your computers keep the same through your account. Choose what syncs, and set encryption keys, in the Runova app."
      />
      {scopes.problem ? (
        <Card>
          <LoadFailure problem={scopes.problem} retry={scopes.reload} />
        </Card>
      ) : !scopes.value ? (
        <Card>
          <Shimmer lines={4} />
        </Card>
      ) : (
        <div className="grid gap-4">
          {scopes.value.items.map((scope) => (
            <ScopeCard key={scope.id} scope={scope} account={account.value} />
          ))}
        </div>
      )}
      <p className="mt-4 flex items-center gap-2 text-muted-foreground text-xs">
        <CloudCog className="size-3.5" aria-hidden />A project's folder never syncs: each computer
        keeps its own.
      </p>
    </>
  );
}

export function Teams() {
  const teams = useLoad<{ items: Team[] }>('/teams');
  const invitations = useLoad<{ items: MyInvitation[] }>('/invitations');
  const [name, setName] = useState('');
  const [error, setError] = useState<string[] | undefined>();
  const create = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    const response = await apiRequest<Team>('/teams', { method: 'POST', body: { name } });
    if (response.ok) window.location.assign(`/account/teams/${response.value.id}`);
    else setError(response.problem.errors.name ?? [response.problem.detail]);
  };
  return (
    <>
      <PageHeader
        title="Teams"
        description="Share servers, passwords, environments and monitors with the people you work with."
      />
      {invitations.value && invitations.value.items.length > 0 && (
        <div className="mb-4">
          <Invitations
            items={invitations.value.items}
            onChange={() => {
              void invitations.reload();
              void teams.reload();
            }}
          />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader icon={<Users />} title="Your teams" />
          {teams.problem ? (
            <LoadFailure problem={teams.problem} retry={teams.reload} />
          ) : !teams.value ? (
            <Shimmer />
          ) : teams.value.items.length === 0 ? (
            <p className="px-5 pb-5 text-muted-foreground text-sm">
              You are not in a team yet. Make one, or accept an invitation sent to your email.
            </p>
          ) : (
            <Rows>
              {teams.value.items.map((team) => (
                <li key={team.id}>
                  <a
                    href={`/account/teams/${team.id}`}
                    className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-foreground/[0.03]"
                  >
                    <span className="flex size-9 items-center justify-center rounded-inner bg-foreground/[0.06] font-semibold text-sm">
                      {team.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{team.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {team.memberCount} {team.memberCount === 1 ? 'person' : 'people'}
                      </span>
                    </span>
                    <Pill tone={team.role === 'owner' ? 'primary' : 'neutral'}>
                      {ROLE_LABELS[team.role]}
                    </Pill>
                  </a>
                </li>
              ))}
            </Rows>
          )}
        </Card>
        <Card>
          <CardHeader
            icon={<Plus />}
            title="Make a team"
            description="You become its Owner and can invite people by email."
          />
          <form onSubmit={create} className="grid gap-3 px-5 pb-5">
            <Field id="team-name" label="Team name" errors={error}>
              {(control) => (
                <Input
                  {...control}
                  className="app-field"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  placeholder="Platform team"
                />
              )}
            </Field>
            <Button type="submit">Make team</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

export function Invitations({ items, onChange }: { items: MyInvitation[]; onChange: () => void }) {
  const answer = async (invitation: MyInvitation, accept: boolean) => {
    const response = accept
      ? await apiRequest<Team>(`/invitations/${invitation.id}/acceptances`, { method: 'POST' })
      : await apiRequest(`/invitations/${invitation.id}`, { method: 'DELETE' });
    if (response.ok && accept) window.location.assign(`/account/teams/${invitation.teamId}`);
    else onChange();
  };
  return (
    <Card className="ring-1 ring-primary/25">
      <CardHeader
        icon={<Mail />}
        title={
          items.length === 1 ? 'You have an invitation' : `You have ${items.length} invitations`
        }
      />
      <Rows>
        {items.map((invitation) => (
          <li key={invitation.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <div className="min-w-[12rem] flex-1">
              <p className="font-medium">{invitation.teamName}</p>
              <p className="text-muted-foreground text-xs">
                {invitation.invitedBy} invited you as {ROLE_LABELS[invitation.role]} · ends{' '}
                {relativeTime(invitation.expiresAt)}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => answer(invitation, false)}>
              Decline
            </Button>
            <Button size="sm" onClick={() => answer(invitation, true)}>
              Join {invitation.teamName}
            </Button>
          </li>
        ))}
      </Rows>
    </Card>
  );
}

export function InvitationsPage() {
  const invitations = useLoad<{ items: MyInvitation[] }>('/invitations');
  return (
    <>
      <PageHeader
        title="Invitations"
        description="Teams that asked you to join. Only invitations to your own email address show here."
      />
      {!invitations.value ? (
        <Card>
          <Shimmer />
        </Card>
      ) : invitations.value.items.length === 0 ? (
        <Card>
          <div className="p-5">
            <Notice title="No invitations waiting">
              An invitation lasts 7 days. Ask for a new one if yours expired, and check it went to
              the email you sign in with.
            </Notice>
          </div>
        </Card>
      ) : (
        <Invitations items={invitations.value.items} onChange={invitations.reload} />
      )}
    </>
  );
}

const ROLES: TeamRole[] = ['owner', 'admin', 'member', 'viewer'];

export function TeamDetail({ teamId, meId }: { teamId: number; meId: number }) {
  const team = useLoad<Team>(`/teams/${teamId}`);
  const members = useLoad<{ items: TeamMember[] }>(`/teams/${teamId}/members`);
  const account = useLoad<Account>('/accounts/me');
  const manager = team.value?.role === 'owner' || team.value?.role === 'admin';
  const invites = useLoad<{ items: TeamInvitation[] }>(
    manager ? `/teams/${teamId}/invitations` : null,
  );
  const activity = useLoad<Page<Activity>>(
    manager ? `/teams/${teamId}/activities?pageSize=10` : null,
  );
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    kind: 'role' | 'remove' | 'delete' | 'leave';
    member?: TeamMember;
    role?: TeamRole;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (team.problem?.status === 404) window.location.assign('/account/teams');
  }, [team.problem]);

  if (team.problem && team.problem.status !== 404)
    return <LoadFailure problem={team.problem} retry={team.reload} />;
  if (!team.value)
    return (
      <Card>
        <Shimmer lines={5} />
      </Card>
    );
  const t = team.value;
  const mayManage = (target: TeamRole) =>
    t.role === 'owner' || (t.role === 'admin' && (target === 'member' || target === 'viewer'));

  const invite = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setInviteError(null);
    const response = await apiRequest(`/teams/${teamId}/invitations`, {
      method: 'POST',
      body: { email, role },
    });
    if (response.ok) {
      setSent(email);
      setEmail('');
      void invites.reload();
    } else
      setInviteError(
        response.problem.errors.email?.[0] ??
          response.problem.errors.role?.[0] ??
          response.problem.detail,
      );
  };

  return (
    <>
      <PageHeader
        title={t.name}
        description={`You are ${ROLE_LABELS[t.role]}. ${ROLE_HINTS[t.role]}.`}
        actions={
          t.role === 'owner' ? (
            <Button variant="ghost" onClick={() => setPending({ kind: 'delete' })}>
              <Trash2 /> Delete team
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setPending({ kind: 'leave' })}>
              Leave team
            </Button>
          )
        }
      />
      {notice && (
        <Notice tone="success" className="mb-4">
          {notice}
        </Notice>
      )}
      {failure && (
        <Notice tone="warning" className="mb-4">
          {failure}
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader
            icon={<Users />}
            title="People"
            description="Share an item with the team from its menu in the Runova app."
          />
          {!members.value ? (
            <Shimmer />
          ) : (
            <Rows>
              {members.value.items.map((m) => (
                <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-primary/30 to-severity-info/20 font-semibold text-xs ring-1 ring-foreground/10">
                    {m.displayName
                      .split(/\s+/)
                      .map((p) => p[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                  <div className="min-w-[10rem] flex-1">
                    <p className="font-medium text-sm">
                      {m.displayName}{' '}
                      {m.userId === meId && <span className="text-muted-foreground">(you)</span>}
                    </p>
                    <p className="text-muted-foreground text-xs">{m.email}</p>
                  </div>
                  {mayManage(m.role) && m.userId !== meId ? (
                    <>
                      <label className="sr-only" htmlFor={`role-${m.userId}`}>
                        Role of {m.displayName}
                      </label>
                      <select
                        id={`role-${m.userId}`}
                        value={m.role}
                        onChange={(e) =>
                          setPending({ kind: 'role', member: m, role: e.target.value as TeamRole })
                        }
                        className="app-field h-8 rounded-full px-3 text-sm"
                      >
                        {ROLES.filter((r) => mayManage(r)).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPending({ kind: 'remove', member: m })}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <Pill tone={m.role === 'owner' ? 'primary' : 'neutral'}>
                      {ROLE_LABELS[m.role]}
                    </Pill>
                  )}
                </li>
              ))}
            </Rows>
          )}
        </Card>

        {manager && (
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader
                icon={<UserPlus />}
                title="Invite someone"
                description="They get an email and join once they sign in with that address."
              />
              <form onSubmit={invite} className="grid gap-3 px-5 pb-5">
                <Field
                  id="invite-email"
                  label="Email"
                  errors={inviteError ? [inviteError] : undefined}
                >
                  {(control) => (
                    <Input
                      {...control}
                      className="app-field"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      placeholder="kim@example.com"
                    />
                  )}
                </Field>
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1 font-medium text-sm">Role</legend>
                  {ROLES.filter((r) => mayManage(r)).map((r) => (
                    <label
                      key={r}
                      className="flex cursor-pointer items-start gap-2.5 rounded-inner p-2 text-sm transition-colors hover:bg-foreground/[0.04] has-[:checked]:bg-primary/8"
                    >
                      <input
                        type="radio"
                        name="role"
                        value={r}
                        checked={role === r}
                        onChange={() => setRole(r)}
                        className="mt-1 accent-[hsl(var(--primary))]"
                      />
                      <span>
                        <span className="font-medium">{ROLE_LABELS[r]}</span>
                        <span className="block text-muted-foreground text-xs">{ROLE_HINTS[r]}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <Button type="submit">Send invitation</Button>
                {sent && <p className="text-success text-sm">Invitation sent to {sent}.</p>}
              </form>
            </Card>
            {invites.value && invites.value.items.length > 0 && (
              <Card>
                <CardHeader icon={<Mail />} title="Waiting to join" />
                <Rows>
                  {invites.value.items.map((i) => (
                    <li key={i.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                      <span className="min-w-0 flex-1 truncate">{i.email}</span>
                      <Pill>{ROLE_LABELS[i.role]}</Pill>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await apiRequest(`/teams/${teamId}/invitations/${i.id}`, {
                            method: 'DELETE',
                          });
                          void invites.reload();
                        }}
                      >
                        Take back
                      </Button>
                    </li>
                  ))}
                </Rows>
              </Card>
            )}
          </div>
        )}
      </div>

      {manager && (
        <Card className="mt-4">
          <CardHeader icon={<Users />} title="Team activity" />
          {activity.value ? <ActivityList items={activity.value.items} /> : <Shimmer />}
        </Card>
      )}

      <StepUpDialog
        open={pending !== null && pending.kind !== 'leave'}
        title={
          pending?.kind === 'delete'
            ? `Delete ${t.name}?`
            : pending?.kind === 'remove'
              ? `Remove ${pending.member?.displayName}?`
              : `Make ${pending?.member?.displayName} ${pending?.role ? ROLE_LABELS[pending.role] : ''}?`
        }
        description={
          pending?.kind === 'delete'
            ? 'Everything the team shares is deleted from the cloud, and its members lose it on their next sync.'
            : pending?.kind === 'remove'
              ? 'They lose the team’s items at their next sync. Then replace the team key in the Runova app, so the old one opens nothing new.'
              : pending?.role
                ? ROLE_HINTS[pending.role]
                : ''
        }
        confirm={
          pending?.kind === 'delete'
            ? 'Delete team'
            : pending?.kind === 'remove'
              ? 'Remove'
              : 'Change role'
        }
        destructive={pending?.kind === 'delete' || pending?.kind === 'remove'}
        hasPassword={account.value?.hasPassword ?? true}
        twoFactor={account.value?.twoFactorEnabled ?? false}
        onClose={() => setPending(null)}
        onConfirm={async (stepUp) => {
          if (!pending) return null;
          const response =
            pending.kind === 'delete'
              ? await apiRequest(`/teams/${teamId}`, { method: 'DELETE', body: stepUp })
              : pending.kind === 'remove'
                ? await apiRequest(`/teams/${teamId}/members/${pending.member?.userId}`, {
                    method: 'DELETE',
                    body: stepUp,
                  })
                : await apiRequest(`/teams/${teamId}/members/${pending.member?.userId}`, {
                    method: 'PATCH',
                    body: {
                      role: pending.role,
                      ...(stepUp.password ? { password: stepUp.password } : {}),
                      ...(stepUp.code ? { code: stepUp.code } : {}),
                    },
                  });
          if (!response.ok)
            return Object.keys(response.problem.errors).length
              ? response.problem.errors
              : { error: [response.problem.detail] };
          if (pending.kind === 'delete') {
            window.location.assign('/account/teams');
            return null;
          }
          setNotice(
            pending.kind === 'remove'
              ? `${pending.member?.displayName} is out of the team.`
              : 'Role changed.',
          );
          setPending(null);
          void members.reload();
          return null;
        }}
      />
      {pending?.kind === 'leave' && (
        <LeaveDialog
          teamName={t.name}
          onCancel={() => setPending(null)}
          onLeave={async () => {
            const response = await apiRequest(`/teams/${teamId}/members/${meId}`, {
              method: 'DELETE',
              body: { password: null, code: null },
            });
            if (response.ok) window.location.assign('/account/teams');
            else {
              setPending(null);
              setNotice(null);
              setFailure(response.problem.detail);
            }
          }}
        />
      )}
    </>
  );
}

function LeaveDialog({
  teamName,
  onCancel,
  onLeave,
}: {
  teamName: string;
  onCancel: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="app-glass w-full max-w-md p-6">
        <h2 id="leave-title" className="font-display font-semibold text-xl">
          Leave {teamName}?
        </h2>
        <p className="mt-1.5 text-muted-foreground text-sm">
          The team’s items leave your computers at their next sync. An Owner or Admin can invite you
          back.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Stay
          </Button>
          <Button variant="destructive" onClick={onLeave}>
            Leave team
          </Button>
        </div>
      </div>
    </div>
  );
}
