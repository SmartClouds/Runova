import { ghApi, runGh } from '../../git/githubCli';
import { gitOrNull } from '../../git/plumbing';
import type { CoreCallDeps } from '../coreCalls';
import { DeployReleases } from './service';

/**
 * Wires GitHub Release images (E105) into the app: the releases come through the GitHub CLI the
 * rest of the app uses, and the signed link through its sign-in token, which is read for the one
 * request and kept nowhere.
 */
export function createDeployReleases(
  deps: CoreCallDeps & { projectFolder: (projectId: string) => Promise<string | null> },
): DeployReleases {
  return new DeployReleases({
    links: deps.links,
    roles: deps.roles,
    remoteOf: async (projectId) => {
      const folder = await deps.projectFolder(projectId);
      if (!folder) return null;
      return (await gitOrNull(folder, ['remote', 'get-url', 'origin']))?.trim() || null;
    },
    github: {
      api: (path) => ghApi(path),
      token: async () => {
        try {
          const { stdout } = await runGh(['auth', 'token'], { readOnly: true });
          return stdout.trim() || null;
        } catch {
          return null;
        }
      },
      fetch: (url, init) => globalThis.fetch(url, init),
    },
  });
}
