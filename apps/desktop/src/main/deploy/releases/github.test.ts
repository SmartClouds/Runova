import { describe, expect, it, vi } from 'vitest';
import {
  type GithubReleaseDeps,
  isReleaseAssetHost,
  listReleases,
  repositoryOfRemote,
  signedAssetLink,
} from './github';

/**
 * GitHub Release images on this computer (E105): the releases of a repository with their image
 * assets and GitHub's digest of each, through the gh sign-in, and the short-lived signed link
 * the server downloads one asset with. The link is handed back once and goes nowhere else.
 */

const SIGNED =
  'https://release-assets.githubusercontent.com/github-production-release-asset/1/77?sig=very-secret';

function deps(overrides: Partial<GithubReleaseDeps> = {}): GithubReleaseDeps {
  return {
    api: vi.fn(async () => []) as GithubReleaseDeps['api'],
    token: vi.fn(async () => 'gho_signedin'),
    fetch: vi.fn(
      async () => new Response(null, { status: 302, headers: { location: SIGNED } }),
    ) as unknown as GithubReleaseDeps['fetch'],
    ...overrides,
  };
}

describe('listReleases', () => {
  it('lists releases newest first with only their image archives and the digest GitHub reports', async () => {
    const api = vi.fn(async () => [
      {
        tag_name: 'v1.4.0',
        name: 'Shop 1.4.0',
        draft: false,
        prerelease: false,
        published_at: '2026-11-10T08:00:00Z',
        assets: [
          { id: 77, name: 'shop-image.tar.gz', size: 1234, digest: `sha256:${'a'.repeat(64)}` },
          { id: 78, name: 'checksums.txt', size: 90, digest: `sha256:${'b'.repeat(64)}` },
          { id: 79, name: 'old.tar', size: 50, digest: null },
        ],
      },
      { tag_name: 'v1.5.0-draft', name: '', draft: true, prerelease: false, assets: [] },
    ]);

    const list = await listReleases('acme/shop', deps({ api: api as GithubReleaseDeps['api'] }));

    expect(api).toHaveBeenCalledWith('repos/acme/shop/releases?per_page=30');
    expect(list).toEqual({
      repository: 'acme/shop',
      releases: [
        {
          tag: 'v1.4.0',
          name: 'Shop 1.4.0',
          prerelease: false,
          publishedAtUnixMs: Date.parse('2026-11-10T08:00:00Z'),
          assets: [
            { id: 77, name: 'shop-image.tar.gz', size: 1234, sha256: 'a'.repeat(64) },
            { id: 79, name: 'old.tar', size: 50, sha256: null },
          ],
        },
      ],
    });
  });

  it('refuses a repository that is not owner/name before asking GitHub', async () => {
    const api = vi.fn();

    await expect(
      listReleases('acme/shop/../x', deps({ api: api as unknown as GithubReleaseDeps['api'] })),
    ).rejects.toThrow('owner/name');
    expect(api).not.toHaveBeenCalled();
  });
});

describe('signedAssetLink', () => {
  it('asks GitHub for the asset as this computer and hands back the link it redirects to', async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: SIGNED } }),
    );

    const link = await signedAssetLink(
      'acme/shop',
      77,
      deps({ fetch: fetch as unknown as GithubReleaseDeps['fetch'] }),
    );

    expect(link).toBe(SIGNED);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/shop/releases/assets/77');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gho_signedin');
    expect((init.headers as Record<string, string>).accept).toBe('application/octet-stream');
  });

  it('answers null without a gh sign-in, so the server uses its own access', async () => {
    const fetch = vi.fn();

    const link = await signedAssetLink(
      'acme/shop',
      77,
      deps({ token: async () => null, fetch: fetch as unknown as GithubReleaseDeps['fetch'] }),
    );

    expect(link).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a redirect anywhere but GitHub, and says so without the link', async () => {
    const elsewhere = 'https://evil.example.com/asset?sig=leak-me';
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: elsewhere } }),
    );

    const failure = signedAssetLink(
      'acme/shop',
      77,
      deps({ fetch: fetch as unknown as GithubReleaseDeps['fetch'] }),
    );

    await expect(failure).rejects.toThrow('release asset hosts');
    await expect(failure).rejects.not.toThrow('leak-me');
  });

  it('says the sign-in cannot read the release when GitHub answers 404', async () => {
    const fetch = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 }));

    await expect(
      signedAssetLink(
        'acme/shop',
        77,
        deps({ fetch: fetch as unknown as GithubReleaseDeps['fetch'] }),
      ),
    ).rejects.toThrow('cannot read the releases of acme/shop');
  });
});

describe('repositoryOfRemote and isReleaseAssetHost', () => {
  it('reads owner/name from the GitHub remotes git writes', () => {
    expect(repositoryOfRemote('git@github.com:Acme/shop.git')).toBe('Acme/shop');
    expect(repositoryOfRemote('https://github.com/acme/shop')).toBe('acme/shop');
    expect(repositoryOfRemote('https://gitlab.com/acme/shop.git')).toBeNull();
  });

  it('takes only GitHub release asset hosts over https', () => {
    expect(isReleaseAssetHost(SIGNED)).toBe(true);
    expect(isReleaseAssetHost('https://objects.githubusercontent.com/x')).toBe(true);
    expect(isReleaseAssetHost('http://release-assets.githubusercontent.com/x')).toBe(false);
    expect(
      isReleaseAssetHost('https://release-assets.githubusercontent.com.evil.example.com/'),
    ).toBe(false);
    expect(isReleaseAssetHost('not a url')).toBe(false);
  });
});
