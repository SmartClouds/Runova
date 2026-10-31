import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerPortMapping } from '@runova/core';
import { engineFromImage } from '@runova/core';

/**
 * This computer's Docker, read for database containers. The environment comes along because
 * it is the user's own machine: `docker inspect` already shows it to anyone who can run docker.
 */

export interface LocalContainer {
  id: string;
  name: string;
  image: string;
  running: boolean;
  project: string | null;
  env: Record<string, string>;
  ports: ContainerPortMapping[];
  networks: { name: string; ip: string | null }[];
}

export interface LocalHelper {
  port: number;
  stop: () => Promise<void>;
}

export interface LocalDocker {
  listDatabases: () => Promise<LocalContainer[]>;
  inspect: (idOrName: string) => Promise<LocalContainer>;
  /**
   * A short-lived socat container on the database's network, publishing its port on 127.0.0.1.
   * For a container with no published port on Docker Desktop, where container addresses cannot
   * be reached from this computer.
   */
  startHelper: (target: { network: string; host: string; port: number }) => Promise<LocalHelper>;
}

export type DockerRunner = (args: string[]) => Promise<string>;

const HELPER_IMAGE = 'alpine/socat:1.8.0.3';
/** Docker names: letters, digits, and . _ - inside. Nothing that docker or socat reads as an option. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

interface RawInspect {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Env?: string[] | null; Labels?: Record<string, string> | null };
  State?: { Running?: boolean };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
    Networks?: Record<string, { IPAddress?: string }> | null;
  };
}

export function parseInspect(output: string): LocalContainer[] {
  const list = JSON.parse(output) as RawInspect[];
  return list.map((raw) => {
    const env: Record<string, string> = {};
    for (const line of raw.Config?.Env ?? []) {
      const equals = line.indexOf('=');
      if (equals > 0) env[line.slice(0, equals)] = line.slice(equals + 1);
    }
    const ports: ContainerPortMapping[] = [];
    for (const [key, bindings] of Object.entries(raw.NetworkSettings?.Ports ?? {})) {
      const [portText, protocol] = key.split('/');
      if (protocol !== 'tcp') continue;
      const hostPort = Number(bindings?.[0]?.HostPort);
      ports.push({
        containerPort: Number(portText),
        hostPort: Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null,
      });
    }
    return {
      id: raw.Id ?? '',
      name: (raw.Name ?? '').replace(/^\//, ''),
      image: raw.Config?.Image ?? '',
      running: raw.State?.Running === true,
      project: raw.Config?.Labels?.['com.docker.compose.project'] ?? null,
      env,
      ports,
      networks: Object.entries(raw.NetworkSettings?.Networks ?? {}).map(([name, network]) => ({
        name,
        ip: network.IPAddress || null,
      })),
    };
  });
}

const execFileAsync = promisify(execFile);

export const runDocker: DockerRunner = async (args) => {
  const { stdout } = await execFileAsync('docker', args, {
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 ** 2,
  });
  return stdout;
};

export function createLocalDocker(run: DockerRunner = runDocker): LocalDocker {
  return {
    async listDatabases() {
      const ids = (await run(['ps', '-a', '-q', '--no-trunc'])).split(/\s+/).filter(Boolean);
      if (ids.length === 0) return [];
      return parseInspect(await run(['inspect', ...ids])).filter(
        (container) => engineFromImage(container.image) !== null,
      );
    },

    async inspect(idOrName) {
      if (!SAFE_NAME.test(idOrName)) throw new Error('That is not a container name.');
      const [found] = parseInspect(await run(['inspect', '--type', 'container', idOrName]));
      if (!found) throw new Error(`There is no container ${idOrName} in Docker on this computer.`);
      return found;
    },

    async startHelper(target) {
      if (!SAFE_NAME.test(target.network) || !SAFE_NAME.test(target.host)) {
        throw new Error('That is not a container network or name.');
      }
      if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
        throw new Error('That is not a port.');
      }
      const id = (
        await run([
          'run',
          '-d',
          '--rm',
          '--label',
          'runova.databaseHelper=1',
          '--network',
          target.network,
          '-p',
          `127.0.0.1::${target.port}`,
          HELPER_IMAGE,
          `TCP-LISTEN:${target.port},fork,reuseaddr`,
          `TCP:${target.host}:${target.port}`,
        ])
      ).trim();
      const mapping = await run(['port', id, `${target.port}/tcp`]);
      const port = Number(/:(\d+)\s*$/m.exec(mapping.split('\n')[0] ?? '')?.[1]);
      if (!Number.isInteger(port) || port <= 0) {
        await run(['rm', '-f', id]).catch(() => undefined);
        throw new Error('The helper container did not publish a port.');
      }
      return {
        port,
        stop: async () => {
          await run(['rm', '-f', id]).catch(() => undefined);
        },
      };
    },
  };
}
