import { getAccountRuntime } from '../account/live';
import { decryptSecret, isLockedEnvelope } from '../ssh/vault';
import { store } from '../store';
import { type CloudMonitors, createCloudMonitors } from './cloud';
import { broadcastHealthChanged, mutateHealth, readHealthTargets } from './store';

/**
 * The online monitors bound to the real app (E56): the account's API and the project placements
 * it knows, the health store for the run mode, and the Servers vault for the key.
 */

let cloud: CloudMonitors | null = null;

// biome-ignore lint/suspicious/noConsole: the only record of a call to the server that failed
const log = (message: string): void => console.warn(message);

export function getCloudMonitors(): CloudMonitors {
  if (cloud) return cloud;
  const runtime = getAccountRuntime();
  cloud = createCloudMonitors({
    api: (method, path, body, options) => runtime.api(method, path, body, options),
    signedIn: async () => (await runtime.status()).state === 'signed-in',
    placement: async (projectId) => (await runtime.projectPlacements()).get(projectId) ?? null,
    names: async (target) => {
      const [projects, environments] = await Promise.all([
        store.getProjects(),
        store.getProjectEnvironments(),
      ]);
      const project = projects.find((one) => one.id === target.projectId);
      if (!project) throw new Error('That project no longer exists.');
      return {
        projectName: project.name,
        environmentName: environments.find((one) => one.id === target.environmentId)?.name ?? null,
      };
    },
    openSecret: async (target) => {
      if (!target.secretEnvelope || isLockedEnvelope(target.secretEnvelope)) return null;
      return decryptSecret(target.secretEnvelope);
    },
    targets: readHealthTargets,
    setRunMode: (targetId, mode, cloudMonitorId) =>
      mutateHealth((state) => {
        const target = state.targets.find((one) => one.id === targetId);
        if (!target) throw new Error('That healthcheck no longer exists.');
        target.runMode = mode;
        target.cloudMonitorId = cloudMonitorId;
        target.updatedAt = Date.now();
        // This computer's own results stay; they show again when it checks here once more.
        const result = state.results[targetId];
        if (result && mode === 'local') result.nextCheckAt = null;
      }),
    changed: broadcastHealthChanged,
    log,
  });
  const live = cloud;
  // The hub moves a card the moment the server knows; this keeps the cards right without it too.
  setInterval(() => {
    void (async () => {
      if (!(await readHealthTargets()).some((target) => target.runMode === 'cloud')) return;
      await live.refresh();
    })().catch((error: unknown) =>
      log(`[cloud-monitors] reading the online monitors failed: ${String(error)}`),
    );
  }, REFRESH_EVERY_MS).unref();
  return cloud;
}

/** How often the online monitors are read again, in case the hub missed something. */
const REFRESH_EVERY_MS = 60_000;
