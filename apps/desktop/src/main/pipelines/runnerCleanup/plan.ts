import { compareCacheVersions } from '@runova/core';
import type {
  RunnerCleanupGroup,
  RunnerCleanupItem,
  RunnerCleanupRunnerStatus,
} from '../../../shared/apiTypes';
import { cacheEntriesFor, cacheLabel } from './cacheCatalog';
import type { CleanStep, DockerPrune } from './cleanSteps';
import {
  type MachineFacts,
  parseGithubUrl,
  type RunnerFolderFacts,
  type SizeKind,
} from './scanParse';

/**
 * Turns what a scan found on a runner machine into what the window shows (groups of items with a
 * size, a risk and a default pick) and what main keeps (the steps behind each item id). Pure, so
 * every rule about what is offered and what is picked is tested here (E104).
 */

/** The runners GitHub lists per scope key, or null when GitHub could not be asked. */
export type RegisteredRunners = Map<string, { id: number; name: string }[] | null>;

export interface PlannedCleanup {
  groups: RunnerCleanupGroup[];
  steps: Map<string, CleanStep>;
  notes: string[];
}

export const LOG_DAYS = 7;
const BUSY_REASON = 'A job is running on this runner right now';

export function scopeKey(scope: { kind: 'repo' | 'org'; name: string }): string {
  return `${scope.kind}:${scope.name.toLowerCase()}`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function parentName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 2] ?? '';
}

function sizesOf(runner: RunnerFolderFacts, kind: SizeKind) {
  return runner.sizes.filter((size) => size.kind === kind && size.bytes > 0);
}

function sum(values: { bytes: number }[]): number {
  return values.reduce((total, value) => total + value.bytes, 0);
}

function listed(names: string[], max = 4): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

type Standing = { gone: false; status: RunnerCleanupRunnerStatus } | { gone: true; why: string };

function standingOf(
  runner: RunnerFolderFacts,
  facts: MachineFacts,
  registered: RegisteredRunners,
): Standing {
  const busy = runner.busy || facts.busyUnknown;
  if (!runner.registration) {
    if (!runner.hasRunnerFile && runner.configured && !busy) {
      return {
        gone: true,
        why: 'Never registered: an install that was not finished. Removes the whole folder',
      };
    }
    return { gone: false, status: busy ? 'busy' : 'unknown' };
  }
  const scope = parseGithubUrl(runner.registration.url);
  const listed = scope ? registered.get(scopeKey(scope)) : undefined;
  if (busy) return { gone: false, status: 'busy' };
  if (!scope || !listed) return { gone: false, status: 'unknown' };
  const name = runner.registration.name.toLowerCase();
  const match = listed.find((entry) => entry.name.toLowerCase() === name);
  const { agentId } = runner.registration;
  if (!match || (agentId !== null && match.id !== agentId)) {
    const service = runner.service ? ' and its service' : '';
    return {
      gone: true,
      why: `No longer registered on GitHub for ${scope.name}. Removes the whole folder${service}`,
    };
  }
  return { gone: false, status: 'idle' };
}

interface Builder {
  items: RunnerCleanupItem[];
  steps: Map<string, CleanStep>;
}

function add(builder: Builder, item: RunnerCleanupItem, step: Omit<CleanStep, 'id'>): void {
  if (item.bytes <= 0) return;
  builder.items.push(item);
  builder.steps.set(item.id, { id: item.id, ...step });
}

/** Tool cache versions other than the newest of each tool. */
function oldToolVersions(runner: RunnerFolderFacts) {
  const byTool = new Map<string, { bytes: number; path: string }[]>();
  for (const size of sizesOf(runner, 'tool')) {
    const tool = parentName(size.path);
    byTool.set(tool, [...(byTool.get(tool) ?? []), size]);
  }
  const old: { tool: string; version: string; bytes: number; path: string }[] = [];
  for (const [tool, versions] of byTool) {
    const sorted = [...versions].sort((a, b) =>
      compareCacheVersions(baseName(a.path), baseName(b.path)),
    );
    for (const size of sorted.slice(0, -1)) {
      old.push({ tool, version: baseName(size.path), ...size });
    }
  }
  return old;
}

function runnerGroup(
  runner: RunnerFolderFacts,
  index: number,
  status: RunnerCleanupRunnerStatus,
  builder: Builder,
): RunnerCleanupGroup {
  const id = `r${index}`;
  const busy = status === 'busy';
  const work = (item: Omit<RunnerCleanupItem, 'disabledReason'>): RunnerCleanupItem =>
    busy ? { ...item, picked: false, disabledReason: BUSY_REASON } : item;
  const items: Builder = { items: [], steps: builder.steps };

  const temp = sizesOf(runner, 'temp');
  add(
    items,
    work({
      id: `${id}-temp`,
      label: 'Temporary files',
      why: 'What jobs left in _work/_temp. No job needs them again.',
      bytes: sum(temp),
      risk: 'safe',
      picked: true,
    }),
    {
      busyGuard: runner.dir,
      measure: temp.map((size) => size.path),
      actions: temp.map((size) => ({ kind: 'empty', path: size.path })),
    },
  );

  const diag = sizesOf(runner, 'diag');
  add(
    items,
    {
      id: `${id}-logs`,
      label: `Runner logs older than ${LOG_DAYS} days`,
      why: 'Diagnostic logs in _diag, which the runner never removes on its own.',
      bytes: sum(diag),
      risk: 'safe',
      picked: true,
    },
    {
      busyGuard: null,
      measure: diag.map((size) => size.path),
      actions: diag.map((size) => ({ kind: 'oldLogs', path: size.path, days: LOG_DAYS })),
    },
  );

  const versions = sizesOf(runner, 'oldver');
  const versionNames = [
    ...new Set(versions.map((size) => baseName(size.path).replace(/^\w+\./, ''))),
  ];
  add(
    items,
    {
      id: `${id}-versions`,
      label: 'Old runner versions',
      why: `Left behind by a self-update (${listed(versionNames)}). The runner uses the newest.`,
      bytes: sum(versions),
      risk: 'safe',
      picked: true,
    },
    {
      busyGuard: null,
      measure: versions.map((size) => size.path),
      actions: versions.map((size) => ({ kind: 'remove', path: size.path })),
    },
  );

  const update = sizesOf(runner, 'update');
  add(
    items,
    work({
      id: `${id}-update`,
      label: 'Update download',
      why: 'A runner update that was downloaded into _work/_update.',
      bytes: sum(update),
      risk: 'safe',
      picked: true,
    }),
    {
      busyGuard: runner.dir,
      measure: update.map((size) => size.path),
      actions: update.map((size) => ({ kind: 'remove', path: size.path })),
    },
  );

  const checkouts = sizesOf(runner, 'checkout');
  const repos = checkouts.map((size) => baseName(size.path));
  add(
    items,
    work({
      id: `${id}-checkouts`,
      label: `Job checkouts (${repos.length} ${repos.length === 1 ? 'repo' : 'repos'})`,
      why: `Working copies from earlier runs: ${listed(repos)}. The next job on a repo clones it again.`,
      bytes: sum(checkouts),
      risk: 'slows',
      picked: true,
    }),
    {
      busyGuard: runner.dir,
      measure: checkouts.map((size) => size.path),
      actions: checkouts.map((size) => ({ kind: 'remove', path: size.path })),
    },
  );

  const tools = oldToolVersions(runner);
  add(
    items,
    work({
      id: `${id}-tools`,
      label: 'Older tool versions',
      why: `The tool cache keeps the newest of each tool. Goes: ${listed(tools.map((tool) => `${tool.tool} ${tool.version}`))}. A job that asks for one installs it again.`,
      bytes: sum(tools),
      risk: 'slows',
      picked: true,
    }),
    {
      busyGuard: runner.dir,
      measure: tools.map((tool) => tool.path),
      actions: tools.map((tool) => ({ kind: 'remove', path: tool.path })),
    },
  );

  const actions = sizesOf(runner, 'actions');
  add(
    items,
    work({
      id: `${id}-actions`,
      label: 'Downloaded actions',
      why: 'Copies of the actions jobs use. The next job downloads the ones it needs again.',
      bytes: sum(actions),
      risk: 'slows',
      picked: false,
    }),
    {
      busyGuard: runner.dir,
      measure: actions.map((size) => size.path),
      actions: actions.map((size) => ({ kind: 'remove', path: size.path })),
    },
  );

  const scope = runner.registration ? parseGithubUrl(runner.registration.url) : null;
  return {
    id,
    kind: 'runner',
    title: runner.registration?.name ?? baseName(runner.dir),
    subtitle: scope ? `${scope.name} · ${runner.dir}` : runner.dir,
    status,
    items: items.items,
  };
}

const DOCKER_ITEMS: {
  id: string;
  prune: DockerPrune;
  label: string;
  why: string;
  risk: 'safe' | 'slows';
  picked: boolean;
}[] = [
  {
    id: 'docker-containers',
    prune: 'containers',
    label: 'Stopped containers',
    why: 'Containers from finished jobs that were never removed.',
    risk: 'safe',
    picked: true,
  },
  {
    id: 'docker-dangling',
    prune: 'dangling',
    label: 'Dangling images',
    why: 'Untagged image layers left over from rebuilds. Nothing uses them.',
    risk: 'safe',
    picked: true,
  },
  {
    id: 'docker-images',
    prune: 'images',
    label: 'Unused images',
    why: 'Images no container uses. A job that needs one pulls it again.',
    risk: 'slows',
    picked: false,
  },
  {
    id: 'docker-build',
    prune: 'buildCache',
    label: 'Build cache',
    why: 'Layers BuildKit kept to speed up builds. The next build makes them again.',
    risk: 'slows',
    picked: false,
  },
];

function dockerGroup(facts: MachineFacts, builder: Builder): RunnerCleanupGroup | null {
  const { docker } = facts;
  if (docker.state !== 'ok') return null;
  const row = (type: string) =>
    docker.rows.find((entry) => entry.type === type)?.reclaimableBytes ?? 0;
  const sizes: Record<DockerPrune, number> = {
    containers: row('Containers'),
    dangling: docker.danglingBytes,
    images: Math.max(0, row('Images') - docker.danglingBytes),
    buildCache: row('Build Cache'),
  };
  const items: Builder = { items: [], steps: builder.steps };
  for (const entry of DOCKER_ITEMS) {
    add(
      items,
      {
        id: entry.id,
        label: entry.label,
        why: entry.why,
        bytes: sizes[entry.prune],
        risk: entry.risk,
        picked: entry.picked,
      },
      { busyGuard: null, measure: [], actions: [{ kind: 'docker', prune: entry.prune }] },
    );
  }
  if (items.items.length === 0) return null;
  return {
    id: 'docker',
    kind: 'docker',
    title: 'Docker',
    subtitle: docker.viaSudo ? 'Through sudo' : undefined,
    items: items.items,
  };
}

function cachesGroup(facts: MachineFacts, builder: Builder): RunnerCleanupGroup | null {
  const os = facts.os ?? 'linux';
  const catalog = cacheEntriesFor(os);
  const items: Builder = { items: [], steps: builder.steps };
  facts.caches.forEach((cache, index) => {
    const entry = catalog.find((item) => item.id === cache.id);
    const own = cache.home === facts.home;
    const command =
      own && entry?.command && facts.tools.has(entry.command.tool) ? entry.command : null;
    add(
      items,
      {
        id: `cache-${index}`,
        label: own ? cacheLabel(cache.id) : `${cacheLabel(cache.id)} (${cache.home})`,
        why: command
          ? `Downloaded packages. Cleaned with ${[command.tool, ...command.args].join(' ')}; the next job downloads what it needs again.`
          : 'Downloaded packages. The next job downloads what it needs again.',
        bytes: cache.bytes,
        risk: 'slows',
        picked: false,
      },
      {
        busyGuard: null,
        measure: [cache.path],
        actions: [
          command
            ? { kind: 'toolCommand', tool: command.tool, args: command.args, fallback: cache.path }
            : { kind: 'empty', path: cache.path },
        ],
      },
    );
  });
  if (items.items.length === 0) return null;
  return { id: 'caches', kind: 'caches', title: 'Package caches', items: items.items };
}

export function planCleanup(facts: MachineFacts, registered: RegisteredRunners): PlannedCleanup {
  const builder: Builder = { items: [], steps: new Map() };
  const groups: RunnerCleanupGroup[] = [];
  const goneItems: Builder = { items: [], steps: builder.steps };
  const notes: string[] = [];

  facts.runners.forEach((runner, index) => {
    const standing = standingOf(runner, facts, registered);
    if (standing.gone) {
      const total = sizesOf(runner, 'total');
      add(
        goneItems,
        {
          id: `gone-${index}`,
          label: runner.registration?.name ?? baseName(runner.dir),
          why: `${standing.why} at ${runner.dir}.`,
          bytes: sum(total) || sum(runner.sizes),
          risk: 'careful',
          picked: false,
        },
        {
          busyGuard: runner.dir,
          measure: [runner.dir],
          actions: [{ kind: 'removeRunner', path: runner.dir }],
        },
      );
      return;
    }
    groups.push(runnerGroup(runner, index, standing.status, builder));
  });

  const docker = dockerGroup(facts, builder);
  if (docker) groups.push(docker);
  if (facts.docker.state === 'denied') {
    notes.push(
      'Docker is installed but Runova could not use it. The login needs the docker group, or sudo without a password.',
    );
  }
  const caches = cachesGroup(facts, builder);
  if (caches) groups.push(caches);
  if (goneItems.items.length > 0) {
    groups.push({
      id: 'abandoned',
      kind: 'abandoned',
      title: 'Runners that are gone',
      subtitle: 'Folders of runners GitHub no longer has',
      items: goneItems.items,
    });
  }
  return { groups, steps: builder.steps, notes };
}
