import { describe, expect, it } from 'vitest';
import {
  decodeGoPath,
  isBunScopeDir,
  isBunSpecialEntry,
  isGradleVersionDir,
  splitBunEntry,
  splitDashVersion,
  splitElectronArtifact,
  splitGoVersionDir,
  splitGradleDist,
  splitRevisionEntry,
} from './layouts.js';

describe('splitDashVersion (pub and Cargo)', () => {
  it.each([
    ['_fe_analyzer_shared-103.0.0', '_fe_analyzer_shared', '103.0.0'],
    ['_discoveryapis_commons-1.0.7', '_discoveryapis_commons', '1.0.7'],
    ['rand_core-0.6.4', 'rand_core', '0.6.4'],
    ['h2-0.4.5', 'h2', '0.4.5'],
    ['bevy-2d-0.1.0', 'bevy-2d', '0.1.0'],
    ['serde-1.0.200-beta.1', 'serde', '1.0.200-beta.1'],
    ['ring-0.17.8', 'ring', '0.17.8'],
  ])('splits %s into %s and %s', (entry, name, version) => {
    expect(splitDashVersion(entry)).toEqual({ name, version });
  });

  it.each(['README.md', 'noversion', 'name-1', 'name-1.2', '-1.2.3', ''])(
    'finds no version in %j',
    (entry) => {
      expect(splitDashVersion(entry)).toBeNull();
    },
  );
});

describe('Bun cache entries', () => {
  it.each([
    ['react@19.2.8@@@1', 'react', '19.2.8'],
    ['typescript@7.0.2@@@1', 'typescript', '7.0.2'],
    ['node@22.1.0-rc.1@@@1', 'node', '22.1.0-rc.1'],
    ['is-number@7.0.0@@@12', 'is-number', '7.0.0'],
  ])('splits %s into %s and %s', (entry, name, version) => {
    expect(splitBunEntry(entry)).toEqual({ name, version });
  });

  it.each(['react', '00000e5c40626918.npm', '@GH@jonschlinkert-is-number-98e8ff1@@@1', ''])(
    'finds no version in %j',
    (entry) => {
      expect(splitBunEntry(entry)).toBeNull();
    },
  );

  it('tells a scope folder from a package', () => {
    expect(isBunScopeDir('@acemir')).toBe(true);
    expect(isBunScopeDir('@types')).toBe(true);
    expect(isBunScopeDir('react@19.2.8@@@1')).toBe(false);
    expect(isBunScopeDir('@GH@jonschlinkert-is-number-98e8ff1@@@1')).toBe(false);
    expect(isBunScopeDir('@')).toBe(false);
  });

  it('recognises the git and tarball entries Bun keeps beside packages', () => {
    expect(isBunSpecialEntry('@GH@jonschlinkert-is-number-98e8ff1@@@1')).toBe(true);
    expect(isBunSpecialEntry('@T@55a80cc6eed2cd5c@@@1')).toBe(true);
    expect(isBunSpecialEntry('@types')).toBe(false);
    expect(isBunSpecialEntry('react@19.2.8@@@1')).toBe(false);
  });
});

describe('Gradle', () => {
  it.each([
    ['gradle-9.4.1-bin', 'bin', '9.4.1'],
    ['gradle-9.3.1-all', 'all', '9.3.1'],
    ['gradle-8.14.3-all', 'all', '8.14.3'],
    ['gradle-8.5-rc-1-bin', 'bin', '8.5-rc-1'],
  ])('reads the distribution %s', (entry, flavour, version) => {
    expect(splitGradleDist(entry)).toEqual({ flavour, version });
  });

  it.each(['gradle-9.4.1', 'gradle-bin', 'other-9.4.1-bin', ''])(
    'does not take %j for a distribution',
    (entry) => {
      expect(splitGradleDist(entry)).toBeNull();
    },
  );

  it('tells the per-version cache folders from the areas Gradle shares between versions', () => {
    for (const name of ['8.14.3', '9.3.1', '9.4.1', '8.5-rc-1', '7.6']) {
      expect(isGradleVersionDir(name)).toBe(true);
    }
    for (const name of ['modules-2', 'jars-9', 'build-cache-1', 'journal-1', 'CACHEDIR.TAG', '']) {
      expect(isGradleVersionDir(name)).toBe(false);
    }
  });
});

describe('splitRevisionEntry (Playwright and the like)', () => {
  it.each([
    ['chromium-1234', 'chromium', '1234'],
    ['chromium_headless_shell-1243', 'chromium_headless_shell', '1243'],
    ['ffmpeg-1011', 'ffmpeg', '1011'],
    ['firefox-1463', 'firefox', '1463'],
    ['webkit-2070', 'webkit', '2070'],
    ['winldd-1007', 'winldd', '1007'],
  ])('reads %s', (entry, family, revision) => {
    expect(splitRevisionEntry(entry)).toEqual({ family, revision });
  });

  it.each(['.links', '__dirlock', 'chromium', 'chromium-', 'chromium-12a', ''])(
    'finds no revision in %j',
    (entry) => {
      expect(splitRevisionEntry(entry)).toBeNull();
    },
  );
});

describe('splitElectronArtifact', () => {
  it.each([
    ['electron-v43.1.1-win32-x64.zip', 'electron-win32-x64', '43.1.1'],
    ['electron-v38.0.0-darwin-arm64.zip', 'electron-darwin-arm64', '38.0.0'],
    ['chromedriver-v43.1.1-win32-x64.zip', 'chromedriver-win32-x64', '43.1.1'],
    ['electron-v43.0.0-beta.2-linux-x64.zip', 'electron-linux-x64', '43.0.0-beta.2'],
    ['ffmpeg-v43.1.1-win32-x64.zip', 'ffmpeg-win32-x64', '43.1.1'],
  ])('reads %s', (file, group, version) => {
    expect(splitElectronArtifact(file)).toEqual({ group, version });
  });

  it.each(['SHASUMS256.txt', 'electron.zip', 'electron-v43.1.1.zip', ''])(
    'finds no artifact in %j',
    (file) => {
      expect(splitElectronArtifact(file)).toBeNull();
    },
  );
});

describe('Go module cache', () => {
  it('turns the case marks in a module path back into capitals', () => {
    expect(decodeGoPath('github.com/!azure/azure-sdk')).toBe('github.com/Azure/azure-sdk');
    expect(decodeGoPath('github.com/!burnt!sushi/toml')).toBe('github.com/BurntSushi/toml');
    expect(decodeGoPath('golang.org/x/net')).toBe('golang.org/x/net');
  });

  it.each([
    ['net@v0.20.0', 'net', 'v0.20.0'],
    ['go.opentelemetry.io@v1.2.3', 'go.opentelemetry.io', 'v1.2.3'],
    ['gopls@v0.14.0-pre.1', 'gopls', 'v0.14.0-pre.1'],
    ['protobuf@v1.0.0+incompatible', 'protobuf', 'v1.0.0+incompatible'],
  ])('splits the folder %s', (entry, name, version) => {
    expect(splitGoVersionDir(entry)).toEqual({ name, version });
  });

  it.each(['cache', 'net', 'net@', '@v1.0.0', 'net@notaversion', ''])(
    'does not take %j for a module version folder',
    (entry) => {
      expect(splitGoVersionDir(entry)).toBeNull();
    },
  );
});
