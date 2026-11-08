import {
  Activity as ActivityIcon,
  ArrowRight,
  CloudCog,
  Globe,
  History,
  KeyRound,
  Laptop,
  Lock,
  LogIn,
  LogOut,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Field } from '@/components/admin/Field';
import { Button } from '@/components/ui/button';
import {
  type Account,
  type Activity,
  apiRequest,
  type Page,
  type Session,
  type SyncScope,
  type Team,
} from '@/lib/account/api';
import { AppInput } from './fields';
import {
  Card,
  CardHeader,
  dateTime,
  EmptyState,
  groupByDay,
  LoadFailure,
  Notice,
  PageHeader,
  PageHint,
  Pill,
  Rows,
  relativeTime,
  Shimmer,
  Spinner,
  StepUpDialog,
  useLoad,
} from './ui';

/** What each activity entry reads as, in the person's words. */
export function describeActivity(entry: Activity): string {
  const d = entry.details ?? {};
  switch (entry.action) {
    case 'sign-in':
      return d.method === 'google'
        ? 'Signed in with Google'
        : d.method === 'email-link'
          ? 'Signed in from the email link'
          : 'Signed in';
    case 'sign-in-failed':
      return d.reason === 'two-factor' ? 'Wrong two-factor code' : 'Wrong password';
    case 'sign-out':
      return 'Signed out';
    case 'device-sign-in':
      return `Signed in Runova on ${String(d.device ?? 'a computer')}`;
    case 'session-ended':
      return `Ended the session on ${String(d.device ?? 'a device')}`;
    case 'sessions-ended':
      return 'Ended every other session';
    case 'refresh-token-reused':
      return `A copied sign-in was stopped on ${String(d.device ?? 'a computer')}`;
    case 'email-verified':
      return 'Confirmed the email address';
    case 'password-changed':
      return 'Changed the password';
    case 'password-reset':
      return 'Reset the password from an email link';
    case 'two-factor-on':
      return 'Turned on two-factor';
    case 'two-factor-off':
      return 'Turned off two-factor';
    case 'login-linked':
      return 'Linked Google';
    case 'login-unlinked':
      return 'Unlinked Google';
    case 'account-updated':
      return 'Changed the profile';
    case 'key-set':
      return 'Set an encryption key';
    case 'key-changed':
      return d.rotated ? 'Replaced an encryption key' : 'Changed an encryption passphrase';
    case 'key-reset':
      return 'Reset an encryption key';
    case 'sync-reset':
      return 'Wiped the cloud copy of synced data';
    case 'sync-policy-changed':
      return 'Changed what is encrypted';
    case 'team-created':
      return `Made the team ${String(d.name ?? '')}`;
    case 'team-updated':
      return `Renamed a team to ${String(d.name ?? '')}`;
    case 'team-deleted':
      return `Deleted the team ${String(d.name ?? '')}`;
    case 'member-invited':
      return `Invited ${String(d.email ?? 'someone')} to a team`;
    case 'member-joined':
      return 'Joined a team';
    case 'member-removed':
      return 'Removed someone from a team';
    case 'member-role-changed':
      return `Changed a role to ${String(d.to ?? '')}`;
    case 'team-left':
      return 'Left a team';
    default:
      return entry.action;
  }
}

const WARNING_ACTIONS = new Set([
  'sign-in-failed',
  'refresh-token-reused',
  'key-reset',
  'sync-reset',
  'two-factor-off',
]);

/** The icon an activity entry shows, by what kind of thing happened. */
function ActivityKindIcon({ action }: { action: string }) {
  if (WARNING_ACTIONS.has(action)) return <ShieldAlert />;
  if (action === 'sign-in' || action === 'sign-out') return <LogIn />;
  if (action === 'device-sign-in' || action.startsWith('session')) return <Laptop />;
  if (
    action.startsWith('password') ||
    action.startsWith('two-factor') ||
    action.startsWith('login')
  )
    return <KeyRound />;
  if (action.startsWith('key') || action.startsWith('sync')) return <Lock />;
  if (action.startsWith('team') || action.startsWith('member')) return <Users />;
  if (action === 'account-updated' || action === 'email-verified') return <UserRound />;
  return <ActivityIcon />;
}

function SessionIcon({ session }: { session: Pick<Session, 'kind'> }) {
  return session.kind === 'web' ? <Globe /> : <Laptop />;
}

export function Overview() {
  const account = useLoad<Account>('/accounts/me');
  const sessions = useLoad<{ items: Session[] }>('/sessions');
  const activity = useLoad<Page<Activity>>('/activities?pageSize=5');
  const scopes = useLoad<{ items: SyncScope[] }>('/sync-scopes');
  const teams = useLoad<{ items: Team[] }>('/teams');
  const me = account.value;
  const computers = sessions.value?.items.filter((s) => s.kind !== 'web') ?? [];
  const browsers = sessions.value?.items.filter((s) => s.kind === 'web') ?? [];
  const protections = me
    ? [me.twoFactorEnabled, me.hasPassword || me.logins.length > 0, me.emailConfirmed]
    : [];
  const strong = protections.filter(Boolean).length;

  return (
    <>
      <PageHeader
        title={me ? `Hello, ${me.displayName.split(' ')[0]}` : 'Your account'}
        description="Everything signed in to your Runova account, and what it keeps in sync."
      />
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader
            icon={<MonitorSmartphone />}
            title="Your computers"
            description="Runova on each of these sees the same projects, servers and settings."
            actions={
              <Button asChild size="sm" variant="ghost">
                <a href="/account/sessions">
                  Manage <ArrowRight />
                </a>
              </Button>
            }
          />
          {sessions.loading && !sessions.value ? (
            <Shimmer />
          ) : computers.length === 0 ? (
            <div className="border-foreground/[0.07] border-t">
              <EmptyState icon={<Laptop />} title="No computer signed in yet">
                Open Runova, go to Account and choose Sign in. Your browser asks you to approve the
                computer.
              </EmptyState>
            </div>
          ) : (
            <ul className="grid gap-2 px-4 pb-4 sm:grid-cols-2 sm:px-5 sm:pb-5">
              {computers.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-3 rounded-inner bg-foreground/[0.03] p-3 ring-1 ring-foreground/[0.07] ring-inset"
                >
                  <div className="flex size-9 items-center justify-center rounded-inner bg-primary/12 text-primary [&_svg]:size-4">
                    <Laptop />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-sm">{c.deviceName}</p>
                    <p className="text-muted-foreground text-xs">
                      {c.platform} · seen {relativeTime(c.lastSeenAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {browsers.length > 0 && (
            <p className="border-foreground/[0.07] border-t px-5 py-3 text-muted-foreground text-xs">
              Plus {browsers.length} {browsers.length === 1 ? 'browser' : 'browsers'}, this one
              included.
            </p>
          )}
        </Card>

        <Card>
          <CardHeader
            icon={strong === 3 ? <ShieldCheck /> : <ShieldAlert />}
            tone={strong === 3 ? 'primary' : 'destructive'}
            title="Security"
            description={
              me
                ? strong === 3
                  ? 'Your account has every protection on.'
                  : 'Turn on two-factor so a stolen password is not enough.'
                : ' '
            }
          />
          {me ? (
            <Rows>
              <CheckRow done={me.emailConfirmed} label="Email confirmed" />
              <CheckRow done={me.twoFactorEnabled} label="Two-factor on" href="/account/security" />
              <CheckRow
                done={me.logins.includes('google')}
                label="Google linked"
                optional
                href="/account/security"
              />
            </Rows>
          ) : (
            <Shimmer lines={3} />
          )}
        </Card>

        <Card>
          <CardHeader
            icon={<CloudCog />}
            title="Sync"
            description="What your computers share through your account."
          />
          <div className="grid grid-cols-2 gap-3 px-4 pb-4 sm:px-5 sm:pb-5">
            <Stat
              label="Spaces"
              value={scopes.value ? String(scopes.value.items.length) : '…'}
              hint="yours and your teams'"
            />
            <Stat
              label="End-to-end encrypted"
              value={
                scopes.value
                  ? `${scopes.value.items.filter((s) => s.keyVersion !== null).length} of ${scopes.value.items.length}`
                  : '…'
              }
              hint="set a key in the app"
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={<Users />}
            title="Teams"
            description={
              teams.value?.items.length
                ? 'Shared servers, passwords and projects.'
                : 'Share servers, passwords and projects with people you work with.'
            }
            actions={
              <Button asChild size="sm" variant="ghost">
                <a href="/account/teams">
                  {teams.value?.items.length ? 'Open' : 'Make a team'} <ArrowRight />
                </a>
              </Button>
            }
          />
          {teams.value?.items.length ? (
            <Rows>
              {teams.value.items.slice(0, 4).map((t) => (
                <li key={t.id}>
                  <a
                    href={`/account/teams/${t.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-foreground/[0.03] sm:px-5"
                  >
                    <span className="min-w-0 truncate font-medium">{t.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {t.memberCount} {t.memberCount === 1 ? 'person' : 'people'}
                    </span>
                  </a>
                </li>
              ))}
            </Rows>
          ) : null}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          icon={<ActivityIcon />}
          title="Recent activity"
          actions={
            <Button asChild size="sm" variant="ghost">
              <a href="/account/activity">
                All activity <ArrowRight />
              </a>
            </Button>
          }
        />
        {activity.value ? <ActivityList items={activity.value.items} /> : <Shimmer />}
      </Card>
    </>
  );
}

function CheckRow({
  done,
  label,
  href,
  optional,
}: {
  done: boolean;
  label: string;
  href?: string;
  optional?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
      <span>{label}</span>
      {done ? (
        <Pill tone="success">On</Pill>
      ) : href ? (
        <a href={href} className="link text-xs">
          {optional ? 'Set up' : 'Turn on'}
        </a>
      ) : (
        <Pill tone="warning">Not yet</Pill>
      )}
    </li>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-inner bg-foreground/[0.03] p-3 ring-1 ring-foreground/[0.07] ring-inset">
      <p className="font-display font-semibold text-xl sm:text-2xl">{value}</p>
      <p className="mt-0.5 font-medium text-sm">{label}</p>
      <p className="text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}

export function ActivityList({
  items,
  byDay = false,
  empty,
}: {
  items: Activity[];
  /** Day headings over the entries, for the full activity page. */
  byDay?: boolean;
  /** What to say when there is nothing, when the caller knows why. */
  empty?: { title: string; body: ReactNode };
}) {
  if (items.length === 0) {
    return (
      <div className="border-foreground/[0.07] border-t first:border-t-0">
        <EmptyState icon={<History />} title={empty?.title ?? 'Nothing here yet'}>
          {empty?.body ?? 'Sign-ins and changes to your account show up here as they happen.'}
        </EmptyState>
      </div>
    );
  }
  if (!byDay)
    return (
      <Rows>
        {items.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </Rows>
    );
  return (
    <div>
      {groupByDay(items).map((group) => (
        <section
          key={group.label}
          aria-label={group.label}
          className="border-foreground/[0.07] border-t first:border-t-0"
        >
          <h3 className="border-foreground/[0.07] border-b px-4 py-2 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.06em] sm:px-5">
            {group.label}
          </h3>
          <ul className="divide-y divide-foreground/[0.07]">
            {group.items.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ActivityRow({ entry }: { entry: Activity }) {
  const warning = WARNING_ACTIONS.has(entry.action);
  return (
    <li className="flex items-start gap-3 px-4 py-3 sm:items-center sm:px-5">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-inner [&_svg]:size-4 ${warning ? 'bg-warning/14 text-warning' : 'bg-foreground/[0.05] text-foreground/70'}`}
        aria-hidden
      >
        <ActivityKindIcon action={entry.action} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">
          {describeActivity(entry)}
          {warning && <span className="sr-only"> (worth a look)</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
          <span className="min-w-0 truncate">{entry.device ?? 'Unknown device'}</span>
          {entry.ip && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">{entry.ip}</span>
            </>
          )}
        </p>
      </div>
      <time
        dateTime={entry.at}
        title={dateTime(entry.at)}
        className="shrink-0 pt-0.5 text-muted-foreground text-xs sm:pt-0"
      >
        {relativeTime(entry.at)}
      </time>
    </li>
  );
}

export function Profile() {
  const account = useLoad<Account>('/accounts/me');
  const [name, setName] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<string[] | undefined>();
  if (account.problem) return <LoadFailure problem={account.problem} retry={account.reload} />;
  const me = account.value;
  const save = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (!me) return;
    const response = await apiRequest<Account>('/accounts/me', {
      method: 'PATCH',
      body: { displayName: name ?? me.displayName },
      ifMatch: `"${me.version}"`,
    });
    if (response.ok) {
      account.setValue(response.value);
      setSaved(true);
      setErrors(undefined);
    } else setErrors(response.problem.errors.displayName ?? [response.problem.detail]);
  };
  return (
    <>
      <PageHeader title="Profile" description="How you appear to the people in your teams." />
      <Card className="max-w-2xl">
        <CardHeader icon={<UserRound />} title="Your details" />
        {me ? (
          <form onSubmit={save} className="grid gap-4 px-5 pb-5">
            <Field id="name" label="Name" errors={errors}>
              {(control) => (
                <AppInput
                  {...control}
                  value={name ?? me.displayName}
                  onChange={(e) => {
                    setName(e.target.value);
                    setSaved(false);
                  }}
                  maxLength={100}
                  required
                />
              )}
            </Field>
            <Field
              id="email"
              label="Email"
              hint="Your email is how teams invite you and how you sign in."
            >
              {(control) => <AppInput {...control} value={me.email} readOnly />}
            </Field>
            <p className="text-muted-foreground text-xs">Member since {dateTime(me.createdAt)}</p>
            <div className="flex items-center gap-3">
              <Button type="submit">Save changes</Button>
              {saved && <span className="text-success text-sm">Saved</span>}
            </div>
          </form>
        ) : (
          <Shimmer />
        )}
      </Card>
    </>
  );
}

export function Sessions() {
  const sessions = useLoad<{ items: Session[] }>('/sessions');
  const account = useLoad<Account>('/accounts/me');
  const [confirmAll, setConfirmAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const end = async (session: Session) => {
    const response = await apiRequest(`/sessions/${session.id}`, { method: 'DELETE' });
    if (response.ok) {
      setMessage(`Signed out ${session.deviceName}.`);
      void sessions.reload();
    }
  };
  const items = sessions.value?.items ?? [];
  return (
    <>
      <PageHeader
        title="Devices and sessions"
        description="Every browser and computer signed in to your account. End one you do not recognise, then change your password."
        actions={
          items.length > 1 && (
            <Button
              variant="outline"
              className="app-field border-0"
              onClick={() => setConfirmAll(true)}
            >
              <LogOut />
              Sign out everywhere else
            </Button>
          )
        }
      />
      {message && (
        <Notice tone="success" className="mb-4">
          {message}
        </Notice>
      )}
      <Card>
        {sessions.problem ? (
          <LoadFailure problem={sessions.problem} retry={sessions.reload} />
        ) : !sessions.value ? (
          <Shimmer lines={4} />
        ) : (
          <Rows>
            {items.map((session) => (
              <li key={session.id} className="flex items-start gap-3 px-4 py-4 sm:gap-4 sm:px-5">
                <div
                  className={`flex size-10 shrink-0 items-center justify-center rounded-inner [&_svg]:size-5 ${session.current ? 'bg-primary/12 text-primary' : 'bg-foreground/[0.06] text-foreground/80'}`}
                >
                  <SessionIcon session={session} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                    <span className="min-w-0 break-words">{session.deviceName}</span>
                    {session.current && <Pill tone="primary">This browser</Pill>}
                    {session.kind === 'desktop' && (
                      <Pill>Runova app{session.appVersion ? ` ${session.appVersion}` : ''}</Pill>
                    )}
                  </p>
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {session.platform} · signed in {relativeTime(session.createdAt)} · last seen{' '}
                    {relativeTime(session.lastSeenAt)}
                    {session.ip && (
                      <>
                        {' · '}
                        <span className="font-mono">{session.ip}</span>
                      </>
                    )}
                  </p>
                </div>
                {!session.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="-my-1 shrink-0"
                    onClick={() => end(session)}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </Rows>
        )}
      </Card>
      <StepUpDialog
        open={confirmAll}
        title="Sign out everywhere else?"
        description="Every other browser and computer signs out at its next request. Runova on those computers asks to sign in again."
        confirm="Sign out the others"
        hasPassword={account.value?.hasPassword ?? true}
        twoFactor={account.value?.twoFactorEnabled ?? false}
        onClose={() => setConfirmAll(false)}
        onConfirm={async (stepUp) => {
          const response = await apiRequest('/sessions', { method: 'DELETE', body: stepUp });
          if (!response.ok) return response.problem.errors;
          setConfirmAll(false);
          setMessage('Every other session is signed out.');
          void sessions.reload();
          return null;
        }}
      />
    </>
  );
}

const FILTERS: { value: string; label: string; empty: { title: string; body: string } }[] = [
  {
    value: '',
    label: 'Everything',
    empty: {
      title: 'Nothing here yet',
      body: 'Sign-ins, new devices and changes to your account show up here as they happen.',
    },
  },
  {
    value: 'sign-in',
    label: 'Sign-ins',
    empty: {
      title: 'No sign-ins yet',
      body: 'Each time you sign in on the website, the browser it came from shows up here.',
    },
  },
  {
    value: 'sign-in-failed',
    label: 'Failed sign-ins',
    empty: {
      title: 'No failed sign-ins',
      body: 'Nobody has tried a wrong password or code on your account.',
    },
  },
  {
    value: 'device-sign-in',
    label: 'New computers',
    empty: {
      title: 'No computer signed in yet',
      body: 'Open Runova, go to Account and choose Sign in. Each computer you approve shows up here.',
    },
  },
  {
    value: 'password-changed',
    label: 'Password changes',
    empty: {
      title: 'No password changes',
      body: 'When your password changes, it shows up here with the device it was changed on.',
    },
  },
];

export function ActivityPage() {
  const [filter, setFilter] = useState('');
  const [pages, setPages] = useState(1);
  const activity = useLoad<Page<Activity>>(
    `/activities?pageSize=${pages * 25}${filter ? `&action=${filter}` : ''}`,
  );
  const current = FILTERS.find((f) => f.value === filter) ?? FILTERS[0];
  return (
    <>
      <PageHeader
        title="Activity"
        description="Sign-ins, new devices and every change to your account, newest first."
      />
      <div className="-mx-2 mb-4 overflow-x-auto px-2 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        <fieldset className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.06] p-1">
          <legend className="sr-only">Show</legend>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => {
                setFilter(f.value);
                setPages(1);
              }}
              className="shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground aria-pressed:bg-background/80 aria-pressed:text-foreground aria-pressed:shadow-sm"
            >
              {f.label}
            </button>
          ))}
        </fieldset>
      </div>
      <Card>
        {activity.problem ? (
          <LoadFailure problem={activity.problem} retry={activity.reload} />
        ) : activity.value ? (
          <>
            <ActivityList items={activity.value.items} byDay empty={current?.empty} />
            {activity.value.totalItems > activity.value.items.length && (
              <div className="border-foreground/[0.07] border-t p-3 text-center">
                {activity.loading ? (
                  <Spinner label="Loading more" />
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setPages((p) => p + 1)}>
                    Show more
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <Shimmer lines={6} />
        )}
      </Card>
      <PageHint icon={<KeyRound aria-hidden />}>
        See something you did not do? End that session in{' '}
        <a href="/account/sessions" className="link">
          Devices and sessions
        </a>
        , then change your password in{' '}
        <a href="/account/security" className="link">
          Security
        </a>
        .
      </PageHint>
    </>
  );
}
