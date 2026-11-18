import { formatBytes } from '@runova/protocol';
import type { AnywhereStatus } from './anywhere';

/**
 * Sending files to your other devices and to teammates (E112). These types cross from main to
 * the renderer; the wording helpers are shared so a notification and a screen say the same thing.
 */

export type SendDirection = 'out' | 'in';

export type SendPhase =
  /** Out: finding the other device and opening the link. */
  | 'connecting'
  /** Out: the list is there; the person at the other end has not answered. */
  | 'waiting'
  /** In: the person here has not answered yet. */
  | 'asking'
  | 'transferring'
  /** The link dropped; it comes back and carries on where it stopped. */
  | 'reconnecting'
  | 'done'
  | 'declined'
  | 'expired'
  | 'cancelled'
  | 'failed';

export const FINISHED_PHASES: readonly SendPhase[] = [
  'done',
  'declined',
  'expired',
  'cancelled',
  'failed',
];

export type SendFileStatus = 'queued' | 'active' | 'done' | 'failed' | 'skipped';

export interface SendFileView {
  transferId: string;
  path: string;
  size: number;
  transferred: number;
  status: SendFileStatus;
  error?: string;
  /** Where a received file was saved. */
  savedPath?: string;
}

/** Who is on the other end of a send. */
export interface SendPeerView {
  /** The person: their display name. */
  name: string;
  email: string;
  /** Their computer or phone. */
  deviceName: string;
  platform: string | null;
  kind: 'computer' | 'phone';
  relation: 'own' | 'teammate';
  remoteId: string | null;
}

export interface SendBatchView {
  id: string;
  direction: SendDirection;
  peer: SendPeerView;
  phase: SendPhase;
  /** Why it ended, in a sentence, once declined, expired, cancelled or failed. */
  reason: string | null;
  note: string | null;
  fileCount: number;
  /** The first rows only, so a batch of thousands stays light; `moreFiles` counts the rest. */
  files: SendFileView[];
  moreFiles: number;
  totalBytes: number;
  transferredBytes: number;
  doneFiles: number;
  failedFiles: number;
  bytesPerSecond: number | null;
  secondsLeft: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** When the person has to answer by, while waiting or asking. */
  answerBy: number | null;
  /** Received: the folder the files are saved in. */
  folder: string | null;
  transport: 'direct' | 'relay' | null;
}

/** A device files can be sent to, from the Anywhere directory. */
export interface SendRecipient {
  remoteId: string;
  name: string;
  platform: string;
  kind: 'computer' | 'phone';
  relation: 'own' | 'teammate';
  owner: { userId: number; displayName: string; email: string };
  teams: string[];
  online: boolean;
  /** Why it can not take files right now, or null when it can. */
  unavailable: 'offline' | 'outdated' | 'website-outdated' | null;
}

/** Something picked to send. Main keeps where it is; the screen only has the id. */
export interface StagedItem {
  id: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  fileCount: number;
}

/** A send someone offers this computer, while the person here decides. */
export interface SendOfferView {
  batchId: string;
  peer: SendPeerView;
  note: string | null;
  fileCount: number;
  totalBytes: number;
  /** What is at the top of the list: a file, or a folder with how much is in it. */
  entries: { name: string; kind: 'file' | 'folder'; size: number; fileCount: number }[];
  /** Where the files go unless the person picks another folder. */
  folder: string;
  /** Free space where they go, when the system says. */
  freeBytes: number | null;
  receivedAt: number;
  expiresAt: number;
}

export type ReceiveFrom = 'everyone' | 'own' | 'nobody';

export interface SendSettingsView {
  receiveFrom: ReceiveFrom;
  autoAcceptOwn: boolean;
  /** The folder received files go to. */
  saveFolder: string;
  /** Downloads, for Reset. */
  defaultSaveFolder: string;
}

export interface FileSendState {
  /** Signed in and on the website's hub, so sends can go out and come in. */
  available: boolean;
  status: AnywhereStatus;
  /** The website does not say which devices take files yet: it needs an update. */
  websiteOutdated: boolean;
  recipients: SendRecipient[];
  staged: StagedItem[];
  batches: SendBatchView[];
  offers: SendOfferView[];
  settings: SendSettingsView;
}

export interface SendRequest {
  remoteId: string;
  note?: string;
}

export interface SendAnswer {
  accept: boolean;
  /** Another folder than the usual one, for this send. Main fills it from `chooseFolder`. */
  folder?: string;
  /** From now on take files from my own devices without asking. */
  alwaysAcceptOwn?: boolean;
}

export interface SendSettingsPatch {
  receiveFrom?: ReceiveFrom;
  autoAcceptOwn?: boolean;
  /** Null goes back to Downloads. */
  saveFolder?: string | null;
}

export interface StageResult {
  staged: StagedItem[];
  /** What could not be staged, each with why. */
  problems: string[];
}

/** What the screens can ask of main. No path the screen gives is trusted beyond staging. */
export interface FileSendBridge {
  getState(): Promise<FileSendState>;
  /** Files and folders dropped on a window, by the paths Electron gave for them. */
  stagePaths(paths: string[]): Promise<StageResult>;
  /** Null when the person closed the picker without choosing. */
  pickFiles(): Promise<StageResult | null>;
  pickFolder(): Promise<StageResult | null>;
  unstage(ids: string[] | 'all'): Promise<void>;
  send(request: SendRequest): Promise<{ batchId: string }>;
  cancel(batchId: string): Promise<void>;
  cancelFile(batchId: string, transferId: string): Promise<void>;
  retry(batchId: string): Promise<{ batchId: string }>;
  dismiss(batchId: string): Promise<void>;
  clearFinished(): Promise<void>;
  respond(batchId: string, answer: SendAnswer): Promise<void>;
  /** Another folder for one offer. Null when the person cancelled the picker. */
  chooseFolder(batchId: string): Promise<string | null>;
  chooseSaveFolder(): Promise<string | null>;
  updateSettings(patch: SendSettingsPatch): Promise<void>;
  showInFolder(batchId: string, transferId?: string): Promise<void>;
  openFile(batchId: string, transferId: string): Promise<void>;
  openApp(): Promise<void>;
  onState(callback: (state: FileSendState) => void): () => void;
}

export const EMPTY_FILE_SEND_STATE: FileSendState = {
  available: false,
  status: 'signed-out',
  websiteOutdated: false,
  recipients: [],
  staged: [],
  batches: [],
  offers: [],
  settings: {
    receiveFrom: 'everyone',
    autoAcceptOwn: false,
    saveFolder: '',
    defaultSaveFolder: '',
  },
};

// --- Wording ------------------------------------------------------------------------

export function filesLabel(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'Someone';
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

export function formatTimeLeft(seconds: number): string {
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes - hours * 60} min left`;
}

export function batchTitle(batch: SendBatchView): string {
  return batch.direction === 'out' ? `To ${batch.peer.deviceName}` : `From ${batch.peer.name}`;
}

/** What a batch is doing, in one line. */
export function batchStatus(batch: SendBatchView, now: number): string {
  const verb = batch.direction === 'out' ? 'Sending' : 'Receiving';
  switch (batch.phase) {
    case 'connecting':
      return `Reaching ${batch.peer.deviceName}…`;
    case 'waiting': {
      const left = batch.answerBy ? Math.max(0, Math.ceil((batch.answerBy - now) / 1000)) : null;
      const who = firstName(batch.peer.name);
      return left === null
        ? `Waiting for ${who} to accept`
        : `Waiting for ${who} to accept, ${left} s`;
    }
    case 'asking':
      return 'Waiting for your answer';
    case 'transferring': {
      const current = Math.min(batch.fileCount, batch.doneFiles + batch.failedFiles + 1);
      const parts = [`${verb} ${current} of ${batch.fileCount.toLocaleString('en-US')}`];
      if (batch.bytesPerSecond) parts.push(formatRate(batch.bytesPerSecond));
      if (batch.secondsLeft !== null) parts.push(formatTimeLeft(batch.secondsLeft));
      return parts.join(', ');
    }
    case 'reconnecting':
      return 'Reconnecting, it picks up where it stopped';
    case 'done': {
      const past = batch.direction === 'out' ? 'Sent' : 'Received';
      if (batch.failedFiles > 0) {
        return `${past} ${batch.doneFiles.toLocaleString('en-US')} of ${filesLabel(batch.fileCount)}, ${batch.failedFiles.toLocaleString('en-US')} failed`;
      }
      return `${past} ${filesLabel(batch.doneFiles)}, ${formatBytes(batch.totalBytes)}, verified`;
    }
    default:
      return batch.reason ?? 'It did not go through.';
  }
}

export function sendButtonLabel(fileCount: number, deviceName: string | null): string {
  if (fileCount === 0) return 'Send';
  return deviceName
    ? `Send ${filesLabel(fileCount)} to ${deviceName}`
    : `Send ${filesLabel(fileCount)}`;
}
