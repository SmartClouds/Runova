import {
  Activity as ActivityIcon,
  ArrowRight,
  CloudCog,
  Globe,
  KeyRound,
  Laptop,
  LogOut,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react';
import { useState } from 'react';
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

function SessionIcon({ session }: { session: Pick<Session, 'kind'> }) {
  return session.kind === 'desktop' ? <Laptop /> : <Globe />;
}

export function Overview() {
  const account = useLoad<Account>('/accounts/me');
  const sessions = useLoad<{ items: Session[] }>('/sessions');
  const activity = useLoad<Page<Activity>>('/activities?pageSize=5');
  const scopes = useLoad<{ items: SyncScope[] }>('/sync-scopes');
  const teams = useLoad<{ items: Team[] }>('/teams');
  const me = account.value;
  const computers = sessions.value?.items.filter((s) => s.kind === 'desktop') ?? [];
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
            <div className="px-5 pb-5">
              <Notice title="No computer signed in yet">
                Open Runova, go to Account and choose Sign in. Your browser asks you to approve the
                computer.
              </Notice>
            </div>
          ) : (
            <ul className="grid gap-2 px-5 pb-5 sm:grid-cols-2">
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
          <div className="grid grid-cols-2 gap-3 px-5 pb-5">
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
                    className="flex items-center justify-between px-5 py-3 text-sm transition-colors hover:bg-foreground/[0.03]"
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="text-muted-foreground text-xs">
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
    <li className="flex items-center justify-between px-5 py-3 text-sm">
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
      <p className="font-display font-semibold text-2xl">{value}</p>
      <p className="mt-0.5 font-medium text-sm">{label}</p>
      <p className="text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}

export function ActivityList({ items }: { items: Activity[] }) {
  if (items.length === 0) {
    return (
      <p className="px-5 pb-5 text-muted-foreground text-sm">
        Nothing yet. Sign-ins and changes show up here.
      </p>
    );
  }
  return (
    <Rows>
      {items.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm"
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${WARNING_ACTIONS.has(entry.action) ? 'bg-warning' : 'bg-primary/70'}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1 font-medium">
            {describeActivity(entry)}
            {WARNING_ACTIONS.has(entry.action) && <span className="sr-only"> (worth a look)</span>}
          </span>
          <span className="text-muted-foreground text-xs">{entry.device ?? 'Unknown device'}</span>
          {entry.ip && <span className="font-mono text-muted-foreground text-xs">{entry.ip}</span>}
          <time
            dateTime={entry.at}
            title={dateTime(entry.at)}
            className="w-28 text-right text-muted-foreground text-xs"
          >
            {relativeTime(entry.at)}
          </time>
        </li>
      ))}
    </Rows>
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
              <li key={session.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div
                  className={`flex size-10 items-center justify-center rounded-inner [&_svg]:size-5 ${session.current ? 'bg-primary/12 text-primary' : 'bg-foreground/[0.06] text-foreground/80'}`}
                >
                  <SessionIcon session={session} />
                </div>
                <div className="min-w-[12rem] flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {session.deviceName}
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
                  <Button size="sm" variant="ghost" onClick={() => end(session)}>
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

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'sign-in', label: 'Sign-ins' },
  { value: 'sign-in-failed', label: 'Failed sign-ins' },
  { value: 'device-sign-in', label: 'New computers' },
  { value: 'password-changed', label: 'Password changes' },
];

export function ActivityPage() {
  const [filter, setFilter] = useState('');
  const [pages, setPages] = useState(1);
  const activity = useLoad<Page<Activity>>(
    `/activities?pageSize=${pages * 25}${filter ? `&action=${filter}` : ''}`,
  );
  return (
    <>
      <PageHeader
        title="Activity"
        description="Sign-ins, new devices and every change to your account, newest first."
      />
      <fieldset className="mb-4 inline-flex flex-wrap items-center gap-1 rounded-full bg-foreground/[0.06] p-1">
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
            className="rounded-full px-3 py-1 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground aria-pressed:bg-background/80 aria-pressed:text-foreground aria-pressed:shadow-sm"
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      <Card>
        {activity.problem ? (
          <LoadFailure problem={activity.problem} retry={activity.reload} />
        ) : activity.value ? (
          <>
            <ActivityList items={activity.value.items} />
            {activity.value.totalItems > activity.value.items.length && (
              <div className="border-foreground/[0.07] border-t p-3 text-center">
                <Button variant="ghost" size="sm" onClick={() => setPages((p) => p + 1)}>
                  Show more
                </Button>
              </div>
            )}
          </>
        ) : (
          <Shimmer lines={6} />
        )}
      </Card>
      <p className="mt-4 flex items-center gap-2 text-muted-foreground text-xs">
        <KeyRound className="size-3.5" aria-hidden />
        See something you did not do? End that session, then change your password in Security.
      </p>
    </>
  );
}
