import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AnyCatalogTemplate,
  CATALOG_TEMPLATES,
  type CatalogReleaseData,
  compareCatalogTags,
  lineTags,
  type PinnedImage,
  type RegistryRelease,
} from '@runova/core';
import type { DeployAppReleases } from '../../../shared/deployAppStoreTypes';
import type { RegistryClient } from './registry';

/**
 * The newest releases of the App Store's images, read from their registries so the store shows
 * what is current rather than what was pinned when the app was built. For each line of each
 * template it reads the tags, takes the few newest of the pin's line (latest.ts in core decides
 * what belongs to a line), and reads their image index: only those that carry linux/amd64 and
 * linux/arm64 are kept, with the digest an install then pins.
 *
 * The reading is cached in memory and on disk for six hours, since Docker Hub counts manifest
 * reads towards its anonymous limit. A registry that fails only drops its own images; when every
 * one fails the last reading stays in use (marked with the error), or the bundled pins do.
 */

export const RELEASES_TTL_MS = 6 * 60 * 60 * 1000;

/** How many releases newer than the pin are read per line. */
export const CHECKED_PER_LINE = 3;

const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'];

const PARALLEL_REPOSITORIES = 4;

export interface CatalogReleaseSourceDeps {
  client: Pick<RegistryClient, 'tags' | 'inspect'>;
  /** Where the reading is kept between runs; null keeps it in memory only. */
  cacheFile: string | null;
  templates?: readonly AnyCatalogTemplate[];
  now?: () => number;
}

interface Cached {
  checkedAtUnixMs: number;
  data: CatalogReleaseData;
}

const isCached = (value: unknown): value is Cached => {
  if (typeof value !== 'object' || value === null) return false;
  const { checkedAtUnixMs, data } = value as Partial<Cached>;
  return (
    typeof checkedAtUnixMs === 'number' &&
    typeof data === 'object' &&
    data !== null &&
    typeof data.checkedAt === 'string' &&
    typeof data.repositories === 'object' &&
    data.repositories !== null
  );
};

export class CatalogReleaseSource {
  private readonly now: () => number;
  private readonly templates: readonly AnyCatalogTemplate[];
  private cached: Cached | null = null;
  private loaded = false;
  private reading: Promise<DeployAppReleases> | null = null;

  constructor(private readonly deps: CatalogReleaseSourceDeps) {
    this.now = deps.now ?? Date.now;
    this.templates = deps.templates ?? CATALOG_TEMPLATES;
  }

  /** The reading, from the cache while it is fresh unless `refresh` asks for a new one. */
  async get(options: { refresh?: boolean } = {}): Promise<DeployAppReleases> {
    if (!this.loaded) await this.load();
    if (
      !options.refresh &&
      this.cached &&
      this.now() - this.cached.checkedAtUnixMs < RELEASES_TTL_MS
    ) {
      return { data: this.cached.data, checkedAtUnixMs: this.cached.checkedAtUnixMs, error: null };
    }
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.deps.cacheFile) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.deps.cacheFile, 'utf8'));
      if (isCached(parsed)) this.cached = parsed;
    } catch {
      // No cache yet, or a damaged one: read the registries.
    }
  }

  private async save(cached: Cached): Promise<void> {
    const file = this.deps.cacheFile;
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(cached));
      await rename(`${file}.tmp`, file);
    } catch {
      // The reading still serves this run; the next one reads the registries again.
    }
  }

  private pinsByRepository(): Map<string, PinnedImage[]> {
    const pins = new Map<string, PinnedImage[]>();
    for (const template of this.templates) {
      for (const version of template.versions) {
        for (const pin of Object.values(version.images)) {
          const list = pins.get(pin.repository) ?? [];
          if (!list.some((known) => known.tag === pin.tag)) list.push(pin);
          pins.set(pin.repository, list);
        }
      }
    }
    return pins;
  }

  private async readRepository(
    repository: string,
    pins: readonly PinnedImage[],
  ): Promise<RegistryRelease[]> {
    const tags = await this.deps.client.tags(repository);
    const candidates = new Set<string>();
    for (const pin of pins) {
      lineTags(pin.tag, tags, pin.track)
        .filter((tag) => compareCatalogTags(tag, pin.tag) > 0)
        .slice(0, CHECKED_PER_LINE)
        .forEach((tag) => {
          candidates.add(tag);
        });
    }
    const releases: RegistryRelease[] = [];
    for (const tag of candidates) {
      try {
        const image = await this.deps.client.inspect(repository, tag);
        if (REQUIRED_PLATFORMS.every((platform) => image.platforms.includes(platform))) {
          releases.push({ tag, digest: image.digest });
        }
      } catch {
        // One unreadable tag only drops that tag.
      }
    }
    return releases.sort((a, b) => compareCatalogTags(b.tag, a.tag));
  }

  private async read(): Promise<DeployAppReleases> {
    const entries = [...this.pinsByRepository()];
    const repositories: Record<string, RegistryRelease[]> = {};
    const failures: string[] = [];
    for (let start = 0; start < entries.length; start += PARALLEL_REPOSITORIES) {
      const batch = entries.slice(start, start + PARALLEL_REPOSITORIES);
      const results = await Promise.allSettled(
        batch.map(([repository, pins]) => this.readRepository(repository, pins)),
      );
      results.forEach((result, index) => {
        const [repository] = batch[index];
        if (result.status === 'fulfilled') repositories[repository] = result.value;
        else failures.push(repository);
      });
    }
    if (entries.length > 0 && failures.length === entries.length) {
      const error =
        'The image registries could not be reached, so the store shows the versions it shipped with.';
      return this.cached
        ? { data: this.cached.data, checkedAtUnixMs: this.cached.checkedAtUnixMs, error }
        : { data: null, checkedAtUnixMs: null, error };
    }
    const checkedAtUnixMs = this.now();
    const cached: Cached = {
      checkedAtUnixMs,
      data: { checkedAt: new Date(checkedAtUnixMs).toISOString().slice(0, 10), repositories },
    };
    this.cached = cached;
    await this.save(cached);
    return { data: cached.data, checkedAtUnixMs, error: null };
  }
}
