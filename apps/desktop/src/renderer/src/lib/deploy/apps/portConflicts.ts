import type { ComposePortBinding } from '@runova/core';
import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Host ports an app would publish that a container already on the server holds. Docker refuses
 * to start a service whose port is taken ("port is already allocated"), so the wizard points
 * these out before the deploy rather than letting it fail halfway.
 */

export interface PortHolder {
  containerId: string;
  containerName: string;
  /** The compose project (app) the container belongs to, or null when it stands alone. */
  project: string | null;
}

export interface PortConflict {
  service: string;
  /** Position of the entry in the service's `ports:` list. */
  index: number;
  target: number;
  port: number;
  protocol: string;
  holders: PortHolder[];
}

function isWildcard(host: string | null | undefined): boolean {
  return host == null || host === '' || host === '0.0.0.0' || host === '::';
}

/** Whether two host addresses would fight over the same port. */
function overlaps(a: string | null | undefined, b: string | null | undefined): boolean {
  if (isWildcard(a) || isWildcard(b)) return true;
  return a === b;
}

/** The single host port a binding asks for, or null when Docker picks one (none or a range). */
function fixedPort(published: string | null): number | null {
  if (published === null || !/^\d+$/.test(published)) return null;
  const port = Number(published);
  return port > 0 ? port : null;
}

export function findPortConflicts(
  bindings: readonly ComposePortBinding[],
  containers: readonly ContainerSummary[],
  /** The app's own compose project: its containers are replaced by the deploy, so they never clash. */
  ownProject: string,
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
          containerId: container.id,
          containerName: container.name,
          project: container.composeProject ?? null,
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

/** "shop-web-1 (app shop)" or just the name for a container outside any app. */
export function describeHolder(holder: PortHolder): string {
  return holder.project ? `${holder.containerName} (app ${holder.project})` : holder.containerName;
}
