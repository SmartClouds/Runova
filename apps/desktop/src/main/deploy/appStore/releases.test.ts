import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnyCatalogTemplate, findCatalogTemplate } from '@runova/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegistryImage } from './registry';
import { CatalogReleaseSource, RELEASES_TTL_MS } from './releases';

/**
 * The newest releases of the App Store's images, as the store and the update check see them:
 * read from the registries a few candidates per line, kept only when they carry both platforms,
 * cached for hours on disk, and the bundled pins when the registries cannot be reached.
 */

const ollama = findCatalogTemplate('ollama') as AnyCatalogTemplate;
const OLLAMA = 'docker.io/ollama/ollama';
const WEBUI = 'ghcr.io/open-webui/open-webui';
const BOTH = ['linux/amd64', 'linux/arm64'];
const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;

const NOW = Date.parse('2026-11-03T10:00:00Z');

function client(tags: Record<string, string[]>, images: Record<string, RegistryImage> = {}) {
  return {
    tags: vi.fn(async (repository: string) => {
      const found = tags[repository];
      if (!found) throw new Error(`${repository} is unreachable`);
      return found;
    }),
    inspect: vi.fn(async (repository: string, tag: string) => {
      const found = images[`${repository}:${tag}`];
      if (!found) throw new Error(`no ${repository}:${tag}`);
      return found;
    }),
  };
}

const folders: string[] = [];
const cacheFile = () => {
  const folder = mkdtempSync(join(tmpdir(), 'releases-'));
  folders.push(folder);
  return join(folder, 'app-store-releases.json');
};

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('CatalogReleaseSource', () => {
  it('keeps the newest releases of each line that carry both platforms', async () => {
    const registry = client(
      {
        [OLLAMA]: [
          '0.34.0',
          '0.35.0',
          '0.36.0',
          '0.37.0',
          '0.38.0',
          '0.38.1',
          '0.38.1-rocm',
          '1.0.0',
        ],
        [WEBUI]: ['v0.11.4', 'v0.12.0'],
      },
      {
        [`${OLLAMA}:0.38.1`]: { digest: digest('1'), platforms: BOTH },
        [`${OLLAMA}:0.38.0`]: { digest: digest('2'), platforms: ['linux/amd64'] },
        [`${OLLAMA}:0.37.0`]: { digest: digest('3'), platforms: BOTH },
        [`${WEBUI}:v0.12.0`]: { digest: digest('4'), platforms: BOTH },
      },
    );
    const source = new CatalogReleaseSource({
      client: registry,
      templates: [ollama],
      cacheFile: null,
      now: () => NOW,
    });

    const releases = await source.get();

    expect(releases.error).toBeNull();
    expect(releases.checkedAtUnixMs).toBe(NOW);
    expect(releases.data?.checkedAt).toBe('2026-11-03');
    // 0.38.0 lacks arm64; only the three newest candidates are read; 1.0.0 is another major.
    expect(releases.data?.repositories[OLLAMA]).toEqual([
      { tag: '0.38.1', digest: digest('1') },
      { tag: '0.37.0', digest: digest('3') },
    ]);
    expect(registry.inspect).not.toHaveBeenCalledWith(OLLAMA, '0.36.0');
    expect(releases.data?.repositories[WEBUI]).toEqual([{ tag: 'v0.12.0', digest: digest('4') }]);
  });

  it('answers from the cache file while it is fresh, and reads again when asked to', async () => {
    const file = cacheFile();
    const registry = client({ [OLLAMA]: ['0.35.0'], [WEBUI]: ['v0.11.4'] });
    const first = new CatalogReleaseSource({
      client: registry,
      templates: [ollama],
      cacheFile: file,
      now: () => NOW,
    });
    await first.get();
    expect(JSON.parse(readFileSync(file, 'utf8')).checkedAtUnixMs).toBe(NOW);

    const later = new CatalogReleaseSource({
      client: registry,
      templates: [ollama],
      cacheFile: file,
      now: () => NOW + RELEASES_TTL_MS - 1,
    });
    await later.get();
    expect(registry.tags).toHaveBeenCalledTimes(2);

    await later.get({ refresh: true });
    expect(registry.tags).toHaveBeenCalledTimes(4);
  });

  it('reads again once the cache is old', async () => {
    const registry = client({ [OLLAMA]: ['0.35.0'], [WEBUI]: ['v0.11.4'] });
    let now = NOW;
    const source = new CatalogReleaseSource({
      client: registry,
      templates: [ollama],
      cacheFile: null,
      now: () => now,
    });
    await source.get();
    now += RELEASES_TTL_MS + 1;
    await source.get();
    expect(registry.tags).toHaveBeenCalledTimes(4);
  });

  it('keeps what it could read when one registry fails', async () => {
    const registry = client({ [OLLAMA]: ['0.35.0'] });
    const source = new CatalogReleaseSource({
      client: registry,
      templates: [ollama],
      cacheFile: null,
      now: () => NOW,
    });

    const releases = await source.get();

    expect(releases.data?.repositories[OLLAMA]).toEqual([]);
    expect(releases.data?.repositories[WEBUI]).toBeUndefined();
    expect(releases.error).toBeNull();
  });

  it('falls back to the bundled pins, with the reason, when nothing can be read', async () => {
    const registry = client({});
    const source = new CatalogReleaseSource({
      client: registry,
      templates: [ollama],
      cacheFile: null,
      now: () => NOW,
    });

    const releases = await source.get();

    expect(releases.data).toBeNull();
    expect(releases.error).toMatch(/registries/);
  });

  it('keeps an old cache rather than nothing when the registries are down', async () => {
    const file = cacheFile();
    writeFileSync(
      file,
      JSON.stringify({
        checkedAtUnixMs: NOW - RELEASES_TTL_MS * 2,
        data: {
          checkedAt: '2026-11-02',
          repositories: { [OLLAMA]: [{ tag: '0.36.0', digest: digest('9') }] },
        },
      }),
    );
    const source = new CatalogReleaseSource({
      client: client({}),
      templates: [ollama],
      cacheFile: file,
      now: () => NOW,
    });

    const releases = await source.get();

    expect(releases.data?.repositories[OLLAMA]).toEqual([{ tag: '0.36.0', digest: digest('9') }]);
    expect(releases.checkedAtUnixMs).toBe(NOW - RELEASES_TTL_MS * 2);
    expect(releases.error).toMatch(/registries/);
  });

  it('reads once for callers that ask at the same time', async () => {
    const registry = client({ [OLLAMA]: ['0.35.0'], [WEBUI]: ['v0.11.4'] });
    const source = new CatalogReleaseSource({
      client: registry,
      templates: [ollama],
      cacheFile: null,
      now: () => NOW,
    });

    await Promise.all([source.get(), source.get()]);

    expect(registry.tags).toHaveBeenCalledTimes(2);
  });
});
