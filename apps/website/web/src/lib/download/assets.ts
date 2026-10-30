import type { VisitorSystem } from './detect';
import { PLATFORMS, type ReleaseArch, type ReleaseAsset, type ReleaseKind } from './release';

/**
 * Which builds the download page puts first for a visitor, and how it names them. The defaults
 * follow docs/website/api-contract.md: the installer on Windows, the disk image on macOS and the
 * AppImage on Linux.
 */

const MAIN_KIND = { windows: 'nsis', macos: 'dmg', linux: 'appimage' } as const;

/** Kinds in the order the full list shows them: the main file of each system before the others. */
const KIND_ORDER: ReleaseKind[] = ['nsis', 'dmg', 'appimage', 'deb', 'zip'];
const ARCH_ORDER: ReleaseArch[] = ['universal', 'arm64', 'x64'];

/**
 * The builds for the main button: none for an unknown system or one with no build, one in
 * general, and both Mac disk images when the Mac's arch is unknown and there is no universal one.
 */
export function primaryAssets(assets: ReleaseAsset[], system: VisitorSystem): ReleaseAsset[] {
  const { os, arch } = system;
  if (!os) return [];
  const main = assets.filter((asset) => asset.platform === os && asset.kind === MAIN_KIND[os]);
  const forArch = (wanted: ReleaseArch) => main.filter((asset) => asset.arch === wanted);
  if (os === 'windows') return forArch('x64').slice(0, 1);
  if (os === 'linux') return forArch(arch ?? 'x64').slice(0, 1);
  const universal = forArch('universal').slice(0, 1);
  if (arch) {
    const exact = forArch(arch).slice(0, 1);
    return exact.length ? exact : universal;
  }
  return universal.length ? universal : sortAssets([...forArch('arm64'), ...forArch('x64')]);
}

/** A copy of the list by platform, then kind, then arch. */
export function sortAssets(assets: ReleaseAsset[]): ReleaseAsset[] {
  const rank = (asset: ReleaseAsset) =>
    PLATFORMS.indexOf(asset.platform) * 100 +
    KIND_ORDER.indexOf(asset.kind) * 10 +
    ARCH_ORDER.indexOf(asset.arch);
  return [...assets].sort((a, b) => rank(a) - rank(b));
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** Bytes in binary units, the way GitHub shows asset sizes: `250.2 MB`. */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' } as const;
const MAC_ARCH_NAMES: Record<ReleaseArch, string> = {
  arm64: 'Apple silicon',
  x64: 'Intel',
  universal: 'Apple silicon and Intel',
};

/** The system and processor an asset is for, such as `macOS (Apple silicon)`. */
export function assetSystemLabel(asset: Pick<ReleaseAsset, 'platform' | 'arch'>): string {
  const arch = asset.platform === 'macos' ? MAC_ARCH_NAMES[asset.arch] : asset.arch;
  return `${OS_NAMES[asset.platform]} (${arch})`;
}

/** The system an asset is for, without the processor, such as `macOS`. */
export function osName(asset: Pick<ReleaseAsset, 'platform'>): string {
  return OS_NAMES[asset.platform];
}

const KIND_NAMES: Record<ReleaseKind, string> = {
  nsis: 'Installer (.exe)',
  dmg: 'Disk image (.dmg)',
  zip: 'Zip archive (.zip)',
  appimage: 'AppImage',
  deb: 'Debian package (.deb)',
};

export function kindLabel(kind: ReleaseKind): string {
  return KIND_NAMES[kind];
}
