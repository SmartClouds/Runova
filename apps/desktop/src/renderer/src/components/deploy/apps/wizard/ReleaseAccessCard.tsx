import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  ExternalLink,
  Key,
  Spinner,
  TerminalSquare,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useDeployServers } from '../../backups/hooks';
import { type Proof, useProofStepUp } from '../../overview/useProofStepUp';
import { newReleaseTokenUrl } from './releaseTokenUrl';

/**
 * How the server gets at a repository's release images (E105), and the way to give it access.
 * A deploy from this computer hands the server a signed link through this computer's GitHub
 * sign-in, so it always works from here; a public repository needs nothing. For deploys without
 * this computer, an Admin stores a fine-grained, read-only token on the server: the card walks
 * through making one on GitHub (the page comes filled in), takes it, and the server checks it with
 * GitHub before keeping it. The Admin can instead hand the server the GitHub CLI's own sign-in,
 * which main reads and sends on, after accepting that it reaches far more than the releases.
 */

export function ReleaseAccessCard({
  serverId,
  repository,
  canAdmin,
}: {
  serverId: string;
  repository: string;
  canAdmin: boolean;
}): React.JSX.Element | null {
  const servers = useDeployServers();
  const server = servers.data?.find((item) => item.id === serverId);
  const access = useQuery({
    queryKey: queryKeys.deployReleaseAccess(serverId, repository),
    queryFn: () => window.runova.deployStacks.releaseAccess({ serverId, repository }),
    retry: false,
  });

  if (access.isPending) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true">
        <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" /> Checking how the server reaches{' '}
        {repository}…
      </p>
    );
  }
  if (access.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        Could not check the server's access: {coreErrorMessage(access.error)}
      </p>
    );
  }
  const check = access.data;
  const ok = check.access !== 'none';
  return (
    <section
      aria-label="Server access to the releases"
      className={cn(
        'space-y-3 rounded-xl p-3 ring-1 ring-inset',
        ok ? 'ring-success/30' : 'ring-warning/30',
      )}
    >
      <p className="flex items-start gap-2 text-sm text-foreground">
        {ok ? (
          <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        ) : (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        )}
        <span>
          {check.message}
          {!ok && (
            <span className="mt-1 block text-xs text-muted-foreground">
              This deploy still works: this computer gets the server a download link through your
              GitHub sign-in.
            </span>
          )}
        </span>
      </p>
      {server && canAdmin && check.access !== 'public' && (
        <TokenForm
          server={server}
          repository={repository}
          stored={check.token?.id ?? null}
          onChanged={() => void access.refetch()}
        />
      )}
    </section>
  );
}

function TokenForm({
  server,
  repository,
  stored,
  onChanged,
}: {
  server: DeployServer;
  repository: string;
  stored: string | null;
  onChanged: () => void;
}): React.JSX.Element {
  const ids = { token: useId(), steps: useId(), accept: useId() };
  const stepUp = useProofStepUp(server);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'paste' | 'gh'>('paste');
  const [accepted, setAccepted] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function close(): void {
    setOpen(false);
    setMode('paste');
    setAccepted(false);
    setToken('');
    setProblem(null);
  }

  async function store(send: (proof?: Proof) => Promise<unknown>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const saved = await stepUp.run(send, 'Giving the server access to the releases');
      if (saved) {
        toast.success(`${server.nickname} now reads the releases of ${repository} on its own.`);
        close();
        onChanged();
      }
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function save(event: React.FormEvent): void {
    event.preventDefault();
    void store((proof) =>
      window.runova.deployStacks.saveReleaseToken({
        serverId: server.id,
        repository,
        token,
        ...proof,
      }),
    );
  }

  function saveGhSignIn(): void {
    void store((proof) =>
      window.runova.deployStacks.saveReleaseTokenFromGh({
        serverId: server.id,
        repository,
        acceptBroaderScopes: true,
        ...proof,
      }),
    );
  }

  const problemLine = problem && (
    <p role="alert" className="text-xs text-destructive">
      {problem}
    </p>
  );

  async function remove(tokenId: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await stepUp.run(
        (proof) =>
          window.runova.deployStacks.removeReleaseToken({ serverId: server.id, tokenId, ...proof }),
        'Removing the server access to the releases',
      );
      onChanged();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {stepUp.dialog}
      {!open && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="soft" onClick={() => setOpen(true)} disabled={busy}>
            <Key className="h-3.5 w-3.5" />
            {stored ? 'Replace the token' : 'Give the server access'}
          </Button>
          {stored && (
            <Button size="sm" variant="soft" onClick={() => void remove(stored)} disabled={busy}>
              Remove the token
            </Button>
          )}
        </div>
      )}
      {open && mode === 'gh' && (
        <div className="space-y-3">
          <div
            role="group"
            aria-label="The gh sign-in"
            className="space-y-2 rounded-xl bg-warning/10 p-3 text-sm ring-1 ring-inset ring-warning/30"
          >
            <p className="flex items-start gap-2 font-medium text-foreground">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              Your gh sign-in can do much more than read releases
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>It can read and change every repository your GitHub account reaches.</li>
              <li>
                {server.nickname} keeps it until you remove it. If the server were broken into,
                whoever did it could use your GitHub account with it.
              </li>
              <li>
                It stops working when you run <code className="font-mono">gh auth logout</code>, and
                the server loses access then.
              </li>
            </ul>
            <p className="text-xs text-muted-foreground">
              A read-only token for {repository} is the safer choice.
            </p>
            <div className="flex items-start gap-2">
              <Checkbox
                id={ids.accept}
                checked={accepted}
                onCheckedChange={(value) => setAccepted(value === true)}
              />
              <Label htmlFor={ids.accept} className="text-xs leading-snug">
                I understand, and I want the server to keep my gh sign-in
              </Label>
            </div>
          </div>
          {problemLine}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy || !accepted} onClick={saveGhSignIn}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Store the gh
              sign-in
            </Button>
            <Button
              type="button"
              size="sm"
              variant="soft"
              disabled={busy}
              onClick={() => {
                setMode('paste');
                setAccepted(false);
                setProblem(null);
              }}
            >
              Paste a token instead
            </Button>
            <Button type="button" size="sm" variant="soft" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {open && mode === 'paste' && (
        <form className="space-y-3" onSubmit={save}>
          <ol id={ids.steps} className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              Open GitHub's page for a new fine-grained token, filled in for this repository.{' '}
              <Button
                type="button"
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs font-medium"
                onClick={() =>
                  void window.runova.shell.openExternal(newReleaseTokenUrl(repository))
                }
              >
                Open GitHub <ExternalLink className="h-3 w-3" />
              </Button>
            </li>
            <li>
              Under Repository access, pick Only select repositories and choose{' '}
              <span className="font-mono text-foreground">{repository}</span>.
            </li>
            <li>
              Under Permissions, GitHub has already set Contents to Read-only. Nothing else is
              needed.
            </li>
            <li>Generate the token and paste it below. The server checks it with GitHub first.</li>
          </ol>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Signed in with the GitHub CLI? The server can keep that sign-in instead.
            <Button
              type="button"
              size="sm"
              variant="soft"
              disabled={busy}
              onClick={() => {
                setMode('gh');
                setProblem(null);
              }}
            >
              <TerminalSquare className="h-3.5 w-3.5" /> Use my gh sign-in
            </Button>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={ids.token}>Token</Label>
            <SecretInput
              id={ids.token}
              value={token}
              onChange={setToken}
              placeholder="github_pat_…"
              aria-describedby={ids.steps}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {server.nickname} keeps it encrypted with its own keys and nobody can read it back.
          </p>
          {problemLine}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || token.trim() === ''}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Check and store
            </Button>
            <Button type="button" size="sm" variant="soft" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!open && problemLine}
    </div>
  );
}
