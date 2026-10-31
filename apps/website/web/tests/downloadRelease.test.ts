import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILD_VERSION,
  createReleaseSource,
  GITHUB_RELEASES_URL,
  parseRelease,
} from '../src/lib/download/release';
import release from './fixtures/releases/latest.json';

const BASE = 'http://api.test';
const LATEST = `${BASE}/api/v1/releases/latest`;
const MINUTE = 60_000;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** A source over a fake fetch and a clock the test moves by hand. */
function setup(...responses: Array<Response | Error>) {
  let time = 1_000_000;
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const source = createReleaseSource({ fetch: fetch as typeof globalThis.fetch, now: () => time });
  return {
    fetch,
    source,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('parseRelease', () => {
  it('reads a ReleaseDto', () => {
    expect(parseRelease(release)).toEqual(release);
  });

  it('keeps an asset whose sha256 is null', () => {
    const withoutDigest = {
      ...release,
      assets: [{ ...release.assets[0], sha256: null }],
    };
    expect(parseRelease(withoutDigest)?.assets[0].sha256).toBeNull();
  });

  it('drops assets it does not know how to show', () => {
    const odd = {
      ...release,
      assets: [
        ...release.assets,
        { ...release.assets[0], name: 'Runova-2.2.0.apk', platform: 'android' },
        { ...release.assets[0], name: 'Runova.msi', kind: 'msi' },
        { ...release.assets[0], name: 'Runova-ppc.dmg', arch: 'ppc' },
        { ...release.assets[0], name: 'no-url', downloadUrl: 'javascript:alert(1)' },
        { name: 'broken' },
      ],
    };
    expect(parseRelease(odd)?.assets).toEqual(release.assets);
  });

  it.each([
    ['null', null],
    ['a string', 'v2.2.0'],
    ['no version', { ...release, version: undefined }],
    ['no assets', { ...release, assets: undefined }],
    ['a notes link that is not https', { ...release, notesUrl: 'file:///etc/passwd' }],
  ])('rejects %s', (_name, value) => {
    expect(parseRelease(value)).toBeNull();
  });
});

describe('createReleaseSource', () => {
  it('reads the latest release from the API', async () => {
    const { fetch, source } = setup(json(release, { headers: { etag: '"a"' } }));
    expect(await source.latest(BASE)).toEqual(release);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(LATEST);
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('if-none-match')).toBeNull();
  });

  it('asks the API once for requests that arrive together', async () => {
    const { fetch, source } = setup(json(release));
    const [first, second] = await Promise.all([source.latest(BASE), source.latest(BASE)]);
    expect(first).toEqual(release);
    expect(second).toEqual(release);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a base URL with a trailing slash', async () => {
    const { fetch, source } = setup(json(release));
    await source.latest(`${BASE}/`);
    expect(String(fetch.mock.calls[0][0])).toBe(LATEST);
  });

  it('keeps the release for 5 minutes', async () => {
    const { fetch, source, advance } = setup(json(release));
    await source.latest(BASE);
    advance(5 * MINUTE - 1);
    expect(await source.latest(BASE)).toEqual(release);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again after 5 minutes with the ETag, and a 304 keeps the release', async () => {
    const { fetch, source, advance } = setup(
      json(release, { headers: { etag: '"a"' } }),
      new Response(null, { status: 304 }),
    );
    await source.latest(BASE);
    advance(5 * MINUTE);
    expect(await source.latest(BASE)).toEqual(release);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('if-none-match')).toBe('"a"');
    advance(5 * MINUTE - 1);
    await source.latest(BASE);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('takes a newer release after 5 minutes', async () => {
    const newer = { ...release, version: '2.3.0', tagName: 'v2.3.0' };
    const { source, advance } = setup(json(release), json(newer));
    await source.latest(BASE);
    advance(5 * MINUTE);
    expect((await source.latest(BASE))?.version).toBe('2.3.0');
  });

  it.each([
    ['the API cannot be reached', new TypeError('fetch failed')],
    ['the API has no release yet (503)', json({ status: 503 }, { status: 503 })],
    ['the API answers 500', new Response('oops', { status: 500 })],
    ['the body is not JSON', new Response('<html>', { status: 200 })],
    ['the body is not a release', json({ hello: 'world' })],
  ])('gives null when %s and nothing was read before', async (_name, response) => {
    const { source } = setup(response);
    expect(await source.latest(BASE)).toBeNull();
  });

  it('keeps serving the last release when the API goes down', async () => {
    const { source, advance } = setup(json(release), new TypeError('fetch failed'));
    await source.latest(BASE);
    advance(5 * MINUTE);
    expect(await source.latest(BASE)).toEqual(release);
  });

  it('waits 30 seconds before asking a failing API again', async () => {
    const { fetch, source, advance } = setup(new TypeError('fetch failed'), json(release));
    expect(await source.latest(BASE)).toBeNull();
    advance(30_000 - 1);
    expect(await source.latest(BASE)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await source.latest(BASE)).toEqual(release);
  });

  it('gives up on an API that does not answer in time', async () => {
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const source = createReleaseSource({
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 20,
    });
    expect(await source.latest(BASE)).toBeNull();
  });

  it('asks nothing when no API URL is set', async () => {
    const { fetch, source } = setup();
    expect(await source.latest('')).toBeNull();
    expect(await source.latest(undefined)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps each API URL apart', async () => {
    const other = { ...release, version: '9.9.9' };
    const { source } = setup(json(release), json(other));
    expect((await source.latest(BASE))?.version).toBe('2.2.0');
    expect((await source.latest('http://other.test'))?.version).toBe('9.9.9');
  });
});

describe('build-time fallback', () => {
  it('is the desktop app version', () => {
    const desktop = JSON.parse(
      readFileSync(new URL('../../../desktop/package.json', import.meta.url), 'utf8'),
    );
    expect(BUILD_VERSION).toBe(desktop.version);
  });

  it('links to the latest GitHub release', () => {
    expect(GITHUB_RELEASES_URL).toBe('https://github.com/SmartClouds/Runova/releases/latest');
  });
});
