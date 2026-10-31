// Runs `docker compose` against the stack in apps/website/compose.yaml, for the stack specs.
import { spawnSync } from 'node:child_process';
import { COMPOSE_FILE, OWNER } from './stackConfig.ts';

export interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a compose command to the end; `input` goes to its stdin. Never throws on a non-zero exit. */
export function compose(args: string[], input = ''): Result {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    input,
    encoding: 'utf8',
  });
  if (result.error) throw new Error(`Could not run docker compose: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a command in a running service's container. */
export const exec = (service: string, command: string[], input = '') =>
  compose(['exec', '-T', service, ...command], input);

/** Makes the owner account with the API's admin verb, unless an Admin exists already. */
export function ensureOwner() {
  const made = exec(
    'api',
    [
      'dotnet',
      'Runova.Website.Api.dll',
      'admin',
      'create-owner',
      '--email',
      OWNER.email,
      '--name',
      OWNER.displayName,
    ],
    `${OWNER.password}\n`,
  );
  if (made.status === 0 || made.stderr.includes('An Admin exists already')) return;
  throw new Error(`admin create-owner exited ${made.status}:\n${made.stdout}${made.stderr}`);
}
