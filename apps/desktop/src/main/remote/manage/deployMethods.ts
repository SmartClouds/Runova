import type {
  ManageDeployLogLine,
  ManageDeployOverview,
  ManageDeployServer,
} from '@runova/protocol';
import { buildProblems } from '../../../shared/deploy/problems';
import type {
  AlertInfo,
  BackupRunInfo,
  CertificateInfo,
  ContainerList,
  ContainerLogLine,
  ContainerSummary,
  ExposureInventory,
  JobInfo,
  StackInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployConnection, DeployHealth, DeployServer } from '../../../shared/deployTypes';
import { ManageError, type ManageMethods } from './session';

export type PhoneContainerAction = 'start' | 'stop' | 'restart';
export type PhoneStackAction = 'start' | 'stop' | 'restart';

/** What the deploy methods need from the rest of the app. */
export interface ManageDeployDeps {
  servers(): Promise<DeployServer[]>;
  connection(serverId: string): DeployConnection;
  health(serverId: string): Promise<DeployHealth>;
  containers(serverId: string): Promise<ContainerList>;
  stacks(serverId: string): Promise<StackInfo[]>;
  alerts(serverId: string): Promise<AlertInfo[]>;
  certificates(serverId: string): Promise<CertificateInfo[]>;
  exposure(serverId: string): Promise<ExposureInventory | null>;
  backups(serverId: string): Promise<BackupRunInfo[]>;
  containerAction(
    serverId: string,
    containerId: string,
    action: PhoneContainerAction,
  ): Promise<ContainerSummary>;
  logs(serverId: string, containerId: string, tail: number): Promise<ContainerLogLine[]>;
  stackAction(serverId: string, stack: string, action: PhoneStackAction): Promise<JobInfo>;
  redeploy(serverId: string, stack: string, revision: number): Promise<JobInfo>;
  now(): number;
  /** How long one read of a server may take before it counts as unreachable. */
  timeoutMs: number;
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const LOG_TAIL = 200;
const DONE: Record<PhoneContainerAction, string> = {
  start: 'Started.',
  stop: 'Stopped.',
  restart: 'Restarted.',
};

function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

function serverId(params: unknown): string {
  const value = field(params, 'serverId');
  if (typeof value !== 'string' || !SERVER_ID.test(value)) {
    throw new ManageError('bad-params', 'Say which server.');
  }
  return value;
}

function text(params: unknown, name: string, say: string): string {
  const value = field(params, name);
  if (typeof value !== 'string' || value.length === 0) throw new ManageError('bad-params', say);
  return value;
}

function resource(params: unknown, name: string, say: string): string {
  const value = text(params, name, say);
  if (!RESOURCE_ID.test(value)) throw new ManageError('bad-params', say);
  return value;
}

function action<T extends string>(params: unknown, allowed: readonly T[]): T {
  const value = field(params, 'action');
  if (!allowed.includes(value as T)) throw new ManageError('bad-params', 'That is not an action.');
  return value as T;
}

/** The answer, or null if it failed or took too long. One slow part never holds up the rest. */
function settle<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([work.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

async function report(work: () => Promise<unknown>, message: string) {
  try {
    await work();
    return { ok: true, message };
  } catch (error) {
    if (error instanceof ManageError) throw error;
    throw new ManageError('failed', (error as Error).message);
  }
}

async function overview(deps: ManageDeployDeps, id: string): Promise<ManageDeployOverview> {
  const wait = <T>(work: Promise<T>) => settle(work, deps.timeoutMs);
  const [health, list, stacks, alerts, certificates, exposure, backups] = await Promise.all([
    wait(deps.health(id)),
    wait(deps.containers(id)),
    wait(deps.stacks(id)),
    wait(deps.alerts(id)),
    wait(deps.certificates(id)),
    wait(deps.exposure(id)),
    wait(deps.backups(id)),
  ]);
  if (!health && !list && !stacks && !alerts) {
    return {
      reachable: false,
      version: null,
      containers: [],
      stacks: [],
      problems: [],
      lastBackup: null,
    };
  }
  const containers = list?.groups.flatMap((group) => group.containers) ?? [];
  const last = backups?.[0];
  return {
    reachable: true,
    version: health?.version ?? null,
    containers: containers.map(({ id: cid, name, image, state, status, health: condition }) => ({
      id: cid,
      name,
      image,
      state,
      status,
      health: condition ?? null,
    })),
    stacks: (stacks ?? []).map((stack) => ({
      id: stack.id,
      name: stack.name,
      status: stack.status,
      running: stack.runningContainers,
      total: stack.containers,
      canRedeploy: stack.liveRevision !== undefined,
    })),
    problems: buildProblems({
      now: deps.now(),
      containers,
      stacks: stacks ?? [],
      alerts: alerts ?? [],
      certificates: certificates ?? [],
      exposure,
    }).map(({ id: pid, severity, title, detail }) => ({ id: pid, severity, title, detail })),
    lastBackup: last
      ? { state: last.state, planName: last.planName ?? null, error: last.error ?? null }
      : null,
  };
}

/** Deploy for a phone: the common cases, through the desktop's own services and tunnels. */
export function deployMethods(deps: ManageDeployDeps): ManageMethods['calls'] {
  return {
    'deploy.servers': async (): Promise<ManageDeployServer[]> =>
      (await deps.servers()).map((server) => {
        const connection = deps.connection(server.id);
        return {
          id: server.id,
          name: server.nickname,
          host: server.host,
          state: connection.state,
          problem: connection.message ?? null,
        };
      }),
    'deploy.overview': async (params) => overview(deps, serverId(params)),
    'deploy.containerAction': async (params) => {
      const id = serverId(params);
      const container = resource(params, 'containerId', 'Say which container.');
      const chosen = action(params, ['start', 'stop', 'restart'] as const);
      return report(() => deps.containerAction(id, container, chosen), DONE[chosen]);
    },
    'deploy.containerLogs': async (params): Promise<ManageDeployLogLine[]> => {
      const lines = await deps.logs(
        serverId(params),
        resource(params, 'containerId', 'Say which container.'),
        LOG_TAIL,
      );
      return lines.map((line) => ({ text: line.text, error: line.stream === 'stderr' }));
    },
    'deploy.stackAction': async (params) => {
      const id = serverId(params);
      const stack = resource(params, 'stack', 'Say which app.');
      const chosen = action(params, ['start', 'stop', 'restart'] as const);
      return report(() => deps.stackAction(id, stack, chosen), 'Started the job.');
    },
    'deploy.stackRedeploy': async (params) => {
      const id = serverId(params);
      const name = resource(params, 'stack', 'Say which app.');
      const found = (await deps.stacks(id)).find((stack) => stack.id === name);
      if (found?.liveRevision === undefined) {
        throw new ManageError('bad-params', 'That app has nothing deployed to redeploy.');
      }
      const revision = found.liveRevision;
      return report(() => deps.redeploy(id, name, revision), 'Redeploying.');
    },
  };
}
