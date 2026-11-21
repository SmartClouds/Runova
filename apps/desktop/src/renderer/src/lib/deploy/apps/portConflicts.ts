import type { ComposePortBinding } from '@runova/core';
import type {
  ContainerSummary,
  ListeningSocketInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Host ports an app would publish that something already on the server holds. Docker refuses
 * to start a service whose port is taken ("port is already allocated"), so the wizard points
 * these out before the deploy rather than letting it fail halfway.
 *
 * Docker's list of published ports catches most of them. The server's listening sockets catch
 * the rest: a container on the host network (it publishes nothing, so only its socket shows, and
 * the core names the container), a container from another Docker engine (its docker-proxy) and
 * any other program.
 */

export type PortHolder =
  | {
      kind: 'container';
      containerId: string;
      containerName: string;
      /** The compose project (app) the container belongs to, or null when it stands alone. */
      project: string | null;
      /** Found through its socket: it listens on the server's own network. */
      hostNetwork?: boolean;
    }
  | {
      kind: 'process';
      /** The program's name, or null when the server could not tell. */
      process: string | null;
      pid: number | null;
    };

export interface PortConflict {
  service: string;
  /** Position of the entry in the service's `ports:` list. */
  index: number;
  target: number;
  port: number;
  protocol: string;
  holders: PortHolder[];
}

const DOCKER_PROXY = 'docker-proxy';

/** ss writes "*", "[::]", "127.0.0.53%lo" or "[fe80::1]%eth0"; Docker writes "0.0.0.0" or "::". */
function plainAddress(address: string | null | undefined): string | null | undefined {
  if (address == null) return address;
  const bare = address.split('%')[0].replace(/^\[|\]$/g, '');
  return bare === '*' ? null : bare;
}

function isWildcard(host: string | null | undefined): boolean {
  return host == null || host === '' || host === '0.0.0.0' || host === '::';
}

/** Whether two host addresses would fight over the same port. */
function overlaps(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = plainAddress(a);
  const right = plainAddress(b);
  if (isWildcard(left) || isWildcard(right)) return true;
  return left === right;
}

/** The single host port a binding asks for, or null when Docker picks one (none or a range). */
function fixedPort(published: string | null): number | null {
  if (published === null || !/^\d+$/.test(published)) return null;
  const port = Number(published);
  return port > 0 ? port : null;
}

/** The core sends a container's full id; Docker's lists may carry the short one. */
function sameContainer(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

export function findPortConflicts(
  bindings: readonly ComposePortBinding[],
  containers: readonly ContainerSummary[],
  /** The app's own compose project: its containers are replaced by the deploy, so they never clash. */
  ownProject: string,
  /** What listens on the server (ss). Leave it empty unless `containers` is the full list. */
  sockets: readonly ListeningSocketInfo[] = [],
): PortConflict[] {
  const conflicts: PortConflict[] = [];
  for (const binding of bindings) {
    const port = fixedPort(binding.published);
    if (port === null) continue;
    const holders = new Map<string, PortHolder>();
    for (const container of containers) {
      if (container.composeProject === ownProject) continue;
      const clash = container.ports.some(
        (held) =>
          held.hostPort === port &&
          held.protocol.toLowerCase() === binding.protocol &&
          overlaps(held.hostIp, binding.hostIp),
      );
      if (clash && !holders.has(container.id)) {
        holders.set(container.id, {
          kind: 'container',
          containerId: container.id,
          containerName: container.name,
          project: container.composeProject ?? null,
        });
      }
    }

    for (const socket of sockets) {
      if (
        socket.port !== port ||
        socket.protocol.toLowerCase() !== binding.protocol ||
        !overlaps(socket.address, binding.hostIp)
      ) {
        continue;
      }
      if (socket.containerId) {
        const id = socket.containerId;
        const container = containers.find((one) => sameContainer(one.id, id));
        if (container?.composeProject === ownProject) continue;
        const key = container?.id ?? id;
        if (!holders.has(key)) {
          holders.set(key, {
            kind: 'container',
            containerId: key,
            containerName: container?.name ?? id.slice(0, 12),
            project: container?.composeProject ?? null,
            hostNetwork: true,
          });
        }
        continue;
      }
      // Docker's own proxy for a port it publishes: the container is in the list already, or it
      // is this app's own and the deploy replaces it. Only one no listed container explains is
      // news, such as a container from another Docker engine.
      if (
        socket.process === DOCKER_PROXY &&
        containers.some((container) =>
          container.ports.some(
            (held) => held.hostPort === port && held.protocol.toLowerCase() === binding.protocol,
          ),
        )
      ) {
        continue;
      }
      const key = socket.pid != null ? `pid:${socket.pid}` : `socket:${socket.address}`;
      if (!holders.has(key)) {
        holders.set(key, {
          kind: 'process',
          process: socket.process ?? null,
          pid: socket.pid ?? null,
        });
      }
    }

    if (holders.size > 0) {
      conflicts.push({
        service: binding.service,
        index: binding.index,
        target: binding.target,
        port,
        protocol: binding.protocol,
        holders: [...holders.values()],
      });
    }
  }
  return conflicts;
}

/**
 * "shop-web-1 (app shop)", "agent (host network)", "the program node (pid 4100)", or just the
 * name for a container outside any app.
 */
export function describeHolder(holder: PortHolder): string {
  if (holder.kind === 'process') {
    const pid = holder.pid != null ? ` (pid ${holder.pid})` : '';
    if (holder.process === DOCKER_PROXY) {
      return `docker-proxy${pid}, for a container this server's Docker does not list`;
    }
    return holder.process ? `the program ${holder.process}${pid}` : `a program on the server${pid}`;
  }
  const notes = [
    ...(holder.project ? [`app ${holder.project}`] : []),
    ...(holder.hostNetwork ? ['host network'] : []),
  ];
  return notes.length > 0 ? `${holder.containerName} (${notes.join(', ')})` : holder.containerName;
}
