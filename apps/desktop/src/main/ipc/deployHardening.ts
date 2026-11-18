import { canonicalSecret, isValidPhrase } from '@runova/protocol';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  DeployBackupInput,
  DeployRestoreInput,
  DeployRestoreProgress,
  DeploySshDecisionInput,
  DeploySshHardeningInput,
} from '../../shared/deployHardeningTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeployBackups } from '../deploy/backups';
import { passphraseProblem } from '../deploy/backups';
import type { DeployHardening } from '../deploy/hardening';
import type { DeployService } from '../deploy/service';
import { readSecret } from '../phrase';
import { type DeployIpcRegistry, object, serverId } from './deploy';

/**
 * The Security center's invoke channels (E15): the checklist, its SSH fixes, backups and
 * restores. Like every Deploy group they answer only the main window's own frame and check each
 * argument here before the core hears of it. A restore names its file by the token the open
 * dialog gave out, so the renderer can never point the main process at a path of its choosing.
 * Passphrases and passwords pass straight through; nothing here keeps them.
 */

export interface DeployHardeningHandlerDeps {
  ipc: DeployIpcRegistry;
  hardening: DeployHardening;
  backups: DeployBackups;
  service: Pick<DeployService, 'restore'>;
  /** Sends a restore's steps to the window that asked. */
  restoreProgress: (
    event: IpcMainInvokeEvent,
    serverId: string,
    progress: DeployRestoreProgress,
  ) => void;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const MAX_SECRET = 1024;

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Say whether to change ${what}.`);
  return value;
}

function sshInput(value: unknown): DeploySshHardeningInput {
  const input = object(value, 'an SSH change');
  const disablePasswordLogin = flag(input.disablePasswordLogin, 'password login');
  const restrictRootLogin = flag(input.restrictRootLogin, 'root login');
  if (!disablePasswordLogin && !restrictRootLogin) {
    throw new Error('Say what to change: password login, root login or both.');
  }
  return { serverId: serverId(input.serverId), disablePasswordLogin, restrictRootLogin };
}

function decisionInput(value: unknown): DeploySshDecisionInput {
  const input = object(value, 'an SSH change');
  if (typeof input.changeId !== 'string' || !GUID.test(input.changeId)) {
    throw new Error('That is not an SSH change.');
  }
  return { serverId: serverId(input.serverId), changeId: input.changeId };
}

/** A new backup passphrase: typed text, or a recovery phrase made for it by id (E107). */
function passphrase(value: unknown, owner: number): string {
  const typed = typeof value === 'string' ? value : null;
  const chosen = typed ?? readSecret(value, owner);
  if (chosen === null) throw new Error('Enter the backup passphrase.');
  const text = canonicalSecret(chosen);
  const problem = isValidPhrase(text) ? null : passphraseProblem(text);
  if (problem) throw new Error(problem);
  return text;
}

function secret(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SECRET ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`Enter the ${what}.`);
  }
  return value;
}

function backupInput(value: unknown, owner: number): DeployBackupInput {
  const input = object(value, 'a backup');
  return { serverId: serverId(input.serverId), passphrase: passphrase(input.passphrase, owner) };
}

function restoreInput(value: unknown): DeployRestoreInput {
  const input = object(value, 'a restore');
  if (typeof input.fileToken !== 'string' || !GUID.test(input.fileToken)) {
    throw new Error('Pick the backup file again.');
  }
  if (typeof input.userName !== 'string' || !USER_NAME.test(input.userName)) {
    throw new Error('A user name has 1 to 64 letters, digits, dots, dashes, underscores or @.');
  }
  return {
    serverId: serverId(input.serverId),
    fileToken: input.fileToken,
    // The core is the judge of an old backup's passphrase; this only keeps it to one line.
    passphrase: canonicalSecret(secret(input.passphrase, 'backup passphrase')),
    sudoPassword:
      input.sudoPassword === null || input.sudoPassword === undefined
        ? null
        : secret(input.sudoPassword, 'sudo password'),
    userName: input.userName,
    password: secret(input.password, 'password'),
  };
}

export function registerDeployHardeningHandlers({
  ipc,
  hardening,
  backups,
  service,
  restoreProgress,
  guard,
}: DeployHardeningHandlerDeps): void {
  const handle = (
    channel: string,
    run: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(event, ...args);
    });
  };

  handle(IPC.deployHardening.checklist, (_event, server) => hardening.checklist(serverId(server)));
  handle(IPC.deployHardening.previewSsh, (_event, input) => hardening.previewSsh(sshInput(input)));
  handle(IPC.deployHardening.applySsh, (_event, input) => hardening.applySsh(sshInput(input)));
  handle(IPC.deployHardening.confirmSsh, (_event, input) =>
    hardening.confirmSsh(decisionInput(input)),
  );
  handle(IPC.deployHardening.revertSsh, (_event, input) =>
    hardening.revertSsh(decisionInput(input)),
  );
  handle(IPC.deployHardening.createBackup, (event, input) =>
    backups.create(backupInput(input, event.sender.id)),
  );
  handle(IPC.deployHardening.pickBackup, () => backups.pick());
  handle(IPC.deployHardening.restore, (event, value) => {
    const { fileToken, ...input } = restoreInput(value);
    const file = backups.resolve(fileToken);
    return service.restore({ ...input, file }, (progress) =>
      restoreProgress(event, input.serverId, progress),
    );
  });
}
