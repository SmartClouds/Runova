import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { RemoteFileProgress, RemoteLogLevel } from '../../shared/apiTypes';
import {
  BIN_SCREEN_TILE,
  encodeFileChunk,
  FILE_CHUNK_BYTES,
  PART_BYTES,
  type RemoteControlMessage,
  transferKeyFromId,
} from '../../shared/remoteProtocol';
import { setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import {
  cleanStalePartFiles,
  type FileTransferCallbacks,
  FileTransferManager,
  type FileTransferOptions,
} from './fileTransfer';

/** Every file handle opened while a test runs, so a test can check one was closed. */
const opened = vi.hoisted(() => [] as FileHandle[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    opened.push(handle);
    return handle;
  };
  return { ...actual, default: { ...actual, open }, open };
});

function lastOpened(): FileHandle {
  const handle = opened[opened.length - 1];
  if (!handle) throw new Error('no file was opened');
  return handle;
}

/**
 * Every byte this class moves goes through the injected `sendControl`/`sendBinary` callbacks, so
 * the socket itself is never read or written. Only `readyState` is consulted, to decide whether a
 * part can go out now or has to wait for a reconnect.
 */
const OPEN = 1 as const;
const CLOSED = 3 as const;

function fakeSocket(readyState: number = OPEN): WebSocket {
  return { readyState } as WebSocket;
}

interface Recorder {
  manager: FileTransferManager;
  control: RemoteControlMessage[];
  binary: Uint8Array[];
  logs: { level: RemoteLogLevel; message: string }[];
  progress: RemoteFileProgress[];
}

/** Every manager a test made, so a download it left half-received is closed before the next test. */
const managers: FileTransferManager[] = [];

function recorder(
  options: FileTransferOptions = {},
  extra: Partial<Pick<FileTransferCallbacks, 'flushed'>> = {},
): Recorder {
  const control: RemoteControlMessage[] = [];
  const binary: Uint8Array[] = [];
  const logs: { level: RemoteLogLevel; message: string }[] = [];
  const progress: RemoteFileProgress[] = [];
  const manager = new FileTransferManager(
    {
      sendControl: (_ws: WebSocket, msg: RemoteControlMessage) => {
        control.push(msg);
      },
      sendBinary: async (_ws: WebSocket, data: Uint8Array) => {
        binary.push(data);
      },
      log: (level: RemoteLogLevel, message: string) => {
        logs.push({ level, message });
      },
      emitProgress: (value: RemoteFileProgress) => {
        progress.push(value);
      },
      ...extra,
    },
    options,
  );
  managers.push(manager);
  return { manager, control, binary, logs, progress };
}

type ControlOf<T extends RemoteControlMessage['t']> = Extract<RemoteControlMessage, { t: T }>;

function allOf<T extends RemoteControlMessage['t']>(
  msgs: RemoteControlMessage[],
  t: T,
): ControlOf<T>[] {
  return msgs.filter((msg): msg is ControlOf<T> => msg.t === t);
}

function lastOf<T extends RemoteControlMessage['t']>(
  msgs: RemoteControlMessage[],
  t: T,
): ControlOf<T> {
  const found = allOf(msgs, t);
  if (found.length === 0) throw new Error(`no "${t}" message was sent`);
  return found[found.length - 1];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic bytes, so a hash mismatch always means the assembly really went wrong. */
function payload(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

let downloads = '';
let work = '';

beforeEach(() => {
  work = tempDir('runova-transfer-');
  downloads = join(work, 'Downloads');
  mkdirSync(downloads, { recursive: true });
  // Everything the receiver writes, temp part file included, hangs off this path.
  setElectronPath('downloads', downloads);
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.cancelAll('Test over.')));
  vi.useRealTimers();
  // A handle nobody closed is closed by garbage collection later, which Node raises as an
  // uncaught error in whichever test happens to be running.
  const leftOpen = opened.splice(0).filter((handle) => handle.fd !== -1);
  expect(leftOpen.map((handle) => handle.fd)).toEqual([]);
});

// --- Receiving -----------------------------------------------------------------

interface OfferOptions {
  transferId?: string;
  name?: string;
  size: number;
  partSize: number;
  destDir?: string;
}

async function offer(rec: Recorder, ws: WebSocket, options: OfferOptions) {
  const transferId = options.transferId ?? 'transfer-0001';
  const partCount = Math.max(1, Math.ceil(options.size / options.partSize));
  const before = allOf(rec.control, 'file-resume').length;
  rec.manager.handleControl(ws, {
    t: 'file-offer',
    transferId,
    name: options.name ?? 'report.bin',
    size: options.size,
    partSize: options.partSize,
    partCount,
    destDir: options.destDir,
  });
  await vi.waitFor(() => expect(allOf(rec.control, 'file-resume').length).toBeGreaterThan(before));
  return { transferId, partCount, key: transferKeyFromId(transferId) };
}

/**
 * Streams one part in as the sender would, waiting for each frame to be written before the next
 * goes out. `handlePartData` is fired without being awaited, so back-to-back frames would race on
 * the shared byte counter and land at the wrong offsets.
 */
async function streamPart(
  rec: Recorder,
  key: number,
  partIndex: number,
  bytes: Buffer,
  chunkSize = FILE_CHUNK_BYTES,
): Promise<void> {
  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    const before = rec.progress.length;
    rec.manager.handleBinary(
      encodeFileChunk({ transferKey: key, partIndex, seq: seq++, bytes: slice }),
    );
    await vi.waitFor(() => expect(rec.progress.length).toBeGreaterThan(before));
  }
}

/** Runs a whole incoming transfer and returns where the file ended up. */
async function receiveWhole(
  rec: Recorder,
  ws: WebSocket,
  options: OfferOptions & { bytes: Buffer; wholeHash?: string },
): Promise<ControlOf<'file-done'>> {
  const { transferId, partCount, key } = await offer(rec, ws, options);
  for (let part = 0; part < partCount; part++) {
    const slice = options.bytes.subarray(part * options.partSize, (part + 1) * options.partSize);
    await streamPart(rec, key, part, slice);
    rec.manager.handleControl(ws, {
      t: 'file-part-done',
      transferId,
      partIndex: part,
      hash: sha256(slice),
      size: slice.length,
    });
  }
  const done = allOf(rec.control, 'file-done').length;
  rec.manager.handleControl(ws, {
    t: 'file-complete',
    transferId,
    hash: options.wholeHash ?? sha256(options.bytes),
  });
  await vi.waitFor(() => expect(allOf(rec.control, 'file-done').length).toBeGreaterThan(done));
  return lastOf(rec.control, 'file-done');
}

describe('receiving a file', () => {
  it('opens a temp part file and asks for every part', async () => {
    const rec = recorder();
    const ws = fakeSocket();

    const { transferId } = await offer(rec, ws, { size: 40, partSize: 16 });

    const resume = lastOf(rec.control, 'file-resume');
    expect(resume).toMatchObject({ transferId, missingParts: [0, 1, 2] });
    // The part file is preallocated so parts can be written at their real offsets out of order.
    const tmpDir = join(downloads, '.runova-tmp');
    expect(readdirSync(tmpDir)).toEqual([`${transferId}.part`]);
    expect(rec.logs[0].level).toBe('info');
    expect(rec.progress[0]).toMatchObject({ direction: 'incoming', total: 40, partsTotal: 3 });
  });

  it('assembles the parts into the original bytes', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(40);

    const done = await receiveWhole(rec, ws, {
      size: 40,
      partSize: 16,
      bytes,
      name: 'report.bin',
    });

    expect(done.verified).toBe(true);
    expect(done.savedPath).toBe(join(downloads, 'report.bin'));
    expect(readFileSync(done.savedPath)).toEqual(bytes);
    // Each part gets its own positive ack, which is what lets a bad one be resent alone.
    expect(allOf(rec.control, 'file-part-ack').map((msg) => [msg.partIndex, msg.ok])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
  });

  it('writes into the destDir the sender picked when it exists', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const dest = join(work, 'Chosen');
    mkdirSync(dest);
    const bytes = payload(20);

    const done = await receiveWhole(rec, ws, { size: 20, partSize: 20, bytes, destDir: dest });

    expect(done.savedPath).toBe(join(dest, 'report.bin'));
  });

  it('falls back to Downloads when the sender names a folder we do not have', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(20);

    const done = await receiveWhole(rec, ws, {
      size: 20,
      partSize: 20,
      bytes,
      destDir: join(work, 'not-on-this-machine'),
    });

    expect(done.savedPath).toBe(join(downloads, 'report.bin'));
  });

  describe('part boundaries', () => {
    it('handles a file that is exactly one part long', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(64);

      const { partCount } = await offer(rec, ws, { size: 64, partSize: 64 });
      expect(partCount).toBe(1);

      const done = await receiveWhole(rec, ws, {
        transferId: 'transfer-exact',
        size: 64,
        partSize: 64,
        bytes,
      });
      expect(done.verified).toBe(true);
      expect(readFileSync(done.savedPath)).toEqual(bytes);
    });

    it('handles a file one byte past a part boundary', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(65);

      const done = await receiveWhole(rec, ws, { size: 65, partSize: 64, bytes });

      // The trailing 1 byte part is the case an off-by-one in the offset maths destroys.
      expect(allOf(rec.control, 'file-part-ack')).toHaveLength(2);
      expect(readFileSync(done.savedPath)).toEqual(bytes);
    });

    it('handles a part split across several wire frames', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(70);
      const ws2 = ws;

      const { transferId, key } = await offer(rec, ws2, { size: 70, partSize: 70 });
      // 7 byte frames inside one 70 byte part: seq must keep advancing the write offset.
      await streamPart(rec, key, 0, bytes, 7);
      rec.manager.handleControl(ws2, {
        t: 'file-part-done',
        transferId,
        partIndex: 0,
        hash: sha256(bytes),
        size: 70,
      });
      rec.manager.handleControl(ws2, { t: 'file-complete', transferId, hash: sha256(bytes) });
      await vi.waitFor(() => expect(allOf(rec.control, 'file-done')).toHaveLength(1));

      const done = lastOf(rec.control, 'file-done');
      expect(done.verified).toBe(true);
      expect(readFileSync(done.savedPath)).toEqual(bytes);
    });
  });

  describe('verification', () => {
    it('nacks a part whose hash does not match', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(16);

      const { transferId, key } = await offer(rec, ws, { size: 16, partSize: 16 });
      await streamPart(rec, key, 0, bytes);
      rec.manager.handleControl(ws, {
        t: 'file-part-done',
        transferId,
        partIndex: 0,
        hash: sha256(payload(16).map((b) => b ^ 0xff)),
        size: 16,
      });

      const ack = lastOf(rec.control, 'file-part-ack');
      expect(ack).toMatchObject({ partIndex: 0, ok: false });
      // A nacked part must not count as received, or the transfer would finish short.
      expect(lastOf(rec.control, 'file-resume').missingParts).toEqual([0]);
    });

    it('nacks a part-done for a part it was not receiving', async () => {
      const rec = recorder();
      const ws = fakeSocket();

      const { transferId } = await offer(rec, ws, { size: 32, partSize: 16 });
      rec.manager.handleControl(ws, {
        t: 'file-part-done',
        transferId,
        partIndex: 1,
        hash: sha256(payload(16)),
        size: 16,
      });

      expect(lastOf(rec.control, 'file-part-ack')).toMatchObject({ partIndex: 1, ok: false });
    });

    it('keeps the temp file and reports failure when the whole-file hash is wrong', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(32);

      const done = await receiveWhole(rec, ws, {
        size: 32,
        partSize: 16,
        bytes,
        wholeHash: 'f'.repeat(64),
      });

      expect(done.verified).toBe(false);
      // Not renamed into Downloads: a file that failed its end-to-end check must not look saved.
      expect(done.savedPath).toBe(join(downloads, '.runova-tmp', 'transfer-0001.part'));
      expect(existsSync(join(downloads, 'report.bin'))).toBe(false);
      expect(rec.logs.some((entry) => entry.level === 'error')).toBe(true);
      const last = rec.progress[rec.progress.length - 1];
      expect(last).toMatchObject({ verified: false, done: true });
      expect(last.error).toMatch(/hash/i);
    });
  });

  describe('naming the saved file', () => {
    it('numbers a name that is already taken', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, 'report.bin'), 'already here');
      const bytes = payload(16);

      const done = await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes });

      // Overwriting someone's existing download would be silent data loss.
      expect(done.savedPath).toBe(join(downloads, 'report (1).bin'));
      expect(readFileSync(join(downloads, 'report.bin'), 'utf-8')).toBe('already here');
    });

    it('keeps counting past the first collision', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, 'report.bin'), 'a');
      writeFileSync(join(downloads, 'report (1).bin'), 'b');

      const done = await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes: payload(16) });

      expect(done.savedPath).toBe(join(downloads, 'report (2).bin'));
    });

    it('numbers an extensionless name without inventing an extension', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, 'README'), 'a');

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name: 'README',
      });

      expect(done.savedPath).toBe(join(downloads, 'README (1)'));
    });

    it('treats a leading dot as part of the name, not an extension', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, '.env'), 'a');

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name: '.env',
      });

      expect(done.savedPath).toBe(join(downloads, '.env (1)'));
    });

    it.each([
      ['../../escape.txt', '.._.._escape.txt'],
      ['C:\\Windows\\evil.dll', 'C__Windows_evil.dll'],
      ['re<port>:|?*.bin', 're_port_____.bin'],
    ])('sanitizes %s into a plain filename', async (name, expected) => {
      const rec = recorder();
      const ws = fakeSocket();

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name,
      });

      // A peer-supplied name must never steer the write outside the chosen folder.
      expect(done.savedPath).toBe(join(downloads, expected));
      expect(existsSync(done.savedPath)).toBe(true);
    });

    it('falls back to a placeholder when the peer sends an empty name', async () => {
      const rec = recorder();
      const ws = fakeSocket();

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name: '',
      });

      expect(done.savedPath).toBe(join(downloads, 'received-file'));
    });
  });

  describe('binary routing', () => {
    it('leaves a frame that is not a file chunk to another handler', () => {
      const rec = recorder();
      const tile = new Uint8Array([BIN_SCREEN_TILE, 0, 0, 0]);
      expect(rec.manager.handleBinary(tile)).toBe(false);
    });

    it('claims a file chunk for a transfer it does not know, without crashing', () => {
      const rec = recorder();
      const frame = encodeFileChunk({
        transferKey: transferKeyFromId('never-offered'),
        partIndex: 0,
        seq: 0,
        bytes: new Uint8Array([1, 2, 3]),
      });
      // Claimed so the socket layer does not try to parse it as something else.
      expect(rec.manager.handleBinary(frame)).toBe(true);
    });

    it('ignores a stray frame for a part it is not currently receiving', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(32);

      const { transferId, key } = await offer(rec, ws, { size: 32, partSize: 16 });
      await streamPart(rec, key, 0, bytes.subarray(0, 16));

      const before = rec.progress.length;
      // seq > 0 for a different part: a late frame from a part that was already abandoned.
      rec.manager.handleBinary(
        encodeFileChunk({ transferKey: key, partIndex: 1, seq: 4, bytes: payload(8) }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rec.progress.length).toBe(before);

      rec.manager.handleControl(ws, {
        t: 'file-part-done',
        transferId,
        partIndex: 0,
        hash: sha256(bytes.subarray(0, 16)),
        size: 16,
      });
      expect(lastOf(rec.control, 'file-part-ack').ok).toBe(true);
    });
  });

  it('rebinds an existing transfer instead of starting over on a re-offer', async () => {
    const rec = recorder();
    const first = fakeSocket();
    const bytes = payload(32);

    const { transferId, key } = await offer(rec, first, { size: 32, partSize: 16 });
    await streamPart(rec, key, 0, bytes.subarray(0, 16));
    rec.manager.handleControl(first, {
      t: 'file-part-done',
      transferId,
      partIndex: 0,
      hash: sha256(bytes.subarray(0, 16)),
      size: 16,
    });

    const second = fakeSocket();
    await offer(rec, second, { transferId, size: 32, partSize: 16 });

    // The part already on disk must not be asked for again, that is the whole resume mechanism.
    expect(lastOf(rec.control, 'file-resume').missingParts).toEqual([1]);
    expect(readdirSync(join(downloads, '.runova-tmp'))).toEqual([`${transferId}.part`]);
  });
});

// --- Sending -------------------------------------------------------------------

describe('sending a file', () => {
  it('offers the file with a part count derived from its size', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(1234));

    await rec.manager.startUpload(ws, source);

    expect(lastOf(rec.control, 'file-offer')).toMatchObject({
      name: 'payload.bin',
      size: 1234,
      partSize: PART_BYTES,
      partCount: 1,
    });
    expect(rec.logs[0]).toMatchObject({ level: 'info' });
    expect(rec.progress[0]).toMatchObject({ direction: 'outgoing', total: 1234, partsTotal: 1 });
    expect(rec.manager.hasActiveTransfers()).toBe(true);
  });

  it('passes the requested destination folder along in the offer', async () => {
    const rec = recorder();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(8));

    await rec.manager.startUpload(fakeSocket(), source, '/peer/Desktop');

    expect(lastOf(rec.control, 'file-offer').destDir).toBe('/peer/Desktop');
  });

  it('rejects rather than inventing a transfer when the file is missing', async () => {
    const rec = recorder();
    await expect(rec.manager.startUpload(fakeSocket(), join(work, 'nope.bin'))).rejects.toThrow();
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  describe('part count at the boundary', () => {
    it.each([
      ['empty', 0, 1],
      ['one byte', 1, 1],
      ['exactly one part', PART_BYTES, 1],
      ['one byte over a part', PART_BYTES + 1, 2],
      ['exactly two parts', PART_BYTES * 2, 2],
    ])('reports %s as %i byte(s) in the right number of parts', async (_label, size, expected) => {
      const rec = recorder();
      const source = join(work, 'sized.bin');
      // Preallocated rather than written byte by byte, so a 20MB case stays fast.
      const handle = await open(source, 'w');
      await handle.truncate(size);
      await handle.close();

      await rec.manager.startUpload(fakeSocket(), source);

      expect(lastOf(rec.control, 'file-offer')).toMatchObject({ size, partCount: expected });
    });
  });

  it('streams the requested part and announces its hash', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(FILE_CHUNK_BYTES + 100);
    const source = join(work, 'payload.bin');
    writeFileSync(source, bytes);
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));

    // Two frames, because the part is one 64KB chunk plus a remainder.
    expect(rec.binary).toHaveLength(2);
    expect(lastOf(rec.control, 'file-part-done')).toMatchObject({
      partIndex: 0,
      hash: sha256(bytes),
      size: bytes.length,
    });
  });

  it('completes with the whole-file hash once the last part is acked', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(512);
    const source = join(work, 'payload.bin');
    writeFileSync(source, bytes);
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 0, ok: true });

    // The end-to-end hash is read off the file again, so a resume can never leave a part out of it.
    await vi.waitFor(() =>
      expect(lastOf(rec.control, 'file-complete')).toMatchObject({ hash: sha256(bytes) }),
    );
  });

  it('ignores a stale ack for a part it is no longer waiting on', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 7, ok: true });

    expect(allOf(rec.control, 'file-complete')).toHaveLength(0);
  });

  it('resends a part the receiver rejected', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 0, ok: false });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(2));

    expect(rec.binary).toHaveLength(2);
    expect(rec.progress[rec.progress.length - 1].currentPartRetry).toBe(1);
  });

  it('gives up after too many rejected retries of the same part', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    for (let attempt = 0; attempt <= 6; attempt++) {
      await vi.waitFor(() =>
        expect(allOf(rec.control, 'file-part-done').length).toBeGreaterThanOrEqual(attempt + 1),
      );
      rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 0, ok: false });
      if (allOf(rec.control, 'file-error').length > 0) break;
    }

    // Five retries is the cap; without it a broken link would resend forever.
    expect(lastOf(rec.control, 'file-error').message).toMatch(/failed too many times/i);
    expect(rec.logs.some((entry) => entry.level === 'error')).toBe(true);
    expect(rec.progress[rec.progress.length - 1]).toMatchObject({ done: true, verified: false });
  });

  it('holds the part back while the socket is closed', async () => {
    const rec = recorder();
    const ws = fakeSocket(CLOSED);
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Writing into a dead socket would burn the retry budget for nothing.
    expect(rec.binary).toHaveLength(0);
    expect(allOf(rec.control, 'file-part-done')).toHaveLength(0);
  });

  it('marks the parts the receiver already has as done on resume', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    const handle = await open(source, 'w');
    await handle.truncate(PART_BYTES * 2 + 1);
    await handle.close();
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [2] });

    // Parts 0 and 1 are credited without being resent, which is what resume is for.
    const progress = rec.progress[rec.progress.length - 1];
    expect(progress.partsCompleted).toBe(2);
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    expect(lastOf(rec.control, 'file-part-done').partIndex).toBe(2);
  });

  it('records a successful receipt', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(16));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, {
      t: 'file-done',
      transferId,
      savedPath: '/peer/Downloads/payload.bin',
      verified: true,
    });

    expect(rec.logs[rec.logs.length - 1]).toMatchObject({ level: 'success' });
    expect(rec.progress[rec.progress.length - 1]).toMatchObject({ done: true, verified: true });
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  it('records a receipt the peer could not verify as a failure', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(16));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, {
      t: 'file-done',
      transferId,
      savedPath: '/peer/tmp/x.part',
      verified: false,
    });

    const last = rec.progress[rec.progress.length - 1];
    expect(last).toMatchObject({ done: true, verified: false });
    expect(last.error).toMatch(/hash/i);
  });
});

describe('file-request from the peer', () => {
  it('accepts and immediately offers the file', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'shared.bin');
    writeFileSync(source, payload(24));

    rec.manager.handleControl(ws, { t: 'file-request', reqId: 'r1', path: source });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-offer')).toHaveLength(1));

    expect(lastOf(rec.control, 'file-request-ack')).toMatchObject({ reqId: 'r1', ok: true });
    expect(lastOf(rec.control, 'file-offer')).toMatchObject({ name: 'shared.bin', size: 24 });
  });

  it('declines a directory', async () => {
    const rec = recorder();
    const ws = fakeSocket();

    rec.manager.handleControl(ws, { t: 'file-request', reqId: 'r1', path: work });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-request-ack')).toHaveLength(1));

    expect(lastOf(rec.control, 'file-request-ack')).toMatchObject({
      ok: false,
      error: 'Not a file.',
    });
    expect(allOf(rec.control, 'file-offer')).toHaveLength(0);
  });

  it('declines a path that is not there', async () => {
    const rec = recorder();
    const ws = fakeSocket();

    rec.manager.handleControl(ws, { t: 'file-request', reqId: 'r1', path: join(work, 'ghost') });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-request-ack')).toHaveLength(1));

    const ack = lastOf(rec.control, 'file-request-ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/ENOENT|no such file/i);
  });
});

// --- Lifecycle -----------------------------------------------------------------

describe('reconnect handling', () => {
  it('parks a transfer instead of failing it when the socket drops', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);

    rec.manager.onConnectionLost(ws);

    const last = rec.progress[rec.progress.length - 1];
    expect(last.resuming).toBe(true);
    expect(last.done).toBe(false);
    // Still "active" as far as quitting is concerned, so the app warns before closing.
    expect(rec.manager.hasActiveTransfers()).toBe(true);
  });

  it('leaves a transfer bound to another socket alone', async () => {
    const rec = recorder();
    const mine = fakeSocket();
    const other = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(mine, source);

    const before = rec.progress.length;
    rec.manager.onConnectionLost(other);

    expect(rec.progress.length).toBe(before);
  });

  it('re-offers an upload when the peer comes back', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;
    rec.manager.onConnectionLost(ws);

    rec.manager.resumeAfterReconnect(fakeSocket());

    // The same transferId is what tells the peer to keep the bytes it already has.
    expect(lastOf(rec.control, 'file-offer')).toMatchObject({ transferId, partCount: 1 });
    expect(rec.progress[rec.progress.length - 1].resuming).toBe(false);
  });

  it('re-asks for the missing parts of a download when the peer comes back', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(32);
    const { transferId, key } = await offer(rec, ws, { size: 32, partSize: 16 });
    await streamPart(rec, key, 0, bytes.subarray(0, 16));
    rec.manager.handleControl(ws, {
      t: 'file-part-done',
      transferId,
      partIndex: 0,
      hash: sha256(bytes.subarray(0, 16)),
      size: 16,
    });
    rec.manager.onConnectionLost(ws);

    rec.manager.resumeAfterReconnect(fakeSocket());

    expect(lastOf(rec.control, 'file-resume')).toMatchObject({ transferId, missingParts: [1] });
  });

  it('leaves a finished transfer out of the resume sweep', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes: payload(16) });

    const before = rec.control.length;
    rec.manager.resumeAfterReconnect(fakeSocket());

    expect(rec.control.length).toBe(before);
  });
});

describe('cancellation', () => {
  it('cancels every transfer when the user disconnects', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    await offer(rec, ws, { transferId: 'incoming-1', size: 16, partSize: 16 });

    rec.manager.cancelAll('Disconnected.');

    const finals = rec.progress.slice(-2);
    expect(finals.every((entry) => entry.done)).toBe(true);
    expect(finals.every((entry) => entry.error === 'Disconnected.')).toBe(true);
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  it('closes the temp file of a download it cancels', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    await offer(rec, ws, { size: 16, partSize: 16 });
    const handle = lastOpened();

    await rec.manager.cancelAll('Disconnected.');

    // Left to garbage collection, the handle surfaces as an uncaught ERR_INVALID_STATE.
    expect(handle.fd).toBe(-1);
  });

  it('writes nothing for a frame that arrives after the download was cancelled', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId, key } = await offer(rec, ws, { size: 16, partSize: 16 });
    const write = vi.spyOn(lastOpened(), 'write');
    rec.manager.handleControl(ws, { t: 'file-cancel', transferId });

    rec.manager.handleBinary(
      encodeFileChunk({ transferKey: key, partIndex: 0, seq: 0, bytes: payload(16) }),
    );

    expect(write).not.toHaveBeenCalled();
  });

  it('honours a cancel from the peer', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });

    rec.manager.handleControl(ws, { t: 'file-cancel', transferId });

    expect(rec.progress[rec.progress.length - 1]).toMatchObject({
      done: true,
      error: 'Cancelled by peer.',
    });
  });

  it('honours an error from the peer', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });

    rec.manager.handleControl(ws, { t: 'file-error', transferId, message: 'Disk full.' });

    expect(rec.progress[rec.progress.length - 1].error).toBe('Disk full.');
  });

  it('does not un-finish a transfer that already completed', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes: payload(16) });

    const before = rec.progress.length;
    rec.manager.cancelAll('Disconnected.');

    expect(rec.progress.length).toBe(before);
  });

  it('claims a control message for a transfer it has never heard of', () => {
    const rec = recorder();
    // Claimed rather than passed on: another handler would only log it as unknown.
    expect(rec.manager.handleControl(fakeSocket(), { t: 'file-cancel', transferId: 'x' })).toBe(
      true,
    );
    expect(rec.manager.handleControl(fakeSocket(), { t: 'ping' })).toBe(false);
  });
});

describe('progress snapshots', () => {
  it('reports every live transfer for a freshly opened window', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    await offer(rec, ws, { transferId: 'incoming-1', size: 32, partSize: 16, name: 'in.bin' });

    const snapshot = rec.manager.listProgress();

    expect(snapshot.map((entry) => entry.direction).sort()).toEqual(['incoming', 'outgoing']);
    expect(snapshot.find((entry) => entry.direction === 'incoming')).toMatchObject({
      name: 'in.bin',
      total: 32,
      partsTotal: 2,
      partsCompleted: 0,
    });
  });

  it('never reports more transferred than the file holds', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(20);

    await receiveWhole(rec, ws, { size: 20, partSize: 16, bytes });

    // The last part is 4 bytes, but completedParts * partSize would claim 32.
    for (const entry of rec.progress) expect(entry.transferred).toBeLessThanOrEqual(20);
  });
});

describe('cleanup', () => {
  it('deletes the temp part file shortly after a cancelled download', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });
    const tmpPath = join(downloads, '.runova-tmp', `${transferId}.part`);
    expect(existsSync(tmpPath)).toBe(true);

    rec.manager.handleControl(ws, { t: 'file-cancel', transferId });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(existsSync(tmpPath)).toBe(false));

    // Half-received files must not pile up in Downloads/.runova-tmp forever.
    expect(rec.manager.listProgress()).toEqual([]);
  });

  it('keeps the temp file of a transfer that is only waiting to reconnect', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });
    const tmpPath = join(downloads, '.runova-tmp', `${transferId}.part`);

    rec.manager.onConnectionLost(ws);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(existsSync(tmpPath)).toBe(true);
    expect(rec.manager.hasActiveTransfers()).toBe(true);
  });

  it('abandons a transfer that never reconnects', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });
    const tmpPath = join(downloads, '.runova-tmp', `${transferId}.part`);
    rec.manager.onConnectionLost(ws);

    // Five minutes of silence is the point where waiting stops being worth the disk space.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);

    expect(rec.progress[rec.progress.length - 1].error).toMatch(/Gave up waiting/);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(existsSync(tmpPath)).toBe(false));
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  it('retries a part the receiver never acked', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(2));

    // A silently dropped ack should cost one part, not the whole transfer.
    expect(rec.progress[rec.progress.length - 1].currentPartRetry).toBe(1);
  });
});

// --- What a send asks of the engine (E112) ---------------------------------------

describe('a manager that only sends', () => {
  it('turns an offer away, since a sender takes no files', async () => {
    const rec = recorder({ role: 'sender' });
    const ws = fakeSocket();

    const claimed = rec.manager.handleControl(ws, {
      t: 'file-offer',
      transferId: 'sneaky',
      name: 'payload.exe',
      size: 4,
      partSize: 4,
      partCount: 1,
    });

    expect(claimed).toBe(true);
    await vi.waitFor(() => expect(lastOf(rec.control, 'file-error').transferId).toBe('sneaky'));
    expect(allOf(rec.control, 'file-resume')).toHaveLength(0);
    expect(existsSync(join(downloads, '.runova-tmp'))).toBe(false);
  });

  it('serves no file the peer asks for', async () => {
    const rec = recorder({ role: 'sender' });
    const source = join(work, 'secret.txt');
    writeFileSync(source, 'mine');

    rec.manager.handleControl(fakeSocket(), { t: 'file-request', reqId: 'r1', path: source });

    await vi.waitFor(() => expect(lastOf(rec.control, 'file-request-ack').ok).toBe(false));
    expect(allOf(rec.control, 'file-offer')).toHaveLength(0);
  });
});

describe('a manager that only receives', () => {
  it('serves no file the peer asks for', async () => {
    const rec = recorder({ role: 'receiver' });
    const source = join(work, 'secret.txt');
    writeFileSync(source, 'mine');

    rec.manager.handleControl(fakeSocket(), { t: 'file-request', reqId: 'r2', path: source });

    await vi.waitFor(() =>
      expect(lastOf(rec.control, 'file-request-ack')).toMatchObject({ ok: false }),
    );
    expect(allOf(rec.control, 'file-offer')).toHaveLength(0);
  });
});

describe('deciding where an offered file goes', () => {
  it('saves where the hook says, ignoring the folder the sender named', async () => {
    const inbox = join(work, 'Inbox');
    const dest = join(inbox, 'Holiday');
    const acceptOffer = vi.fn(async () => ({
      destDir: dest,
      partDir: join(inbox, '.runova-partial'),
    }));
    const rec = recorder({ role: 'receiver', acceptOffer });
    const bytes = payload(20);
    const elsewhere = join(work, 'Elsewhere');
    mkdirSync(elsewhere);

    const done = await receiveWhole(rec, fakeSocket(), {
      transferId: 'hooked-1',
      size: 20,
      partSize: 16,
      bytes,
      destDir: elsewhere,
    });

    expect(acceptOffer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: 'hooked-1', name: 'report.bin', size: 20 }),
    );
    expect(done).toMatchObject({ verified: true, savedPath: join(dest, 'report.bin') });
    expect(readFileSync(join(dest, 'report.bin'))).toEqual(bytes);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('saves under the name the hook gives', async () => {
    const inbox = join(work, 'Inbox');
    const rec = recorder({
      role: 'receiver',
      acceptOffer: async () => ({ destDir: inbox, name: 'CON_.txt' }),
    });

    const done = await receiveWhole(rec, fakeSocket(), {
      transferId: 'named-1',
      name: 'CON.txt',
      size: 8,
      partSize: 8,
      bytes: payload(8),
    });

    // Windows keeps CON for a device; only the receiver's own rule mends it.
    expect(done.savedPath).toBe(join(inbox, 'CON_.txt'));
  });

  it('keeps the part file beside the target, not in Downloads', async () => {
    const inbox = join(work, 'Inbox');
    const partDir = join(inbox, '.runova-partial');
    const rec = recorder({
      role: 'receiver',
      acceptOffer: async () => ({ destDir: inbox, partDir }),
    });

    await offer(rec, fakeSocket(), { transferId: 'beside-1', size: 40, partSize: 16 });

    expect(readdirSync(partDir)).toEqual(['beside-1.part']);
    expect(existsSync(join(downloads, '.runova-tmp'))).toBe(false);
  });

  it('turns an offer away when the hook says no', async () => {
    const rec = recorder({
      role: 'receiver',
      acceptOffer: async () => ({ refuse: 'That file is not in the list you accepted.' }),
    });

    rec.manager.handleControl(fakeSocket(), {
      t: 'file-offer',
      transferId: 'unlisted',
      name: 'extra.bin',
      size: 4,
      partSize: 4,
      partCount: 1,
    });

    await vi.waitFor(() =>
      expect(lastOf(rec.control, 'file-error')).toMatchObject({
        transferId: 'unlisted',
        message: 'That file is not in the list you accepted.',
      }),
    );
    expect(allOf(rec.control, 'file-resume')).toHaveLength(0);
  });

  it('turns away an offer whose part count does not fit its size', async () => {
    const rec = recorder();

    rec.manager.handleControl(fakeSocket(), {
      t: 'file-offer',
      transferId: 'lying',
      name: 'big.bin',
      size: 40,
      partSize: 16,
      partCount: 1_000_000,
    });

    await vi.waitFor(() => expect(lastOf(rec.control, 'file-error').transferId).toBe('lying'));
    expect(allOf(rec.control, 'file-resume')).toHaveLength(0);
  });

  it('fails the file, and tells the sender, when it can not be moved into place', async () => {
    const inbox = join(work, 'Inbox');
    const dest = join(inbox, 'Holiday');
    const rec = recorder({
      role: 'receiver',
      acceptOffer: async () => ({ destDir: dest, partDir: join(inbox, '.runova-partial') }),
    });
    const ws = fakeSocket();
    const bytes = payload(16);
    const { transferId, key } = await offer(rec, ws, {
      transferId: 'blocked-1',
      size: 16,
      partSize: 16,
    });
    await streamPart(rec, key, 0, bytes);
    rec.manager.handleControl(ws, {
      t: 'file-part-done',
      transferId,
      partIndex: 0,
      hash: sha256(bytes),
      size: 16,
    });
    // Someone puts a file where the folder was, so the move has nowhere to go.
    rmSync(dest, { recursive: true, force: true });
    writeFileSync(dest, 'in the way');

    rec.manager.handleControl(ws, { t: 'file-complete', transferId, hash: sha256(bytes) });

    await vi.waitFor(() =>
      expect(lastOf(rec.control, 'file-error').message).toMatch(/could not save/i),
    );
    expect(allOf(rec.control, 'file-done')).toHaveLength(0);
    expect(rec.progress[rec.progress.length - 1]).toMatchObject({ done: true, verified: false });
  });
});

describe('a file offered again', () => {
  it('rebinds only when the offer is for the same file', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    await offer(rec, ws, { transferId: 'same-1', size: 40, partSize: 16 });

    rec.manager.handleControl(ws, {
      t: 'file-offer',
      transferId: 'same-1',
      name: 'report.bin',
      size: 41,
      partSize: 16,
      partCount: 3,
    });

    await vi.waitFor(() =>
      expect(lastOf(rec.control, 'file-error').message).toMatch(/does not match/i),
    );
    expect(allOf(rec.control, 'file-resume')).toHaveLength(1);
  });

  it('answers a file it already saved with the same receipt instead of saving it twice', async () => {
    const rec = recorder({ forgetAfterMs: 0 });
    const ws = fakeSocket();
    const first = await receiveWhole(rec, ws, {
      transferId: 'twice-1',
      size: 20,
      partSize: 16,
      bytes: payload(20),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    rec.manager.handleControl(ws, {
      t: 'file-offer',
      transferId: 'twice-1',
      name: 'report.bin',
      size: 20,
      partSize: 16,
      partCount: 2,
    });

    await vi.waitFor(() => expect(allOf(rec.control, 'file-done')).toHaveLength(2));
    expect(lastOf(rec.control, 'file-done')).toEqual(first);
    expect(readdirSync(downloads).filter((name) => name.endsWith('.bin'))).toEqual(['report.bin']);
  });
});

describe('sending under a given id and part size', () => {
  it('offers the file with the id, name and part size it is given', async () => {
    const rec = recorder({ role: 'sender', partBytes: 64 * 1024 });
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(100_000));

    await rec.manager.startUpload(fakeSocket(), source, undefined, {
      transferId: 'send-1',
      name: 'Renamed.bin',
    });

    expect(lastOf(rec.control, 'file-offer')).toMatchObject({
      transferId: 'send-1',
      name: 'Renamed.bin',
      partSize: 64 * 1024,
      partCount: 2,
    });
  });

  it('refuses an id it is already using', async () => {
    const rec = recorder({ role: 'sender' });
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(10));
    await rec.manager.startUpload(fakeSocket(), source, undefined, { transferId: 'dup' });

    await expect(
      rec.manager.startUpload(fakeSocket(), source, undefined, { transferId: 'dup' }),
    ).rejects.toThrow(/already/i);
  });
});

describe('the whole-file hash', () => {
  it('stays right when the link drops with an ack on the way', async () => {
    const rec = recorder({ partBytes: 64 * 1024 });
    const bytes = payload(64 * 1024 * 2 + 10);
    const source = join(work, 'payload.bin');
    writeFileSync(source, bytes);
    const first = fakeSocket();
    await rec.manager.startUpload(first, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;
    rec.manager.handleControl(first, { t: 'file-resume', transferId, missingParts: [0, 1, 2] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));

    // The receiver acked part 0, but the link went before the ack got here.
    rec.manager.onConnectionLost(first);
    const second = fakeSocket();
    rec.manager.resumeAfterReconnect(second);
    rec.manager.handleControl(second, { t: 'file-resume', transferId, missingParts: [1, 2] });
    for (const part of [1, 2]) {
      await vi.waitFor(() => expect(lastOf(rec.control, 'file-part-done').partIndex).toBe(part));
      rec.manager.handleControl(second, {
        t: 'file-part-ack',
        transferId,
        partIndex: part,
        ok: true,
      });
    }

    await vi.waitFor(() => expect(allOf(rec.control, 'file-complete')).toHaveLength(1));
    expect(lastOf(rec.control, 'file-complete').hash).toBe(sha256(bytes));
  });
});

describe('waiting for the link to drain', () => {
  it('starts the ack clock only once the part has left', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const flushed = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const rec = recorder({}, { flushed });
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;
    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(flushed).toHaveBeenCalled());

    // A slow link still holds the part: no answer is overdue yet, however long that takes.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(allOf(rec.control, 'file-part-done')).toHaveLength(1);

    release();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(2));
  });
});

describe('waiting for a reconnect', () => {
  it('waits as long as it is told to before giving up', async () => {
    vi.useFakeTimers();
    const rec = recorder({ reconnectAbandonMs: 7 * 60_000 });
    const ws = fakeSocket();
    await offer(rec, ws, { size: 16, partSize: 16 });
    rec.manager.onConnectionLost(ws);

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(rec.manager.hasActiveTransfers()).toBe(true);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(rec.progress[rec.progress.length - 1].error).toMatch(/Gave up waiting/);
  });
});

describe('closing down', () => {
  it('stops its sweep and closes half-received files when disposed', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const rec = recorder();
    await offer(rec, fakeSocket(), { size: 40, partSize: 16 });

    await rec.manager.dispose();

    expect(clear).toHaveBeenCalled();
    expect(lastOpened().fd).toBe(-1);
    expect(rec.manager.hasActiveTransfers()).toBe(false);
    clear.mockRestore();
  });
});

describe('part files a crash left behind', () => {
  it('removes those older than the age it is given and keeps the rest', async () => {
    const dir = join(work, '.runova-partial');
    mkdirSync(dir);
    writeFileSync(join(dir, 'old.part'), 'x');
    writeFileSync(join(dir, 'fresh.part'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const twoDaysAgo = (Date.now() - 2 * 24 * 3600_000) / 1000;
    utimesSync(join(dir, 'old.part'), twoDaysAgo, twoDaysAgo);

    await cleanStalePartFiles(dir, 24 * 3600_000);

    expect(readdirSync(dir).sort()).toEqual(['fresh.part', 'notes.txt']);
  });

  it('does nothing for a folder that is not there', async () => {
    await expect(cleanStalePartFiles(join(work, 'missing'), 1)).resolves.toBeUndefined();
  });
});

describe('frames that arrive back to back', () => {
  it('lands each at its own offset, so the part checks out without waiting between frames', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(FILE_CHUNK_BYTES * 3 + 500);
    const { transferId, key } = await offer(rec, ws, {
      transferId: 'burst-1',
      size: bytes.length,
      partSize: bytes.length,
    });

    // A fast link hands over every frame of a part before the first write is done.
    let seq = 0;
    for (let at = 0; at < bytes.length; at += FILE_CHUNK_BYTES) {
      rec.manager.handleBinary(
        encodeFileChunk({
          transferKey: key,
          partIndex: 0,
          seq: seq++,
          bytes: bytes.subarray(at, at + FILE_CHUNK_BYTES),
        }),
      );
    }
    rec.manager.handleControl(ws, {
      t: 'file-part-done',
      transferId,
      partIndex: 0,
      hash: sha256(bytes),
      size: bytes.length,
    });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-ack')).toHaveLength(1));
    rec.manager.handleControl(ws, { t: 'file-complete', transferId, hash: sha256(bytes) });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-done')).toHaveLength(1));

    expect(lastOf(rec.control, 'file-part-ack').ok).toBe(true);
    const done = lastOf(rec.control, 'file-done');
    expect(done.verified).toBe(true);
    expect(readFileSync(done.savedPath)).toEqual(bytes);
  });
});
