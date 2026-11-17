import type {
  ReleaseAccessCheck,
  ReleaseTokenInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployReleaseList,
  DeployReleaseListInput,
  DeployReleaseTokenInput,
  DeployReleaseTokenRemoveInput,
} from '../../../shared/deployStacksTypes';
import { ADMIN_ROLES, type CoreCallDeps, callCore } from '../coreCalls';
import {
  type GithubReleaseDeps,
  isRepository,
  listReleases,
  repositoryOfRemote,
  signedAssetLink,
} from './github';

/**
 * GitHub Release images in the app (E105): the releases of the repository a project pushes to,
 * the signed link a deploy hands the server, and the read-only token a server keeps for the
 * downloads nobody signs in for. Storing and removing that token are for Admins with a step-up,
 * made on the way when the call carries the password or a code; the core never sends it back.
 */

export interface DeployReleasesDeps extends CoreCallDeps {
  /** The URL of a project's origin remote, or null when it has none. */
  remoteOf: (projectId: string) => Promise<string | null>;
  github: GithubReleaseDeps;
}

async function stepUp(
  hub: ICoreHub,
  proof: { password?: string; totpCode?: string },
): Promise<void> {
  if (proof.password || proof.totpCode) {
    await hub.stepUp({
      ...(proof.password ? { password: proof.password } : {}),
      ...(proof.totpCode ? { totpCode: proof.totpCode } : {}),
    });
  }
}

const TOKEN = /^[\x21-\x7e]{1,255}$/;

export class DeployReleases {
  constructor(private readonly deps: DeployReleasesDeps) {}

  /** owner/name of the project's GitHub remote, or null. */
  async repositoryOf(projectId: string): Promise<string | null> {
    const remote = await this.deps.remoteOf(projectId);
    return remote ? repositoryOfRemote(remote) : null;
  }

  /** The releases of the repository typed in, or of the one the project pushes to. */
  async list(input: DeployReleaseListInput): Promise<DeployReleaseList> {
    const repository =
      input.repository?.trim() ||
      (input.projectId ? await this.repositoryOf(input.projectId) : null);
    if (!repository) {
      throw new Error(
        'This project has no GitHub remote. Type the repository that has the releases, as owner/name.',
      );
    }
    return listReleases(repository, this.deps.github);
  }

  /** The signed link for one asset, or null without a gh sign-in. */
  signedLink(repository: string, assetId: number): Promise<string | null> {
    return signedAssetLink(repository, assetId, this.deps.github);
  }

  serverTokens(serverId: string): Promise<ReleaseTokenInfo[]> {
    return callCore(this.deps, serverId, (hub) => hub.listReleaseTokens());
  }

  checkAccess(serverId: string, repository: string): Promise<ReleaseAccessCheck> {
    if (!isRepository(repository)) {
      return Promise.reject(new Error('Name the repository as owner/name, such as acme/shop.'));
    }
    return callCore(this.deps, serverId, (hub) => hub.checkReleaseAccess(repository));
  }

  saveServerToken(input: DeployReleaseTokenInput): Promise<ReleaseTokenInfo> {
    const repository = input.repository.trim();
    const token = input.token.trim();
    if (!isRepository(repository)) {
      return Promise.reject(new Error('Name the repository as owner/name, such as acme/shop.'));
    }
    if (!TOKEN.test(token)) {
      return Promise.reject(new Error('Paste the token on one line, as GitHub shows it.'));
    }
    return callCore(
      this.deps,
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        return hub.saveReleaseToken({ repository, token });
      },
      { stepUpFor: ADMIN_ROLES },
    );
  }

  removeServerToken(input: DeployReleaseTokenRemoveInput): Promise<void> {
    return callCore(
      this.deps,
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        await hub.deleteReleaseToken(input.tokenId);
      },
      { stepUpFor: ADMIN_ROLES },
    );
  }
}
