import { engineInfo } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DatabaseCandidate,
  DatabaseConnectResult,
  DatabaseNeedsPassword,
  DatabaseRevealedSignIn,
  DatabaseSession,
  DatabaseSignIn,
  DatabaseSignIns,
} from '@shared/databaseTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Key } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { queryKeys } from '@/lib/queryKeys';
import { type Proof, useProofStepUp } from '../overview/useProofStepUp';

/**
 * One click from a card to an open connection. Main reads the sign-in from the container; this
 * only steps in when something is missing. A server that wants a step-up before it shows a
 * container's environment gets the usual password prompt (or the remembered password), and a
 * database whose password was not found asks for that password and nothing else.
 */

/** useProofStepUp needs a server; on this computer it is never asked, since nothing needs a step-up. */
const THIS_COMPUTER = { id: 'local', nickname: 'This computer' } as DeployServer;

interface Asking {
  need: DatabaseNeedsPassword;
  name: string;
  attempt: (password: string) => Promise<DatabaseConnectResult>;
  settle: (session: DatabaseSession | null) => void;
}

export interface DatabaseConnector {
  /** The card or saved connection being connected, by key or id. */
  pending: string | null;
  /** The last failure, by the key or id it was for. */
  failure: { key: string; message: string } | null;
  connectCandidate: (candidate: DatabaseCandidate) => Promise<DatabaseSession | null>;
  connectSaved: (connectionId: string, name: string) => Promise<DatabaseSession | null>;
  /**
   * Every sign-in the container's project writes down, without passwords. Null when the user
   * closed the step-up. Throws what went wrong otherwise.
   */
  listSignIns: (candidate: DatabaseCandidate) => Promise<DatabaseSignIns | null>;
  /** Connects with one sign-in. Pending and failure use the key `signIn:<id>`. */
  connectSignIn: (
    candidate: DatabaseCandidate,
    signIn: DatabaseSignIn,
  ) => Promise<DatabaseSession | null>;
  /** The one call that shows a password, made only when the user presses Show. */
  revealSignIn: (
    candidate: DatabaseCandidate,
    signIn: DatabaseSignIn,
  ) => Promise<DatabaseRevealedSignIn | null>;
  dialogs: React.ReactNode;
}

export const signInKey = (signIn: DatabaseSignIn): string => `signIn:${signIn.id}`;

export function useDatabaseConnect(server: DeployServer | null): DatabaseConnector {
  const stepUp = useProofStepUp(server ?? THIS_COMPUTER);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<DatabaseConnector['failure']>(null);
  const [asking, setAsking] = useState<Asking | null>(null);

  /** Settles a result: a session as it is, a missing password by asking for it. */
  const settle = useCallback(
    async (
      result: DatabaseConnectResult,
      name: string,
      attempt: (password: string) => Promise<DatabaseConnectResult>,
    ): Promise<DatabaseSession | null> => {
      if (!('needsPassword' in result)) return result;
      return new Promise<DatabaseSession | null>((resolve) =>
        setAsking({ need: result, name, attempt, settle: resolve }),
      );
    },
    [],
  );

  const run = useCallback(
    async (key: string, work: () => Promise<DatabaseSession | null>) => {
      setPending(key);
      setFailure(null);
      try {
        const session = await work();
        if (session) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.databaseConnections() });
          void queryClient.invalidateQueries({ queryKey: ['database', 'discovery'] });
        }
        return session;
      } catch (error) {
        setFailure({ key, message: coreErrorMessage(error) });
        return null;
      } finally {
        setPending(null);
      }
    },
    [queryClient],
  );

  const connectCandidate = useCallback(
    (candidate: DatabaseCandidate) =>
      run(candidate.key, async () => {
        const base = { serverId: candidate.serverId, containerId: candidate.containerId };
        const first =
          candidate.serverId === null
            ? await window.runova.database.connectCandidate(base)
            : await stepUp.run(
                (proof?: Proof) => window.runova.database.connectCandidate({ ...base, ...proof }),
                `Reading the sign-in of ${candidate.containerName}`,
              );
        if (!first) return null;
        return settle(first, candidate.containerName, (databasePassword) =>
          window.runova.database.connectCandidate({ ...base, databasePassword }),
        );
      }),
    [run, settle, stepUp],
  );

  /** A call for a container: as it is on this computer, behind the step-up on a server. */
  const forContainer = useCallback(
    async <T,>(
      candidate: DatabaseCandidate,
      work: (proof?: Proof) => Promise<T>,
      what: string,
    ): Promise<T | null> => {
      if (candidate.serverId === null) return work();
      return (await stepUp.run(work, what)) ?? null;
    },
    [stepUp],
  );

  const listSignIns = useCallback(
    (candidate: DatabaseCandidate) =>
      forContainer(
        candidate,
        (proof?: Proof) =>
          window.runova.database.listSignIns({
            serverId: candidate.serverId,
            containerId: candidate.containerId,
            ...proof,
          }),
        `Reading the sign-ins of ${candidate.containerName}`,
      ),
    [forContainer],
  );

  const revealSignIn = useCallback(
    (candidate: DatabaseCandidate, signIn: DatabaseSignIn) =>
      forContainer(
        candidate,
        (proof?: Proof) =>
          window.runova.database.revealSignIn({
            serverId: candidate.serverId,
            containerId: candidate.containerId,
            signInId: signIn.id,
            ...proof,
          }),
        `Showing the password of ${signIn.user ?? candidate.containerName}`,
      ),
    [forContainer],
  );

  const connectSignIn = useCallback(
    (candidate: DatabaseCandidate, signIn: DatabaseSignIn) =>
      run(signInKey(signIn), async () => {
        const base = {
          serverId: candidate.serverId,
          containerId: candidate.containerId,
          signInId: signIn.id,
        };
        const first = await forContainer(
          candidate,
          (proof?: Proof) => window.runova.database.connectSignIn({ ...base, ...proof }),
          `Reading the sign-in of ${candidate.containerName}`,
        );
        if (!first) return null;
        const name = signIn.user
          ? `${candidate.containerName} (${signIn.user})`
          : candidate.containerName;
        return settle(first, name, (databasePassword) =>
          window.runova.database.connectSignIn({ ...base, databasePassword }),
        );
      }),
    [run, settle, forContainer],
  );

  const connectSaved = useCallback(
    (connectionId: string, name: string) =>
      run(connectionId, async () => {
        const first = await window.runova.database.connect(connectionId);
        return settle(first, name, (password) =>
          window.runova.database.connect(connectionId, password),
        );
      }),
    [run, settle],
  );

  return {
    pending,
    failure,
    connectCandidate,
    connectSaved,
    listSignIns,
    connectSignIn,
    revealSignIn,
    dialogs: (
      <>
        {stepUp.dialog}
        <PasswordDialog
          asking={asking}
          onDone={(session) => {
            asking?.settle(session);
            setAsking(null);
          }}
        />
      </>
    ),
  };
}

function PasswordDialog({
  asking,
  onDone,
}: {
  asking: Asking | null;
  onDone: (session: DatabaseSession | null) => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const need = asking?.need;
  const label = need ? engineInfo(need.engine).label : 'database';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!asking) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await asking.attempt(password);
      if ('needsPassword' in result) {
        setProblem('That password was not accepted. Check it and try again.');
        return;
      }
      setPassword('');
      onDone(result);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={asking !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setPassword('');
          setProblem(null);
          onDone(null);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-4 w-4 text-primary" /> {label} password
            </DialogTitle>
            <DialogDescription>
              {need?.reason === 'refused'
                ? `${asking?.name} turned down the saved password`
                : `Runova could not find the password of ${asking?.name}`}
              {need?.user ? ` for the user ${need.user}` : ''}. Type it once and it is kept sealed
              on this computer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="database-password">Password</Label>
            <SecretInput
              id="database-password"
              value={password}
              onChange={setPassword}
              autoFocus
              autoComplete="off"
            />
            {problem ? (
              <p role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onDone(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
