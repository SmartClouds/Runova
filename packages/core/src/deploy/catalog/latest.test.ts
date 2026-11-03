import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCatalogTemplate } from './define.js';
import {
  type CatalogReleaseData,
  catalogReleases,
  catalogTagVersion,
  fillVersionLabel,
  latestCatalogVersion,
  lineTags,
  templateAtRelease,
  withLatest,
} from './latest.js';
import type { PinnedImage } from './types.js';
import { checkCatalogUpdate } from './updates.js';

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;

const pin = (repository: string, tag: string, digit: string): PinnedImage => ({
  repository,
  tag,
  digest: digest(digit),
  platforms: ['linux/amd64', 'linux/arm64'],
  source: 'vendor',
  publisher: 'Example',
  resolvedAt: '2026-10-01',
});

const APP = 'docker.io/example/app';
const DB = 'docker.io/library/db';

const TEMPLATE = defineCatalogTemplate({
  id: 'example',
  name: 'Example',
  description: 'A made-up app for the tests.',
  category: 'developer',
  homepage: 'https://example.com',
  versions: [
    {
      id: '0.35',
      label: 'Example {app} with DB {db}',
      images: { app: pin(APP, '0.35.0', 'a'), db: pin(DB, 'v8.4.1', 'b') },
    },
    {
      id: '0.20',
      label: 'Example {app} (old line)',
      images: { app: { ...pin(APP, '0.20.3', 'c'), track: 2 }, db: pin(DB, 'v8.4.1', 'b') },
    },
  ],
  defaultVersion: '0.35',
  parameters: z.object({}),
  fields: {},
  secrets: [],
  minMemoryMb: 128,
  firstVisitorSetup: false,
  exposureNote: null,
  acknowledgments: [],
  build: () => ({ services: {}, web: null, facts: [] }),
});

const DATA: CatalogReleaseData = {
  checkedAt: '2026-11-03',
  repositories: {
    [APP]: [
      { tag: '1.0.0', digest: digest('1') },
      { tag: '0.38.2', digest: digest('2') },
      { tag: '0.38.1', digest: digest('3') },
      { tag: '0.20.9', digest: digest('4') },
      { tag: '0.38.3-rc1', digest: digest('5') },
    ],
    [DB]: [
      { tag: 'v8.4.9', digest: digest('6') },
      { tag: 'v9.0.0', digest: digest('7') },
    ],
  },
};

describe('catalogTagVersion', () => {
  it('is the number part of a tag, without a leading v', () => {
    expect(catalogTagVersion('0.35.0')).toBe('0.35.0');
    expect(catalogTagVersion('v0.11.4')).toBe('0.11.4');
    expect(catalogTagVersion('7.1.2-php8.3-apache')).toBe('7.1.2');
    expect(catalogTagVersion('latest')).toBe('latest');
  });
});

describe('fillVersionLabel', () => {
  it('puts each role version in its place', () => {
    expect(
      fillVersionLabel('Example {app} with DB {db}', {
        app: pin(APP, '0.38.2', 'a'),
        db: pin(DB, 'v8.4.9', 'b'),
      }),
    ).toBe('Example 0.38.2 with DB 8.4.9');
  });

  it('refuses a role the version does not run', () => {
    expect(() => fillVersionLabel('Example {web}', { app: pin(APP, '1.0', 'a') })).toThrow(/web/);
  });
});

describe('defineCatalogTemplate labels', () => {
  it('fills a label pattern and keeps the pattern', () => {
    expect(TEMPLATE.versions[0].label).toBe('Example 0.35.0 with DB 8.4.1');
    expect(TEMPLATE.versions[0].labelPattern).toBe('Example {app} with DB {db}');
  });
});

describe('lineTags', () => {
  const tags = ['0.38.2', '0.35.0', '1.0.0', '0.38', '0.36.0-rc1', '0.37.0', 'latest'];

  it('keeps tags of the same major with the same shape, newest first', () => {
    expect(lineTags('0.35.0', tags)).toEqual(['0.38.2', '0.37.0', '0.35.0']);
  });

  it('can be held to a longer prefix', () => {
    expect(lineTags('0.35.0', tags, 2)).toEqual(['0.35.0']);
  });

  it('needs the same suffix, so another variant or a prerelease never matches', () => {
    expect(
      lineTags('7.1.2-php8.3-apache', [
        '7.1.3-php8.3-apache',
        '7.2.0-php8.4-apache',
        '7.1.4-php8.3-fpm',
        '7.1.5',
      ]),
    ).toEqual(['7.1.3-php8.3-apache']);
  });

  it('keeps the leading v', () => {
    expect(lineTags('v0.11.4', ['v0.12.0', '0.13.0'])).toEqual(['v0.12.0']);
  });
});

describe('catalogReleases', () => {
  it('lists the newest line within its major, newest first, the other roles at their newest', () => {
    const releases = catalogReleases(TEMPLATE, '0.35', DATA);
    // 1.0.0 is another major, 0.38.3-rc1 a prerelease and 0.20.x the older line's.
    expect(releases.map((release) => release.tag)).toEqual(['0.38.2', '0.38.1', '0.35.0']);
    expect(releases[0].version).toMatchObject({
      id: '0.35',
      label: 'Example 0.38.2 with DB 8.4.9',
      images: {
        app: { tag: '0.38.2', digest: digest('2'), resolvedAt: '2026-11-03' },
        db: { tag: 'v8.4.9', digest: digest('6') },
      },
    });
  });

  it('holds a line to as many numbers as its track says', () => {
    const releases = catalogReleases(TEMPLATE, '0.20', DATA);
    expect(releases.map((release) => release.tag)).toEqual(['0.20.9', '0.20.3']);
    expect(releases[0].version.label).toBe('Example 0.20.9 (old line)');
  });

  it('is the bundled pin alone without registry data', () => {
    const releases = catalogReleases(TEMPLATE, '0.35', null);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ tag: '0.35.0', version: TEMPLATE.versions[0] });
  });

  it('is empty for a line the template does not have', () => {
    expect(catalogReleases(TEMPLATE, '9', DATA)).toEqual([]);
  });
});

describe('latestCatalogVersion', () => {
  it('is the newest release of the line', () => {
    expect(latestCatalogVersion(TEMPLATE, TEMPLATE.versions[0], DATA).images.app.tag).toBe(
      '0.38.2',
    );
  });

  it('keeps the bundled pin when the registry has nothing newer', () => {
    expect(
      latestCatalogVersion(TEMPLATE, TEMPLATE.versions[0], { checkedAt: 'x', repositories: {} }),
    ).toBe(TEMPLATE.versions[0]);
  });
});

describe('withLatest', () => {
  it('lets the update check see the newest release', () => {
    const latest = withLatest(TEMPLATE, DATA);
    const onBundled = {
      version: '0.35',
      images: {
        app: { tag: '0.35.0', digest: digest('a') },
        db: { tag: 'v8.4.1', digest: digest('b') },
      },
    };
    expect(checkCatalogUpdate(TEMPLATE, onBundled).status).toBe('current');
    expect(checkCatalogUpdate(latest, onBundled).status).toBe('update');
    const onNewest = {
      version: '0.35',
      images: {
        app: { tag: '0.38.2', digest: digest('2') },
        db: { tag: 'v8.4.9', digest: digest('6') },
      },
    };
    expect(checkCatalogUpdate(latest, onNewest).status).toBe('current');
  });

  it('is the template itself without registry data', () => {
    expect(withLatest(TEMPLATE, null)).toBe(TEMPLATE);
  });
});

describe('templateAtRelease', () => {
  it('puts the picked release on its line', () => {
    const template = templateAtRelease(TEMPLATE, '0.35', '0.38.1', DATA);
    expect(template?.versions[0].images.app.tag).toBe('0.38.1');
    expect(template?.versions[1]).toBe(TEMPLATE.versions[1]);
  });

  it('takes latest as the newest release', () => {
    expect(templateAtRelease(TEMPLATE, '0.35', 'latest', DATA)?.versions[0].images.app.tag).toBe(
      '0.38.2',
    );
  });

  it('refuses a release the line does not list', () => {
    expect(templateAtRelease(TEMPLATE, '0.35', '1.0.0', DATA)).toBeNull();
    expect(templateAtRelease(TEMPLATE, '9', 'latest', DATA)).toBeNull();
  });
});
