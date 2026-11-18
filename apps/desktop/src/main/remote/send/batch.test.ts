import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendBatchView, SendPeerView } from '../../../shared/fileSend';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { type MemoryLink, memoryLinkPair } from '../../../test/main/memoryLink';
import { IncomingBatch, type IncomingBatchOptions, OutgoingBatch, openInbox } from './batch';
import { buildManifest } from './manifest';

const toSam: SendPeerView = {
  name: 'Sam Lee',
  email: 'sam@example.com',
  deviceName: 'Sam desk',
  platform: 'windows',
  kind: 'computer',
  relation: 'teammate',
  remoteId: '482193775',
};
const fromAli: SendPeerView = { ...toSam, name: 'Ali Rezaei', deviceName: 'Ali laptop' };

/** Deterministic bytes, so a mix-up between files or parts shows in the comparison. */
function bytes(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const open: { out: OutgoingBatch[]; in: IncomingBatch[] } = { out: [], in: [] };

afterEach(async () => {
  for (const batch of open.out.splice(0)) await batch.dispose();
  for (const batch of open.in.splice(0)) await batch.dispose();
  vi.useRealTimers();
});

interface Setup {
  out: OutgoingBatch;
  incoming: Promise<IncomingBatch>;
  links: [MemoryLink, MemoryLink];
  inbox: string;
  outViews: SendBatchView[];
}

async function setup(
  pick: (root: string) => string[],
  options: {
    out?: Partial<ConstructorParameters<typeof OutgoingBatch>[0]>;
    in?: Partial<IncomingBatchOptions>;
  } = {},
): Promise<Setup> {
  const root = tempDir('runova-send-');
  const inbox = tempDir('runova-inbox-');
  const manifest = await buildManifest(pick(root));
  const outViews: SendBatchView[] = [];
  const out: OutgoingBatch = new OutgoingBatch({
    batchId: 'batch-1',
    manifest,
    note: 'For the review',
    peer: toSam,
    changed: () => outViews.push(out.view()),
    dropped: () => undefined,
    ended: () => undefined,
    partBytes: 64 * 1024,
    ...options.out,
  });
  open.out.push(out);
  const links = memoryLinkPair();
  out.attach(links[0], 'direct');
  const incoming = (async () => {
    const inboxReader = openInbox(links[1]);
    const offer = await inboxReader.firstOffer(5_000);
    if (!offer) throw new Error('no offer came');
    const batch = new IncomingBatch(links[1], inboxReader, offer, {
      peer: fromAli,
      senderKey: 'ali-key',
      folder: inbox,
      changed: () => undefined,
      ended: () => undefined,
      ...options.in,
    });
    open.in.push(batch);
    return batch;
  })();
  return { out, incoming, links, inbox, outViews };
}

function tree(root: string): string[] {
  writeTree(root, {});
  writeFileSync(join(root, 'report.pdf'), bytes(150_000, 1));
  writeTree(root, { 'Holiday/notes.txt': 'beach day' });
  writeFileSync(join(root, 'Holiday', 'beach.jpg'), bytes(70_000, 2));
  return [join(root, 'report.pdf'), join(root, 'Holiday')];
}

describe('sending a batch', () => {
  it('offers the list, and once accepted every file arrives under the folder the receiver chose', async () => {
    const { out, incoming, inbox } = await setup(tree);
    const batch = await incoming;

    expect(out.view()).toMatchObject({ phase: 'waiting', fileCount: 3, note: 'For the review' });
    expect(batch.view()).toMatchObject({ phase: 'asking', direction: 'in', fileCount: 3 });
    expect(batch.offerView()?.entries).toEqual([
      { name: 'report.pdf', kind: 'file', size: 150_000, fileCount: 1 },
      { name: 'Holiday', kind: 'folder', size: 70_009, fileCount: 2 },
    ]);

    await batch.accept({});

    await vi.waitFor(() => expect(out.view().phase).toBe('done'), { timeout: 10_000 });
    await vi.waitFor(() => expect(batch.view().phase).toBe('done'));
    expect(out.view()).toMatchObject({ doneFiles: 3, failedFiles: 0, transferredBytes: 220_009 });
    expect(readFileSync(join(inbox, 'report.pdf'))).toEqual(bytes(150_000, 1));
    expect(readFileSync(join(inbox, 'Holiday', 'beach.jpg'))).toEqual(bytes(70_000, 2));
    expect(readFileSync(join(inbox, 'Holiday', 'notes.txt'), 'utf8')).toBe('beach day');
    // No part file is left behind once everything is in place.
    expect(readdirSync(join(inbox, '.runova-partial'))).toEqual([]);
  });

  it('moves several small files at once rather than one round trip each', async () => {
    let busiest = 0;
    const many = (root: string) => {
      writeTree(
        root,
        Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`many/f${i}.txt`, `file ${i}`])),
      );
      return [join(root, 'many')];
    };
    const holder: { out?: OutgoingBatch } = {};
    const { out, incoming } = await setup(many, {
      out: {
        changed: () => {
          const active = holder.out?.view().files.filter((file) => file.status === 'active');
          busiest = Math.max(busiest, active?.length ?? 0);
        },
      },
    });
    holder.out = out;
    await (await incoming).accept({});

    await vi.waitFor(() => expect(out.view().phase).toBe('done'), { timeout: 10_000 });
    expect(busiest).toBeGreaterThan(1);
    expect(busiest).toBeLessThanOrEqual(4);
  });

  it('tells the sender who declined', async () => {
    const { out, incoming, links } = await setup(tree);

    (await incoming).decline();

    await vi.waitFor(() => expect(out.view().phase).toBe('declined'));
    expect(out.view().reason).toBe('Declined by Sam.');
    await vi.waitFor(() => expect(links[0].readyState).not.toBe(1));
  });

  it('stops waiting when no one answers in the time it gives', async () => {
    vi.useFakeTimers();
    const { out, incoming } = await setup(tree, { out: { answerTimeoutMs: 5_000 } });
    const batch = await incoming;

    await vi.advanceTimersByTimeAsync(5_001);

    expect(out.view()).toMatchObject({ phase: 'expired', reason: 'No one answered in time.' });
    await vi.waitFor(() => expect(batch.view().phase).toBe('expired'));
  });

  it('declines on its own when the person here never answers', async () => {
    vi.useFakeTimers();
    const { out, incoming } = await setup(tree, { in: { answerTimeoutMs: 3_000 } });
    const batch = await incoming;

    await vi.advanceTimersByTimeAsync(3_001);

    expect(batch.view().phase).toBe('expired');
    await vi.waitFor(() => expect(out.view().phase).toBe('expired'));
    expect(out.view().reason).toBe('No one answered in time.');
  });

  it('skips one file the sender takes back and sends the rest', async () => {
    const { out, incoming, inbox } = await setup(tree);
    const holiday = out.view().files.find((file) => file.path === 'Holiday/beach.jpg');
    out.cancelFile(holiday?.transferId ?? '');
    await (await incoming).accept({});

    await vi.waitFor(() => expect(out.view().phase).toBe('done'), { timeout: 10_000 });
    expect(out.view().files.find((file) => file.path === 'Holiday/beach.jpg')?.status).toBe(
      'skipped',
    );
    expect(out.view().doneFiles).toBe(2);
    expect(readdirSync(join(inbox, 'Holiday'))).toEqual(['notes.txt']);
  });

  it('stops for both when the receiver cancels', async () => {
    const { out, incoming } = await setup(tree);
    const batch = await incoming;
    await batch.accept({});

    batch.cancel();

    await vi.waitFor(() => expect(out.view().phase).toBe('cancelled'));
    expect(out.view().reason).toBe('Sam stopped it.');
    expect(batch.view().phase).toBe('cancelled');
  });

  it('will not accept files there is no room for', async () => {
    const { incoming } = await setup(tree, { in: { freeBytes: async () => 1_000 } });
    const batch = await incoming;
    await vi.waitFor(() => expect(batch.offerView()?.freeBytes).toBe(1_000));

    await expect(batch.accept({})).rejects.toThrow(/room/i);
    expect(batch.view().phase).toBe('asking');
  });

  it('turns away a file that was not in the list it accepted', async () => {
    const { incoming, links } = await setup(tree);
    const batch = await incoming;
    await batch.accept({});

    links[0].send(
      JSON.stringify({
        t: 'file-offer',
        transferId: 'smuggled',
        name: 'evil.exe',
        size: 4,
        partSize: 4,
        partCount: 1,
      }),
    );

    await vi.waitFor(() =>
      expect(links[1].sent).toContainEqual(
        expect.objectContaining({ t: 'file-error', transferId: 'smuggled' }),
      ),
    );
  });
});

describe('a link that drops in the middle', () => {
  it('goes quiet, comes back on a new link, and ends with one copy of every file', async () => {
    let dropped = 0;
    const { out, incoming, links, inbox } = await setup(tree, {
      out: { pingMs: 40, silenceMs: 200, dropped: () => dropped++ },
      in: { pingMs: 40, silenceMs: 200 },
    });
    // The network dies without a word a few frames in: neither end closes, they just stop
    // hearing each other.
    const sendFrame = links[0].send.bind(links[0]);
    let frames = 0;
    links[0].send = (data, options, cb) => {
      sendFrame(data, options, cb);
      if (typeof data !== 'string' && ++frames === 3) {
        links[0].silence();
        links[1].silence();
      }
    };
    const batch = await incoming;
    await batch.accept({});
    await vi.waitFor(() => expect(out.view().phase).toBe('reconnecting'), { timeout: 5_000 });
    await vi.waitFor(() => expect(batch.view().phase).toBe('reconnecting'), { timeout: 5_000 });
    expect(dropped).toBe(1);

    const [a, b] = memoryLinkPair();
    out.attach(a, 'relay');
    const reader = openInbox(b);
    const again = await reader.firstOffer(5_000);
    expect(again?.batchId).toBe('batch-1');
    batch.resume(b, reader);

    await vi.waitFor(() => expect(out.view().phase).toBe('done'), { timeout: 10_000 });
    expect(out.view().transport).toBe('relay');
    expect(readFileSync(join(inbox, 'report.pdf'))).toEqual(bytes(150_000, 1));
    expect(readdirSync(inbox).sort()).toEqual(['.runova-partial', 'Holiday', 'report.pdf']);
    expect(readdirSync(join(inbox, 'Holiday')).sort()).toEqual(['beach.jpg', 'notes.txt']);
  });
});
