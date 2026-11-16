import { ghApi } from '../../git/githubCli';

/**
 * The runners GitHub has registered for a repo or an org, so the runner cleanup can tell a runner
 * folder whose runner was removed on GitHub (E104). Anything short of a full, clear answer is null:
 * a folder is only called abandoned when GitHub plainly says its runner is not there.
 */

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ORG = /^[A-Za-z0-9_.-]+$/;

interface RunnerList {
  total_count?: unknown;
  runners?: { id?: unknown; name?: unknown }[];
}

export async function fetchRegisteredRunners(scope: {
  kind: 'repo' | 'org';
  name: string;
}): Promise<{ id: number; name: string }[] | null> {
  const valid = scope.kind === 'repo' ? REPO.test(scope.name) : ORG.test(scope.name);
  if (!valid || scope.name.split('/').some((part) => part === '.' || part === '..')) return null;
  const path =
    scope.kind === 'repo'
      ? `repos/${scope.name}/actions/runners?per_page=100`
      : `orgs/${scope.name}/actions/runners?per_page=100`;
  let reply: RunnerList;
  try {
    reply = await ghApi<RunnerList>(path);
  } catch {
    return null;
  }
  if (!Array.isArray(reply.runners)) return null;
  const runners = reply.runners.flatMap((runner) =>
    typeof runner.id === 'number' && typeof runner.name === 'string'
      ? [{ id: runner.id, name: runner.name }]
      : [],
  );
  // More than one page: a runner missing from this one may be on the next.
  if (typeof reply.total_count === 'number' && reply.total_count > runners.length) return null;
  return runners;
}
