import { createHash } from 'node:crypto';

/**
 * A small client for the OCI distribution API, used by the App Store to find the newest releases
 * of its images. It is anonymous, as `docker pull` is for public images: a registry that wants a
 * token says where to get one in its 401 challenge, and this follows it once per repository.
 *
 * Listing tags is free on Docker Hub; reading a manifest counts towards its anonymous pull limit,
 * so the caller reads only the few candidates it means to offer (releases.ts) and caches them.
 */

export interface RegistryImage {
  digest: `sha256:${string}`;
  /** The os/architecture pairs the index carries, such as linux/amd64. */
  platforms: string[];
}

export interface RegistryClientDeps {
  fetch?: typeof fetch;
  /** Per request; a registry that hangs must not hold the store up. */
  timeoutMs?: number;
}

const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];

const SINGLE_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];

/** At most this many pages of tags, so a repository with endless tags cannot run forever. */
const MAX_TAG_PAGES = 20;

/** Where a catalog repository (`docker.io/ollama/ollama`) is served from. */
export function registryLocation(repository: string): { host: string; name: string } {
  const slash = repository.indexOf('/');
  const host = repository.slice(0, slash);
  const name = repository.slice(slash + 1);
  return { host: host === 'docker.io' ? 'registry-1.docker.io' : host, name };
}

/** Bearer realm="...",service="...",scope="..." as a map. */
function parseChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const fields: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/([a-zA-Z]+)="([^"]*)"/g)) {
    fields[match[1].toLowerCase()] = match[2];
  }
  return fields.realm ? fields : null;
}

/** The next page from a Link header, as a path on the same registry. */
function nextPage(link: string | null): string | null {
  const match = link ? /<([^>]+)>\s*;\s*rel="?next"?/.exec(link) : null;
  return match ? match[1] : null;
}

export class RegistryClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, string>();

  constructor(deps: RegistryClientDeps = {}) {
    this.fetchFn = deps.fetch ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  /** Every tag of the repository, in the registry's order. */
  async tags(repository: string): Promise<string[]> {
    const { host, name } = registryLocation(repository);
    const tags: string[] = [];
    let path: string | null = `/v2/${name}/tags/list?n=1000`;
    for (let page = 0; path && page < MAX_TAG_PAGES; page++) {
      const response = await this.get(host, name, path, 'application/json');
      const body = (await response.json()) as { tags?: unknown };
      if (Array.isArray(body.tags)) {
        tags.push(...body.tags.filter((tag): tag is string => typeof tag === 'string'));
      }
      path = nextPage(response.headers.get('link'));
    }
    return tags;
  }

  /** The digest of the tag's image index and the platforms in it. */
  async inspect(repository: string, tag: string): Promise<RegistryImage> {
    const { host, name } = registryLocation(repository);
    const response = await this.get(
      host,
      name,
      `/v2/${name}/manifests/${encodeURIComponent(tag)}`,
      [...INDEX_TYPES, ...SINGLE_TYPES].join(', '),
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    const computed = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    const named = response.headers.get('docker-content-digest');
    if (named && named !== computed) {
      throw new Error(`${repository}:${tag} came back with a body that does not match its digest.`);
    }
    const body = JSON.parse(bytes.toString('utf8')) as {
      mediaType?: string;
      manifests?: { platform?: { os?: string; architecture?: string } }[];
    };
    const platforms = (body.manifests ?? [])
      .map((entry) => entry.platform)
      .filter((platform) => platform?.os && platform.os !== 'unknown' && platform.architecture)
      .map((platform) => `${platform?.os}/${platform?.architecture}`);
    return { digest: computed, platforms: [...new Set(platforms)] };
  }

  private async get(host: string, name: string, path: string, accept: string): Promise<Response> {
    const url = `https://${host}${path}`;
    let response = await this.send(url, accept, this.tokens.get(`${host}/${name}`));
    if (response.status === 401) {
      const challenge = parseChallenge(response.headers.get('www-authenticate'));
      if (!challenge) throw new Error(`${host} refused the request without saying how to sign in.`);
      const token = await this.token(challenge, name);
      this.tokens.set(`${host}/${name}`, token);
      response = await this.send(url, accept, token);
    }
    if (!response.ok) {
      throw new Error(`${host} answered ${response.status} for ${path.split('?')[0]}.`);
    }
    return response;
  }

  private async token(challenge: Record<string, string>, name: string): Promise<string> {
    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set('service', challenge.service);
    url.searchParams.set('scope', `repository:${name}:pull`);
    const response = await this.send(url.toString(), 'application/json');
    if (!response.ok) throw new Error(`${url.host} gave no token (${response.status}).`);
    const body = (await response.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`${url.host} gave no token.`);
    return token;
  }

  private send(url: string, accept: string, token?: string): Promise<Response> {
    const headers: Record<string, string> = { accept };
    if (token) headers.authorization = `Bearer ${token}`;
    return this.fetchFn(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }
}
