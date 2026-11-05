import { type DevOs, pathFlavour } from '@runova/core';

/**
 * The folders Disk Cleanup must never treat as a cache, be inside of, or sit above: the person's
 * documents and media, the app's own data, the system folders, and any OneDrive folder (what is
 * removed there is removed everywhere it syncs). The rules in core use this list; the names here
 * come from the running system, which is why they are handed in.
 */

export interface ProtectedFolderInput {
  os: DevOs;
  env: NodeJS.ProcessEnv;
  /** `app.getPath`, or null/throwing for a name the system does not know. */
  getPath: (name: string) => string | null;
}

const APP_PATHS = [
  'documents',
  'desktop',
  'downloads',
  'music',
  'pictures',
  'videos',
  'temp',
  'userData',
  'appData',
];

const WINDOWS_VARIABLES = [
  'SystemRoot',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'OneDrive',
  'OneDriveConsumer',
  'OneDriveCommercial',
];

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key]?.trim() || undefined : undefined;
}

export function protectedFolders(input: ProtectedFolderInput): string[] {
  const flavour = pathFlavour(input.os);
  const found: string[] = [];

  const add = (path: string | null | undefined): void => {
    if (path && flavour.isAbsolute(path) && !found.includes(path)) found.push(path);
  };

  for (const name of APP_PATHS) {
    try {
      add(input.getPath(name));
    } catch {
      // The system has no folder by that name here.
    }
  }
  if (input.os === 'win32') {
    for (const name of WINDOWS_VARIABLES) add(readEnv(input.env, name));
  }
  return found;
}
