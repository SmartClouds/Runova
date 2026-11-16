import { describe, expect, it } from 'vitest';
import { CACHE_CATALOG, cacheEntriesFor, cacheLabel } from './cacheCatalog';

describe('CACHE_CATALOG', () => {
  it('has unique ids', () => {
    const ids = CACHE_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only uses relative paths, so the scan joins them to each home it checks', () => {
    for (const entry of CACHE_CATALOG) {
      for (const where of Object.values(entry.paths)) {
        expect(where.rel.startsWith('/')).toBe(false);
        expect(where.rel).not.toMatch(/^[A-Za-z]:/);
        expect(where.rel).not.toContain('..');
      }
    }
  });
});

describe('cacheEntriesFor', () => {
  it('puts the pip cache where each OS keeps it', () => {
    const pip = (os: 'linux' | 'macos' | 'windows') =>
      cacheEntriesFor(os).find((entry) => entry.id === 'pip');
    expect(pip('linux')).toMatchObject({ base: 'home', rel: '.cache/pip' });
    expect(pip('macos')).toMatchObject({ base: 'home', rel: 'Library/Caches/pip' });
    expect(pip('windows')).toMatchObject({ base: 'localAppData', rel: 'pip\\Cache' });
  });

  it('uses backslashes on Windows and forward slashes elsewhere', () => {
    for (const entry of cacheEntriesFor('windows')) expect(entry.rel).not.toContain('/');
    for (const entry of cacheEntriesFor('linux')) expect(entry.rel).not.toContain('\\');
  });

  it('names the tool command that cleans a cache when there is one', () => {
    const npm = cacheEntriesFor('linux').find((entry) => entry.id === 'npm');
    expect(npm?.command).toEqual({ tool: 'npm', args: ['cache', 'clean', '--force'] });
    const maven = cacheEntriesFor('linux').find((entry) => entry.id === 'maven');
    expect(maven?.command).toBeUndefined();
  });
});

describe('cacheLabel', () => {
  it('gives each cache a readable name', () => {
    expect(cacheLabel('gradle')).toBe('Gradle caches');
    expect(cacheLabel('go')).toBe('Go build cache');
  });
});
