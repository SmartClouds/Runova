import type { AnyCatalogTemplate, CatalogVersion, PinnedImage } from './types.js';

/**
 * Explicit updates: an installed app keeps the digests it was deployed with until someone
 * applies a new one. This compares what an install runs with what the catalog pins now for the
 * same release line, so the app can show the new digest before anything is pulled. Moving to a
 * newer line (PostgreSQL 17 to 18) is offered separately, since it can need a migration.
 */

export interface InstalledCatalogImage {
  tag: string;
  digest: string;
}

export interface InstalledCatalogApp {
  /** The version id it was installed with. */
  version: string;
  /** What each image role runs now. */
  images: Readonly<Record<string, InstalledCatalogImage>>;
  /**
   * The image roles the install's choices use, when known. An app installed without an optional
   * part (Ollama without Open WebUI) uses fewer than its version pins, and the rest are no update.
   */
  roles?: readonly string[];
}

export interface CatalogImageChange {
  role: string;
  /** What runs now, or null when the line has gained an image. */
  from: InstalledCatalogImage | null;
  to: PinnedImage;
}

export interface CatalogUpdateCheck {
  /**
   * current: runs the pinned digests. update: the catalog pins something newer (see changes).
   * ahead: runs something newer than the catalog knows. retired: the line is no longer listed.
   */
  status: 'current' | 'update' | 'ahead' | 'retired';
  version: string;
  changes: CatalogImageChange[];
  /** Newer release lines, newest first, to offer as an upgrade rather than apply. */
  newerVersions: CatalogVersion[];
}

/** Compares the numbers in two tags in order, so 18.10 comes after 18.6. */
export function compareCatalogTags(a: string, b: string): number {
  const numbers = (tag: string) => (tag.match(/[0-9]+/g) ?? []).map(Number);
  const left = numbers(a);
  const right = numbers(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? -1) - (right[i] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function checkCatalogUpdate(
  template: AnyCatalogTemplate,
  installed: InstalledCatalogApp,
): CatalogUpdateCheck {
  const index = template.versions.findIndex((version) => version.id === installed.version);
  if (index < 0) {
    return {
      status: 'retired',
      version: installed.version,
      changes: [],
      newerVersions: [...template.versions],
    };
  }
  const pinned = template.versions[index];
  const changes: CatalogImageChange[] = [];
  let ahead = false;
  for (const [role, image] of Object.entries(pinned.images)) {
    if (installed.roles && !installed.roles.includes(role)) continue;
    const running = installed.images[role];
    if (!running) {
      changes.push({ role, from: null, to: image });
    } else if (running.digest !== image.digest) {
      // The same tag with another digest is a rebuild (a base image fix), which counts as newer.
      if (compareCatalogTags(running.tag, image.tag) > 0) ahead = true;
      else changes.push({ role, from: { tag: running.tag, digest: running.digest }, to: image });
    }
  }
  return {
    status: changes.length > 0 ? 'update' : ahead ? 'ahead' : 'current',
    version: installed.version,
    changes,
    newerVersions: template.versions.slice(0, index),
  };
}
