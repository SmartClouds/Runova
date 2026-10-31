import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Real database servers for the driver tests, started with this computer's Docker on a random
 * loopback port and removed afterwards. Tests skip when Docker is not there.
 */

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a test can use the image: it is already here, or this is CI, where pulling works. A
 * computer offline from the registry still runs the engines it has images for.
 */
export function imageUsable(image: string): boolean {
  if (process.env.CI) return true;
  try {
    execFileSync('docker', ['image', 'inspect', image], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export interface TestDatabase {
  host: string;
  port: number;
  containerId: string;
  remove: () => void;
}

export function startDatabase(options: {
  image: string;
  port: number;
  env?: Record<string, string>;
  args?: string[];
}): TestDatabase {
  const name = `runova-dbtest-${randomBytes(4).toString('hex')}`;
  const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]);
  const containerId = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      'runova.test=database',
      '-p',
      `127.0.0.1::${options.port}`,
      ...env,
      options.image,
      ...(options.args ?? []),
    ],
    { encoding: 'utf-8', windowsHide: true, timeout: 300_000 },
  ).trim();
  const mapping = execFileSync('docker', ['port', containerId, `${options.port}/tcp`], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  const port = Number(/:(\d+)\s*$/m.exec(mapping.split('\n')[0] ?? '')?.[1]);
  return {
    host: '127.0.0.1',
    port,
    containerId,
    remove: () => {
      try {
        execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore', windowsHide: true });
      } catch {
        // Already gone.
      }
    },
  };
}

/** Tries `attempt` until it stops throwing, for a server that is still starting. */
export async function waitFor<T>(attempt: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last instanceof Error ? last : new Error('The database did not start in time.');
}
