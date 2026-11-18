import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  encodeSendMessage,
  formatBytes,
  isSendMessage,
  parseSendMessage,
  type RemoteControlMessage,
  SEND_LIMITS,
  SEND_PART_BYTES,
  SEND_PING_MS,
  SEND_SILENCE_MS,
  type SendAnswerReason,
  type SendMessage,
} from '@runova/protocol';
import type { RemoteFileProgress } from '../../../shared/apiTypes';
import {
  FINISHED_PHASES,
  firstName,
  type SendBatchView,
  type SendFileStatus,
  type SendFileView,
  type SendOfferView,
  type SendPeerView,
  type SendPhase,
} from '../../../shared/fileSend';
import { FileTransferManager, type OfferDecision } from '../fileTransfer';
import type { PeerSocket } from '../peerSocket';
import { type Manifest, targetFor } from './manifest';
import { RateMeter } from './rate';

/** A secured Anywhere link as a send uses it. `SecureLink` is one. */
export interface SendLink extends PeerSocket {
  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void;
  onClose(listener: (reason: string) => void): void;
  /** Resolves once no more than `threshold` bytes wait to go out. */
  drain(threshold: number): Promise<void>;
}

export type SendOffer = Extract<SendMessage, { t: 'send-offer' }>;

/** Frames wait while more than this is queued on the link. */
const DRAIN_AT = 2 * 1024 * 1024;
/** A part counts as gone, and its ack clock starts, once the queue is down to this. */
const FLUSHED_AT = 256 * 1024;
/** How many files move at the same time in one batch. */
const CONCURRENCY = 4;
/** Rows a view carries, so a batch of thousands of files stays light to send to the screen. */
const VIEW_ROWS = 500;
/** Long enough for the other side's own one-minute question, and the link opening before it. */
const SENDER_ANSWER_MS = 75_000;
const RECEIVER_ANSWER_MS = 60_000;
/** The receiver waits longer for a dropped link than the sender keeps dialing, so it never gives up first. */
const RECEIVER_RECONNECT_MS = 7 * 60_000;

// --- Reading a link -----------------------------------------------------------------

interface InboxHandler {
  send(message: SendMessage): void;
  file(message: RemoteControlMessage): void;
  binary(data: Buffer): void;
}

type Item =
  | { kind: 'send'; message: SendMessage }
  | { kind: 'file'; message: RemoteControlMessage }
  | { kind: 'binary'; data: Buffer };

/** What a link says, kept until a batch takes over, so nothing said early is lost. */
export interface Inbox {
  /** The first `send-offer`, or null when none comes in time or the link closes. */
  firstOffer(timeoutMs: number): Promise<SendOffer | null>;
  /** Hands every later message, and those kept so far, to `handler`. */
  take(handler: InboxHandler): void;
  /** Called for every message heard, for the keepalive. */
  onHeard(listener: () => void): void;
}

export function openInbox(link: SendLink): Inbox {
  const kept: Item[] = [];
  const heard: (() => void)[] = [];
  let handler: InboxHandler | null = null;
  let waiter: ((offer: SendOffer | null) => void) | null = null;

  const dispatch = (to: InboxHandler, item: Item): void => {
    if (item.kind === 'send') to.send(item.message);
    else if (item.kind === 'file') to.file(item.message);
    else to.binary(item.data);
  };

  link.onMessage((data, isBinary) => {
    for (const listener of heard) listener();
    const item = isBinary ? ({ kind: 'binary', data } as const) : read(data.toString('utf8'));
    if (!item) return;
    if (waiter && item.kind === 'send' && item.message.t === 'send-offer') {
      const resolve = waiter;
      waiter = null;
      resolve(item.message);
      return;
    }
    if (handler) dispatch(handler, item);
    else kept.push(item);
  });
  link.onClose(() => {
    const resolve = waiter;
    waiter = null;
    resolve?.(null);
  });

  return {
    firstOffer(timeoutMs) {
      const index = kept.findIndex(
        (item) => item.kind === 'send' && item.message.t === 'send-offer',
      );
      if (index !== -1) {
        const [item] = kept.splice(index, 1);
        return Promise.resolve((item as { message: SendOffer }).message);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (waiter !== settle) return;
          waiter = null;
          resolve(null);
        }, timeoutMs);
        const settle = (offer: SendOffer | null): void => {
          clearTimeout(timer);
          resolve(offer);
        };
        waiter = settle;
      });
    },
    take(next) {
      handler = next;
      for (const item of kept.splice(0)) dispatch(next, item);
    },
    onHeard(listener) {
      heard.push(listener);
    },
  };
}

/** A text message on a send link: the send protocol, or a file transfer message. Anything else is dropped. */
function read(text: string): Item | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (isSendMessage(value)) {
    const message = parseSendMessage(text);
    return message ? { kind: 'send', message } : null;
  }
  const t = (value as { t?: unknown } | null)?.t;
  return typeof t === 'string' && t.startsWith('file-')
    ? { kind: 'file', message: value as RemoteControlMessage }
    : null;
}

/** Pings a quiet link, and calls it dead when nothing has been heard for `silenceMs`. */
class Keepalive {
  private lastHeard: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly link: SendLink,
    private readonly options: { pingMs: number; silenceMs: number; now: () => number },
    private readonly onSilent: () => void,
  ) {
    this.lastHeard = options.now();
    this.timer = setInterval(() => this.tick(), options.pingMs);
  }

  heard(): void {
    this.lastHeard = this.options.now();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.options.now() - this.lastHeard > this.options.silenceMs) {
      this.stop();
      this.onSilent();
      return;
    }
    send(this.link, { t: 'send-ping' });
  }
}

function send(link: PeerSocket, message: SendMessage | RemoteControlMessage): void {
  try {
    link.send(
      'v' in message || (message as { t: string }).t.startsWith('send-')
        ? encodeSendMessage(message as SendMessage)
        : JSON.stringify(message),
    );
  } catch {
    // A link that is going away; its close says the rest.
  }
}

/** Closes a link once what was said on it has gone out. */
function closeSoon(link: SendLink): void {
  void link.drain(0).then(() => setTimeout(() => link.close(), 200));
}

// --- Both sides ---------------------------------------------------------------------

interface FileEntry {
  transferId: string;
  path: string;
  size: number;
  source: string | null;
  status: SendFileStatus;
  transferred: number;
  error?: string;
  savedPath?: string;
}

interface Common {
  peer: SendPeerView;
  changed(): void;
  ended(): void;
  now?: () => number;
  pingMs?: number;
  silenceMs?: number;
}

abstract class Batch {
  protected phase: SendPhase;
  protected reason: string | null = null;
  protected link: SendLink | null = null;
  protected keepalive: Keepalive | null = null;
  protected transport: 'direct' | 'relay' | null = null;
  protected readonly files: FileEntry[];
  protected readonly byId: Map<string, FileEntry>;
  protected readonly meter: RateMeter;
  protected readonly now: () => number;
  protected readonly startedAt: number;
  protected finishedAt: number | null = null;
  protected answerBy: number | null = null;
  protected answerTimer: NodeJS.Timeout | null = null;
  protected folder: string | null = null;

  protected constructor(
    readonly batchId: string,
    protected readonly direction: 'out' | 'in',
    files: FileEntry[],
    protected readonly note: string | null,
    protected readonly common: Common,
    phase: SendPhase,
  ) {
    this.now = common.now ?? Date.now;
    this.meter = new RateMeter(this.now);
    this.startedAt = this.now();
    this.files = files;
    this.byId = new Map(files.map((file) => [file.transferId, file]));
    this.phase = phase;
  }

  get finished(): boolean {
    return FINISHED_PHASES.includes(this.phase);
  }

  view(): SendBatchView {
    const done = this.files.filter((file) => file.status === 'done').length;
    const failed = this.files.filter((file) => file.status === 'failed').length;
    const totalBytes = this.files.reduce((sum, file) => sum + file.size, 0);
    const transferredBytes = this.transferredBytes();
    const moving = this.phase === 'transferring';
    return {
      id: this.batchId,
      direction: this.direction,
      peer: this.common.peer,
      phase: this.phase,
      reason: this.reason,
      note: this.note,
      fileCount: this.files.length,
      files: this.files.slice(0, VIEW_ROWS).map(fileView),
      moreFiles: Math.max(0, this.files.length - VIEW_ROWS),
      totalBytes,
      transferredBytes,
      doneFiles: done,
      failedFiles: failed,
      bytesPerSecond: moving ? this.meter.bytesPerSecond() : null,
      secondsLeft: moving ? this.meter.secondsLeft(totalBytes - transferredBytes) : null,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      answerBy: this.answerBy,
      folder: this.folder,
      transport: this.transport,
    };
  }

  protected transferredBytes(): number {
    return this.files.reduce(
      (sum, file) =>
        sum + (file.status === 'done' ? file.size : Math.min(file.size, file.transferred)),
      0,
    );
  }

  protected watch(link: SendLink, inbox: Inbox, handler: InboxHandler): void {
    this.link = link;
    this.keepalive?.stop();
    const keepalive = new Keepalive(
      link,
      {
        pingMs: this.common.pingMs ?? SEND_PING_MS,
        silenceMs: this.common.silenceMs ?? SEND_SILENCE_MS,
        now: this.now,
      },
      () => link.close(),
    );
    this.keepalive = keepalive;
    inbox.onHeard(() => keepalive.heard());
    inbox.take(handler);
    link.onClose(() => this.linkClosed(link));
  }

  /** Bytes moved for one file, from its engine. */
  protected progress(p: RemoteFileProgress): void {
    const entry = this.byId.get(p.transferId);
    if (
      !entry ||
      entry.status === 'done' ||
      entry.status === 'failed' ||
      entry.status === 'skipped'
    ) {
      return;
    }
    entry.transferred = p.transferred;
    if (p.done) this.settled(entry, p);
    this.meter.update(this.transferredBytes());
    this.common.changed();
  }

  protected abstract settled(entry: FileEntry, p: RemoteFileProgress): void;
  protected abstract linkClosed(link: SendLink): void;
  protected abstract engine(): FileTransferManager | null;

  protected finish(phase: SendPhase, reason: string | null): void {
    if (this.finished) return;
    this.phase = phase;
    this.reason = reason;
    this.finishedAt = this.now();
    this.answerBy = null;
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
    this.keepalive?.stop();
    void this.engine()?.dispose(reason ?? 'Finished.');
    if (this.link) closeSoon(this.link);
    this.common.ended();
    this.common.changed();
  }

  /** Stops everything at once, without a word to the other side. */
  async dispose(): Promise<void> {
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.keepalive?.stop();
    await this.engine()?.dispose();
    this.link?.close();
  }
}

function fileView(file: FileEntry): SendFileView {
  return {
    transferId: file.transferId,
    path: file.path,
    size: file.size,
    transferred: file.status === 'done' ? file.size : Math.min(file.size, file.transferred),
    status: file.status,
    ...(file.error ? { error: file.error } : {}),
    ...(file.savedPath ? { savedPath: file.savedPath } : {}),
  };
}

function engineCallbacks(onProgress: (p: RemoteFileProgress) => void) {
  return {
    sendControl: (ws: PeerSocket, msg: RemoteControlMessage) => send(ws, msg),
    sendBinary: async (ws: PeerSocket, data: Uint8Array) => {
      await (ws as SendLink).drain(DRAIN_AT);
      await new Promise<void>((resolve, reject) =>
        ws.send(data, { binary: true }, (err) => (err ? reject(err) : resolve())),
      );
    },
    flushed: (ws: PeerSocket) => (ws as SendLink).drain(FLUSHED_AT),
    log: () => undefined,
    emitProgress: onProgress,
  };
}

// --- Sending ------------------------------------------------------------------------

export interface OutgoingBatchOptions extends Common {
  batchId: string;
  manifest: Manifest;
  note?: string;
  /** The link went in the middle: dial again and `attach` the new one. */
  dropped(): void;
  answerTimeoutMs?: number;
  concurrency?: number;
  partBytes?: number;
}

/** A send from this computer: the offer, then the files, over whichever link is attached now. */
export class OutgoingBatch extends Batch {
  private readonly ftm: FileTransferManager;
  private answered = false;
  private offered = false;
  private readonly skipping = new Set<string>();

  constructor(private readonly options: OutgoingBatchOptions) {
    super(
      options.batchId,
      'out',
      options.manifest.files.map((file) => ({
        transferId: file.transferId,
        path: file.path,
        size: file.size,
        source: file.source,
        status: 'queued' as const,
        transferred: 0,
      })),
      options.note ?? null,
      options,
      'connecting',
    );
    this.ftm = new FileTransferManager(
      engineCallbacks((p) => this.progress(p)),
      { role: 'sender', partBytes: options.partBytes ?? SEND_PART_BYTES },
    );
  }

  protected engine(): FileTransferManager {
    return this.ftm;
  }

  /** A secured link to the other side, the first or one dialed again after a drop. */
  attach(link: SendLink, transport: 'direct' | 'relay'): void {
    if (this.finished) {
      link.close();
      return;
    }
    this.transport = transport;
    this.watch(link, openInbox(link), {
      send: (message) => this.onSend(link, message),
      file: (message) => {
        if (link === this.link) this.ftm.handleControl(link, message);
      },
      binary: () => undefined,
    });
    send(link, {
      t: 'send-offer',
      v: 1,
      batchId: this.batchId,
      files: this.files.map(({ transferId, path, size }) => ({ transferId, path, size })),
      ...(this.note ? { note: this.note } : {}),
    });
    if (!this.offered) {
      this.offered = true;
      const wait = this.options.answerTimeoutMs ?? SENDER_ANSWER_MS;
      this.answerBy = this.now() + wait;
      this.answerTimer = setTimeout(() => this.expire(), wait);
    }
    this.phase = this.answered ? 'reconnecting' : 'waiting';
    this.common.changed();
  }

  cancel(): void {
    if (this.finished) return;
    if (this.link)
      send(this.link, { t: 'send-cancel', batchId: this.batchId, reason: 'The sender cancelled.' });
    this.finish('cancelled', 'You cancelled it.');
  }

  cancelFile(transferId: string): void {
    const entry = this.byId.get(transferId);
    if (
      !entry ||
      entry.status === 'done' ||
      entry.status === 'failed' ||
      entry.status === 'skipped'
    ) {
      return;
    }
    this.skipping.add(transferId);
    if (entry.status === 'queued') {
      entry.status = 'skipped';
    } else {
      void this.ftm.cancelTransfer(transferId, 'Skipped.');
    }
    this.pump();
    this.checkFinished();
    this.common.changed();
  }

  /** Dialing did not work out, for good. */
  fail(reason: string): void {
    this.finish('failed', reason);
  }

  /** The other computer turned the send away before any link opened, by its own rules. */
  declineFromDial(reason: string): void {
    this.finish('declined', reason);
  }

  private expire(): void {
    if (this.answered || this.finished) return;
    if (this.link) {
      send(this.link, {
        t: 'send-cancel',
        batchId: this.batchId,
        reason: 'No one answered in time.',
      });
    }
    this.finish('expired', 'No one answered in time.');
  }

  private onSend(link: SendLink, message: SendMessage): void {
    if (link !== this.link || this.finished) return;
    if (message.t === 'send-cancel' && message.batchId === this.batchId) {
      this.finish('cancelled', `${firstName(this.common.peer.name)} stopped it.`);
      return;
    }
    if (message.t !== 'send-answer' || message.batchId !== this.batchId) return;
    this.answered = true;
    if (!message.accept) {
      const [phase, reason] = this.declined(message.reason);
      this.finish(phase, reason);
      return;
    }
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
    this.answerBy = null;
    for (const id of message.finished ?? []) {
      const entry = this.byId.get(id);
      if (entry && entry.status !== 'skipped') {
        entry.status = 'done';
        entry.transferred = entry.size;
      }
    }
    this.phase = 'transferring';
    this.meter.reset();
    if (message.resumed) this.ftm.resumeAfterReconnect(link);
    this.pump();
    this.checkFinished();
    this.common.changed();
  }

  private declined(reason: SendAnswerReason | undefined): [SendPhase, string] {
    const who = firstName(this.common.peer.name);
    const device = this.common.peer.deviceName;
    switch (reason) {
      case 'timeout':
        return ['expired', 'No one answered in time.'];
      case 'busy':
        return ['failed', `${device} is busy with other files. Try again in a moment.`];
      case 'no-space':
        return ['failed', `${device} does not have room for these files.`];
      case 'not-allowed':
        return ['declined', `${device} is not taking files from you.`];
      default:
        return ['declined', `Declined by ${who}.`];
    }
  }

  private pump(): void {
    const link = this.link;
    if (this.phase !== 'transferring' || !link) return;
    const limit = this.options.concurrency ?? CONCURRENCY;
    let active = this.files.filter((file) => file.status === 'active').length;
    for (const entry of this.files) {
      if (active >= limit) break;
      if (entry.status !== 'queued' || !entry.source) continue;
      entry.status = 'active';
      active++;
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      void this.ftm
        .startUpload(link, entry.source, undefined, { transferId: entry.transferId, name })
        .catch((error: unknown) => {
          if (entry.status !== 'active') return;
          entry.status = 'failed';
          entry.error =
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'It is not there any more.'
              : 'It could not be read.';
          this.pump();
          this.checkFinished();
          this.common.changed();
        });
    }
  }

  protected settled(entry: FileEntry, p: RemoteFileProgress): void {
    if (this.skipping.has(entry.transferId)) entry.status = 'skipped';
    else if (p.verified === true) {
      entry.status = 'done';
      entry.transferred = entry.size;
    } else {
      entry.status = 'failed';
      entry.error = p.error ?? 'It did not arrive intact.';
    }
    this.pump();
    this.checkFinished();
  }

  private checkFinished(): void {
    if (this.phase !== 'transferring') return;
    if (this.files.some((file) => file.status === 'queued' || file.status === 'active')) return;
    if (this.link) send(this.link, { t: 'send-complete', batchId: this.batchId });
    const done = this.files.filter((file) => file.status === 'done').length;
    const failed = this.files.filter((file) => file.status === 'failed').length;
    if (done > 0) this.finish('done', null);
    else if (failed > 0) this.finish('failed', 'None of the files arrived.');
    else this.finish('cancelled', 'You took every file back.');
  }

  protected linkClosed(link: SendLink): void {
    if (link !== this.link) return;
    this.link = null;
    this.keepalive?.stop();
    if (this.finished) return;
    this.ftm.onConnectionLost(link);
    if (this.phase === 'transferring') this.phase = 'reconnecting';
    this.meter.reset();
    this.options.dropped();
    this.common.changed();
  }
}

// --- Receiving ----------------------------------------------------------------------

export interface IncomingBatchOptions extends Common {
  /** The sender's identity key, so a link dialed again is known as the same sender. */
  senderKey: string;
  /** Where files go unless the person picks another folder. */
  folder: string;
  answerTimeoutMs?: number;
  reconnectWaitMs?: number;
  /** Free bytes in a folder, or null when the system will not say. */
  freeBytes?: (dir: string) => Promise<number | null>;
}

/** A send to this computer: the question first, then the files into the folder chosen. */
export class IncomingBatch extends Batch {
  private ftm: FileTransferManager | null = null;
  private freeBytes: number | null = null;
  private readonly receivedAt: number;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    link: SendLink,
    inbox: Inbox,
    offer: SendOffer,
    private readonly options: IncomingBatchOptions,
  ) {
    super(
      offer.batchId,
      'in',
      offer.files.map((file) => ({
        transferId: file.transferId,
        path: file.path,
        size: file.size,
        source: null,
        status: 'queued' as const,
        transferred: 0,
      })),
      offer.note ?? null,
      options,
      'asking',
    );
    this.receivedAt = this.now();
    const wait = options.answerTimeoutMs ?? RECEIVER_ANSWER_MS;
    this.answerBy = this.receivedAt + wait;
    this.answerTimer = setTimeout(() => this.timedOut(), wait);
    this.attachLink(link, inbox);
    void this.checkSpace(options.folder);
  }

  get senderKey(): string {
    return this.options.senderKey;
  }

  protected engine(): FileTransferManager | null {
    return this.ftm;
  }

  /** The question to put to the person here, while it is open. */
  offerView(): SendOfferView | null {
    if (this.phase !== 'asking') return null;
    const entries: SendOfferView['entries'] = [];
    const folders = new Map<string, SendOfferView['entries'][number]>();
    for (const file of this.files) {
      const slash = file.path.indexOf('/');
      if (slash === -1) {
        entries.push({ name: file.path, kind: 'file', size: file.size, fileCount: 1 });
        continue;
      }
      const name = file.path.slice(0, slash);
      let folder = folders.get(name);
      if (!folder) {
        folder = { name, kind: 'folder', size: 0, fileCount: 0 };
        folders.set(name, folder);
        entries.push(folder);
      }
      folder.size += file.size;
      folder.fileCount += 1;
    }
    return {
      batchId: this.batchId,
      peer: this.common.peer,
      note: this.note,
      fileCount: this.files.length,
      totalBytes: this.files.reduce((sum, file) => sum + file.size, 0),
      entries,
      folder: this.options.folder,
      freeBytes: this.freeBytes,
      receivedAt: this.receivedAt,
      expiresAt: this.answerBy ?? this.receivedAt,
    };
  }

  /** The person said yes. Throws, and stays asking, when the folder has no room for the files. */
  async accept(choice: { folder?: string }): Promise<void> {
    if (this.phase !== 'asking') return;
    const folder = choice.folder ?? this.options.folder;
    const total = this.files.reduce((sum, file) => sum + file.size, 0);
    const free = await (this.options.freeBytes ?? freeBytesIn)(folder);
    if (free !== null && free < total) {
      throw new Error(
        `There is not enough room in ${folder}: these files need ${formatBytes(total)} and ${formatBytes(free)} is free.`,
      );
    }
    if (this.phase !== 'asking') return;
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
    this.answerBy = null;
    this.folder = folder;
    this.ftm = new FileTransferManager(
      engineCallbacks((p) => this.progress(p)),
      {
        role: 'receiver',
        acceptOffer: async (offer) => this.place(offer),
        reconnectAbandonMs: this.options.reconnectWaitMs ?? RECEIVER_RECONNECT_MS,
      },
    );
    this.phase = 'transferring';
    if (this.link) send(this.link, { t: 'send-answer', batchId: this.batchId, accept: true });
    this.common.changed();
  }

  decline(reason: SendAnswerReason = 'declined'): void {
    if (this.phase !== 'asking') return;
    if (this.link)
      send(this.link, { t: 'send-answer', batchId: this.batchId, accept: false, reason });
    this.finish(
      reason === 'timeout' ? 'expired' : 'declined',
      reason === 'timeout' ? 'No one answered in time.' : 'You declined.',
    );
  }

  cancel(): void {
    if (this.finished) return;
    if (this.link) {
      send(this.link, {
        t: 'send-cancel',
        batchId: this.batchId,
        reason: 'The receiver cancelled.',
      });
    }
    this.finish('cancelled', 'You cancelled it.');
  }

  /** The same sender dialed again for this batch after its link dropped. */
  resume(link: SendLink, inbox: Inbox): void {
    if (this.finished) {
      link.close();
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attachLink(link, inbox);
    if (this.phase === 'asking') return;
    this.phase = 'transferring';
    this.meter.reset();
    send(link, {
      t: 'send-answer',
      batchId: this.batchId,
      accept: true,
      resumed: true,
      finished: this.files.filter((file) => file.status === 'done').map((file) => file.transferId),
    });
    this.common.changed();
  }

  private attachLink(link: SendLink, inbox: Inbox): void {
    this.transport = null;
    this.watch(link, inbox, {
      send: (message) => this.onSend(link, message),
      file: (message) => {
        if (link === this.link) this.ftm?.handleControl(link, message);
      },
      binary: (data) => {
        if (link === this.link) this.ftm?.handleBinary(data);
      },
    });
  }

  private timedOut(): void {
    if (this.phase === 'asking') this.decline('timeout');
  }

  private async checkSpace(folder: string): Promise<void> {
    this.freeBytes = await (this.options.freeBytes ?? freeBytesIn)(folder);
    if (this.phase === 'asking') this.common.changed();
  }

  private onSend(link: SendLink, message: SendMessage): void {
    if (link !== this.link || this.finished) return;
    if (message.t === 'send-cancel' && message.batchId === this.batchId) {
      const who = firstName(this.common.peer.name);
      if (this.phase === 'asking') this.finish('expired', `${who} stopped waiting.`);
      else this.finish('cancelled', `${who} stopped it.`);
      return;
    }
    if (message.t === 'send-complete' && message.batchId === this.batchId) {
      for (const file of this.files) {
        if (file.status === 'queued' || file.status === 'active') file.status = 'skipped';
      }
      const done = this.files.some((file) => file.status === 'done');
      this.finish(done ? 'done' : 'failed', done ? null : 'None of the files arrived.');
    }
  }

  /** Where an offered file goes, checked against the list the person accepted. */
  private place(offer: Extract<RemoteControlMessage, { t: 'file-offer' }>): OfferDecision {
    const entry = this.byId.get(offer.transferId);
    const folder = this.folder ?? this.options.folder;
    if (!entry || entry.status === 'skipped') {
      return { refuse: 'That file is not in the list you accepted.' };
    }
    const target = targetFor(folder, entry.path);
    if (!target) return { refuse: 'That file would land outside the folder you chose.' };
    if (
      offer.name !== entry.path.slice(entry.path.lastIndexOf('/') + 1) ||
      offer.size !== entry.size
    ) {
      return { refuse: 'That file does not match the list you accepted.' };
    }
    if (offer.partSize < SEND_LIMITS.minPartSize || offer.partSize > SEND_LIMITS.maxPartSize) {
      return { refuse: 'That file comes in parts of a size this side does not take.' };
    }
    if (entry.status === 'queued') entry.status = 'active';
    return { destDir: target.dir, partDir: join(folder, '.runova-partial'), name: target.name };
  }

  protected settled(entry: FileEntry, p: RemoteFileProgress): void {
    if (p.verified === true && p.savedPath) {
      entry.status = 'done';
      entry.transferred = entry.size;
      entry.savedPath = p.savedPath;
    } else {
      entry.status = 'failed';
      entry.error = p.error ?? 'It did not arrive intact.';
    }
  }

  protected linkClosed(link: SendLink): void {
    if (link !== this.link) return;
    this.link = null;
    this.keepalive?.stop();
    if (this.finished || this.phase === 'asking') return;
    this.phase = 'reconnecting';
    this.ftm?.onConnectionLost(link);
    this.meter.reset();
    this.reconnectTimer = setTimeout(
      () => this.finish('failed', `The connection to ${this.common.peer.deviceName} was lost.`),
      this.options.reconnectWaitMs ?? RECEIVER_RECONNECT_MS,
    );
    this.common.changed();
  }

  protected override finish(phase: SendPhase, reason: string | null): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    super.finish(phase, reason);
  }

  override async dispose(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await super.dispose();
  }
}

async function freeBytesIn(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}
