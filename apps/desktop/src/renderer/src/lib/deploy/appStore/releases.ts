import {
  type AnyCatalogTemplate,
  type CatalogInstall,
  type CatalogReleaseData,
  catalogReleases,
  catalogTagVersion,
  fillVersionLabel,
  LATEST_RELEASE,
  type PinnedImage,
} from '@runova/core';

/**
 * What the App Store shows of the registries' reading (releases.ts in main): the releases the
 * version picker offers, the label of the newest one for the catalog card, and the release an
 * installed app runs. Without a reading every line is what the app shipped with.
 */

export interface ReleaseOption {
  value: string;
  label: string;
}

/** Latest first (naming its number), then every other release of the line, newest first. */
export function releaseOptions(
  template: AnyCatalogTemplate,
  versionId: string,
  data: CatalogReleaseData | null,
): ReleaseOption[] {
  const releases = catalogReleases(template, versionId, data);
  const [newest, ...rest] = releases;
  if (!newest) return [{ value: LATEST_RELEASE, label: 'Latest' }];
  return [
    { value: LATEST_RELEASE, label: `Latest (${catalogTagVersion(newest.tag)})` },
    ...rest.map((release) => ({ value: release.tag, label: catalogTagVersion(release.tag) })),
  ];
}

/** The newest release's label, such as "Ollama 0.38.2 with Open WebUI 0.12.0". */
export function latestLabel(
  template: AnyCatalogTemplate,
  versionId: string,
  data: CatalogReleaseData | null,
): string {
  const [newest] = catalogReleases(template, versionId, data);
  const bundled = template.versions.find((version) => version.id === versionId);
  return newest?.version.label ?? bundled?.label ?? template.name;
}

/** Whether the registries list a newer release of the line than the one the app shipped with. */
export function newerThanBundled(
  template: AnyCatalogTemplate,
  versionId: string,
  data: CatalogReleaseData | null,
): boolean {
  const [newest] = catalogReleases(template, versionId, data);
  const bundled = template.versions.find((version) => version.id === versionId);
  return newest !== undefined && bundled !== undefined && newest.version !== bundled;
}

/** The label of what an installed app runs now, filled from its own image tags. */
export function installedLabel(install: CatalogInstall): string {
  const { template } = install;
  const pinned = template.versions.find((version) => version.id === install.version);
  if (!pinned) return `${template.name} ${install.version}`;
  if (!pinned.labelPattern) return pinned.label;
  const images: Record<string, PinnedImage> = {};
  for (const [role, pin] of Object.entries(pinned.images)) {
    const running = install.installed.images[role];
    images[role] = running ? { ...pin, tag: running.tag } : pin;
  }
  return fillVersionLabel(pinned.labelPattern, images);
}
