import {
  type AnywhereDirectoryEntry,
  type AnywhereIntent,
  type AnywhereState,
  formatRemoteId,
  formatTypedRemoteId,
  parseRemoteId,
} from '@shared/anywhere';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Folder,
  Globe,
  History,
  Key,
  Link,
  Lock,
  Monitor,
  Power,
  Route,
  SettingsIcon,
  ShieldSolid,
  SignIn,
  Trash2,
  Users,
} from '@/components/icons';
import { Chip, Notice, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { relativeTime } from '@/hooks/useAccount';
import { cn } from '@/lib/utils';
import { useAnywhere } from '@/stores/anywhereStore';
import { REMOTE_CARD, RemoteCardHeader } from '../remoteCard';
import { AccessSettingsDialog } from './AccessSettingsDialog';
import { ConnectionSheet } from './ConnectionSheet';
import { type Presence, RemoteIdDial } from './RemoteIdDial';

const connect = (remoteId: string, intent: AnywhereIntent) =>
  void window.runova.anywhere.connect({ remoteId, intent });

/**
 * Runova Anywhere on the Remote page (E61): this computer's ID and who may use it, a field to
 * connect to any other computer by its ID, and the computers this account already knows.
 */
export function AnywherePanel(): React.JSX.Element {
  const state = useAnywhere();
  if (state.status === 'signed-out') return <SignedOut />;
  return (
    <div className="flex flex-col gap-2">
      <ThisComputer state={state} />
      <Readiness state={state} />
      {state.passwordLockedUntil ? (
        <Notice tone="warning" icon={Lock}>
          Password access is locked until {new Date(state.passwordLockedUntil).toLocaleTimeString()}{' '}
          after too many wrong passwords. Teammates who ask can still connect.
        </Notice>
      ) : null}
      {state.hosted.length > 0 ? <HostedSessions state={state} /> : null}
      <ConnectCard state={state} />
      {state.outgoing ? <ConnectionSheet outgoing={state.outgoing} /> : null}
    </div>
  );
}

/** What this computer still needs before others can see and control it. */
function Readiness({ state }: { state: AnywhereState }): React.JSX.Element | null {
  const { controlUnavailable, needs } = state.readiness;
  if (!controlUnavailable && needs.length === 0) return null;
  const grant = (kind: 'accessibility' | 'screen') =>
    void window.runova.anywhere.grantPermission(kind);
  return (
    <div className="flex flex-col gap-2">
      {needs.length > 0 ? (
        <Notice
          tone="warning"
          action={
            <div className="flex flex-wrap gap-1.5">
              {needs.includes('accessibility') ? (
                <Button
                  size="sm"
                  variant="soft"
                  shape="pill"
                  onClick={() => grant('accessibility')}
                >
                  Allow control
                </Button>
              ) : null}
              {needs.includes('screen') ? (
                <Button size="sm" variant="soft" shape="pill" onClick={() => grant('screen')}>
                  Allow screen recording
                </Button>
              ) : null}
            </div>
          }
        >
          macOS needs your permission before others can{' '}
          {needs.includes('screen') ? 'see this screen' : ''}
          {needs.length === 2 ? ' or ' : ''}
          {needs.includes('accessibility') ? 'use the mouse and keyboard here' : ''}.
        </Notice>
      ) : null}
      {controlUnavailable ? <Notice tone="neutral">{controlUnavailable}</Notice> : null}
    </div>
  );
}

function SignedOut(): React.JSX.Element {
  const signIn = useMutation({ mutationFn: () => window.runova.account.signIn() });
  const ways = [
    {
      icon: Globe,
      title: 'By ID',
      text: 'Every computer gets a 9-digit Runova ID. Type it on another one to connect.',
    },
    {
      icon: Users,
      title: 'As a teammate',
      text: 'Ask to connect to a computer shown to your team. Someone there accepts.',
    },
    {
      icon: Key,
      title: 'With a password',
      text: 'Set a password for when no one is at the computer to accept.',
    },
  ];
  return (
    <section className={cn(REMOTE_CARD, 'px-6 py-8')}>
      <div className="mx-auto flex max-w-xl flex-col items-center gap-5 text-center">
        <RemoteIdDial remoteId={null} presence="offline" />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight">
            Reach your computers from anywhere
          </h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Control another computer over the internet, or let a teammate help on yours. Runova
            tries a direct connection first and uses its relay only when it has to. Everything is
            encrypted end to end.
          </p>
        </div>
        <ul className="grid w-full gap-2 text-left @2xl/remote:grid-cols-3">
          {ways.map((way) => (
            <li key={way.title} className="rounded-xl bg-foreground/[0.04] p-3">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                <way.icon className="h-3.5 w-3.5 text-primary" />
                {way.title}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{way.text}</p>
            </li>
          ))}
        </ul>
        <div className="space-y-2">
          <Button
            shape="pill"
            size="lg"
            onClick={() => signIn.mutate()}
            disabled={signIn.isPending}
          >
            <SignIn />
            {signIn.isPending ? 'Waiting for the browser…' : 'Sign in to Runova'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Both computers sign in. New to Runova? You can create an account on the same page.
          </p>
        </div>
      </div>
    </section>
  );
}

function presenceOf(state: AnywhereState): Presence {
  if (state.status === 'online') return 'online';
  return state.status === 'starting' ? 'starting' : 'offline';
}

function ThisComputer({ state }: { state: AnywhereState }): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const s = state.settings;
  const teams = state.teams.filter((t) => s.teamIds.includes(t.id));
  const ways: string[] = [];
  if (s.allowOwnDevices) ways.push('My computers');
  for (const team of teams) ways.push(`${team.name} can ask`);
  if (s.passwordSet) ways.push('Password set');
  return (
    <section className={REMOTE_CARD} aria-label="This computer">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-5">
        <div className="space-y-2">
          <h2 className={SECTION_HEADING}>This computer</h2>
          <RemoteIdDial
            remoteId={state.device?.remoteId ?? null}
            presence={presenceOf(state)}
            copy
          />
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/85">
              {state.device?.name ?? 'Registering…'}
            </span>
            {state.error ? <span className="text-warning"> · {state.error}</span> : null}
          </p>
        </div>
        <div className="ml-auto flex min-w-[min(100%,16rem)] flex-1 flex-col items-start gap-2.5 @3xl/remote:items-end">
          <div className="flex flex-wrap gap-1.5 @3xl/remote:justify-end">
            {!s.acceptConnections ? (
              <Chip tone="warning" dot>
                Not taking connections
              </Chip>
            ) : ways.length === 0 ? (
              <Chip tone="neutral" dot>
                Nobody can connect yet
              </Chip>
            ) : (
              ways.map((way) => (
                <Chip key={way} tone="success">
                  {way}
                </Chip>
              ))
            )}
            {s.alwaysRelay ? (
              <Chip tone="neutral">
                <Route />
                Relay only
              </Chip>
            ) : null}
          </div>
          <Button variant="soft" shape="pill" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
            Access settings
          </Button>
        </div>
      </div>
      <AccessSettingsDialog state={state} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </section>
  );
}

function HostedSessions({ state }: { state: AnywhereState }): React.JSX.Element {
  return (
    <section
      className={cn(REMOTE_CARD, 'ring-1 ring-primary/25')}
      aria-label="Connected to this computer"
    >
      <ul className="settings-rows">
        {state.hosted.map((session) => (
          <li key={session.sessionId} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/50 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">
                {session.intent === 'files'
                  ? `${session.controllerName} is browsing files here`
                  : `${session.controllerName} is connected to this computer`}
              </div>
              <div className="text-xs text-muted-foreground">
                {[
                  session.deviceName,
                  session.transport === 'relay' ? 'through the relay' : 'direct',
                  session.permissions.control ? 'can control' : 'view only',
                  `safety code ${session.safetyCode.slice(0, 3)} ${session.safetyCode.slice(3)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <Button
              size="sm"
              variant="danger"
              shape="pill"
              aria-label={`End session with ${session.controllerName}`}
              onClick={() => void window.runova.anywhere.endHosted(session.sessionId)}
            >
              <Power />
              End
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConnectCard({ state }: { state: AnywhereState }): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const remoteId = parseRemoteId(typed);
  const mine = state.directory.mine.filter((e) => e.remoteId !== state.device?.remoteId);
  const teammates = state.directory.teammates;
  const nothing = mine.length === 0 && teammates.length === 0 && state.recent.length === 0;

  return (
    <section className={REMOTE_CARD} aria-label="Connect to a computer">
      <RemoteCardHeader
        icon={Link}
        title="Connect to a computer"
        description="By its Runova ID, or pick one you have used before."
      />
      <form
        className="flex flex-wrap items-center gap-2 px-5 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (remoteId) connect(remoteId, 'control');
        }}
      >
        <label className="sr-only" htmlFor="anywhere-remote-id">
          Runova ID
        </label>
        <input
          id="anywhere-remote-id"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="123 456 789"
          value={typed}
          onChange={(event) => setTyped(formatTypedRemoteId(event.target.value))}
          className="field-surface h-11 min-w-[12rem] flex-1 rounded-xl px-4 font-mono text-lg tabular-nums tracking-[0.14em] placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" shape="pill" size="lg" disabled={!remoteId}>
          <Monitor />
          Connect
        </Button>
        <SimpleTooltip label="Files only, no screen">
          <Button
            type="button"
            variant="soft"
            shape="pill"
            size="lg"
            disabled={!remoteId}
            onClick={() => remoteId && connect(remoteId, 'files')}
          >
            <Folder />
            Files
          </Button>
        </SimpleTooltip>
      </form>

      {nothing ? (
        <p className="px-5 pb-5 text-xs text-muted-foreground">
          Type the ID shown in Runova on the other computer. Computers you sign in to, and the ones
          your teammates show to your team, appear here on their own.
        </p>
      ) : (
        <div className="space-y-4 px-2 pb-3">
          {mine.length > 0 ? <DeviceList title="My computers" entries={mine} /> : null}
          {teammates.length > 0 ? (
            <DeviceList title="Teammates" entries={teammates} teammates />
          ) : null}
          {state.recent.length > 0 ? <RecentList state={state} /> : null}
        </div>
      )}
    </section>
  );
}

function DeviceList({
  title,
  entries,
  teammates = false,
}: {
  title: string;
  entries: AnywhereDirectoryEntry[];
  teammates?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <h3 className={cn(SECTION_HEADING, 'px-3 pb-1')}>{title}</h3>
      <ul aria-label={title}>
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-foreground/[0.04]"
          >
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                entry.online
                  ? 'bg-primary/12 text-primary'
                  : 'bg-foreground/[0.06] text-muted-foreground',
              )}
            >
              <Monitor className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{entry.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {teammates
                  ? `${entry.owner.displayName} · ${entry.teams.map((t) => t.name).join(', ')}`
                  : formatRemoteId(entry.remoteId)}
              </div>
            </div>
            {entry.online ? (
              <Chip tone="success" dot>
                Online
              </Chip>
            ) : (
              <Chip tone="neutral">Offline</Chip>
            )}
            <div className="flex items-center gap-1">
              <SimpleTooltip label="Files only">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  shape="pill"
                  aria-label={`Open files on ${entry.name}`}
                  disabled={!entry.online}
                  onClick={() => connect(entry.remoteId, 'files')}
                >
                  <Folder />
                </Button>
              </SimpleTooltip>
              <Button
                size="sm"
                variant="tint"
                shape="pill"
                aria-label={`Connect to ${entry.name}`}
                disabled={!entry.online}
                onClick={() => connect(entry.remoteId, 'control')}
              >
                Connect
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentList({ state }: { state: AnywhereState }): React.JSX.Element {
  return (
    <div>
      <h3 className={cn(SECTION_HEADING, 'flex items-center gap-1.5 px-3 pb-1')}>
        <History className="h-3 w-3" />
        Recent
      </h3>
      <ul aria-label="Recent">
        {state.recent.map((entry) => {
          const id = formatRemoteId(entry.remoteId);
          return (
            <li
              key={entry.remoteId}
              className="group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-foreground/[0.04]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
                <ShieldSolid className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                  <span className={entry.name ? '' : 'font-mono tabular-nums tracking-wider'}>
                    {entry.name || id}
                  </span>
                  {entry.savedPassword ? (
                    <span role="img" aria-label="Password saved" className="text-primary">
                      <Key className="h-3 w-3" />
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {entry.name ? `${id} · ` : ''}
                  {relativeTime(entry.at)}
                </div>
              </div>
              <SimpleTooltip label="Forget">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  shape="pill"
                  aria-label={`Forget ${id}`}
                  className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={() => void window.runova.anywhere.forgetRecent(entry.remoteId)}
                >
                  <Trash2 />
                </Button>
              </SimpleTooltip>
              <Button
                size="sm"
                variant="tint"
                shape="pill"
                aria-label={`Connect to ${entry.name || id}`}
                onClick={() => connect(entry.remoteId, 'control')}
              >
                Connect
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
