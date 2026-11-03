import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCatalogTemplate } from './define.js';
import type { PinnedImage } from './types.js';
import { checkCatalogUpdate, compareCatalogTags } from './updates.js';

const pin = (tag: string, digit: string): PinnedImage => ({
  repository: 'docker.io/library/example',
  tag,
  digest: `sha256:${digit.repeat(64)}`,
  platforms: ['linux/amd64', 'linux/arm64'],
  source: 'docker-official',
  publisher: 'Docker Official Images',
  resolvedAt: '2026-10-01',
});

const TEMPLATE = defineCatalogTemplate({
  id: 'example',
  name: 'Example',
  description: 'A made-up app for the tests.',
  category: 'developer',
  homepage: 'https://example.com',
  versions: [
    { id: '3', label: 'Example 3', images: { app: pin('3.0.1', 'a'), db: pin('16.4', 'b') } },
    { id: '2', label: 'Example 2', images: { app: pin('2.4.0', 'c'), db: pin('16.4', 'b') } },
  ],
  defaultVersion: '3',
  parameters: z.object({}),
  fields: {},
  secrets: [],
  minMemoryMb: 128,
  firstVisitorSetup: false,
  exposureNote: null,
  acknowledgments: [],
  build: () => ({ services: {}, web: null, facts: [] }),
});

const installed = (version: string, app: [string, string], db: [string, string]) => ({
  version,
  images: {
    app: { tag: app[0], digest: `sha256:${app[1].repeat(64)}` },
    db: { tag: db[0], digest: `sha256:${db[1].repeat(64)}` },
  },
});

describe('checkCatalogUpdate', () => {
  it('says an install on the pinned digests is current, and offers newer lines', () => {
    expect(checkCatalogUpdate(TEMPLATE, installed('3', ['3.0.1', 'a'], ['16.4', 'b']))).toEqual({
      status: 'current',
      version: '3',
      changes: [],
      newerVersions: [],
    });
    const older = checkCatalogUpdate(TEMPLATE, installed('2', ['2.4.0', 'c'], ['16.4', 'b']));
    expect(older.status).toBe('current');
    expect(older.newerVersions.map((version) => version.id)).toEqual(['3']);
  });

  it('shows the new digest when the catalog pins a newer tag or a rebuild of the same tag', () => {
    const result = checkCatalogUpdate(TEMPLATE, installed('3', ['3.0.0', 'e'], ['16.4', 'f']));
    expect(result.status).toBe('update');
    expect(result.changes).toEqual([
      {
        role: 'app',
        from: { tag: '3.0.0', digest: `sha256:${'e'.repeat(64)}` },
        to: TEMPLATE.versions[0].images.app,
      },
      {
        role: 'db',
        from: { tag: '16.4', digest: `sha256:${'f'.repeat(64)}` },
        to: TEMPLATE.versions[0].images.db,
      },
    ]);
  });

  it('does not offer to go back when the install is newer than the catalog', () => {
    const result = checkCatalogUpdate(TEMPLATE, installed('3', ['3.1.0', 'e'], ['16.4', 'b']));
    expect(result).toMatchObject({ status: 'ahead', changes: [] });
  });

  it('treats an image the install lacks as part of the update', () => {
    const result = checkCatalogUpdate(TEMPLATE, {
      version: '3',
      images: { app: { tag: '3.0.1', digest: `sha256:${'a'.repeat(64)}` } },
    });
    expect(result.status).toBe('update');
    expect(result.changes).toEqual([
      { role: 'db', from: null, to: TEMPLATE.versions[0].images.db },
    ]);
  });

  it('leaves out a role the install does not use, even when it runs no image for it', () => {
    const result = checkCatalogUpdate(TEMPLATE, {
      version: '3',
      images: { app: { tag: '3.0.1', digest: `sha256:${'a'.repeat(64)}` } },
      roles: ['app'],
    });
    expect(result).toMatchObject({ status: 'current', changes: [] });
  });

  it('says when a release line is no longer in the catalog', () => {
    const result = checkCatalogUpdate(TEMPLATE, installed('1', ['1.0', 'e'], ['15', 'f']));
    expect(result.status).toBe('retired');
    expect(result.newerVersions.map((version) => version.id)).toEqual(['3', '2']);
  });
});

describe('compareCatalogTags', () => {
  it('compares the numbers in tags in order', () => {
    expect(compareCatalogTags('18.6', '18.10')).toBeLessThan(0);
    expect(compareCatalogTags('v3.15.0', 'v3.13.4')).toBeGreaterThan(0);
    expect(compareCatalogTags('7.1.2-php8.3-apache', '7.1.2-php8.3-apache')).toBe(0);
    expect(compareCatalogTags('2.5', '2.5.1')).toBeLessThan(0);
    expect(compareCatalogTags('6.1.1-standalone', '6.1.0-standalone')).toBeGreaterThan(0);
  });
});
