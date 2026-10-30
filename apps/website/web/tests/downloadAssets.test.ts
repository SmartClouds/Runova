import { describe, expect, it } from 'vitest';
import {
  assetSystemLabel,
  formatSize,
  kindLabel,
  primaryAssets,
  sortAssets,
} from '../src/lib/download/assets';
import type { ReleaseAsset } from '../src/lib/download/release';
import release from './fixtures/releases/latest.json';

const assets = release.assets as ReleaseAsset[];

const names = (list: ReleaseAsset[]) => list.map((asset) => asset.name);

function asset(name: string, platform: string, arch: string, kind: string): ReleaseAsset {
  return {
    name,
    platform,
    arch,
    kind,
    size: 1,
    sha256: null,
    downloadUrl: `https://example.com/${name}`,
  } as ReleaseAsset;
}

describe('primaryAssets', () => {
  it.each([
    ['windows', 'x64', ['Runova-Setup-2.2.0.exe']],
    // Windows on Arm runs the x64 installer.
    ['windows', 'arm64', ['Runova-Setup-2.2.0.exe']],
    ['windows', null, ['Runova-Setup-2.2.0.exe']],
    ['macos', 'arm64', ['Runova-2.2.0-arm64.dmg']],
    ['macos', 'x64', ['Runova-2.2.0.dmg']],
    // No way to tell Apple silicon from Intel and no universal build: offer both disk images.
    ['macos', null, ['Runova-2.2.0-arm64.dmg', 'Runova-2.2.0.dmg']],
    ['linux', 'x64', ['Runova-2.2.0.AppImage']],
    ['linux', null, ['Runova-2.2.0.AppImage']],
    // There is no arm64 Linux build in this release, and the x64 one would not run.
    ['linux', 'arm64', []],
    [null, null, []],
    [null, 'x64', []],
  ] as const)('%s %s gets %j', (os, arch, expected) => {
    expect(names(primaryAssets(assets, { os, arch }))).toEqual(expected);
  });

  it('prefers a universal disk image when the Mac arch is unknown', () => {
    const withUniversal = [
      ...assets,
      asset('Runova-2.2.0-universal.dmg', 'macos', 'universal', 'dmg'),
    ];
    expect(names(primaryAssets(withUniversal, { os: 'macos', arch: null }))).toEqual([
      'Runova-2.2.0-universal.dmg',
    ]);
  });

  it('falls back to the universal disk image when there is none for the arch', () => {
    const list = [
      asset('Runova-2.2.0-universal.dmg', 'macos', 'universal', 'dmg'),
      asset('Runova-2.2.0.dmg', 'macos', 'x64', 'dmg'),
    ];
    expect(names(primaryAssets(list, { os: 'macos', arch: 'arm64' }))).toEqual([
      'Runova-2.2.0-universal.dmg',
    ]);
  });

  it('gives an arm64 Linux visitor the arm64 AppImage when the release has one', () => {
    const list = [...assets, asset('Runova-2.2.0-arm64.AppImage', 'linux', 'arm64', 'appimage')];
    expect(names(primaryAssets(list, { os: 'linux', arch: 'arm64' }))).toEqual([
      'Runova-2.2.0-arm64.AppImage',
    ]);
  });

  it('gives nothing when the release has no build for the system', () => {
    const list = assets.filter((item) => item.platform !== 'windows');
    expect(primaryAssets(list, { os: 'windows', arch: 'x64' })).toEqual([]);
  });
});

describe('sortAssets', () => {
  it('orders by platform, then the main file kind first, then Apple silicon before Intel', () => {
    const shuffled = [...assets].reverse();
    expect(names(sortAssets(shuffled))).toEqual([
      'Runova-Setup-2.2.0.exe',
      'Runova-2.2.0-arm64.dmg',
      'Runova-2.2.0.dmg',
      'Runova-2.2.0-arm64-mac.zip',
      'Runova-2.2.0-mac.zip',
      'Runova-2.2.0.AppImage',
      'Runova-2.2.0-amd64.deb',
    ]);
  });

  it('does not change the list it was given', () => {
    const copy = [...assets];
    sortAssets(copy);
    expect(copy).toEqual(assets);
  });
});

describe('labels', () => {
  it.each([
    [262371947, '250.2 MB'],
    [500720746, '477.5 MB'],
    [1536, '1.5 KB'],
    [512, '512 B'],
    [2147483648, '2.0 GB'],
  ])('formatSize(%d) is %s', (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected);
  });

  it.each([
    ['windows', 'x64', 'Windows (x64)'],
    ['macos', 'arm64', 'macOS (Apple silicon)'],
    ['macos', 'x64', 'macOS (Intel)'],
    ['macos', 'universal', 'macOS (Apple silicon and Intel)'],
    ['linux', 'x64', 'Linux (x64)'],
    ['linux', 'arm64', 'Linux (arm64)'],
  ] as const)('%s %s is labelled %s', (platform, arch, expected) => {
    expect(assetSystemLabel({ platform, arch })).toBe(expected);
  });

  it.each([
    ['nsis', 'Installer (.exe)'],
    ['dmg', 'Disk image (.dmg)'],
    ['zip', 'Zip archive (.zip)'],
    ['appimage', 'AppImage'],
    ['deb', 'Debian package (.deb)'],
  ] as const)('the %s kind is labelled %s', (kind, expected) => {
    expect(kindLabel(kind)).toBe(expected);
  });
});
