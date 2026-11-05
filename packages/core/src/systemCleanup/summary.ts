import { planKeepNewest, summarizePlan } from './plan.js';
import type { CacheProviderId, ProviderScan } from './types.js';

/**
 * The figures at the top of Disk Cleanup, worked out from what a scan found.
 */

/**
 * What removing every version but the newest `keep` would free from one cache, at most. A cache
 * that was not laid out as expected, that is still being read, or that only its own tool cleans,
 * promises nothing, so a number shown to the person is never a hope.
 */
export function providerReclaimable(provider: ProviderScan, keep: number): number {
  if (provider.kind !== 'versioned' || provider.status !== 'ready') return 0;
  return summarizePlan(planKeepNewest(provider.items, { keep }).remove).freesUpTo;
}

export interface ScanSummary {
  totalBytes: number;
  totalFiles: number;
  /** Packages with more than a name, counted once however many versions are cached. */
  packageCount: number;
  reclaimableBytes: number;
  /** Caches that hold anything at all. */
  cachesFound: number;
  /** Where the space goes, largest first. */
  parts: { id: CacheProviderId; label: string; bytes: number }[];
}

export function summarizeScan(
  providers: readonly ProviderScan[],
  options: { keep: number },
): ScanSummary {
  let totalBytes = 0;
  let totalFiles = 0;
  let reclaimableBytes = 0;
  let cachesFound = 0;
  const packages = new Set<string>();
  const parts: ScanSummary['parts'] = [];

  for (const provider of providers) {
    totalBytes += provider.bytes;
    totalFiles += provider.files;
    reclaimableBytes += providerReclaimable(provider, options.keep);
    if (provider.bytes > 0) {
      cachesFound += 1;
      parts.push({ id: provider.id, label: provider.label, bytes: provider.bytes });
    }
    if (provider.kind === 'versioned' && provider.status === 'ready') {
      for (const item of provider.items) {
        if (item.version !== null) packages.add(`${provider.id}/${item.group}`);
      }
    }
  }

  parts.sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes,
    totalFiles,
    packageCount: packages.size,
    reclaimableBytes,
    cachesFound,
    parts,
  };
}
