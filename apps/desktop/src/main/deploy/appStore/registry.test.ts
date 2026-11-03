import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RegistryClient, registryLocation } from './registry';

/**
 * The App Store's look at the registries: anonymous, as `docker pull` is for public images. It
 * lists a repository's tags and reads an image index for its digest and platforms, signing in
 * with the bearer token the registry's challenge points at.
 */

const INDEX = 'application/vnd.oci.image.index.v1+json';

interface Seen {
  url: string;
  method: string;
  auth: string | null;
}

function fakeRegistry(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  const fetchFn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization') });
    if (url.startsWith('https://auth.example/token')) {
      return Response.json({ token: 'tok-1' });
    }
    if (headers.get('authorization') !== 'Bearer tok-1') {
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://auth.example/token",service="registry.example",scope="repository:app:pull"',
        },
      });
    }
    const route = routes[url.replace('https://registry-1.docker.io', '')];
    return route ? route() : new Response('not found', { status: 404 });
  };
  return { seen, fetchFn: fetchFn as typeof fetch };
}

const index = (platforms: string[]) =>
  JSON.stringify({
    schemaVersion: 2,
    mediaType: INDEX,
    manifests: platforms.map((platform) => {
      const [os, architecture] = platform.split('/');
      return {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        platform: { os, architecture },
      };
    }),
  });

describe('registryLocation', () => {
  it('sends Docker Hub repositories to its registry host', () => {
    expect(registryLocation('docker.io/ollama/ollama')).toEqual({
      host: 'registry-1.docker.io',
      name: 'ollama/ollama',
    });
    expect(registryLocation('docker.io/library/postgres')).toEqual({
      host: 'registry-1.docker.io',
      name: 'library/postgres',
    });
  });

  it('keeps other registries as they are', () => {
    expect(registryLocation('ghcr.io/open-webui/open-webui')).toEqual({
      host: 'ghcr.io',
      name: 'open-webui/open-webui',
    });
  });
});

describe('RegistryClient', () => {
  it('lists every tag across pages, signing in once', async () => {
    const { seen, fetchFn } = fakeRegistry({
      '/v2/example/app/tags/list?n=1000': () =>
        Response.json(
          { name: 'example/app', tags: ['1.0.0', '1.1.0'] },
          { headers: { link: '</v2/example/app/tags/list?last=1.1.0&n=1000>; rel="next"' } },
        ),
      '/v2/example/app/tags/list?last=1.1.0&n=1000': () =>
        Response.json({ name: 'example/app', tags: ['1.2.0'] }),
    });
    const client = new RegistryClient({ fetch: fetchFn });

    const tags = await client.tags('docker.io/example/app');

    expect(tags).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect(seen.filter((call) => call.url.startsWith('https://auth.example')).length).toBe(1);
    expect(seen[1].url).toBe(
      'https://auth.example/token?service=registry.example&scope=repository%3Aexample%2Fapp%3Apull',
    );
  });

  it('reads the digest and platforms of an image index', async () => {
    const body = index(['linux/amd64', 'linux/arm64', 'unknown/unknown']);
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const { seen, fetchFn } = fakeRegistry({
      '/v2/example/app/manifests/1.2.0': () =>
        new Response(body, { headers: { 'content-type': INDEX, 'docker-content-digest': digest } }),
    });
    const client = new RegistryClient({ fetch: fetchFn });

    const image = await client.inspect('docker.io/example/app', '1.2.0');

    expect(image).toEqual({ digest, platforms: ['linux/amd64', 'linux/arm64'] });
    const asked = seen.find((call) => call.url.endsWith('/manifests/1.2.0') && call.auth);
    expect(asked?.method).toBe('GET');
  });

  it('refuses an index whose body does not match the digest the registry named', async () => {
    const body = index(['linux/amd64', 'linux/arm64']);
    const { fetchFn } = fakeRegistry({
      '/v2/example/app/manifests/1.2.0': () =>
        new Response(body, {
          headers: { 'content-type': INDEX, 'docker-content-digest': `sha256:${'0'.repeat(64)}` },
        }),
    });
    const client = new RegistryClient({ fetch: fetchFn });

    await expect(client.inspect('docker.io/example/app', '1.2.0')).rejects.toThrow(/digest/);
  });

  it('says what went wrong when the registry refuses', async () => {
    const { fetchFn } = fakeRegistry({
      '/v2/example/app/tags/list?n=1000': () => new Response('slow down', { status: 429 }),
    });
    const client = new RegistryClient({ fetch: fetchFn });

    await expect(client.tags('docker.io/example/app')).rejects.toThrow(/429/);
  });
});
