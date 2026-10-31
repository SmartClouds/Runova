import type { DeployConnection, DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Key, LinkOff, Lock, Plug, RefreshCw, SignIn, TriangleAlert } from '@/components/icons';
import { EmptyState } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { useNow } from './apps/hooks';
import { EnrollDialog } from './EnrollDialog';
import { ConnectionMark } from './overview/ConnectionBadge';
import { useDeployConnection } from './overview/hooks';
import { RedeemCodeDialog } from './RedeemCodeDialog';
import { SignInDialog } from './SignInDialog';

type Dialog = 'sign-in' | 'enroll' | 'redeem' | null;

/** The connection is on its way up, or keeps being tried, so the section will open by itself. */
function isTrying(connection: DeployConnection | undefined): boolean {
  if (!connection) return false;
  if (connection.state === 'connecting' || connection.state === 'reconnecting') return true;
  return connection.state === 'offline' && connection.retryAt !== undefined;
}

/**
 * What a server's section shows in place of its content while this computer cannot use the core:
 * a card that says why and offers the one step that fixes it, right here (sign in, enroll, or
 * try again). While the connection is still being tried, it says so with a spinner and a
 * countdown instead, since the section opens by itself once the core answers.
 */
export function SignInGate({
  server,
  purpose,
  children,
}: {
  server: DeployServer;
  /** What signing in lets the user do here, finishing "Sign in to ...", e.g. "see its apps". */
  purpose: string;
  /** More ways forward, shown under the main action (a restore over SSH, say). */
  children?: React.ReactNode;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const access = useQuery({
    queryKey: queryKeys.deployAccess(server.id),
    queryFn: () => window.runova.deploy.access(server.id),
    retry: false,
    staleTime: 30_000,
  });
  const connection = useDeployConnection(server.id);
  const trying = isTrying(connection);
  const now = useNow(trying && connection?.retryAt !== undefined, 1_000);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployAccess(server.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployServers });
  };
  const closeDialog = () => {
    setDialog(null);
    refresh();
  };

  const state = access.data?.state;
  const name = server.nickname;
  let body: React.ReactNode;

  const retrying =
    access.isPending || (access.isFetching && (access.isError || state === 'unreachable'));
  if (trying || retrying) {
    const reconnecting = connection?.state === 'reconnecting';
    const seconds =
      connection?.retryAt !== undefined
        ? Math.max(1, Math.round((connection.retryAt - now) / 1000))
        : null;
    body = (
      <EmptyState
        card
        size="lg"
        busy
        icon={Plug}
        title={reconnecting ? `Reconnecting to ${name}` : `Connecting to ${name}`}
        description={
          <div role="status" aria-live="polite" className="space-y-3">
            <p>
              {reconnecting
                ? 'The connection dropped and is being tried again by itself.'
                : 'Opening a connection to the server core.'}{' '}
              This section fills in as soon as it answers.
            </p>
            <p className="inline-flex items-center gap-2 rounded-full bg-foreground/[0.05] px-3 py-1 text-xs text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
              <ConnectionMark state={connection?.state ?? 'connecting'} />
              {seconds !== null ? `Next try in ${seconds} s` : 'Waiting for the core'}
            </p>
            {connection?.message && (
              <p className="text-xs text-muted-foreground/80">Last problem: {connection.message}</p>
            )}
          </div>
        }
      />
    );
  } else if (state === 'needs-sign-in') {
    body = (
      <EmptyState
        card
        size="lg"
        icon={Lock}
        title={`Sign in to ${name}`}
        description={
          <>
            <p>
              {access.data?.message ??
                'This computer is set up on the server, but it has no session right now.'}
            </p>
            <p>Sign in to {purpose}.</p>
          </>
        }
        action={
          <div className="flex flex-col items-center gap-3">
            <Button onClick={() => setDialog('sign-in')}>
              <SignIn /> Sign in
            </Button>
            {children}
          </div>
        }
      />
    );
  } else if (state === 'needs-re-enroll' || state === 'not-enrolled') {
    const again = state === 'needs-re-enroll';
    body = (
      <EmptyState
        card
        size="lg"
        icon={again ? TriangleAlert : Key}
        title={again ? `${name} no longer accepts this computer` : 'This computer is not enrolled'}
        description={
          <>
            <p>
              {again
                ? 'It was removed or revoked on the core.'
                : `It has not been set up on ${name} yet.`}
            </p>
            <p>
              {again ? 'Enroll it again' : 'Enroll it'} to {purpose}.
            </p>
          </>
        }
        action={
          <div className="flex flex-col items-center gap-3">
            {!server.dev && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setDialog('enroll')}>
                  <Key /> {again ? 'Enroll again' : 'Enroll this computer'}
                </Button>
                <Button variant="soft" onClick={() => setDialog('redeem')}>
                  Use an enrollment code
                </Button>
              </div>
            )}
            {children}
          </div>
        }
      />
    );
  } else {
    // Unreachable, or the question itself failed.
    body = (
      <EmptyState
        card
        size="lg"
        icon={LinkOff}
        title={`Could not reach ${name}`}
        description={
          <>
            <p>{access.data?.message ?? 'The core did not answer who is signed in.'}</p>
            <p>Once it answers, sign in to {purpose}.</p>
          </>
        }
        action={
          <div className="flex flex-col items-center gap-3">
            <Button variant="soft" onClick={() => void access.refetch()}>
              <RefreshCw /> Try again
            </Button>
            {children}
          </div>
        }
      />
    );
  }

  return (
    <>
      {body}
      <SignInDialog
        server={server}
        open={dialog === 'sign-in'}
        onOpenChange={(open) => (open ? setDialog('sign-in') : closeDialog())}
        onSignedIn={refresh}
      />
      <EnrollDialog
        server={server}
        open={dialog === 'enroll'}
        onOpenChange={(open) => (open ? setDialog('enroll') : closeDialog())}
        onEnrolled={refresh}
      />
      <RedeemCodeDialog
        server={server}
        open={dialog === 'redeem'}
        onOpenChange={(open) => (open ? setDialog('redeem') : closeDialog())}
        onEnrolled={refresh}
      />
    </>
  );
}
