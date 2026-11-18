import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { encodeSendMessage, RECEIVE_FILES_FEATURE } from '@runova/protocol';
import {
  type AnywhereDirectoryEntry,
  type AnywhereSettingsPatch,
  type AnywhereState,
  formatRemoteId,
} from '../../../shared/anywhere';
import {
  FINISHED_PHASES,
  type FileSendState,
  filesLabel,
  type SendAnswer,
  type SendBatchView,
  type SendPeerView,
  type SendRecipient,
  type SendRequest,
  type SendSettingsPatch,
  type StagedItem,
} from '../../../shared/fileSend';
import type { DialError, DialedLink, SendSender } from '../anywhere/service';
import {
  type Inbox,
  IncomingBatch,
  OutgoingBatch,
  openInbox,
  type SendLink,
  type SendOffer,
} from './batch';
import { buildManifest, ManifestError } from './manifest';

/** What the send service needs of Runova Anywhere. */
export interface SendAnywherePort {
  state(): AnywhereState;
  dial(remoteId: string, intent: 'send'): Promise<DialedLink>;
  updateSettings(patch: AnywhereSettingsPatch): Promise<void>;
}

export interface SendServiceDeps {
  anywhere: SendAnywherePort;
  /** Downloads, where files go unless the person chose another folder. */
  defaultSaveFolder(): string;
  announce(state: FileSendState): void;
  /** Brings up the window that asks the person here about files offered to them. */
  showOffer(): void;
  /** An OS notification; the wiring decides whether one is shown. */
  notify(title: string, body: string): void;
  /** Files are moving (keep the computer awake), or no longer. */
  busy(active: boolean): void;
  partBytes?: number;
  /** How long to wait before each dial after a drop; the last one repeats. */
  redialDelaysMs?: number[];
  /** How long a dropped send keeps dialing before it gives up. */
  giveUpMs?: number;
  announceEveryMs?: number;
  log?(message: string): void;
}

const REDIAL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const GIVE_UP_MS = 5 * 60_000;
/** How long the other side gets to send its list once the link is open. */
const OFFER_WAIT_MS = 15_000;
/** How many sends may wait on the person here, or move, at the same time. */
const MAX_INCOMING = 4;
/** Batches kept for the list, newest first; finished ones go first when there are more. */
const MAX_BATCHES = 50;

interface Staged {
  item: StagedItem;
  path: string;
}

interface Outgoing {
  batch: OutgoingBatch;
  remoteId: string;
  paths: string[];
  note?: string;
  peer: SendPeerView;
  dialedOnce: boolean;
  droppedAt: number | null;
  redial: NodeJS.Timeout | null;
  attempt: number;
}

interface Incoming {
  batch: IncomingBatch;
  from: SendSender;
}

/**
 * Sending files (E112): what is staged, the devices files can go to, every send out and in, and
 * the question put to the person here. Links come from Runova Anywhere; each batch does the
 * talking over its own.
 */
export function createSendService(deps: SendServiceDeps) {
  const staged: Staged[] = [];
  const outgoing = new Map<string, Outgoing>();
  const incoming = new Map<string, Incoming>();
  /** Batch ids in the order they started, for the list. */
  const order: string[] = [];
  let wasBusy = false;

  const announce = throttle(() => deps.announce(state()), deps.announceEveryMs ?? 200);

  function changed(): void {
    const busy = activeCount() > 0;
    if (busy !== wasBusy) {
      wasBusy = busy;
      deps.busy(busy);
    }
    announce();
  }

  function settings() {
    const s = deps.anywhere.state().settings;
    return {
      receiveFrom: s.receiveFrom,
      autoAcceptOwn: s.autoAcceptOwn,
      saveFolder: s.saveFolder ?? deps.defaultSaveFolder(),
      defaultSaveFolder: deps.defaultSaveFolder(),
    };
  }

  function recipients(): { list: SendRecipient[]; websiteOutdated: boolean } {
    const anywhere = deps.anywhere.state();
    const self = anywhere.device?.remoteId;
    const entries = [
      ...anywhere.directory.mine.filter((e) => e.remoteId !== self).map((e) => [e, 'own'] as const),
      ...anywhere.directory.teammates.map((e) => [e, 'teammate'] as const),
    ];
    const websiteOutdated =
      entries.length > 0 && entries.every(([entry]) => entry.features === undefined);
    return {
      websiteOutdated,
      list: entries.map(([entry, relation]) => ({
        remoteId: entry.remoteId,
        name: entry.name,
        platform: entry.platform,
        kind: 'computer' as const,
        relation,
        owner: entry.owner,
        teams: entry.teams.map((team) => team.name),
        online: entry.online,
        unavailable: unavailable(entry),
      })),
    };
  }

  function state(): FileSendState {
    const anywhere = deps.anywhere.state();
    const { list, websiteOutdated } = recipients();
    const views: SendBatchView[] = [];
    for (const id of [...order].reverse()) {
      const view = outgoing.get(id)?.batch.view() ?? incoming.get(id)?.batch.view();
      if (view) views.push(view);
    }
    return {
      available: anywhere.status === 'online',
      status: anywhere.status,
      websiteOutdated,
      recipients: list,
      staged: staged.map((entry) => entry.item),
      batches: views,
      offers: [...incoming.values()]
        .map((entry) => entry.batch.offerView())
        .filter((offer) => offer !== null),
      settings: settings(),
    };
  }

  function remember(id: string): void {
    order.push(id);
    while (order.length > MAX_BATCHES) {
      const finished = order.find((batchId) => isFinished(batchId));
      if (!finished) break;
      forget(finished);
    }
  }

  function isFinished(id: string): boolean {
    const view = outgoing.get(id)?.batch.view() ?? incoming.get(id)?.batch.view();
    return !view || FINISHED_PHASES.includes(view.phase);
  }

  function forget(id: string): void {
    const index = order.indexOf(id);
    if (index !== -1) order.splice(index, 1);
    const out = outgoing.get(id);
    if (out?.redial) clearTimeout(out.redial);
    void out?.batch.dispose();
    void incoming.get(id)?.batch.dispose();
    outgoing.delete(id);
    incoming.delete(id);
  }

  // --- Staging -------------------------------------------------------------------

  async function stage(paths: string[]): Promise<{ staged: StagedItem[]; problems: string[] }> {
    const problems: string[] = [];
    for (const picked of paths) {
      const path = resolve(picked);
      if (staged.some((entry) => entry.path === path)) continue;
      try {
        const info = await lstat(path);
        const manifest = await buildManifest([path]);
        staged.push({
          path,
          item: {
            id: randomUUID(),
            name: basename(path),
            kind: info.isDirectory() ? 'folder' : 'file',
            size: manifest.totalBytes,
            fileCount: manifest.files.length,
          },
        });
      } catch (error) {
        problems.push(
          `${basename(path)}: ${error instanceof ManifestError ? error.message : 'It is not there any more.'}`,
        );
      }
    }
    changed();
    return { staged: staged.map((entry) => entry.item), problems };
  }

  function unstage(ids: string[] | 'all'): void {
    for (let i = staged.length - 1; i >= 0; i--) {
      if (ids === 'all' || ids.includes(staged[i].item.id)) staged.splice(i, 1);
    }
    changed();
  }

  // --- Sending -------------------------------------------------------------------

  async function send(request: SendRequest): Promise<{ batchId: string }> {
    if (staged.length === 0) throw new Error('Pick some files or a folder to send first.');
    const recipient = recipients().list.find((r) => r.remoteId === request.remoteId);
    const paths = staged.map((entry) => entry.path);
    const result = await start(request.remoteId, paths, request.note, recipient);
    staged.splice(0);
    changed();
    return result;
  }

  async function start(
    remoteId: string,
    paths: string[],
    note: string | undefined,
    recipient: SendRecipient | undefined,
  ): Promise<{ batchId: string }> {
    let manifest: Awaited<ReturnType<typeof buildManifest>>;
    try {
      manifest = await buildManifest(paths);
    } catch (error) {
      throw new Error(error instanceof ManifestError ? error.message : String(error));
    }
    const batchId = randomUUID();
    const peer: SendPeerView = {
      name: recipient?.owner.displayName ?? '',
      email: recipient?.owner.email ?? '',
      deviceName: recipient?.name ?? formatRemoteId(remoteId),
      platform: recipient?.platform ?? null,
      kind: recipient?.kind ?? 'computer',
      relation: recipient?.relation ?? 'own',
      remoteId,
    };
    const entry: Outgoing = {
      remoteId,
      paths,
      note,
      peer,
      dialedOnce: false,
      droppedAt: null,
      redial: null,
      attempt: 0,
      batch: new OutgoingBatch({
        batchId,
        manifest,
        ...(note ? { note } : {}),
        peer,
        partBytes: deps.partBytes,
        changed,
        ended: () => finishedOut(batchId),
        dropped: () => droppedOut(batchId),
      }),
    };
    outgoing.set(batchId, entry);
    remember(batchId);
    changed();
    void dialFor(entry);
    return { batchId };
  }

  async function dialFor(entry: Outgoing): Promise<void> {
    const attempt = ++entry.attempt;
    try {
      const dialed = await deps.anywhere.dial(entry.remoteId, 'send');
      if (attempt !== entry.attempt || entry.batch.finished) {
        dialed.link.close();
        return;
      }
      entry.dialedOnce = true;
      entry.droppedAt = null;
      entry.batch.attach(dialed.link as unknown as SendLink, dialed.transport);
    } catch (error) {
      if (attempt !== entry.attempt || entry.batch.finished) return;
      const problem = error as DialError;
      const message = problem.message || 'It did not go through.';
      if (!entry.dialedOnce) {
        if (problem.reason === 'declined') entry.batch.declineFromDial(message);
        else entry.batch.fail(message);
        return;
      }
      if (problem.reason === 'declined' || problem.reason === 'key-changed') {
        entry.batch.fail(message);
        return;
      }
      scheduleRedial(entry);
    }
  }

  function droppedOut(batchId: string): void {
    const entry = outgoing.get(batchId);
    if (!entry || entry.batch.finished) return;
    entry.droppedAt ??= Date.now();
    entry.dialedOnce = true;
    scheduleRedial(entry);
  }

  function scheduleRedial(entry: Outgoing): void {
    const delays = deps.redialDelaysMs ?? REDIAL_DELAYS_MS;
    const since = entry.droppedAt ?? Date.now();
    if (Date.now() - since >= (deps.giveUpMs ?? GIVE_UP_MS)) {
      entry.batch.fail(
        `The connection to ${entry.peer.deviceName} was lost and did not come back.`,
      );
      return;
    }
    const tries = Math.max(0, entry.attempt - 1);
    const delay = delays[Math.min(tries, delays.length - 1)];
    if (entry.redial) clearTimeout(entry.redial);
    entry.redial = setTimeout(() => {
      entry.redial = null;
      void dialFor(entry);
    }, delay);
  }

  function finishedOut(batchId: string): void {
    const entry = outgoing.get(batchId);
    if (!entry) return;
    if (entry.redial) clearTimeout(entry.redial);
    entry.redial = null;
    const view = entry.batch.view();
    if (view.phase === 'done') {
      deps.notify(
        `Sent ${filesLabel(view.doneFiles)} to ${view.peer.deviceName}`,
        view.failedFiles > 0
          ? `${filesLabel(view.failedFiles)} did not go through.`
          : 'Every file arrived and checked out.',
      );
    }
    changed();
  }

  async function retry(batchId: string): Promise<{ batchId: string }> {
    const entry = outgoing.get(batchId);
    if (!entry) throw new Error('That send is not there any more.');
    const recipient = recipients().list.find((r) => r.remoteId === entry.remoteId);
    const next = await start(entry.remoteId, entry.paths, entry.note, recipient);
    forget(batchId);
    changed();
    return next;
  }

  // --- Receiving -----------------------------------------------------------------

  function attachIncoming(link: SendLink, from: SendSender): void {
    void takeIncoming(link, from).catch((error) => {
      deps.log?.(`[send] an incoming send failed: ${String(error)}`);
      link.close();
    });
  }

  async function takeIncoming(link: SendLink, from: SendSender): Promise<void> {
    const inbox = openInbox(link);
    const offer = await inbox.firstOffer(OFFER_WAIT_MS);
    if (!offer) {
      link.close();
      return;
    }
    const known = incoming.get(offer.batchId);
    if (known && known.from.identityKey === from.identityKey && !known.batch.finished) {
      known.batch.resume(link, inbox);
      return;
    }
    const current = settings();
    const allowed =
      current.receiveFrom === 'everyone' ||
      (current.receiveFrom === 'own' && from.relation === 'own');
    if (known || !allowed) {
      refuse(link, offer, 'not-allowed');
      return;
    }
    const live = [...incoming.values()].filter((entry) => !entry.batch.finished).length;
    if (live >= MAX_INCOMING) {
      refuse(link, offer, 'busy');
      return;
    }
    const batch = newIncoming(link, inbox, offer, from, current.saveFolder);
    incoming.set(offer.batchId, { batch, from });
    remember(offer.batchId);
    changed();
    if (from.relation === 'own' && current.autoAcceptOwn) {
      try {
        await batch.accept({});
        return;
      } catch {
        // No room: ask the person instead, so they can pick another folder.
      }
    }
    deps.showOffer();
    deps.notify(
      `${from.displayName || 'Someone'} wants to send you ${filesLabel(offer.files.length)}`,
      `From ${from.deviceName ?? 'another computer'}. Open Runova to accept or decline.`,
    );
  }

  function newIncoming(
    link: SendLink,
    inbox: Inbox,
    offer: SendOffer,
    from: SendSender,
    folder: string,
  ): IncomingBatch {
    const peer: SendPeerView = {
      name: from.displayName,
      email: from.email,
      deviceName: from.deviceName ?? 'another computer',
      platform: from.platform,
      kind: from.platform === 'android' || from.platform === 'ios' ? 'phone' : 'computer',
      relation: from.relation,
      remoteId: from.remoteId,
    };
    return new IncomingBatch(link, inbox, offer, {
      peer,
      senderKey: from.identityKey,
      folder,
      changed,
      ended: () => finishedIn(offer.batchId),
    });
  }

  function refuse(link: SendLink, offer: SendOffer, reason: 'busy' | 'not-allowed'): void {
    link.send(
      encodeSendMessage({ t: 'send-answer', batchId: offer.batchId, accept: false, reason }),
    );
    void link.drain(0).then(() => setTimeout(() => link.close(), 200));
  }

  function finishedIn(batchId: string): void {
    const entry = incoming.get(batchId);
    if (!entry) return;
    const view = entry.batch.view();
    if (view.phase === 'done') {
      deps.notify(
        `Received ${filesLabel(view.doneFiles)} from ${view.peer.name || view.peer.deviceName}`,
        `Saved in ${view.folder ?? settings().saveFolder}.`,
      );
    }
    changed();
  }

  async function respond(batchId: string, answer: SendAnswer): Promise<void> {
    const entry = incoming.get(batchId);
    if (!entry) return;
    if (answer.alwaysAcceptOwn && entry.from.relation === 'own') {
      await deps.anywhere.updateSettings({ autoAcceptOwn: true });
    }
    if (answer.accept) await entry.batch.accept(answer.folder ? { folder: answer.folder } : {});
    else entry.batch.decline();
    changed();
  }

  // --- Both ways -----------------------------------------------------------------

  function cancel(batchId: string): void {
    outgoing.get(batchId)?.batch.cancel();
    incoming.get(batchId)?.batch.cancel();
  }

  function cancelFile(batchId: string, transferId: string): void {
    outgoing.get(batchId)?.batch.cancelFile(transferId);
  }

  function dismiss(batchId: string): void {
    if (!isFinished(batchId)) return;
    forget(batchId);
    changed();
  }

  function clearFinished(): void {
    for (const id of [...order]) if (isFinished(id)) forget(id);
    changed();
  }

  /** Where a received file, or a received batch's folder, is on this computer. */
  function savedPathOf(batchId: string, transferId?: string): string | null {
    const view = incoming.get(batchId)?.batch.view();
    if (!view) return null;
    if (!transferId) return view.folder;
    return view.files.find((file) => file.transferId === transferId)?.savedPath ?? null;
  }

  function activeCount(): number {
    let count = 0;
    for (const entry of outgoing.values()) if (!entry.batch.finished) count++;
    for (const entry of incoming.values()) if (!entry.batch.finished) count++;
    return count;
  }

  /** Runova is quitting: every live send stops, and the other side is told. */
  function cancelAllForQuit(): void {
    for (const entry of outgoing.values()) if (!entry.batch.finished) entry.batch.cancel();
    for (const entry of incoming.values()) if (!entry.batch.finished) entry.batch.cancel();
    changed();
  }

  async function updateSettings(patch: SendSettingsPatch): Promise<void> {
    await deps.anywhere.updateSettings(patch);
    changed();
  }

  async function dispose(): Promise<void> {
    for (const id of [...order]) forget(id);
    announce.cancel();
  }

  return {
    attachIncoming,
    state,
    stage,
    unstage,
    send,
    retry,
    respond,
    cancel,
    cancelFile,
    dismiss,
    clearFinished,
    savedPathOf,
    activeCount,
    cancelAllForQuit,
    updateSettings,
    /** The Anywhere state changed (the directory, presence, settings). */
    refresh: () => announce(),
    dispose,
  };
}

export type SendService = ReturnType<typeof createSendService>;

/**
 * Why a device can not take files now. What an app can do is known only while it is online (the
 * hub keeps it with the presence), so offline comes first.
 */
function unavailable(entry: AnywhereDirectoryEntry): SendRecipient['unavailable'] {
  if (!entry.online) return 'offline';
  if (entry.features === undefined) return 'website-outdated';
  if (!entry.features.includes(RECEIVE_FILES_FEATURE)) return 'outdated';
  return null;
}

/**
 * Calls `fn` at once, then at most once per `everyMs` while calls keep coming, so a transfer that
 * changes on every frame does not flood the screens.
 */
export function throttle(fn: () => void, everyMs: number): (() => void) & { cancel(): void } {
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  const run = (): void => {
    last = Date.now();
    timer = null;
    fn();
  };
  const throttled = (): void => {
    if (timer) return;
    const wait = everyMs - (Date.now() - last);
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return throttled;
}
