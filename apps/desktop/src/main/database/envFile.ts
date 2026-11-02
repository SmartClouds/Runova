import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MAX_ENV_FILE_BYTES, shQuote } from '@runova/core';

/**
 * Reads a compose project's .env for the sign-ins it holds. Only a file named .env, at an
 * absolute path with no "..", is ever read, so a label on a container cannot point this at
 * anything else on the server or this computer.
 */

/** True for an absolute POSIX path to a file named .env with no ".." in it. */
export function isServerEnvPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    path.endsWith('/.env') &&
    !path.split('/').includes('..') &&
    !/[\0\n\r]/.test(path)
  );
}

/**
 * The shell command that prints a server .env: as the SSH user when it can read the file, else
 * through sudo without a prompt, which fails at once when sudo would ask for a password.
 */
export function serverEnvCommand(path: string): string {
  if (!isServerEnvPath(path)) throw new Error('That is not a .env file Runova reads.');
  const file = shQuote(path);
  return `if [ -r ${file} ]; then cat -- ${file}; else sudo -n cat -- ${file}; fi`;
}

/** This computer's .env, or null when there is none, it is too big, or it is not a .env. */
export async function readLocalEnvFile(path: string): Promise<string | null> {
  const name = path.replace(/\\/g, '/');
  if (!isAbsolute(path) || !name.endsWith('/.env') || name.split('/').includes('..')) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_ENV_FILE_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
