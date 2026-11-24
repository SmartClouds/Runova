import { createHash, type Hash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  copyFile,
  type FileHandle,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';
import type {
  RemoteFileDirection,
  RemoteFileProgress,
  RemoteLogLevel,
} from '../../shared/apiTypes';
import {
  BIN_FILE_CHUNK,
  decodeFileChunk,
  encodeFileChunk,
  FILE_CHUNK_BYTES,
  type FileChunk,
  formatBytes,
  PART_BYTES,
  type RemoteControlMessage,
  transferKeyFromId,
} from '../../shared/remoteProtocol';
import { type PeerSocket, SOCKET_OPEN } from './peerSocket';

/** A part is retried this many times (hash mismatch or ack timeout) before the whole transfer is failed. */
const MAX_PART_RETRIES = 5;
/** How long we wait for a `file-part-ack` before treating it as a timeout and retrying the part. */
const PART_ACK_TIMEOUT_MS = 30_000;
/** Transfers stuck `awaiting-reconnect` longer than this are abandoned and their temp files cleaned up. */
const RECONNECT_ABANDON_MS = 5 * 60 * 1000;
/** How many saved files are remembered, so one offered again is answered instead of saved twice. */
const MAX_RECEIPTS = 20_000;

export type TransferStatus = 'active' | 'awaiting-reconnect' | 'done' | 'error' | 'cancelled';

type FileOffer = Extract<RemoteControlMessage, { t: 'file-offer' }>;

interface UploadState {
  direction: 'upload';
  transferId: string;
  transferKey: number;
  name: string;
  size: number;
  partSize: number;
  partCount: number;
  filePath: string;
  ws: PeerSocket | null;
  status: TransferStatus;
  lastActivityAt: number;
  completedParts: Set<number>;
  pendingPart: { partIndex: number; hash: string } | null;
  retries: number;
  ackTimer: NodeJS.Timeout | null;
  error?: string;
}

interface DownloadState {
  direction: 'download';
  transferId: string;
  transferKey: number;
  name: string;
  size: number;
  partSize: number;
  partCount: number;
  destDir?: string;
  /** The name it is saved under, when the receiver chose one. */
  saveAs?: string;
  tmpPath: string;
  /** Final path the file was renamed to once verified (set on completion). */
  savedPath?: string;
  fh: FileHandle;
  ws: PeerSocket | null;
  status: TransferStatus;
  lastActivityAt: number;
  completedParts: Set<number>;
  currentPartIndex: number | null;
  partHash: Hash | null;
  partBytesReceived: number;
  /** Writes to the part file, in the order the frames came. */
  writes: Promise<void>;
  error?: string;
}

type TransferState = UploadState | DownloadState;

export interface FileTransferCallbacks {
  sendControl(ws: PeerSocket, msg: RemoteControlMessage): void;
  sendBinary(ws: PeerSocket, data: Uint8Array): Promise<void>;
  log(level: RemoteLogLevel, message: string): void;
  emitProgress(progress: RemoteFileProgress): void;
  /**
   * Resolves once what was sent on `ws` has actually left, for links that take frames faster than
   * they can send them. A part's ack clock starts only then, so a slow link is not taken for a
   * silent peer.
   */
  flushed?(ws: PeerSocket): Promise<void>;
}

/**
 * Where an offered file goes: its folder, the folder its part file is written to meanwhile, and
 * the name it is saved under when not the one offered.
 */
export type OfferDecision =
  | { destDir: string; partDir?: string; name?: string }
  | { refuse: string };

export interface FileTransferOptions {
  /**
   * Which side of a transfer this manager plays. The remote-control session plays both. A send
   * (E112) gives each side one role, so the sender takes no files and neither side serves a path
   * the other asks for.
   */
  role?: 'both' | 'sender' | 'receiver';
  /**
   * Decides where an offered file is saved, or turns it away. With it, the folder a sender names is
   * ignored: the receiver alone decides where files land.
   */
  acceptOffer?: (offer: FileOffer) => Promise<OfferDecision>;
  /** Where files land when nothing else says, and where part files go. Electron's Downloads otherwise. */
  downloadsDir?: () => string;
  /** The part size of files this manager sends. */
  partBytes?: number;
  /** How long a transfer waits for its link to come back before it is abandoned. */
  reconnectAbandonMs?: number;
  /** How long a finished transfer's state is kept for a late progress event. */
  forgetAfterMs?: number;
}

/**
 * Resumable, hash-verified file transfer over the remote-control connection (a LAN WebSocket or a Runova Anywhere link).
 *
 * Files are split into fixed-size parts (`PART_BYTES`, 10MB, unless `partBytes` says otherwise).
 * Each part is streamed as 64KB `BIN_FILE_CHUNK` frames, independently SHA-256 hashed and acked
 * before the next part starts (stop-and-wait, see protocol comment on `file-offer`), so a dropped
 * connection or a corrupted part only costs a resend of that one part, never the whole file. The
 * whole file is verified again at the end: the sender reads its file again for the hash, and the
 * receiver re-reads the fully assembled temp file in one pass and compares the two, which is the
 * only way to catch a bug anywhere in the part-by-part pipeline (or a resume that skipped a part)
 * without trusting that the parts summed to the same bytes the sender started with.
 *
 * State is keyed by `transferId`, not by connection, on purpose: when the
 * dialing side (always the controller, since the host never dials) reconnects
 * after a drop, it re-sends the message that drives its role in the
 * transfer (`file-offer` if it's the sender, `file-resume` if it's the
 * receiver) for the *same* `transferId`. Both handlers below recognize an
 * existing transfer by that id and just rebind `ws`/resume, instead of
 * starting over. That's the entire resume mechanism.
 */
export class FileTransferManager {
  private readonly transfers = new Map<string, TransferState>();
  private readonly byKey = new Map<number, string>();
  /** Files this side saved, by transfer id, so a repeated offer gets the same receipt. */
  private readonly receipts = new Map<string, { savedPath: string }>();
  /** Offers still waiting on `acceptOffer`, so a repeat of one does not open a second file. */
  private readonly deciding = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly role: 'both' | 'sender' | 'receiver';
  private readonly partBytes: number;
  private readonly abandonMs: number;
  private readonly forgetMs: number;

  constructor(
    private readonly callbacks: FileTransferCallbacks,
    private readonly options: FileTransferOptions = {},
  ) {
    this.role = options.role ?? 'both';
    this.partBytes = options.partBytes ?? PART_BYTES;
    this.abandonMs = options.reconnectAbandonMs ?? RECONNECT_ABANDON_MS;
    this.forgetMs = options.forgetAfterMs ?? 5_000;
  }

  hasActiveTransfers(): boolean {
    for (const t of this.transfers.values()) {
      if (t.status === 'active' || t.status === 'awaiting-reconnect') return true;
    }
    return false;
  }

  /** Snapshot of all transfers, for the initial state pushed to a newly-opened renderer window. */
  listProgress(): RemoteFileProgress[] {
    return [...this.transfers.values()].map((t) => this.progressFor(t));
  }

  // --- Sending -------------------------------------------------------------

  async startUpload(
    ws: PeerSocket,
    filePath: string,
    destDir?: string,
    as: { transferId?: string; name?: string } = {},
  ): Promise<void> {
    if (as.transferId !== undefined && this.transfers.has(as.transferId)) {
      throw new Error(`Transfer ${as.transferId} is already under way.`);
    }
    const info = await stat(filePath);
    const name = as.name ?? basename(filePath);
    const transferId = as.transferId ?? this.freshTransferId();
    const partCount = Math.max(1, Math.ceil(info.size / this.partBytes));
    const state: UploadState = {
      direction: 'upload',
      transferId,
      transferKey: transferKeyFromId(transferId),
      name,
      size: info.size,
      partSize: this.partBytes,
      partCount,
      filePath,
      ws,
      status: 'active',
      lastActivityAt: Date.now(),
      completedParts: new Set(),
      pendingPart: null,
      retries: 0,
      ackTimer: null,
    };
    this.transfers.set(transferId, state);
    this.byKey.set(state.transferKey, transferId);
    this.callbacks.sendControl(ws, {
      t: 'file-offer',
      transferId,
      name,
      size: info.size,
      partSize: this.partBytes,
      partCount,
      destDir,
    });
    this.callbacks.log('info', `Sending "${name}" (${formatBytes(info.size)})…`);
    this.emit(state);
    this.ensureSweep();
  }

  /** Peer asked us to push a file from our own filesystem (the download half of the remote file manager). */
  async handleFileRequest(
    ws: PeerSocket,
    msg: Extract<RemoteControlMessage, { t: 'file-request' }>,
  ): Promise<void> {
    if (this.role !== 'both') {
      this.callbacks.sendControl(ws, {
        t: 'file-request-ack',
        reqId: msg.reqId,
        ok: false,
        error: 'This connection does not hand out files.',
      });
      return;
    }
    try {
      const info = await stat(msg.path);
      if (!info.isFile()) throw new Error('Not a file.');
      this.callbacks.sendControl(ws, { t: 'file-request-ack', reqId: msg.reqId, ok: true });
      await this.startUpload(ws, msg.path);
    } catch (err) {
      this.callbacks.sendControl(ws, {
        t: 'file-request-ack',
        reqId: msg.reqId,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  private async sendPart(state: UploadState, partIndex: number): Promise<void> {
    if (state.ws?.readyState !== SOCKET_OPEN) return; // will resume once reconnected
    const ws = state.ws;
    const start = partIndex * state.partSize;
    const end = Math.min(state.size, start + state.partSize) - 1;
    const partHash = createHash('sha256');
    let sent = 0;
    let seq = 0;
    try {
      const stream = createReadStream(state.filePath, {
        start,
        end,
        highWaterMark: FILE_CHUNK_BYTES,
      });
      for await (const chunkUnknown of stream) {
        const bytes = chunkUnknown as Buffer;
        partHash.update(bytes);
        sent += bytes.byteLength;
        await this.callbacks.sendBinary(
          ws,
          encodeFileChunk({ transferKey: state.transferKey, partIndex, seq: seq++, bytes }),
        );
        state.lastActivityAt = Date.now();
        this.emit(state, partIndex, sent);
      }
      const hash = partHash.digest('hex');
      state.pendingPart = { partIndex, hash };
      this.callbacks.sendControl(ws, {
        t: 'file-part-done',
        transferId: state.transferId,
        partIndex,
        hash,
        size: end - start + 1,
      });
      await this.callbacks.flushed?.(ws);
      // The ack may already be in, or the link gone; then there is nothing to wait for.
      if (state.pendingPart?.partIndex === partIndex && state.status === 'active') {
        this.armAckTimeout(state, partIndex);
      }
    } catch (err) {
      this.failUpload(state, (err as Error).message);
    }
  }

  private armAckTimeout(state: UploadState, partIndex: number): void {
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = setTimeout(() => {
      if (state.pendingPart?.partIndex !== partIndex || state.status !== 'active') return;
      this.retryOrFail(state, partIndex);
    }, PART_ACK_TIMEOUT_MS);
  }

  private handlePartAck(
    state: UploadState,
    msg: Extract<RemoteControlMessage, { t: 'file-part-ack' }>,
  ): void {
    if (state.pendingPart?.partIndex !== msg.partIndex) return; // stale ack, ignore
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = null;
    state.lastActivityAt = Date.now();
    if (!msg.ok) {
      this.retryOrFail(state, msg.partIndex);
      return;
    }
    state.completedParts.add(msg.partIndex);
    state.pendingPart = null;
    state.retries = 0;
    this.emit(state);
    const next = this.nextMissingPart(state);
    if (next === null) {
      void this.complete(state);
      return;
    }
    void this.sendPart(state, next);
  }

  /** Every part is in: the whole file's hash, read from disk so a resume can not leave a part out. */
  private async complete(state: UploadState): Promise<void> {
    try {
      const hash = await hashFile(state.filePath);
      if (state.ws && state.status === 'active') {
        this.callbacks.sendControl(state.ws, {
          t: 'file-complete',
          transferId: state.transferId,
          hash,
        });
      }
    } catch (err) {
      this.failUpload(state, (err as Error).message);
    }
  }

  private retryOrFail(state: UploadState, partIndex: number): void {
    state.pendingPart = null;
    state.retries++;
    if (state.retries > MAX_PART_RETRIES) {
      this.failUpload(state, `Part ${partIndex + 1}/${state.partCount} failed too many times.`);
      return;
    }
    void this.sendPart(state, partIndex);
  }

  private failUpload(state: UploadState, message: string): void {
    state.status = 'error';
    state.error = message;
    if (state.ackTimer) clearTimeout(state.ackTimer);
    this.callbacks.log('error', `Failed to send "${state.name}": ${message}`);
    if (state.ws)
      this.callbacks.sendControl(state.ws, {
        t: 'file-error',
        transferId: state.transferId,
        message,
      });
    this.emit(state);
    this.forget(state);
  }

  private handleFileDone(
    state: UploadState,
    msg: Extract<RemoteControlMessage, { t: 'file-done' }>,
  ): void {
    if (state.status === 'done') return;
    state.status = msg.verified ? 'done' : 'error';
    if (!msg.verified) state.error = 'Receiver could not verify the whole-file hash.';
    this.callbacks.log(
      msg.verified ? 'success' : 'error',
      msg.verified
        ? `Sent "${state.name}".`
        : `Sent "${state.name}" but the receiver's hash check failed.`,
    );
    this.emit(state);
    this.forget(state);
  }

  // --- Receiving -------------------------------------------------------------

  private refuseOffer(ws: PeerSocket, transferId: string, message: string): void {
    this.callbacks.sendControl(ws, { t: 'file-error', transferId, message });
  }

  private async handleFileOffer(ws: PeerSocket, msg: FileOffer): Promise<void> {
    if (this.role === 'sender') {
      this.refuseOffer(ws, msg.transferId, 'This side only sends files.');
      return;
    }
    if (!offerAddsUp(msg)) {
      this.refuseOffer(ws, msg.transferId, 'The offer does not add up.');
      return;
    }
    const receipt = this.receipts.get(msg.transferId);
    if (receipt) {
      // Saved already; the sender just never heard. Tell it again rather than saving a copy.
      this.callbacks.sendControl(ws, {
        t: 'file-done',
        transferId: msg.transferId,
        savedPath: receipt.savedPath,
        verified: true,
      });
      return;
    }
    const existing = this.transfers.get(msg.transferId);
    if (existing) {
      if (
        existing.direction !== 'download' ||
        existing.name !== msg.name ||
        existing.size !== msg.size ||
        existing.partSize !== msg.partSize ||
        existing.partCount !== msg.partCount
      ) {
        this.refuseOffer(
          ws,
          msg.transferId,
          'The offer does not match the file already under way.',
        );
        return;
      }
      if (existing.status !== 'active' && existing.status !== 'awaiting-reconnect') return;
      // Rebind after a reconnect: keep the temp file and completed parts, just point at the new socket.
      existing.ws = ws;
      existing.status = 'active';
      existing.lastActivityAt = Date.now();
      this.emit(existing);
      this.askForMissing(ws, existing);
      return;
    }
    if (this.deciding.has(msg.transferId)) return;
    this.deciding.add(msg.transferId);
    let state: DownloadState;
    try {
      const place = await this.placeFor(msg);
      if ('refuse' in place) {
        this.refuseOffer(ws, msg.transferId, place.refuse);
        return;
      }
      await mkdir(place.destDir, { recursive: true });
      await mkdir(place.partDir, { recursive: true });
      const tmpPath = join(place.partDir, `${msg.transferId}.part`);
      const fh = await open(tmpPath, 'w+');
      await fh.truncate(msg.size);
      state = {
        direction: 'download',
        transferId: msg.transferId,
        transferKey: transferKeyFromId(msg.transferId),
        name: msg.name,
        size: msg.size,
        partSize: msg.partSize,
        partCount: msg.partCount,
        destDir: place.destDir,
        saveAs: place.name,
        tmpPath,
        fh,
        ws,
        status: 'active',
        lastActivityAt: Date.now(),
        completedParts: new Set(),
        currentPartIndex: null,
        partHash: null,
        partBytesReceived: 0,
        writes: Promise.resolve(),
      };
    } catch (err) {
      this.refuseOffer(
        ws,
        msg.transferId,
        `Could not make room for "${msg.name}": ${(err as Error).message}`,
      );
      return;
    } finally {
      this.deciding.delete(msg.transferId);
    }
    this.transfers.set(state.transferId, state);
    this.byKey.set(state.transferKey, state.transferId);
    this.callbacks.log('info', `Receiving "${msg.name}" (${formatBytes(msg.size)})…`);
    this.emit(state);
    this.ensureSweep();
    this.askForMissing(ws, state);
  }

  /** The receiver's folder for an offer: the hook's word, else the sender's folder if we have it, else Downloads. */
  private async placeFor(
    msg: FileOffer,
  ): Promise<{ destDir: string; partDir: string; name?: string } | { refuse: string }> {
    const downloads = this.downloadsDir();
    if (this.options.acceptOffer) {
      const decision = await this.options.acceptOffer(msg);
      if ('refuse' in decision) return decision;
      return {
        destDir: decision.destDir,
        partDir: decision.partDir ?? join(decision.destDir, '.runova-partial'),
        name: decision.name,
      };
    }
    const destDir = msg.destDir && existsSync(msg.destDir) ? msg.destDir : downloads;
    return { destDir, partDir: join(downloads, '.runova-tmp') };
  }

  private askForMissing(ws: PeerSocket, state: DownloadState): void {
    this.callbacks.sendControl(ws, {
      t: 'file-resume',
      transferId: state.transferId,
      missingParts: this.missingPartsOf(state),
    });
  }

  /** We're the sender for this transfer; the peer told us which parts it still needs. */
  private handleFileResume(
    state: UploadState,
    ws: PeerSocket,
    msg: Extract<RemoteControlMessage, { t: 'file-resume' }>,
  ): void {
    state.ws = ws;
    state.status = 'active';
    state.lastActivityAt = Date.now();
    state.pendingPart = null;
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = null;
    for (let i = 0; i < state.partCount; i++) {
      if (!msg.missingParts.includes(i)) state.completedParts.add(i);
    }
    this.emit(state);
    const next = msg.missingParts.find((i) => i >= 0 && i < state.partCount) ?? null;
    if (next === null) {
      if (this.nextMissingPart(state) === null) void this.complete(state);
      return;
    }
    void this.sendPart(state, next);
  }

  /**
   * Takes one frame. Its place in the file and its part of the hash are settled here, in the
   * order frames come, and the write to disk joins a queue: frames of a fast link arrive before
   * the write of the one before has finished.
   */
  private handlePartData(state: DownloadState, chunk: FileChunk): void {
    // A frame still on the wire after a cancel or the end of the transfer has no open file to go to.
    if (state.status !== 'active' && state.status !== 'awaiting-reconnect') return;
    if (chunk.seq === 0) {
      state.currentPartIndex = chunk.partIndex;
      state.partHash = createHash('sha256');
      state.partBytesReceived = 0;
    }
    if (state.currentPartIndex !== chunk.partIndex || !state.partHash) return; // stray/late frame
    // A part never runs past its own end, whatever the sender says.
    if (state.partBytesReceived + chunk.bytes.byteLength > state.partSize) return;
    const offset = chunk.partIndex * state.partSize + state.partBytesReceived;
    if (offset + chunk.bytes.byteLength > state.size) return;
    state.partHash.update(chunk.bytes);
    state.partBytesReceived += chunk.bytes.byteLength;
    state.lastActivityAt = Date.now();
    const received = state.partBytesReceived;
    const bytes = chunk.bytes;
    state.writes = state.writes
      .then(async () => {
        await state.fh.write(bytes, 0, bytes.byteLength, offset);
        this.emit(state, chunk.partIndex, received);
      })
      .catch(() => {
        // The file was closed under it (a cancel); the transfer is over anyway.
      });
  }

  private handlePartDone(
    state: DownloadState,
    msg: Extract<RemoteControlMessage, { t: 'file-part-done' }>,
  ): void {
    const ok =
      state.currentPartIndex === msg.partIndex &&
      !!state.partHash &&
      state.partHash.digest('hex') === msg.hash;
    if (state.ws) {
      this.callbacks.sendControl(state.ws, {
        t: 'file-part-ack',
        transferId: state.transferId,
        partIndex: msg.partIndex,
        ok,
      });
    }
    if (ok) {
      state.completedParts.add(msg.partIndex);
      state.partHash = null;
      this.emit(state);
    }
    // On failure the sender will resend the same part from seq 0, which naturally resets our accumulator above.
  }

  private async handleFileComplete(
    state: DownloadState,
    msg: Extract<RemoteControlMessage, { t: 'file-complete' }>,
  ): Promise<void> {
    if (state.status !== 'active') return;
    await state.writes;
    const actual = await hashFile(state.tmpPath);
    const verified = actual === msg.hash;
    try {
      await state.fh.close();
    } catch (err) {
      this.callbacks.log('error', `Failed to close "${state.name}": ${(err as Error).message}`);
    }
    if (!verified) {
      state.status = 'error';
      state.error = "Whole-file hash didn't match after reassembly.";
      if (state.ws) {
        this.callbacks.sendControl(state.ws, {
          t: 'file-done',
          transferId: state.transferId,
          savedPath: state.tmpPath,
          verified: false,
        });
      }
      this.callbacks.log('error', `Saved "${state.name}" but its hash didn't verify.`);
      this.emit(state);
      this.forget(state);
      return;
    }
    const target = uniquePath(
      join(state.destDir ?? this.downloadsDir(), sanitizeName(state.saveAs ?? state.name)),
    );
    try {
      await mkdir(dirname(target), { recursive: true });
      await moveInto(state.tmpPath, target);
    } catch (err) {
      // A file that is not where it should be is not saved, however well its bytes checked out.
      state.status = 'error';
      state.error = `Could not save "${state.name}": ${(err as Error).message}`;
      if (state.ws) {
        this.callbacks.sendControl(state.ws, {
          t: 'file-error',
          transferId: state.transferId,
          message: state.error,
        });
      }
      this.callbacks.log('error', state.error);
      this.emit(state);
      this.forget(state);
      return;
    }
    state.status = 'done';
    state.savedPath = target;
    this.remember(state.transferId, target);
    if (state.ws) {
      this.callbacks.sendControl(state.ws, {
        t: 'file-done',
        transferId: state.transferId,
        savedPath: target,
        verified: true,
      });
    }
    this.callbacks.log('success', `Saved "${state.name}" to ${target}.`);
    this.emit(state);
    this.forget(state);
  }

  private remember(transferId: string, savedPath: string): void {
    this.receipts.set(transferId, { savedPath });
    if (this.receipts.size > MAX_RECEIPTS) {
      const oldest = this.receipts.keys().next().value;
      if (oldest !== undefined) this.receipts.delete(oldest);
    }
  }

  // --- Dispatch ----------------------------------------------------------------

  /** Route a control-plane message into whichever transfer it belongs to. Returns false if this message isn't ours. */
  handleControl(ws: PeerSocket, msg: RemoteControlMessage): boolean {
    switch (msg.t) {
      case 'file-offer':
        void this.handleFileOffer(ws, msg);
        return true;
      case 'file-resume': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'upload') this.handleFileResume(state, ws, msg);
        return true;
      }
      case 'file-part-done': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'download') this.handlePartDone(state, msg);
        return true;
      }
      case 'file-part-ack': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'upload') this.handlePartAck(state, msg);
        return true;
      }
      case 'file-complete': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'download') void this.handleFileComplete(state, msg);
        return true;
      }
      case 'file-done': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'upload') this.handleFileDone(state, msg);
        return true;
      }
      case 'file-error': {
        const state = this.transfers.get(msg.transferId);
        if (state) this.cancel(state, msg.message);
        return true;
      }
      case 'file-cancel': {
        const state = this.transfers.get(msg.transferId);
        if (state) this.cancel(state, 'Cancelled by peer.');
        return true;
      }
      case 'file-request':
        void this.handleFileRequest(ws, msg);
        return true;
      default:
        return false;
    }
  }

  handleBinary(buf: Uint8Array): boolean {
    if (buf[0] !== BIN_FILE_CHUNK) return false;
    const chunk = decodeFileChunk(buf);
    if (!chunk) return true;
    const transferId = this.byKey.get(chunk.transferKey);
    const state = transferId ? this.transfers.get(transferId) : undefined;
    if (state?.direction === 'download') this.handlePartData(state, chunk);
    return true;
  }

  /** Stops one transfer from this side and tells the peer. */
  cancelTransfer(transferId: string, reason = 'Cancelled.'): Promise<void> {
    const state = this.transfers.get(transferId);
    if (!state) return Promise.resolve();
    if (state.ws && state.status !== 'done') {
      this.callbacks.sendControl(state.ws, { t: 'file-cancel', transferId });
    }
    return this.cancel(state, reason);
  }

  // --- Reconnect lifecycle -------------------------------------------------

  /** Connection to `ws` was lost; mark any transfer using it as awaiting-reconnect instead of tearing it down. */
  onConnectionLost(ws: PeerSocket): void {
    for (const state of this.transfers.values()) {
      if (state.ws !== ws) continue;
      state.ws = null;
      if (state.status === 'active') {
        state.status = 'awaiting-reconnect';
        state.lastActivityAt = Date.now();
        this.emit(state);
      }
      if (state.direction === 'upload') {
        state.pendingPart = null;
        if (state.ackTimer) {
          clearTimeout(state.ackTimer);
          state.ackTimer = null;
        }
      }
    }
  }

  /** The dialing side reconnected; re-drive whichever message resumes our role in each pending transfer. */
  resumeAfterReconnect(ws: PeerSocket): void {
    for (const state of this.transfers.values()) {
      if (state.status !== 'awaiting-reconnect') continue;
      state.ws = ws;
      state.status = 'active';
      state.lastActivityAt = Date.now();
      if (state.direction === 'upload') {
        this.callbacks.sendControl(ws, {
          t: 'file-offer',
          transferId: state.transferId,
          name: state.name,
          size: state.size,
          partSize: state.partSize,
          partCount: state.partCount,
        });
      } else {
        this.askForMissing(ws, state);
      }
      this.emit(state);
    }
  }

  /**
   * User explicitly disconnected, so cancel everything cleanly rather than waiting to see if it
   * reconnects. Resolves once every half-received file is closed.
   */
  async cancelAll(reason: string): Promise<void> {
    await Promise.all([...this.transfers.values()].map((state) => this.cancel(state, reason)));
  }

  /** Stops everything without a word to the peer, closes every open file and the sweep. */
  async dispose(reason = 'Closed.'): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.cancelAll(reason);
  }

  private cancel(state: TransferState, reason: string): Promise<void> {
    if (state.status === 'done') return Promise.resolve();
    const wasLive = state.status === 'active' || state.status === 'awaiting-reconnect';
    state.status = state.status === 'error' ? 'error' : 'cancelled';
    state.error = state.error ?? reason;
    if (state.direction === 'upload' && state.ackTimer) clearTimeout(state.ackTimer);
    if (wasLive) {
      this.emit(state);
      this.forget(state);
    }
    if (state.direction === 'upload') return Promise.resolve();
    // Left open, the temp file's handle leaked until garbage collection closed it, which Node now
    // raises as an uncaught error. Closing a handle that is already closed does nothing.
    return state.writes
      .then(() => state.fh.close())
      .catch((err: Error) => {
        this.callbacks.log('error', `Failed to close "${state.name}": ${err.message}`);
      });
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepAbandoned(), 30_000);
  }

  private sweepAbandoned(): void {
    const now = Date.now();
    for (const state of [...this.transfers.values()]) {
      if (state.status === 'awaiting-reconnect' && now - state.lastActivityAt > this.abandonMs) {
        this.cancel(state, 'Gave up waiting for the connection to resume.');
      }
    }
    if (this.transfers.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // --- Helpers ---------------------------------------------------------------

  private downloadsDir(): string {
    return this.options.downloadsDir?.() ?? app.getPath('downloads');
  }

  private missingPartsOf(state: TransferState): number[] {
    const missing: number[] = [];
    for (let i = 0; i < state.partCount; i++) if (!state.completedParts.has(i)) missing.push(i);
    return missing;
  }

  private nextMissingPart(state: TransferState): number | null {
    for (let i = 0; i < state.partCount; i++) if (!state.completedParts.has(i)) return i;
    return null;
  }

  private freshTransferId(): string {
    for (;;) {
      const id = randomUUID();
      if (!this.byKey.has(transferKeyFromId(id))) return id;
    }
  }

  private forget(state: TransferState): void {
    setTimeout(() => {
      if (this.transfers.get(state.transferId) !== state) return;
      this.transfers.delete(state.transferId);
      if (this.byKey.get(state.transferKey) === state.transferId)
        this.byKey.delete(state.transferKey);
      if (state.direction === 'download' && state.status !== 'done' && existsSync(state.tmpPath)) {
        void rm(state.tmpPath, { force: true });
      }
    }, this.forgetMs); // brief grace period so a last progress event still finds the state if in flight
  }

  private progressFor(
    state: TransferState,
    partIndexInFlight?: number,
    bytesInFlight?: number,
  ): RemoteFileProgress {
    const direction: RemoteFileDirection = state.direction === 'upload' ? 'outgoing' : 'incoming';
    const transferred =
      state.completedParts.size * state.partSize +
      (partIndexInFlight !== undefined && !state.completedParts.has(partIndexInFlight)
        ? (bytesInFlight ?? 0)
        : 0);
    return {
      transferId: state.transferId,
      name: state.name,
      direction,
      transferred: Math.min(transferred, state.size),
      total: state.size,
      done: state.status === 'done' || state.status === 'error' || state.status === 'cancelled',
      error: state.status === 'error' || state.status === 'cancelled' ? state.error : undefined,
      savedPath: state.direction === 'download' ? state.savedPath : undefined,
      partsTotal: state.partCount,
      partsCompleted: state.completedParts.size,
      verified: state.status === 'done' ? true : state.status === 'error' ? false : undefined,
      resuming: state.status === 'awaiting-reconnect',
      currentPartRetry: state.direction === 'upload' ? state.retries : undefined,
    };
  }

  private emit(state: TransferState, partIndexInFlight?: number, bytesInFlight?: number): void {
    this.callbacks.emitProgress(this.progressFor(state, partIndexInFlight, bytesInFlight));
  }
}

/**
 * Removes the part files a crash or a hard quit left in `dir` (`*.part` older than `olderThanMs`).
 * A folder that is not there is fine.
 */
export async function cleanStalePartFiles(dir: string, olderThanMs: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - olderThanMs;
  await Promise.all(
    names
      .filter((name) => name.endsWith('.part'))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
        } catch {
          // Gone already, or in use by a transfer that started meanwhile.
        }
      }),
  );
}

/** A size, part size and part count that agree, so an offer can not make us track parts that can not exist. */
function offerAddsUp(msg: FileOffer): boolean {
  return (
    Number.isSafeInteger(msg.size) &&
    msg.size >= 0 &&
    Number.isSafeInteger(msg.partSize) &&
    msg.partSize > 0 &&
    msg.partCount === Math.max(1, Math.ceil(msg.size / msg.partSize))
  );
}

/** Renames, or copies and deletes when the two are on different disks. */
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_') || 'received-file';
}

function uniquePath(path: string): string {
  const dot = basename(path).lastIndexOf('.');
  const dir = path.slice(0, path.length - basename(path).length);
  const stem = dot > 0 ? basename(path).slice(0, dot) : basename(path);
  const ext = dot > 0 ? basename(path).slice(dot) : '';
  let candidate = path;
  let n = 0;
  while (existsSync(candidate)) {
    n++;
    candidate = join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
