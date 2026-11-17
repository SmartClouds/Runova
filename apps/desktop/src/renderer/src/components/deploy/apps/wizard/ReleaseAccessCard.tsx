import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, ExternalLink, Key, Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useDeployServers } from '../../backups/hooks';
import { useProofStepUp } from '../../overview/useProofStepUp';

/**
 * How the server gets at a repository's release images (E105), and the way to give it access.
 * A deploy from this computer hands the server a signed link through this computer's GitHub
 * sign-in, so it always works from here; a public repository needs nothing. For deploys without
 * this computer, an Admin stores a fine-grained, read-only token on the server: the card walks
 * through making one on GitHub, takes it, and the server checks it with GitHub before keeping it.
 */

export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

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
  const ids = { token: useId(), steps: useId() };
  const stepUp = useProofStepUp(server);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const saved = await stepUp.run(
        (proof) =>
          window.runova.deployStacks.saveReleaseToken({
            serverId: server.id,
            repository,
            token,
            ...proof,
          }),
        'Giving the server access to the releases',
      );
      if (saved) {
        toast.success(`${server.nickname} now reads the releases of ${repository} on its own.`);
        setToken('');
        setOpen(false);
        onChanged();
      }
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

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
      {open && (
        <form className="space-y-3" onSubmit={(event) => void save(event)}>
          <ol id={ids.steps} className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              Open GitHub's page for a new fine-grained token.{' '}
              <Button
                type="button"
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs font-medium"
                onClick={() => void window.runova.shell.openExternal(NEW_TOKEN_URL)}
              >
                Open GitHub <ExternalLink className="h-3 w-3" />
              </Button>
            </li>
            <li>
              Under Repository access, pick Only select repositories and choose{' '}
              <span className="font-mono text-foreground">{repository}</span>.
            </li>
            <li>Under Permissions, set Contents to Read-only. Nothing else is needed.</li>
            <li>Generate the token and paste it below. The server checks it with GitHub first.</li>
          </ol>
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
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || token.trim() === ''}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Check and store
            </Button>
            <Button
              type="button"
              size="sm"
              variant="soft"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setToken('');
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!open && problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
