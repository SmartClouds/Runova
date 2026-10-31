import type { DeployConnection, DeployConnectionState, DeployTransport } from '@shared/deployTypes';
import { Lock, Spinner, TriangleAlert } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useDeployConnection } from './hooks';

/**
 * The server's lasting connection, in a word and a mark, so it never relies on colour: a
 * pulsing dot when connected, a spinner while on the way, a hollow ring when not connected and
 * a lock when it waits for the user. The tooltip says why and what happens next.
 */

const LABEL: Record<DeployConnectionState, string> = {
  connecting: 'Connecting',
  online: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Not connected',
  'needs-sign-in': 'Sign-in needed',
  'needs-re-enroll': 'Access to set up again',
  locked: 'Servers locked',
};

/** What the connection rides on, in a word or two (E16 adds the core's own TLS port, E44 its domain). */
const VIA: Record<DeployTransport, string> = {
  streamlocal: 'SSH',
  bridge: 'SSH',
  'dev-tcp': 'loopback',
  'direct-tls': 'direct TLS',
  'core-domain': 'the core domain',
};

const VIA_SENTENCE: Record<DeployTransport, string> = {
  streamlocal: 'It runs through the SSH tunnel.',
  bridge: "It runs through the core's bridge over SSH.",
  'dev-tcp': 'It runs over loopback to the DevHost.',
  'direct-tls': "It runs straight to the core's TLS port, with this computer's device key.",
  'core-domain': "It runs through the core's domain in nginx, with this computer's device key.",
};

const PIN_MISMATCH = 'Certificate mismatch';

function explain(connection: DeployConnection | undefined, now: number): string {
  if (!connection) return 'Checking the connection to the server core.';
  if (connection.problem === 'tls-pin-mismatch') {
    return connection.message ?? 'The direct TLS certificate does not match the pinned one.';
  }
  const retry =
    connection.retryAt !== undefined
      ? ` Trying again in ${Math.max(1, Math.round((connection.retryAt - now) / 1000))} s.`
      : '';
  switch (connection.state) {
    case 'online':
      return `Live: metrics, alerts and job logs arrive as they happen.${
        connection.transport ? ` ${VIA_SENTENCE[connection.transport]}` : ''
      }`;
    case 'connecting':
      return 'Opening a live connection to the server core.';
    case 'reconnecting':
      return `The connection dropped and is being tried again by itself.${retry}`;
    case 'offline':
      return connection.message
        ? `${connection.message}${retry}`
        : 'Opens by itself when this page needs the server core.';
    case 'needs-sign-in':
      return 'Sign in to the server core to connect again.';
    case 'needs-re-enroll':
      return 'This computer has to be set up on the server core again.';
    case 'locked':
      return 'Unlock your saved servers to connect.';
  }
}

export function ConnectionMark({
  state,
  className,
}: {
  state: DeployConnectionState | undefined;
  className?: string;
}): React.JSX.Element {
  if (state === 'online') {
    return (
      <span className={cn('relative flex h-2 w-2', className)} aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
    );
  }
  if (state === undefined || state === 'connecting' || state === 'reconnecting') {
    return (
      <Spinner
        className={cn(
          'h-3 w-3 motion-safe:animate-spin',
          state === 'reconnecting' ? 'text-warning' : 'text-muted-foreground',
          className,
        )}
      />
    );
  }
  if (state === 'offline') {
    return (
      <span
        aria-hidden
        className={cn(
          'h-2 w-2 rounded-full ring-[1.5px] ring-inset ring-muted-foreground/60',
          className,
        )}
      />
    );
  }
  return <Lock className={cn('h-3 w-3 text-warning', className)} />;
}

export function ConnectionBadge({ serverId }: { serverId: string }): React.JSX.Element {
  const connection = useDeployConnection(serverId);
  const state = connection?.state;
  const mismatch = connection?.problem === 'tls-pin-mismatch';
  const label = mismatch ? PIN_MISMATCH : state ? LABEL[state] : 'Checking';
  const via = state === 'online' && connection?.transport ? VIA[connection.transport] : null;
  return (
    <SimpleTooltip label={explain(connection, Date.now())}>
      <Chip
        role="status"
        aria-label={`Live connection: ${label}${via ? `, ${via}` : ''}`}
        tabIndex={0}
        tone={
          mismatch
            ? 'destructive'
            : state === 'online'
              ? 'success'
              : state === 'reconnecting' || state === 'needs-sign-in' || state === 'locked'
                ? 'warning'
                : 'neutral'
        }
        className="h-6 gap-1.5 px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {mismatch ? <TriangleAlert aria-hidden /> : <ConnectionMark state={state} />}
        {label}
        {via && <span className="font-normal opacity-75">over {via}</span>}
      </Chip>
    </SimpleTooltip>
  );
}
