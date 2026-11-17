import type {
  DeployGithubRelease,
  DeployReleaseAsset,
  DeployReleaseList,
} from '../../../shared/deployStacksTypes';
import { parseGithubRemote } from '../../git/githubCli';

/**
 * GitHub Release images on this computer (E105). The releases of a repository and their image
 * assets come through the gh sign-in. For a deploy, this computer asks GitHub's API for one asset
 * and takes the short-lived signed link GitHub redirects to; the server downloads with that link,
 * so the image never passes through here and the server needs no token. The link is returned once
 * to the upload and is never logged, stored or put in an error message.
 */

export interface GithubReleaseDeps {
  /** One `gh api` call, parsed. */
  api: <T>(path: string) => Promise<T>;
  /** The gh sign-in's token, or null when gh is missing or signed out. */
  token: () => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** What docker load reads: a docker save archive, plain or gzipped. */
const IMAGE_ASSET = /\.(?:tar|tar\.gz|tgz)$/i;

const ASSET_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const S3_ASSET_HOST = /^github-production-release-asset-[a-z0-9]+\.s3\.amazonaws\.com$/;

const TIMEOUT_MS = 20_000;

export function isRepository(value: string): boolean {
  return REPOSITORY.test(value) && !value.endsWith('/.') && !value.endsWith('/..');
}

function checkRepository(repository: string): void {
  if (!isRepository(repository)) {
    throw new Error('Name the repository as owner/name, such as acme/shop.');
  }
}

/** owner/name of a github.com remote, or null for any other host. */
export function repositoryOfRemote(url: string): string | null {
  const parsed = parseGithubRemote(url);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

/** HTTPS to one of GitHub's release asset hosts, as the server core allows it too. */
export function isReleaseAssetHost(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    (ASSET_HOSTS.has(host) || S3_ASSET_HOST.test(host))
  );
}

interface ApiAsset {
  id: number;
  name: string;
  size: number;
  digest?: string | null;
}

interface ApiRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  assets: ApiAsset[];
}

function toAsset(asset: ApiAsset): DeployReleaseAsset {
  const digest = typeof asset.digest === 'string' ? asset.digest : null;
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    sha256: digest?.startsWith('sha256:') ? digest.slice('sha256:'.length).toLowerCase() : null,
  };
}

function toRelease(release: ApiRelease): DeployGithubRelease {
  const published = release.published_at ? Date.parse(release.published_at) : Number.NaN;
  return {
    tag: release.tag_name,
    name: release.name ?? '',
    prerelease: release.prerelease,
    publishedAtUnixMs: Number.isNaN(published) ? null : published,
    assets: release.assets.filter((asset) => IMAGE_ASSET.test(asset.name)).map(toAsset),
  };
}

/** The published releases of a repository, as GitHub lists them (newest first), with their image assets. */
export async function listReleases(
  repository: string,
  deps: GithubReleaseDeps,
): Promise<DeployReleaseList> {
  checkRepository(repository);
  const releases = await deps.api<ApiRelease[]>(`repos/${repository}/releases?per_page=30`);
  return {
    repository,
    releases: releases.filter((release) => !release.draft).map(toRelease),
  };
}

/**
 * The signed link GitHub hands out for one asset to this computer's sign-in, or null when there
 * is no gh sign-in (the server then reads the release on its own, or says it cannot).
 */
export async function signedAssetLink(
  repository: string,
  assetId: number,
  deps: GithubReleaseDeps,
): Promise<string | null> {
  checkRepository(repository);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) throw new Error('Pick the asset again.');
  const token = await deps.token();
  if (!token) return null;
  let response: Response;
  try {
    response = await deps.fetch(
      `https://api.github.com/repos/${repository}/releases/assets/${assetId}`,
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'application/octet-stream',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error('Could not reach GitHub to get the download for the release image.');
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location && isReleaseAssetHost(location)) return location;
    throw new Error(
      'GitHub sent the download somewhere other than its release asset hosts, so it was not used.',
    );
  }
  if (response.status === 404 || response.status === 401 || response.status === 403) {
    throw new Error(
      `Your GitHub sign-in cannot read the releases of ${repository}. Sign in with an account that can, or give the server its own access.`,
    );
  }
  throw new Error(
    `GitHub answered ${response.status} for the release image. Try again in a moment.`,
  );
}
