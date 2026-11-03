import { type CatalogReleaseData, findCatalogTemplate, readCatalogInstall } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { installedCompose } from '../../../components/deploy/appStore/testing/fixtures';
import { installedLabel, latestLabel, newerThanBundled, releaseOptions } from './releases';

const ollama = findCatalogTemplate('ollama');
const postgres = findCatalogTemplate('postgres');
if (!ollama || !postgres) throw new Error('catalog changed');

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;

const DATA: CatalogReleaseData = {
  checkedAt: '2026-11-03',
  repositories: {
    'docker.io/ollama/ollama': [
      { tag: '0.38.2', digest: digest('1') },
      { tag: '0.38.1', digest: digest('2') },
    ],
    'ghcr.io/open-webui/open-webui': [{ tag: 'v0.12.0', digest: digest('3') }],
  },
};

describe('releaseOptions', () => {
  it('starts with Latest, naming its number, then the other releases', () => {
    expect(releaseOptions(ollama, '0.35', DATA)).toEqual([
      { value: 'latest', label: 'Latest (0.38.2)' },
      { value: '0.38.1', label: '0.38.1' },
      { value: '0.35.0', label: '0.35.0' },
    ]);
  });

  it('is the bundled release alone without a reading', () => {
    expect(releaseOptions(ollama, '0.35', null)).toEqual([
      { value: 'latest', label: 'Latest (0.35.0)' },
    ]);
  });
});

describe('latestLabel', () => {
  it('names what the newest release runs', () => {
    expect(latestLabel(ollama, ollama.defaultVersion, DATA)).toBe(
      'Ollama 0.38.2 with Open WebUI 0.12.0',
    );
    expect(latestLabel(ollama, ollama.defaultVersion, null)).toBe(ollama.versions[0].label);
  });
});

describe('newerThanBundled', () => {
  it('is true only when the registries list something newer than what shipped', () => {
    expect(newerThanBundled(ollama, ollama.defaultVersion, DATA)).toBe(true);
    expect(newerThanBundled(ollama, ollama.defaultVersion, null)).toBe(false);
    expect(newerThanBundled(postgres, postgres.defaultVersion, DATA)).toBe(false);
  });
});

describe('installedLabel', () => {
  it('names the release an install runs, not the one the catalog ships', () => {
    const { compose } = installedCompose('ollama');
    const older = compose.replace(/ollama\/ollama:0\.35\.0/, 'ollama/ollama:0.34.1');
    const read = readCatalogInstall(older);
    if (!read.ok) throw new Error(read.reason);
    expect(installedLabel(read.install)).toMatch(/^Ollama 0\.34\.1 with Open WebUI /);
  });
});
