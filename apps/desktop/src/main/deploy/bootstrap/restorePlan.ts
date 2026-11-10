import { quoteForShell } from '@runova/core';
import { RUNOVA_CORE } from '../coreLayout';

/**
 * The root commands that put a backup in place of a core's state, as data (E15). The restorer
 * runs them one by one; nothing here touches a server. The order is what keeps a restore safe:
 *
 * - The backup is decrypted, unpacked and checked (`admin restore-stage`) in a folder of its own
 *   while the core keeps running. A wrong passphrase, a damaged file, a backup from a newer core,
 *   or a firewall or SSH change on the server still waiting to be kept (its rollback files live in
 *   the state folder the swap replaces) stops there, and nothing has changed.
 * - Only then is the core stopped and the state folder swapped for the staged one with two renames
 *   on the same filesystem. The old state is kept, root only, so going back is two renames too.
 */

export const DATA_DIRECTORY = RUNOVA_CORE.dataDirectory;
export const RESTORE_ROOT = `${DATA_DIRECTORY}-restore`;
export const PREVIOUS = `${RESTORE_ROOT}/previous`;

/** The folders a restore works in, beside the core's state folder. */
const paths = {
  data: DATA_DIRECTORY,
  root: RESTORE_ROOT,
  stage: `${RESTORE_ROOT}/stage`,
  backup: `${RESTORE_ROOT}/backup.rnbackup`,
  previous: PREVIOUS,
  failed: `${RESTORE_ROOT}/failed`,
};

const { binaryPath, unit } = RUNOVA_CORE;

/** The stage command's exit code when the backup was refused (wrong passphrase, damaged, newer). */
export const STAGE_REFUSED_EXIT = 1;

export type RestoreStepId = 'stage' | 'stop' | 'swap' | 'start' | 'rollback' | 'cleanup';

export interface RestoreStep {
  id: RestoreStepId;
  title: string;
  command: string;
}

const q = (value: string): string => quoteForShell(value, 'posix');

/** The staging upload has to be a file in a folder the installer made for it. */
const STAGING_FILE = /^\/[A-Za-z0-9._/-]+\/[A-Za-z0-9._-]+$/;

/** Copies the upload where only root can reach it, then decrypts and checks it. The passphrase goes on stdin. */
export function stageStep(stagingFile: string): RestoreStep {
  if (!STAGING_FILE.test(stagingFile) || stagingFile.split('/').includes('..')) {
    throw new Error('The uploaded backup is not where the restore put it.');
  }
  return {
    id: 'stage',
    title: 'Decrypt and check the backup',
    command: [
      `install -d -m 0700 -o root -g root ${paths.root}`,
      `rm -rf ${paths.stage} ${paths.stage}.payload ${paths.backup}`,
      `install -m 0600 -o root -g root -- ${q(stagingFile)} ${paths.backup}`,
      `${binaryPath} admin restore-stage --file ${paths.backup} --into ${paths.stage} --passphrase-stdin`,
    ].join(' && '),
  };
}

/** Stop, swap the folders, start: once these begin, the core may no longer run its old state. */
export function swapSteps(): RestoreStep[] {
  return [
    {
      id: 'stop',
      title: 'Stop the server core',
      command: `systemctl stop ${unit}`,
    },
    {
      id: 'swap',
      title: "Put the backup in place of the core's state",
      command: [
        `rm -rf ${paths.previous}`,
        `mv -T ${paths.data} ${paths.previous}`,
        `mv -T ${paths.stage} ${paths.data}`,
        `chmod 0700 ${paths.data}`,
      ].join(' && '),
    },
    {
      id: 'start',
      title: 'Start the server core on the restored state',
      // Type=notify: start only returns once the core listens, and fails for one that cannot.
      command: `systemctl start ${unit}`,
    },
  ];
}

/** Back to the state from before the restore, keeping the restored one aside for a look. */
export function restoreRollbackStep(): RestoreStep {
  return {
    id: 'rollback',
    title: 'Go back to the state from before',
    command: [
      `systemctl stop ${unit}`,
      `test -d ${paths.previous}`,
      `rm -rf ${paths.failed}`,
      `{ ! test -e ${paths.data} || mv -T ${paths.data} ${paths.failed}; }`,
      `mv -T ${paths.previous} ${paths.data}`,
      `systemctl start ${unit}`,
    ].join(' && '),
  };
}

export function restoreCleanupStep(): RestoreStep {
  return {
    id: 'cleanup',
    title: 'Remove the uploaded backup',
    command: `rm -rf ${paths.backup} ${paths.stage} ${paths.stage}.payload`,
  };
}
