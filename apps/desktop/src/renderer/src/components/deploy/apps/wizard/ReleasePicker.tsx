import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DeployGithubRelease,
  DeployReleaseAsset,
  DeployReleaseAssetPick,
} from '@shared/deployStacksTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Field, Problem } from '@/components/cloudflare/fields';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { ReleaseAccessCard } from './ReleaseAccessCard';

/**
 * Picks the GitHub Release image a deploy loads (E105): the repository (the project's GitHub
 * remote unless another is typed), one of its releases (the newest first) and the image archive
 * attached to it, with the SHA-256 GitHub reports, which the server checks the download against.
 */

export function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function pickOf(
  repository: string,
  release: DeployGithubRelease,
  asset: DeployReleaseAsset,
): DeployReleaseAssetPick | null {
  return asset.sha256
    ? {
        repository,
        tag: release.tag,
        assetId: asset.id,
        assetName: asset.name,
        size: asset.size,
        sha256: asset.sha256,
      }
    : null;
}

/** The newest release with an image GitHub reports a digest for, and that image. */
function newestUsable(
  releases: DeployGithubRelease[],
): { release: DeployGithubRelease; asset: DeployReleaseAsset } | null {
  for (const release of releases.filter((item) => !item.prerelease).concat(releases)) {
    const asset = release.assets.find((item) => item.sha256);
    if (asset) return { release, asset };
  }
  return null;
}

export function ReleasePicker({
  serverId,
  projectId,
  repository,
  value,
  canAdmin,
  onChange,
}: {
  serverId: string;
  projectId: string;
  /** Typed in; '' uses the project's GitHub remote. */
  repository: string;
  value: DeployReleaseAssetPick | null;
  canAdmin: boolean;
  onChange: (next: { releaseRepository?: string; release: DeployReleaseAssetPick | null }) => void;
}): React.JSX.Element {
  const ids = { repository: useId(), release: useId(), asset: useId() };
  const [typed, setTyped] = useState(repository);
  const releases = useQuery({
    queryKey: queryKeys.deployReleases(projectId, repository),
    queryFn: () =>
      window.runova.deployStacks.releases({
        projectId,
        ...(repository ? { repository } : {}),
      }),
    enabled: projectId !== '',
    retry: false,
  });
  const list = releases.data;
  const found = list?.repository ?? '';
  const pickedRelease = list?.releases.find((item) => item.tag === value?.tag) ?? null;

  // The newest usable image is picked until the user picks another.
  useEffect(() => {
    if (!list || (value && value.repository === list.repository)) return;
    const newest = newestUsable(list.releases);
    const next = newest ? pickOf(list.repository, newest.release, newest.asset) : null;
    if (next === null && value === null) return;
    onChange({ release: next });
  }, [list, value, onChange]);

  const asset = pickedRelease?.assets.find((item) => item.id === value?.assetId) ?? null;

  return (
    <div className="space-y-4">
      <Field
        label="Repository"
        htmlFor={ids.repository}
        hint={
          repository
            ? 'The releases of this repository.'
            : "The project's GitHub remote. Type another as owner/name to use its releases."
        }
      >
        <Input
          id={ids.repository}
          value={typed}
          placeholder={found || 'owner/name'}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => {
            const next = typed.trim();
            if (next !== repository) onChange({ releaseRepository: next, release: null });
          }}
          className="font-mono"
          spellCheck={false}
        />
      </Field>

      {releases.isPending && projectId !== '' && (
        <Skeleton className="h-9 w-full rounded-full" aria-busy="true" />
      )}
      {releases.isError && (
        <Problem
          message={`The releases did not load: ${coreErrorMessage(releases.error)}`}
          onRetry={() => void releases.refetch()}
        />
      )}
      {list && list.releases.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {list.repository} has no published releases yet. Have the CD pipeline attach the image to
          a release (docker save, then upload the archive).
        </p>
      )}
      {list && list.releases.length > 0 && (
        <>
          <Field label="Release" htmlFor={ids.release}>
            <Combobox
              id={ids.release}
              options={list.releases.map((item) => ({
                value: item.tag,
                label:
                  item.name && item.name !== item.tag ? `${item.tag} (${item.name})` : item.tag,
                hint: item.prerelease
                  ? 'pre-release'
                  : item.assets.length === 0
                    ? 'no image'
                    : undefined,
              }))}
              value={value?.tag ?? ''}
              placeholder="Pick a release"
              searchPlaceholder="Search releases…"
              emptyText="No release matches."
              onChange={(tag) => {
                const release = list.releases.find((item) => item.tag === tag);
                const first = release?.assets.find((item) => item.sha256);
                onChange({
                  release: release && first ? pickOf(list.repository, release, first) : null,
                });
              }}
            />
          </Field>
          {pickedRelease && pickedRelease.assets.length === 0 && (
            <p role="status" className="text-sm text-warning">
              {pickedRelease.tag} has no image archive (.tar, .tar.gz or .tgz) attached.
            </p>
          )}
          {pickedRelease && pickedRelease.assets.length > 0 && (
            <Field label="Image" htmlFor={ids.asset}>
              <Combobox
                id={ids.asset}
                searchable={false}
                options={pickedRelease.assets.map((item) => ({
                  value: String(item.id),
                  label: item.name,
                  hint: item.sha256 ? describeSize(item.size) : 'no SHA-256 from GitHub',
                }))}
                value={asset ? String(asset.id) : ''}
                placeholder="Pick the image"
                onChange={(id) => {
                  const picked = pickedRelease.assets.find((item) => String(item.id) === id);
                  onChange({
                    release: picked ? pickOf(list.repository, pickedRelease, picked) : null,
                  });
                }}
              />
            </Field>
          )}
          {value && (
            <p className="text-xs text-muted-foreground">
              The server downloads {value.assetName} ({describeSize(value.size)}) from GitHub itself
              and loads it only if its SHA-256 is{' '}
              <span className="font-mono text-foreground" title={value.sha256}>
                {value.sha256.slice(0, 12)}…
              </span>{' '}
              as GitHub reports.
            </p>
          )}
          {!value && pickedRelease && pickedRelease.assets.length > 0 && (
            <p role="status" className="text-sm text-warning">
              GitHub reports no SHA-256 for this image (assets uploaded before June 2025 have none),
              so the server cannot check it. Upload it to the release again.
            </p>
          )}
          <ReleaseAccessCard serverId={serverId} repository={list.repository} canAdmin={canAdmin} />
        </>
      )}
    </div>
  );
}
