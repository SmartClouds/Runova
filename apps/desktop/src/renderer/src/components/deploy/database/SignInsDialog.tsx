import { engineInfo } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DatabaseCandidate,
  DatabaseRevealedSignIn,
  DatabaseSession,
  DatabaseSignIn,
  DatabaseSignInOrigin,
  DatabaseSignIns,
} from '@shared/databaseTypes';
import { useState } from 'react';
import { Eye, EyeOff, Key, Plug, RefreshCw, Spinner } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { LIST_ROW, LIST_WELL } from '../deployKit';
import { EngineMark } from './EngineMark';
import { type DatabaseConnector, signInKey } from './useDatabaseConnect';

/**
 * Every way to sign in to one database container that its project already writes down: the
 * owner it was started with, the project's .env, and the URLs its apps are given. Each one
 * connects in a click, and Show puts its connection string and password on screen on purpose.
 * What Show reveals lives in this dialog only and is gone when it closes.
 */

export function SignInsDialog({
  candidate,
  found,
  connector,
  onClose,
  onFound,
  onConnected,
}: {
  candidate: DatabaseCandidate | null;
  found: DatabaseSignIns | null;
  connector: DatabaseConnector;
  onClose: () => void;
  /** A fresh look, after Look again. */
  onFound: (found: DatabaseSignIns) => void;
  onConnected: (session: DatabaseSession) => void;
}): React.JSX.Element {
  const [revealed, setRevealed] = useState<Record<string, DatabaseRevealedSignIn>>({});
  const [showing, setShowing] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const close = () => {
    setRevealed({});
    setProblem(null);
    onClose();
  };

  const lookAgain = async () => {
    if (!candidate) return;
    setLooking(true);
    setProblem(null);
    try {
      const next = await connector.listSignIns(candidate);
      if (next) {
        setRevealed({});
        onFound(next);
      }
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setLooking(false);
    }
  };

  const toggle = async (signIn: DatabaseSignIn) => {
    if (!candidate) return;
    if (revealed[signIn.id]) {
      setRevealed(({ [signIn.id]: _gone, ...rest }) => rest);
      return;
    }
    setShowing(signIn.id);
    setProblem(null);
    try {
      const shown = await connector.revealSignIn(candidate, signIn);
      if (shown) setRevealed((current) => ({ ...current, [signIn.id]: shown }));
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setShowing(null);
    }
  };

  const connect = async (signIn: DatabaseSignIn) => {
    if (!candidate) return;
    const session = await connector.connectSignIn(candidate, signIn);
    if (session) {
      close();
      onConnected(session);
    }
  };

  const label = candidate ? engineInfo(candidate.engine).label : '';
  return (
    <Dialog open={candidate !== null && found !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {candidate ? <EngineMark engine={candidate.engine} size="sm" /> : null}
            Sign-ins for {candidate?.containerName}
          </DialogTitle>
          <DialogDescription>
            {label} sign-ins Runova read from the container, the project's .env, and the connection
            strings its other containers use.{' '}
            {found?.envFile
              ? found.envFile.found
                ? `It read ${found.envFile.path}.`
                : `There is no .env Runova could read at ${found.envFile.path}.`
              : 'The container is not part of a compose project, so there is no .env to read.'}
          </DialogDescription>
        </DialogHeader>

        {found && found.unread.length > 0 ? (
          <Notice tone="warning" size="sm">
            Runova could not read {found.unread.join(', ')}, so sign-ins written there are missing.
          </Notice>
        ) : null}
        {problem ? (
          <Notice tone="destructive" size="sm">
            {problem}
          </Notice>
        ) : null}

        <ul className={cn(LIST_WELL, 'max-h-[55vh] overflow-y-auto')}>
          {(found?.signIns ?? []).map((signIn) => (
            <SignInRow
              key={signIn.id}
              signIn={signIn}
              revealed={revealed[signIn.id] ?? null}
              showing={showing === signIn.id}
              busy={connector.pending === signInKey(signIn)}
              disabled={connector.pending !== null}
              failure={
                connector.failure?.key === signInKey(signIn) ? connector.failure.message : null
              }
              onToggle={() => void toggle(signIn)}
              onConnect={() => void connect(signIn)}
            />
          ))}
        </ul>

        <div className="flex justify-end">
          <Button
            size="sm"
            shape="pill"
            variant="ghost"
            onClick={() => void lookAgain()}
            disabled={looking}
          >
            <RefreshCw className={cn(looking && 'animate-spin')} /> Look again
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "DATABASE_URL_APP in curalink-api", "POSTGRES_PASSWORD in /opt/curalink/.env". */
function describeOrigin(origin: DatabaseSignInOrigin): string {
  return `${origin.key || 'The environment'} in ${origin.where}`;
}

function SignInRow({
  signIn,
  revealed,
  showing,
  busy,
  disabled,
  failure,
  onToggle,
  onConnect,
}: {
  signIn: DatabaseSignIn;
  revealed: DatabaseRevealedSignIn | null;
  showing: boolean;
  busy: boolean;
  disabled: boolean;
  failure: string | null;
  onToggle: () => void;
  onConnect: () => void;
}): React.JSX.Element {
  const who = signIn.user ?? 'No user name';
  const more = signIn.alsoIn.length;
  return (
    <li
      aria-label={signIn.database ? `${who} on ${signIn.database}` : who}
      className={cn(LIST_ROW, 'space-y-2')}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Key className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
            <span className="font-medium">{who}</span>
            {signIn.database ? (
              <span className="text-muted-foreground">on {signIn.database}</span>
            ) : null}
            {signIn.owner ? (
              <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                Owner
              </span>
            ) : null}
            {signIn.connectionId ? (
              <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px]">
                Saved
              </span>
            ) : null}
          </p>
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={[signIn.origin, ...signIn.alsoIn].map(describeOrigin).join('\n')}
          >
            {describeOrigin(signIn.origin)}
            {more > 0 ? `, and ${more} more ${more === 1 ? 'place' : 'places'}` : ''}
          </p>
          {signIn.hasPassword ? null : (
            <p className="text-[11px] text-muted-foreground">
              No password is written down for it. Connect asks for one.
            </p>
          )}
        </div>
        <Button
          size="sm"
          shape="pill"
          variant="ghost"
          onClick={onToggle}
          disabled={showing}
          aria-label={revealed ? `Hide the sign-in for ${who}` : `Show the sign-in for ${who}`}
        >
          {showing ? <Spinner className="animate-spin" /> : revealed ? <EyeOff /> : <Eye />}
          {revealed ? 'Hide' : 'Show'}
        </Button>
        <Button size="sm" shape="pill" variant="tint" disabled={disabled} onClick={onConnect}>
          {busy ? <Spinner className="animate-spin" /> : <Plug />}
          {busy ? 'Connecting' : 'Connect'}
        </Button>
      </div>
      {revealed ? (
        <div className="space-y-1.5 rounded-lg bg-foreground/[0.04] p-2.5">
          <Secret label="Connection string" value={revealed.url} />
          {revealed.password !== null ? (
            <Secret label="Password" value={revealed.password} />
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {failure}
        </p>
      ) : null}
    </li>
  );
}

function Secret({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">{value}</code>
      <CopyButton text={value} label={`Copy the ${label.toLowerCase()}`} alwaysVisible />
    </div>
  );
}
