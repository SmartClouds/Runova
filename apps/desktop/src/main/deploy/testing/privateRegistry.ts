import { execFile, execFileSync } from 'node:child_process';

/**
 * A private registry on a test server (E08): registry:2 with htpasswd, run by the server's own
 * Docker on 127.0.0.1:5000, holding images pushed by a separate pushing user from a throwaway
 * config. The pulling user's token is what a deploy sends and what must never stay behind. Shared
 * by the registries system test and the full-stack e2e run. No vitest import, so Playwright can
 * load it too.
 *
 * The slow steps are async on purpose. A test that holds a hub connection to the core must keep
 * its event loop free: SignalR closes a connection that hears nothing for 30 seconds, and a
 * synchronous `docker exec` that runs longer (a docker load, a grep over the whole disk) starves it.
 */

/** The puller's token is what must never stay behind; the pusher only fills the registry. */
export const REGISTRY_PULLER = 'puller';
export const REGISTRY_TOKEN = 'regtoken-e08-pull-7f3a9c41d2b6';
const PUSHER = 'pusher';
const PUSH_PASSWORD = 'regpush-e08-5b1e8d';
/** bcrypt lines (golang.org/x/crypto/bcrypt, cost 5, as registry:2 reads them) for the two users above. */
const HTPASSWD = [
  'puller:$2a$05$Dd4yy7wbltwZ65/oyLlsm.7t0S.MkFew0/1.JX7X/Q61FfmLfcHxW',
  'pusher:$2a$05$7r5reuzkZNfz3B7eH5GUiOmUgxpa8tU7N0EoyQauYYaP/OPK22Swa',
].join('\n');
export const REGISTRY_HOST = 'localhost:5000';

/** A command in the test server's container; its input (if any) goes through stdin, never argv. */
export function onServer(container: string, command: string, input?: string): string {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-c', command], {
    encoding: 'utf-8',
    timeout: 900_000,
    killSignal: 'SIGKILL',
    stdio: 'pipe',
    ...(input === undefined ? {} : { input }),
  }).trim();
}

/** Runs a command on this machine without blocking the event loop; `input` goes to its stdin. */
function run(
  file: string,
  args: string[],
  options: { input?: string | Buffer; timeout: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: 'buffer',
        timeout: options.timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`${file} ${args.slice(0, 3).join(' ')} failed: ${error.message}\n${stderr}`),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end(options.input);
  });
}

/** `onServer` for a caller whose event loop must keep running, like one holding a hub connection. */
export async function onServerAsync(
  container: string,
  command: string,
  input?: string,
): Promise<string> {
  const output = await run('docker', ['exec', '-i', container, 'sh', '-c', command], {
    input,
    timeout: 900_000,
  });
  return output.toString('utf-8').trim();
}

/**
 * Copies an image from this machine's Docker into the test server's, pulling it here first when
 * needed: one pull per machine instead of one per test server, over a network that can be slow.
 */
export async function loadImage(container: string, image: string): Promise<void> {
  try {
    await run('docker', ['image', 'inspect', image], { timeout: 60_000 });
  } catch {
    await run('docker', ['pull', image], { timeout: 600_000 });
  }
  const archive = await run('docker', ['save', image], { timeout: 300_000 });
  await run('docker', ['exec', '-i', container, 'docker', 'load'], {
    input: archive,
    timeout: 300_000,
  });
}

/**
 * Starts the registry on a test server whose Docker is installed, and pushes `source` (already in
 * the server's Docker) to it as `target` under the pushing user. The pushed tag is removed again,
 * so the pull a deploy makes really comes from the registry.
 */
export async function startPrivateRegistry(
  container: string,
  source: string,
  target: string,
): Promise<void> {
  await loadImage(container, 'registry:2');
  await onServerAsync(
    container,
    'mkdir -p /srv/registry-auth && cat > /srv/registry-auth/htpasswd',
    `${HTPASSWD}\n`,
  );
  await onServerAsync(
    container,
    'docker run -d --name registry --restart unless-stopped -p 127.0.0.1:5000:5000 -v /srv/registry-auth:/auth -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=e2e -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd registry:2',
  );
  await onServerAsync(
    container,
    'for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:5000/v2/ && break; sleep 1; done',
  );
  await onServerAsync(
    container,
    `export DOCKER_CONFIG=$(mktemp -d) && docker login ${REGISTRY_HOST} -u ${PUSHER} --password-stdin && docker tag ${source} ${target} && docker push ${target} && rm -rf "$DOCKER_CONFIG" && docker rmi ${target}`,
    PUSH_PASSWORD,
  );
}
