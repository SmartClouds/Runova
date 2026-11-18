import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AnywhereDirectoryEntry,
  type AnywhereState,
  EMPTY_ANYWHERE_STATE,
} from '../../../shared/anywhere';
import type { FileSendState } from '../../../shared/fileSend';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { type MemoryLink, memoryLinkPair } from '../../../test/main/memoryLink';
import { DialError, type SendSender } from '../anywhere/service';
import { createSendService, type SendService, throttle } from './service';

interface Computer {
  remoteId: string;
  userId: number;
  name: string;
  person: string;
  service: SendService;
  states: FileSendState[];
  inbox: string;
  offersShown: number;
  notices: string[];
  settings: AnywhereState['settings'];
  online: boolean;
  /** When set, the next dials to this computer fail with it. */
  refuse: DialError | null;
  dials: number;
  busy: boolean[];
  /** The links this computer dialed, so a test can cut them. */
  outLinks: MemoryLink[];
}

const services: SendService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  vi.useRealTimers();
});

function entry(
  of: Computer,
  viewer: Computer,
  features: string[] | undefined,
): AnywhereDirectoryEntry {
  return {
    id: of.userId * 100,
    remoteId: of.remoteId,
    name: of.name,
    platform: 'windows',
    kind: 'app',
    identityKey: `key-${of.remoteId}`,
    unattendedEnabled: false,
    online: of.online,
    lastSeenAt: '2026-11-18T09:00:00Z',
    owner: {
      userId: of.userId,
      displayName: of.person,
      email: `${of.person.toLowerCase()}@example.com`,
    },
    teams: of.userId === viewer.userId ? [] : [{ id: 10, name: 'Ops' }],
    ...(features ? { features } : {}),
  };
}

/** Computers that find each other through a pretend Anywhere: a dial pairs two memory links. */
function network() {
  const computers: Computer[] = [];

  function add(
    remoteId: string,
    userId: number,
    name: string,
    person: string,
    options: {
      redialDelaysMs?: number[];
      giveUpMs?: number;
    } = {},
  ): Computer {
    const inbox = tempDir('runova-inbox-');
    const computer: Computer = {
      remoteId,
      userId,
      name,
      person,
      service: null as unknown as SendService,
      states: [],
      inbox,
      offersShown: 0,
      notices: [],
      settings: { ...EMPTY_ANYWHERE_STATE.settings, saveFolder: inbox },
      online: true,
      refuse: null,
      dials: 0,
      busy: [],
      outLinks: [],
    };
    let session = 0;
    computer.service = createSendService({
      anywhere: {
        state: (): AnywhereState => ({
          ...EMPTY_ANYWHERE_STATE,
          status: 'online',
          device: { id: userId * 100, remoteId, name, platform: 'windows' },
          settings: computer.settings,
          directory: {
            mine: computers
              .filter((c) => c.userId === userId)
              .map((c) => entry(c, computer, ['receive-files'])),
            teammates: computers
              .filter((c) => c.userId !== userId)
              .map((c) => entry(c, computer, ['receive-files'])),
          },
        }),
        dial: async (to) => {
          const target = computers.find((c) => c.remoteId === to);
          if (target) target.dials++;
          if (!target || !target.online) {
            throw new DialError(
              'offline',
              'That device is offline. It needs Runova open and signed in.',
            );
          }
          if (target.refuse) throw target.refuse;
          const [mine, theirs] = memoryLinkPair();
          computer.outLinks.push(mine);
          const from: SendSender = {
            sessionId: `${remoteId}-${++session}`,
            userId,
            displayName: person,
            email: `${person.toLowerCase()}@example.com`,
            deviceName: name,
            platform: 'windows',
            remoteId,
            identityKey: `key-${remoteId}`,
            relation: target.userId === userId ? 'own' : 'teammate',
            teams: target.userId === userId ? [] : ['Ops'],
          };
          target.service.attachIncoming(theirs as never, from);
          return {
            link: mine as never,
            sessionId: from.sessionId,
            transport: 'direct' as const,
            host: { remoteId: to, name: target.name, platform: 'windows' as const, kind: 'app' },
          };
        },
        updateSettings: async (patch) => {
          computer.settings = { ...computer.settings, ...patch } as AnywhereState['settings'];
        },
      },
      defaultSaveFolder: () => inbox,
      announce: (state) => computer.states.push(state),
      showOffer: () => computer.offersShown++,
      notify: (title, body) => computer.notices.push(`${title}: ${body}`),
      busy: (active) => computer.busy.push(active),
      partBytes: 64 * 1024,
      redialDelaysMs: options.redialDelaysMs ?? [20, 40],
      giveUpMs: options.giveUpMs ?? 5_000,
    });
    services.push(computer.service);
    computers.push(computer);
    return computer;
  }

  return { add };
}

function picked(): { root: string; paths: string[] } {
  const root = tempDir('runova-pick-');
  writeFileSync(join(root, 'report.pdf'), Buffer.alloc(150_000, 7));
  writeTree(root, { 'Holiday/notes.txt': 'beach day', 'Holiday/raw/img.cr3': 'raw!' });
  return { root, paths: [join(root, 'report.pdf'), join(root, 'Holiday')] };
}

const state = (c: Computer) => c.service.state();
const batchOf = (c: Computer, id?: string) =>
  id ? state(c).batches.find((b) => b.id === id) : state(c).batches[0];

describe('sending files to another computer', () => {
  it('stages a pick, offers it, and once accepted every file lands where the other side chose', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    const { paths } = picked();

    const staged = await sam.service.stage(paths);
    expect(staged.problems).toEqual([]);
    expect(state(sam).staged).toEqual([
      expect.objectContaining({ name: 'report.pdf', kind: 'file', size: 150_000, fileCount: 1 }),
      expect.objectContaining({ name: 'Holiday', kind: 'folder', size: 13, fileCount: 2 }),
    ]);

    const { batchId } = await sam.service.send({ remoteId: kim.remoteId, note: 'For the review' });
    expect(state(sam).staged).toEqual([]);
    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(1));
    expect(kim.offersShown).toBe(1);
    expect(state(kim).offers[0]).toMatchObject({
      batchId,
      note: 'For the review',
      fileCount: 3,
      peer: { name: 'Sam', deviceName: "Sam's desk", relation: 'teammate' },
    });
    expect(batchOf(sam, batchId)?.phase).toBe('waiting');

    await kim.service.respond(batchId, { accept: true });

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('done'), { timeout: 10_000 });
    await vi.waitFor(() => expect(batchOf(kim, batchId)?.phase).toBe('done'));
    expect(readFileSync(join(kim.inbox, 'report.pdf'))).toEqual(Buffer.alloc(150_000, 7));
    expect(readFileSync(join(kim.inbox, 'Holiday', 'raw', 'img.cr3'), 'utf8')).toBe('raw!');
    expect(state(kim).offers).toEqual([]);
    expect(kim.notices).toContainEqual(expect.stringMatching(/^Received 3 files from Sam/));
  });

  it('takes files from my own devices straight in when that is turned on', async () => {
    const net = network();
    const desk = net.add('100000111', 1, "Sam's desk", 'Sam');
    const laptop = net.add('100000333', 1, "Sam's laptop", 'Sam');
    laptop.settings = { ...laptop.settings, autoAcceptOwn: true };
    await desk.service.stage(picked().paths);

    const { batchId } = await desk.service.send({ remoteId: laptop.remoteId });

    await vi.waitFor(() => expect(batchOf(desk, batchId)?.phase).toBe('done'), { timeout: 10_000 });
    expect(laptop.offersShown).toBe(0);
    expect(readdirSync(laptop.inbox).sort()).toEqual(['.runova-partial', 'Holiday', 'report.pdf']);
  });

  it('still asks about a teammate when my own devices go straight in', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    kim.settings = { ...kim.settings, autoAcceptOwn: true };
    await sam.service.stage(picked().paths);

    await sam.service.send({ remoteId: kim.remoteId });

    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(1));
  });

  it('turns a teammate away when only my own devices may send, whatever got through', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    kim.settings = { ...kim.settings, receiveFrom: 'own' };
    await sam.service.stage(picked().paths);

    const { batchId } = await sam.service.send({ remoteId: kim.remoteId });

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('declined'));
    expect(batchOf(sam, batchId)?.reason).toBe("Kim's laptop is not taking files from you.");
    expect(state(kim).offers).toEqual([]);
  });

  it('says the other computer is busy beyond four sends waiting at once', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    for (let i = 0; i < 4; i++) {
      await sam.service.stage(picked().paths);
      await sam.service.send({ remoteId: kim.remoteId });
    }
    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(4));
    await sam.service.stage(picked().paths);

    const { batchId } = await sam.service.send({ remoteId: kim.remoteId });

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('failed'));
    expect(batchOf(sam, batchId)?.reason).toMatch(/busy/);
  });

  it('says why a first dial did not go through', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    kim.online = false;
    await sam.service.stage(picked().paths);

    const { batchId } = await sam.service.send({ remoteId: kim.remoteId });

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('failed'));
    expect(batchOf(sam, batchId)?.reason).toBe(
      'That device is offline. It needs Runova open and signed in.',
    );
    expect(kim.dials).toBe(1);
  });

  it('names a device it does not know by its Runova ID', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    await sam.service.stage(picked().paths);

    const { batchId } = await sam.service.send({ remoteId: '482193775' });

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('failed'));
    expect(batchOf(sam, batchId)?.peer.deviceName).toBe('482 193 775');
  });

  it('sends the same files again from a send that did not go through', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    kim.online = false;
    await sam.service.stage(picked().paths);
    const first = await sam.service.send({ remoteId: kim.remoteId });
    await vi.waitFor(() => expect(batchOf(sam, first.batchId)?.phase).toBe('failed'));
    kim.online = true;

    const again = await sam.service.retry(first.batchId);

    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(1));
    expect(state(kim).offers[0].fileCount).toBe(3);
    expect(again.batchId).not.toBe(first.batchId);
  });

  it('dials again after the link drops, and ends with one copy of every file', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    await sam.service.stage(picked().paths);
    const { batchId } = await sam.service.send({ remoteId: kim.remoteId });
    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(1));

    // The first link goes the moment the first file is accepted.
    const accepted = kim.service.respond(batchId, { accept: true });
    for (const link of sam.outLinks) link.drop();
    await accepted;

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('done'), { timeout: 10_000 });
    expect(kim.dials).toBe(2);
    expect(readdirSync(kim.inbox).sort()).toEqual(['.runova-partial', 'Holiday', 'report.pdf']);
    expect(readdirSync(join(kim.inbox, 'Holiday')).sort()).toEqual(['notes.txt', 'raw']);
  });

  it('gives up when the other side does not come back in time', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam', { giveUpMs: 150 });
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    await sam.service.stage(picked().paths);
    const { batchId } = await sam.service.send({ remoteId: kim.remoteId });
    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(1));
    await kim.service.respond(batchId, { accept: true });
    kim.online = false;

    for (const link of sam.outLinks) link.drop();

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('failed'), { timeout: 5_000 });
    expect(batchOf(sam, batchId)?.reason).toBe(
      "The connection to Kim's laptop was lost and did not come back.",
    );
  });

  it('tells the other side when Runova quits in the middle', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    await sam.service.stage(picked().paths);
    const { batchId } = await sam.service.send({ remoteId: kim.remoteId });
    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(1));
    expect(sam.service.activeCount()).toBe(1);

    sam.service.cancelAllForQuit();

    await vi.waitFor(() => expect(batchOf(kim, batchId)?.phase).not.toBe('asking'));
    expect(sam.service.activeCount()).toBe(0);
  });

  it('keeps the computer awake while files move, and lets it sleep after', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    await sam.service.stage(picked().paths);
    const { batchId } = await sam.service.send({ remoteId: kim.remoteId });
    await vi.waitFor(() => expect(state(kim).offers).toHaveLength(1));
    await kim.service.respond(batchId, { accept: true });

    await vi.waitFor(() => expect(batchOf(sam, batchId)?.phase).toBe('done'), { timeout: 10_000 });

    expect(sam.busy[0]).toBe(true);
    expect(sam.busy[sam.busy.length - 1]).toBe(false);
  });
});

describe('what the screens are told', () => {
  it('lists the devices files can go to, and why some can not take them', () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');
    kim.online = false;

    expect(state(sam).recipients).toEqual([
      expect.objectContaining({
        remoteId: kim.remoteId,
        name: "Kim's laptop",
        relation: 'teammate',
        owner: expect.objectContaining({ displayName: 'Kim' }),
        teams: ['Ops'],
        online: false,
        unavailable: 'offline',
      }),
    ]);
  });

  it('never names a staged file by where it is on this computer', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const { root, paths } = picked();

    await sam.service.stage(paths);

    expect(JSON.stringify(state(sam))).not.toContain(root);
    expect(JSON.stringify(state(sam))).not.toContain('key-');
  });

  it('takes the same thing once, and lets it go again', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const { paths } = picked();
    await sam.service.stage(paths);
    await sam.service.stage([paths[0]]);

    expect(state(sam).staged).toHaveLength(2);
    sam.service.unstage([state(sam).staged[0].id]);
    expect(state(sam).staged.map((item) => item.name)).toEqual(['Holiday']);
  });

  it('says what can not be staged and why', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const empty = tempDir('runova-empty-');

    const result = await sam.service.stage([empty, join(empty, 'gone.txt')]);

    expect(state(sam).staged).toEqual([]);
    expect(result.problems).toHaveLength(2);
  });

  it('sends nothing while nothing is staged', async () => {
    const net = network();
    const sam = net.add('100000111', 1, "Sam's desk", 'Sam');
    const kim = net.add('100000222', 2, "Kim's laptop", 'Kim');

    await expect(sam.service.send({ remoteId: kim.remoteId })).rejects.toThrow(/Pick/);
  });
});

describe('throttled announcing', () => {
  it('passes the first change at once and folds a burst into one more', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const announce = throttle(() => calls.push(Date.now()), 200);

    announce();
    for (let i = 0; i < 50; i++) announce();
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(200);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(2);
  });
});
