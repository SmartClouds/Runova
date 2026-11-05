import type { AccountSession, AccountStatus } from '@shared/accountTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { SyncPanel, SyncStatusLine } from '@/components/account/SyncPanel';
import { TeamsPanel } from '@/components/account/TeamsPanel';
import {
  Cloud,
  ExternalLink,
  Globe,
  History,
  Lock,
  Monitor,
  RefreshCw,
  SignIn,
  TriangleAlert,
  UserRound,
  Users,
} from '@/components/icons';
import { Chip, Notice, PillTabs, SectionCard } from '@/components/pageKit';
import { GLASS_CARD, SECTION_WELL } from '@/components/pageKit/styles';
import { Button } from '@/components/ui/button';
import { errorText, relativeTime, useAccountStatus, useSyncOverview } from '@/hooks/useAccount';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * The Runova account on this computer (E48): signing in through the browser, what syncs and how
 * it is encrypted, the devices and sessions of the account, its activity, and teams. The account
 * panel on runovahq.com shows the same, for when this computer is not at hand.
 */

type Tab = 'overview' | 'sync' | 'devices' | 'activity' | 'teams';

const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'sync', label: 'Sync and encryption' },
  { value: 'devices', label: 'Devices' },
  { value: 'activity', label: 'Activity' },
  { value: 'teams', label: 'Teams' },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export default function AccountPage(): React.JSX.Element {
  const status = useAccountStatus();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'overview') as Tab;
  const current = status.data;

  if (!current) return <div className="p-6" />;
  if (current.state !== 'signed-in') return <SignedOut status={current} />;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <AccountHeader status={current} />
      {current.needsSignIn && (
        <Notice tone="warning" action={<SignInButton label="Sign in again" />}>
          Runova on this computer was signed out by your account (the session ended, or the password
          changed). Sign in again to keep syncing.
        </Notice>
      )}
      <PillTabs
        id="account-tabs"
        label="Account"
        items={TABS}
        value={tab}
        onChange={(next) => setParams(next === 'overview' ? {} : { tab: next })}
      />
      {tab === 'overview' && <OverviewTab onOpen={(next) => setParams({ tab: next })} />}
      {tab === 'sync' && <SyncPanel />}
      {tab === 'devices' && <DevicesTab />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'teams' && <TeamsPanel />}
    </div>
  );
}

function SignInButton({ label = 'Sign in' }: { label?: string }) {
  const client = useQueryClient();
  const signIn = useMutation({
    mutationFn: () => window.runova.account.signIn(),
    onSuccess: () => {
      void client.invalidateQueries();
      toast.success('Signed in. This computer is syncing now.');
    },
    onError: (error) => toast.error(errorText(error)),
  });
  return (
    <Button shape="pill" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
      <SignIn />
      {signIn.isPending ? 'Waiting for the browser…' : label}
    </Button>
  );
}

function AccountHeader({ status }: { status: Extract<AccountStatus, { state: 'signed-in' }> }) {
  const client = useQueryClient();
  const signOut = async () => {
    const ok = await confirmDialog({
      title: 'Sign out of Runova on this computer?',
      description:
        'Syncing stops here. Everything on this computer stays as it is, and your other computers keep syncing.',
      confirmLabel: 'Sign out',
    });
    if (!ok) return;
    await window.runova.account.signOut();
    void client.invalidateQueries();
  };
  return (
    <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-4 p-5')}>
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/45 to-sky-400/25 text-lg font-semibold ring-1 ring-foreground/10">
        {initials(status.account.displayName)}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-semibold tracking-tight">
          {status.account.displayName}
        </h1>
        <p className="truncate text-sm text-muted-foreground">{status.account.email}</p>
        <SyncStatusLine />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          shape="pill"
          variant="soft"
          onClick={() => window.runova.account.openWebsite('/account')}
        >
          <ExternalLink />
          Open on runovahq.com
        </Button>
        <Button shape="pill" variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>
      {!status.rememberedOnDisk && (
        <Notice tone="neutral" size="sm" className="basis-full">
          This computer has no keychain Runova can use, so you will sign in again next time it
          starts.
        </Notice>
      )}
    </div>
  );
}

const PROMISES = [
  {
    icon: Monitor,
    title: 'The same Runova everywhere',
    text: 'Projects, servers, monitors and settings follow you to every computer you sign in on.',
  },
  {
    icon: Lock,
    title: 'Encrypted with your own key',
    text: 'Passwords and keys leave this computer only sealed with a key the server never sees.',
  },
  {
    icon: Users,
    title: 'Teams that share',
    text: 'Share a server list, a password or a project’s environments with the people you work with.',
  },
];

function SignedOut({ status }: { status: AccountStatus }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 pt-10">
      <div className={cn(GLASS_CARD, 'relative overflow-hidden p-8')}>
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -left-16 h-64 w-64 rounded-full bg-primary/20 blur-3xl"
        />
        <div className="relative flex flex-col gap-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary [&_svg]:size-6">
            <UserRound />
          </div>
          <div className="max-w-xl">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to sync this computer</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Your browser opens runovahq.com, where you sign in with your email or Google and
              approve this computer. Runova never sees your password.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status.state === 'signing-in' ? (
              <>
                <Button shape="pill" disabled>
                  <RefreshCw className="animate-spin motion-reduce:animate-none" />
                  Waiting for the browser…
                </Button>
                <Button
                  shape="pill"
                  variant="ghost"
                  onClick={() => window.runova.account.cancelSignIn()}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <SignInButton />
                <Button
                  shape="pill"
                  variant="soft"
                  onClick={() => window.runova.account.openWebsite('/account/register')}
                >
                  Make an account
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {PROMISES.map(({ icon: Icon, title, text }) => (
          <div key={title} className={cn(GLASS_CARD, 'p-4')}>
            <Icon className="mb-3 size-4 text-primary" />
            <p className="text-sm font-semibold">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Everything works signed out, exactly as before. A project’s folder never syncs: each
        computer keeps its own.
      </p>
    </div>
  );
}

function OverviewTab({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const sessions = useQuery({
    queryKey: queryKeys.accountSessions,
    queryFn: () => window.runova.account.sessions(),
  });
  const overview = useSyncOverview();
  const profile = useQuery({
    queryKey: queryKeys.accountProfile,
    queryFn: () => window.runova.account.profile(),
  });
  const computers = sessions.data?.filter((s) => s.kind === 'desktop') ?? [];
  const sync = overview.data;
  const locked = sync?.scopes.filter((s) => s.hasKey && !s.unlockedHere) ?? [];
  const noKey = sync?.scopes.filter((s) => !s.hasKey && s.canManage) ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <SectionCard
        icon={<Monitor />}
        title="Your computers"
        description="Each of these sees the same projects, servers and settings."
        actions={
          <Button shape="pill" variant="soft" size="sm" onClick={() => onOpen('devices')}>
            Manage
          </Button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {computers.map((c) => (
            <div key={c.id} className={cn(SECTION_WELL, 'flex items-center gap-3')}>
              <div
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-xl [&_svg]:size-4',
                  c.current ? 'bg-primary/15 text-primary' : 'bg-foreground/[0.06]',
                )}
              >
                <Monitor />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{c.deviceName}</p>
                <p className="text-xs text-muted-foreground">
                  {c.current ? 'This computer' : `Seen ${relativeTime(c.lastSeenAt)}`}
                </p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard
        icon={<Cloud />}
        title="Sync"
        description="What this computer shares through your account."
      >
        <div className="grid gap-2 text-sm">
          {sync && sync.conflicts > 0 && (
            <Notice
              tone="warning"
              size="sm"
              action={
                <Button size="xs" shape="pill" variant="soft" onClick={() => onOpen('sync')}>
                  Review
                </Button>
              }
            >
              {sync.conflicts} {sync.conflicts === 1 ? 'item was' : 'items were'} changed here and
              on another computer.
            </Notice>
          )}
          {locked.length > 0 && (
            <Notice
              tone="primary"
              size="sm"
              action={
                <Button size="xs" shape="pill" variant="soft" onClick={() => onOpen('sync')}>
                  Unlock
                </Button>
              }
            >
              Type the key of {locked.map((s) => s.name).join(', ')} once on this computer to read
              what is sealed.
            </Notice>
          )}
          {noKey.length > 0 && locked.length === 0 && (
            <Notice
              tone="neutral"
              size="sm"
              action={
                <Button size="xs" shape="pill" variant="soft" onClick={() => onOpen('sync')}>
                  Set a key
                </Button>
              }
            >
              Passwords and keys stay on this computer until you set an encryption key.
            </Notice>
          )}
          {sync && sync.conflicts === 0 && locked.length === 0 && noKey.length === 0 && (
            <Notice tone="success" size="sm">
              Everything is in sync and encrypted end to end.
            </Notice>
          )}
        </div>
      </SectionCard>
      {profile.data && !profile.data.twoFactorEnabled && (
        <SectionCard
          icon={<TriangleAlert />}
          tone="destructive"
          title="Turn on two-factor sign-in"
          description="A code from your phone after your password, so a leaked password is not enough."
          actions={
            <Button
              shape="pill"
              size="sm"
              onClick={() => window.runova.account.openWebsite('/account/security')}
            >
              Turn on
            </Button>
          }
          className="lg:col-span-2"
        />
      )}
    </div>
  );
}

function SessionRow({ session, onEnd }: { session: AccountSession; onEnd: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-xl [&_svg]:size-4',
          session.current
            ? 'bg-primary/15 text-primary'
            : 'bg-foreground/[0.06] text-foreground/80',
        )}
      >
        {session.kind === 'desktop' ? <Monitor /> : <Globe />}
      </div>
      <div className="min-w-[12rem] flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {session.deviceName}
          {session.current && <Chip tone="primary">This computer</Chip>}
        </p>
        <p className="text-xs text-muted-foreground">
          {session.platform} · signed in {relativeTime(session.createdAt)} · seen{' '}
          {relativeTime(session.lastSeenAt)}
          {session.ip && <span className="font-mono"> · {session.ip}</span>}
        </p>
      </div>
      {!session.current && (
        <Button size="sm" shape="pill" variant="ghost" onClick={onEnd}>
          Sign out
        </Button>
      )}
    </li>
  );
}

function DevicesTab() {
  const client = useQueryClient();
  const sessions = useQuery({
    queryKey: queryKeys.accountSessions,
    queryFn: () => window.runova.account.sessions(),
  });
  const end = async (session: AccountSession) => {
    const ok = await confirmDialog({
      title: `Sign out ${session.deviceName}?`,
      description: 'It signs out at its next request. Runova there asks to sign in again.',
      confirmLabel: 'Sign out',
    });
    if (!ok) return;
    try {
      await window.runova.account.endSession(session.id);
      toast.success(`Signed out ${session.deviceName}.`);
      void client.invalidateQueries({ queryKey: queryKeys.accountSessions });
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  const endOthers = () => window.runova.account.openWebsite('/account/sessions');
  return (
    <SectionCard
      icon={<Monitor />}
      title="Devices and sessions"
      description="Every browser and computer signed in to your account. Sign out one you do not recognise, then change your password."
      actions={
        <Button shape="pill" variant="soft" size="sm" onClick={endOthers}>
          <ExternalLink /> Sign out everywhere else
        </Button>
      }
      flush
    >
      <ul className="divide-y divide-foreground/[0.07]">
        {(sessions.data ?? []).map((s) => (
          <SessionRow key={s.id} session={s} onEnd={() => end(s)} />
        ))}
      </ul>
    </SectionCard>
  );
}

const ACTIVITY_WORDS: Record<string, string> = {
  'sign-in': 'Signed in',
  'sign-in-failed': 'Wrong password or code',
  'sign-out': 'Signed out',
  'device-sign-in': 'Signed in Runova on a computer',
  'session-ended': 'Ended a session',
  'sessions-ended': 'Ended every other session',
  'refresh-token-reused': 'Stopped a copied sign-in',
  'password-changed': 'Changed the password',
  'password-reset': 'Reset the password',
  'two-factor-on': 'Turned on two-factor',
  'two-factor-off': 'Turned off two-factor',
  'key-set': 'Set an encryption key',
  'key-changed': 'Changed an encryption key',
  'key-reset': 'Reset an encryption key',
  'sync-reset': 'Wiped the cloud copy',
  'team-created': 'Made a team',
  'member-invited': 'Invited someone to a team',
  'member-joined': 'Joined a team',
  'member-removed': 'Removed someone from a team',
};

function ActivityTab() {
  const [page, setPage] = useState(1);
  const activity = useQuery({
    queryKey: queryKeys.accountActivities(page),
    queryFn: () => window.runova.account.activities(page),
  });
  const warn = new Set([
    'sign-in-failed',
    'refresh-token-reused',
    'key-reset',
    'sync-reset',
    'two-factor-off',
  ]);
  return (
    <SectionCard
      icon={<History />}
      title="Activity"
      description="Sign-ins, new computers and every change to your account, newest first."
      flush
    >
      <ul className="divide-y divide-foreground/[0.07]">
        {(activity.data?.items ?? []).map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm"
          >
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                warn.has(entry.action) ? 'bg-warning' : 'bg-primary/70',
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 font-medium">
              {ACTIVITY_WORDS[entry.action] ?? entry.action}
              {warn.has(entry.action) && <span className="sr-only"> (worth a look)</span>}
            </span>
            <span className="text-xs text-muted-foreground">
              {entry.device ?? 'Unknown device'}
            </span>
            {entry.ip && (
              <span className="font-mono text-xs text-muted-foreground">{entry.ip}</span>
            )}
            <span className="w-28 text-right text-xs text-muted-foreground">
              {relativeTime(entry.at)}
            </span>
          </li>
        ))}
      </ul>
      {activity.data && activity.data.totalPages > page && (
        <div className="p-3 text-center">
          <Button size="sm" shape="pill" variant="soft" onClick={() => setPage((p) => p + 1)}>
            Older
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
