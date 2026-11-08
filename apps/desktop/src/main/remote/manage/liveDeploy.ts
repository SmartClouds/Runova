import { liveDeployService } from '../../deploy/liveServices';
import type { ManageDeployDeps } from './deployMethods';

const SERVER_READ_TIMEOUT_MS = 12_000;
const BACKUP_RUNS = 1;
const ALERT_LIMIT = 100;

/** The same service instances the Deploy pages use, so a phone goes through their tunnels. */
export const liveDeploy: ManageDeployDeps = {
  servers: () => liveDeployService('deploy').listServers(),
  connection: (id) => liveDeployService('deploy').connection(id),
  health: (id) => liveDeployService('deploy').health(id),
  containers: (id) => liveDeployService('docker').listContainers(id),
  stacks: (id) => liveDeployService('stacks').list(id),
  alerts: (id) =>
    liveDeployService('system').alerts(id, { includeResolved: false, limit: ALERT_LIMIT }),
  certificates: (id) => liveDeployService('sites').certificates(id),
  exposure: (id) => liveDeployService('firewall').exposure(id),
  backups: (id) => liveDeployService('backups').runs(id, BACKUP_RUNS),
  containerAction: (serverId, containerId, action) =>
    liveDeployService('docker').act({ serverId, containerId, action }),
  logs: (serverId, containerId, tail) =>
    liveDeployService('docker').logTail({ serverId, containerId, tail }),
  stackAction: (id, stack, action) => liveDeployService('stacks').action(id, stack, action),
  redeploy: (id, stack, revision) => liveDeployService('stacks').deploy(id, stack, revision),
  now: Date.now,
  timeoutMs: SERVER_READ_TIMEOUT_MS,
};
