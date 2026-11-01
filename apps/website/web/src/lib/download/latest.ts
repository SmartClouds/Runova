import { primaryAssets } from './assets';
import type { DesktopArch, DesktopOs } from './detect';
import { GITHUB_RELEASES_URL, type Release } from './release';

/**
 * Where `/download/<os>/latest` sends a visitor. The home page is static, so its download button
 * links here and the server picks the file from the latest release (the same choice as the main
 * button on /download). Same idea as openbot.run's `/download/<platform>/latest` links.
 */

const SYSTEMS: readonly DesktopOs[] = ['windows', 'macos', 'linux'];
const ARCHES: readonly DesktopArch[] = ['x64', 'arm64'];

export function parseDesktopOs(value: string | undefined): DesktopOs | null {
  return SYSTEMS.find((os) => os === value) ?? null;
}

export function parseDesktopArch(value: string | null | undefined): DesktopArch | null {
  return ARCHES.find((arch) => arch === value) ?? null;
}

/**
 * The installer's own URL when there is exactly one right file. A Mac of unknown arch with no
 * universal build gets /download, which offers both disk images. Without a release from the API
 * it is GitHub Releases, which always has every file.
 */
export function latestDownloadTarget(
  release: Release | null,
  os: DesktopOs,
  arch: DesktopArch | null,
): string {
  if (!release) return GITHUB_RELEASES_URL;
  const picked = primaryAssets(release.assets, { os, arch });
  if (picked.length === 1) return picked[0].downloadUrl;
  return picked.length > 1 ? '/download' : '/download#all-downloads';
}
