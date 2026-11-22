import { describe, expect, it, vi } from 'vitest';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { DeployReleases } from './service';

/**
 * GitHub Release images in the app (E105): the releases of the repository a project pushes to,
 * and the read-only token a server keeps for downloads nobody signs in for, stored through the
 * hub with a step-up and never read back.
 */

const SERVER = 'srv-1';
const TOKEN = 'github_pat_releaseReadOnly_123';

const GH_TOKEN = 'gho_cliSignIn_456';

function harness(
  remote: string | null = 'git@github.com:acme/shop.git',
  roles = ['admin'],
  ghToken: string | null = GH_TOKEN,
) {
  const hub = {
    stepUp: vi.fn(async () => ({})),
    listReleaseTokens: vi.fn(async () => []),
    saveReleaseToken: vi.fn(async (request: { repository: string }) => ({
      id: 't1',
      repository: request.repository.toLowerCase(),
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    })),
    deleteReleaseToken: vi.fn(async () => undefined),
    checkReleaseAccess: vi.fn(async (repository: string) => ({
      repository,
      access: 'public',
      message: 'public',
    })),
  };
  const api = vi.fn(async () => []);
  const token = vi.fn(async () => ghToken);
  const releases = new DeployReleases({
    links: { call: (_serverId, work) => work(hub as unknown as ICoreHub) },
    roles: () => roles,
    remoteOf: vi.fn(async () => remote),
    github: { api: api as never, token, fetch: vi.fn() as never },
  });
  return { releases, hub, api, token };
}

describe('DeployReleases', () => {
  it('lists the releases of the GitHub repository the project pushes to', async () => {
    const { releases, api } = harness();

    const list = await releases.list({ projectId: 'p1' });

    expect(list.repository).toBe('acme/shop');
    expect(api).toHaveBeenCalledWith('repos/acme/shop/releases?per_page=30');
  });

  it('takes a repository typed in over the remote, and asks for one when there is no GitHub remote', async () => {
    const { releases, api } = harness(null);

    await expect(releases.list({ projectId: 'p1' })).rejects.toThrow('owner/name');
    const list = await releases.list({ projectId: 'p1', repository: 'acme/site' });

    expect(list.repository).toBe('acme/site');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('stores a token on the server after a step-up, and removes it the same way', async () => {
    const { releases, hub } = harness();

    const saved = await releases.saveServerToken({
      serverId: SERVER,
      repository: 'Acme/Shop',
      token: ` ${TOKEN} `,
      password: 'pw',
    });
    await releases.removeServerToken({ serverId: SERVER, tokenId: 't1', totpCode: '123456' });

    expect(hub.stepUp).toHaveBeenNthCalledWith(1, { password: 'pw' });
    expect(hub.saveReleaseToken).toHaveBeenCalledWith({ repository: 'Acme/Shop', token: TOKEN });
    expect(saved.repository).toBe('acme/shop');
    expect(hub.stepUp).toHaveBeenNthCalledWith(2, { totpCode: '123456' });
    expect(hub.deleteReleaseToken).toHaveBeenCalledWith('t1');
  });

  it('refuses a token with spaces inside or a repository that is not owner/name before the server hears of it', async () => {
    const { releases, hub } = harness();

    await expect(
      releases.saveServerToken({ serverId: SERVER, repository: 'acme/shop', token: 'two words' }),
    ).rejects.toThrow('one line');
    await expect(
      releases.saveServerToken({ serverId: SERVER, repository: 'acme', token: TOKEN }),
    ).rejects.toThrow('owner/name');
    expect(hub.saveReleaseToken).not.toHaveBeenCalled();
  });

  it("stores the GitHub CLI's sign-in on the server once the broader scopes are accepted", async () => {
    const { releases, hub, token } = harness();

    const saved = await releases.saveGhSignIn({
      serverId: SERVER,
      repository: 'Acme/Shop',
      acceptBroaderScopes: true,
      totpCode: '123456',
    });

    expect(token).toHaveBeenCalledTimes(1);
    expect(hub.stepUp).toHaveBeenCalledWith({ totpCode: '123456' });
    expect(hub.saveReleaseToken).toHaveBeenCalledWith({
      repository: 'Acme/Shop',
      token: GH_TOKEN,
    });
    expect(saved).not.toHaveProperty('token');
  });

  it('does not touch the gh sign-in until the broader scopes are accepted', async () => {
    const { releases, hub, token } = harness();

    await expect(
      releases.saveGhSignIn({
        serverId: SERVER,
        repository: 'acme/shop',
        acceptBroaderScopes: false,
      }),
    ).rejects.toThrow(/more than read/);
    expect(token).not.toHaveBeenCalled();
    expect(hub.saveReleaseToken).not.toHaveBeenCalled();
  });

  it('points at gh auth login when the GitHub CLI has no sign-in', async () => {
    const { releases, hub } = harness(undefined, undefined, null);

    await expect(
      releases.saveGhSignIn({
        serverId: SERVER,
        repository: 'acme/shop',
        acceptBroaderScopes: true,
      }),
    ).rejects.toThrow(/gh auth login/);
    expect(hub.saveReleaseToken).not.toHaveBeenCalled();
  });

  it('refuses a repository that is not owner/name before asking gh', async () => {
    const { releases, token } = harness();

    await expect(
      releases.saveGhSignIn({ serverId: SERVER, repository: 'acme', acceptBroaderScopes: true }),
    ).rejects.toThrow('owner/name');
    expect(token).not.toHaveBeenCalled();
  });

  it('asks the server how it reads a repository on its own', async () => {
    const { releases, hub } = harness();

    const check = await releases.checkAccess(SERVER, 'acme/shop');

    expect(hub.checkReleaseAccess).toHaveBeenCalledWith('acme/shop');
    expect(check.access).toBe('public');
  });
});
