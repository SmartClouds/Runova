import { CACHE_PROVIDERS, type CacheProviderId, type CleanSelection } from '@runova/core';
import { type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipcChannels';
import { throttle } from '../projectCleanup/throttle';
import { createRealSystemCleanup } from '../systemCleanup/deps';
import type { SystemCleanupService } from '../systemCleanup/runtime';
import { sendToContents } from './send';

/**
 * The window's side of Disk Cleanup (E50). It can start a scan, stop it, and ask for things in the
 * caches to be removed, so it answers the main window only.
 *
 * The window never names a path. It names a cache by id, a scan by the id the scan was given, and
 * the things to remove by the ids that scan reported. Anything else in the request, a path
 * included, is refused rather than ignored, and the service checks the ids against the scan it
 * holds before it touches a file.
 */

export interface SystemCleanupHandlerOptions {
  /** True for the windows that may use these channels (the main window, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
  /** For tests. The real one is built on first use. */
  service?: SystemCleanupService;
}

/** How often a scan may tell the window how far it has got. */
const PROGRESS_GAP_MS = 150;

const requestId = z.string().min(1).max(100);
const scanId = z.string().min(1).max(100);

const providerIds = CACHE_PROVIDERS.map((provider) => provider.id) as [
  CacheProviderId,
  ...CacheProviderId[],
];
const providerId = z.enum(providerIds);
const providerList = z.array(providerId).max(providerIds.length).optional();

/** An item id is a short number written in base 36, so anything longer is not one. */
const itemId = z.string().min(1).max(32);

const selectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('old-versions'),
    providerId,
    keep: z.number().int().min(1).max(9),
  }),
  z.strictObject({ mode: z.literal('everything'), providerId }),
  z.strictObject({
    mode: z.literal('items'),
    providerId,
    itemIds: z.array(itemId).min(1).max(50_000),
  }),
  z.strictObject({ mode: z.literal('tidy'), providerId }),
  z.strictObject({ mode: z.literal('clear-command'), providerId }),
]);

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`That ${label} is not valid.`);
  return result.data;
}

export function registerSystemCleanupHandlers(options: SystemCleanupHandlerOptions = {}): void {
  let built: SystemCleanupService | null = options.service ?? null;
  const service = (): SystemCleanupService => {
    built ??= createRealSystemCleanup();
    return built;
  };

  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (options.guard && !options.guard(event)) {
        throw new Error('Disk Cleanup answers only the main window.');
      }
      return listener(event, ...args);
    });
  };

  handle(IPC.systemCleanup.status, () => service().status());

  handle(IPC.systemCleanup.scan, (event, rawRequest, rawProviders) => {
    const id = parse(requestId, rawRequest, 'request');
    const caches = parse(providerList, rawProviders, 'list of caches');
    const send = (payload: unknown): void =>
      sendToContents(event.sender, IPC.systemCleanup.onScanEvent, payload);
    const sendProgress = throttle(send, PROGRESS_GAP_MS);
    return service().scan({
      requestId: id,
      providerIds: caches,
      onEvent: (scanEvent) => (scanEvent.type === 'progress' ? sendProgress : send)(scanEvent),
    });
  });

  handle(IPC.systemCleanup.cancel, (_event, rawRequest) =>
    service().cancel(parse(requestId, rawRequest, 'request')),
  );

  handle(IPC.systemCleanup.clean, (event, rawRequest, rawScan, rawSelection) => {
    const selection: CleanSelection = parse(selectionSchema, rawSelection, 'choice');
    return service().clean({
      requestId: parse(requestId, rawRequest, 'request'),
      scanId: parse(scanId, rawScan, 'scan'),
      selection,
      onEvent: (cleanEvent) =>
        sendToContents(event.sender, IPC.systemCleanup.onCleanEvent, cleanEvent),
    });
  });

  handle(IPC.systemCleanup.reveal, async (_event, rawProvider) => {
    const root = await service().rootOf(parse(providerId, rawProvider, 'cache'));
    if (!root) return false;
    return (await shell.openPath(root)) === '';
  });
}
