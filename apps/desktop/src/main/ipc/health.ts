import { randomUUID } from 'node:crypto';
import {
  buildHealthFixPrompt,
  buildHealthSetupPrompt,
  buildHealthSpecMarkdown,
  HEALTH_DEFAULT_PATH,
  HEALTH_ENV,
  type HealthAuthMode,
} from '@runova/core';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { z } from 'zod';
import type {
  HealthCloudEnableInput,
  HealthCloudPlan,
  HealthCloudSettingsPatch,
  HealthCreateResult,
  HealthSecretReveal,
  HealthSetupPrompt,
  HealthTargetDetail,
  HealthTargetInput,
  HealthTargetSummary,
} from '../../shared/healthTypes';
import { IPC } from '../../shared/ipcChannels';
import type { CloudDefinitionPatch, CloudMonitors } from '../health/cloud';
import { getCloudMonitors } from '../health/cloudLive';
import { healthDiagnoser } from '../health/diagnose';
import { getHealthScheduler } from '../health/scheduler';
import {
  broadcastHealthChanged,
  cleanHealthTargetInput,
  type HealthResultRecord,
  healthSealedKeys,
  mutateHealth,
  readHealthState,
  type StoredHealthTarget,
} from '../health/store';
import { toHealthDetail, toHealthSummary } from '../health/summary';
import { generateHealthPassword, generateHealthToken, sha256Hex } from '../health/token';
import { encryptSecret, isLockedEnvelope, registerSealedSecretStore } from '../ssh/vault';
import { store } from '../store';

/**
 * The Health page's channels (E22). Every argument is checked here before anything reads it. A
 * target's key or password is generated here, sealed with the Servers vault at once, and shown
 * exactly once, by create and by rotate; every other answer only says whether there is one.
 */

const id = z.string().min(1).max(128);

const inputSchema = z.object({
  projectId: id,
  environmentId: id.nullable(),
  name: z.string().max(500),
  serverLabel: z.string().max(500).nullable(),
  serverLink: z.object({ kind: z.enum(['ssh', 'wordpress']), id }).nullable(),
  appLink: z.object({ serverId: id, stackId: id }).nullable().optional(),
  url: z.string().max(4096),
  intervalSec: z.number(),
  timeoutSec: z.number(),
  authMode: z.enum(['bearer', 'basic']),
  basicUser: z.string().max(500).nullable(),
  allowInsecure: z.boolean(),
  autoDiagnose: z.boolean(),
  showVersion: z.boolean().optional(),
});

const patchSchema = inputSchema.partial();
const cloudEnableSchema = z.object({
  consent: z.boolean(),
  intervalSec: z.number().int().min(30).max(86_400),
  notifyInApp: z.boolean(),
  notifyTelegram: z.boolean(),
});
const cloudSettingsSchema = z
  .object({ notifyInApp: z.boolean(), notifyTelegram: z.boolean(), muted: z.boolean() })
  .partial();
const cloudPlanSchema = z.union([
  id,
  z.object({
    projectId: id,
    url: z.string().max(4096).optional(),
    allowInsecure: z.boolean().optional(),
    runMode: z.enum(['local', 'cloud']).optional(),
  }),
]);
const filterSchema = z.object({ projectId: id.optional() }).optional();

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join('.');
  throw new Error(`That healthcheck ${what} is not valid${field ? ` (${field})` : ''}.`);
}

const targetId = (value: unknown) => parse(id, value, 'id');

function inputOf(target: StoredHealthTarget): HealthTargetInput {
  return {
    projectId: target.projectId,
    environmentId: target.environmentId,
    name: target.name,
    serverLabel: target.serverLabel,
    serverLink: target.serverLink,
    appLink: target.appLink ?? null,
    url: target.url,
    intervalSec: target.intervalSec,
    timeoutSec: target.timeoutSec,
    authMode: target.authMode,
    basicUser: target.basicUser,
    allowInsecure: target.allowInsecure,
    autoDiagnose: target.autoDiagnose,
    showVersion: target.showVersion,
  };
}

/**
 * The online monitors (E56). They are made, with their refresh timer, only once a cloud channel is
 * used or a target runs online; a computer with local checks alone never pays for them. The module
 * is imported normally: the app loads it at start anyway, through the account runtime.
 */
async function cloudMonitors(): Promise<CloudMonitors> {
  return getCloudMonitors();
}

/** The online monitors for a target that runs on Runova Cloud; a local one has nothing there. */
async function onlineFor(target: StoredHealthTarget): Promise<CloudMonitors | null> {
  return target.runMode === 'cloud' ? cloudMonitors() : null;
}

async function context(target: StoredHealthTarget) {
  const cloud = await onlineFor(target);
  const info = cloud?.info(target) ?? null;
  return {
    now: Date.now(),
    locked: isLockedEnvelope(target.secretEnvelope ?? undefined),
    cloud: cloud && info ? { info, paused: cloud.paused(target) } : null,
  };
}

async function summary(target: StoredHealthTarget, result: HealthResultRecord | undefined) {
  return toHealthSummary(target, result, await context(target));
}

/** For a monitor on Runova Cloud the server's results stand in for this computer's (E56). */
async function resultOf(
  target: StoredHealthTarget,
  local: HealthResultRecord | undefined,
): Promise<HealthResultRecord | undefined> {
  const cloud = await onlineFor(target);
  return cloud ? cloud.result(target, true) : local;
}

/** What the server keeps of a change made in the dialog. */
async function cloudPatchOf(
  before: StoredHealthTarget,
  after: HealthTargetInput,
): Promise<CloudDefinitionPatch> {
  const patch: CloudDefinitionPatch = {};
  if (after.name !== before.name) patch.name = after.name;
  if (after.url !== before.url) patch.url = after.url;
  if (after.intervalSec !== before.intervalSec) patch.intervalSec = after.intervalSec;
  if (after.timeoutSec !== before.timeoutSec) patch.timeoutSec = after.timeoutSec;
  if (after.allowInsecure !== before.allowInsecure) patch.allowInsecure = after.allowInsecure;
  if (after.environmentId !== before.environmentId) {
    patch.environmentName = await environmentName({
      ...before,
      environmentId: after.environmentId,
    });
  }
  if (after.projectId !== before.projectId) {
    patch.projectName = await projectName({ ...before, projectId: after.projectId });
  }
  return patch;
}

function findTarget(targets: StoredHealthTarget[], targetId: string): StoredHealthTarget {
  const target = targets.find((one) => one.id === targetId);
  if (!target) throw new Error('That healthcheck no longer exists.');
  return target;
}

async function detail(targetId: string): Promise<HealthTargetDetail | null> {
  const { targets, results } = await readHealthState();
  const target = targets.find((one) => one.id === targetId);
  if (!target) return null;
  const result = await resultOf(target, results[target.id]);
  return toHealthDetail(target, result, await context(target));
}

function newSecret(authMode: HealthAuthMode): string {
  return authMode === 'basic' ? generateHealthPassword() : generateHealthToken();
}

function reveal(target: StoredHealthTarget, secret: string): HealthSecretReveal {
  return {
    targetId: target.id,
    authMode: target.authMode,
    secret,
    sha256: sha256Hex(secret),
    basicUser: target.basicUser,
    hashEnvVar: target.authMode === 'basic' ? HEALTH_ENV.passwordHash : HEALTH_ENV.tokenHash,
  };
}

async function environmentName(target: StoredHealthTarget): Promise<string | null> {
  if (!target.environmentId) return null;
  const environments = await store.getProjectEnvironments();
  return environments.find((one) => one.id === target.environmentId)?.name ?? null;
}

async function projectName(target: StoredHealthTarget): Promise<string> {
  const project = (await store.getProjects()).find((one) => one.id === target.projectId);
  if (!project) throw new Error('That project no longer exists.');
  return project.name;
}

export interface HealthHandlerOptions {
  /** True for the windows that may use these channels (the main window, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
}

/** What the Health page lists, with cloud monitors' results in place of this computer's. */
export async function listHealthSummaries(projectId?: string): Promise<HealthTargetSummary[]> {
  const { targets, results } = await readHealthState();
  const shown = targets.filter(
    (target) => projectId === undefined || target.projectId === projectId,
  );
  return Promise.all(
    shown.map(async (target) => summary(target, await resultOf(target, results[target.id]))),
  );
}

export async function setHealthPaused(
  idValue: string,
  paused: boolean,
): Promise<HealthTargetSummary> {
  const updated = await mutateHealth(async (state) => {
    const target = findTarget(state.targets, idValue);
    // Resuming an online monitor has to fit the account type; the server says when it does not.
    await (await onlineFor(target))?.push(target, { paused });
    target.paused = paused;
    target.updatedAt = Date.now();
    const result = state.results[target.id];
    if (!paused && result) result.nextCheckAt = null;
    return target;
  });
  broadcastHealthChanged([idValue]);
  return summary(updated, await resultOf(updated, (await readHealthState()).results[idValue]));
}

export async function checkHealthNow(idValue: string): Promise<HealthTargetDetail> {
  const current = findTarget((await readHealthState()).targets, idValue);
  // Runova Cloud checks it on its own schedule: "check now" reads what it found.
  const cloud = await onlineFor(current);
  if (cloud) await cloud.reload(current);
  else await getHealthScheduler().checkNow(idValue);
  const found = await detail(idValue);
  if (!found) throw new Error('That healthcheck no longer exists.');
  return found;
}

export function registerHealthHandlers(options: HealthHandlerOptions = {}): void {
  registerSealedSecretStore(healthSealedKeys);

  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (options.guard && !options.guard(event)) {
        throw new Error('Healthchecks answer only the main window.');
      }
      return listener(...args);
    });
  };

  handle(
    IPC.health.list,
    (filter): Promise<HealthTargetSummary[]> =>
      listHealthSummaries(parse(filterSchema, filter, 'filter')?.projectId),
  );

  handle(IPC.health.get, (value) => detail(targetId(value)));

  handle(IPC.health.create, async (value): Promise<HealthCreateResult> => {
    const input = await cleanHealthTargetInput(parse(inputSchema, value, 'setup'));
    const secret = newSecret(input.authMode);
    const now = Date.now();
    const target: StoredHealthTarget = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      paused: false,
      secretEnvelope: await encryptSecret(secret),
      secretRotatedAt: null,
    };
    await mutateHealth((state) => {
      state.targets.push(target);
    });
    broadcastHealthChanged([target.id]);
    return { target: await summary(target, undefined), secret: reveal(target, secret) };
  });

  handle(IPC.health.update, async (value, patchValue): Promise<HealthTargetSummary> => {
    const idValue = targetId(value);
    const patch = parse(patchSchema, patchValue, 'change');
    const updated = await mutateHealth(async (state) => {
      const target = findTarget(state.targets, idValue);
      const cleaned = await cleanHealthTargetInput({ ...inputOf(target), ...patch });
      // The server's copy first: when it refuses the change (an interval the type does not allow),
      // nothing changes here either.
      await (await onlineFor(target))?.push(target, await cloudPatchOf(target, cleaned));
      Object.assign(target, cleaned);
      target.updatedAt = Date.now();
      // New settings are worth seeing at once rather than at the end of the old interval.
      const result = state.results[target.id];
      if (result) result.nextCheckAt = null;
      return summary(target, result);
    });
    broadcastHealthChanged([idValue]);
    return updated;
  });

  handle(IPC.health.remove, async (value): Promise<void> => {
    const idValue = targetId(value);
    const existing = (await readHealthState()).targets.find((one) => one.id === idValue);
    // Runova Cloud stops checking it too, or it would go on alerting for a monitor nobody sees.
    if (existing) await (await onlineFor(existing))?.remove(existing);
    healthDiagnoser.cancel(idValue);
    await mutateHealth((state) => {
      state.targets = state.targets.filter((target) => target.id !== idValue);
      delete state.results[idValue];
    });
    broadcastHealthChanged([idValue]);
  });

  handle(
    IPC.health.setPaused,
    (value, pausedValue): Promise<HealthTargetSummary> =>
      setHealthPaused(targetId(value), parse(z.boolean(), pausedValue, 'pause switch')),
  );

  handle(
    IPC.health.checkNow,
    (value): Promise<HealthTargetDetail> => checkHealthNow(targetId(value)),
  );

  handle(IPC.health.rotateSecret, async (value): Promise<HealthSecretReveal> => {
    const idValue = targetId(value);
    const current = findTarget((await readHealthState()).targets, idValue);
    const secret = newSecret(current.authMode);
    const envelope = await encryptSecret(secret);
    // The nodes get the new key at once; without it they would be refused once the endpoint has it.
    await (await onlineFor(current))?.rotate(current, secret);
    const rotated = await mutateHealth((state) => {
      const target = findTarget(state.targets, idValue);
      if (target.authMode !== current.authMode) {
        throw new Error('The target changed while the key was made. Try again.');
      }
      target.secretEnvelope = envelope;
      target.secretRotatedAt = Date.now();
      target.updatedAt = target.secretRotatedAt;
      return target;
    });
    broadcastHealthChanged([idValue]);
    return reveal(rotated, secret);
  });

  handle(IPC.health.setupPrompt, async (value): Promise<HealthSetupPrompt> => {
    const target = findTarget((await readHealthState()).targets, targetId(value));
    let path = HEALTH_DEFAULT_PATH;
    try {
      const pathname = new URL(target.url).pathname;
      if (pathname && pathname !== '/') path = pathname;
    } catch {
      // The URL was checked when it was saved; the default path is a fine fallback.
    }
    return {
      prompt: buildHealthSetupPrompt({
        projectName: await projectName(target),
        environmentName: await environmentName(target),
        serverLabel: target.serverLabel,
        path,
        authMode: target.authMode,
      }),
      spec: buildHealthSpecMarkdown(),
    };
  });

  handle(IPC.health.spec, () => buildHealthSpecMarkdown());

  // Runova Cloud (E56): where a monitor runs.
  handle(IPC.health.cloudPlan, async (value): Promise<HealthCloudPlan> => {
    const which = parse(cloudPlanSchema, value, 'monitor');
    const target =
      typeof which === 'string' ? findTarget((await readHealthState()).targets, which) : which;
    return (await cloudMonitors()).plan(target);
  });

  handle(IPC.health.cloudEnable, async (value, inputValue): Promise<HealthTargetSummary> => {
    const idValue = targetId(value);
    const input: HealthCloudEnableInput = parse(cloudEnableSchema, inputValue, 'online setup');
    await (await cloudMonitors()).enable(idValue, input);
    const found = await detail(idValue);
    if (!found) throw new Error('That healthcheck no longer exists.');
    return found.target;
  });

  handle(IPC.health.cloudDisable, async (value): Promise<HealthTargetSummary> => {
    const idValue = targetId(value);
    await (await cloudMonitors()).disable(idValue);
    const found = await detail(idValue);
    if (!found) throw new Error('That healthcheck no longer exists.');
    return found.target;
  });

  handle(IPC.health.cloudSettings, async (value, patchValue): Promise<HealthTargetSummary> => {
    const idValue = targetId(value);
    const patch: HealthCloudSettingsPatch = parse(
      cloudSettingsSchema,
      patchValue,
      'online settings',
    );
    await (await cloudMonitors()).settings(idValue, patch);
    const found = await detail(idValue);
    if (!found) throw new Error('That healthcheck no longer exists.');
    return found.target;
  });

  handle(IPC.health.fixPrompt, async (value): Promise<string | null> => {
    const { targets, results } = await readHealthState();
    const target = findTarget(targets, targetId(value));
    const result = results[target.id];
    if (!result?.report) return null;
    const incident =
      result.incidents.find((one) => one.resolvedAt === null) ?? result.incidents[0] ?? null;
    const diagnosis = incident?.diagnosis?.status === 'done' ? incident.diagnosis.text : null;
    return buildHealthFixPrompt({
      projectName: await projectName(target),
      targetName: target.name,
      environmentName: await environmentName(target),
      serverLabel: target.serverLabel,
      url: target.url,
      report: result.report,
      diagnosis,
    });
  });

  handle(IPC.health.diagnoseNow, (value) => healthDiagnoser.diagnoseNow(targetId(value)));

  handle(IPC.health.cancelDiagnose, (value) => {
    healthDiagnoser.cancel(targetId(value));
  });
}
