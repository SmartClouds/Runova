import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipcChannels';
import type {
  CleanupRemoveItem,
  CleanupRemoveResult,
  ProjectCleanupScan,
} from '../../shared/projectCleanupTypes';
import { createCleanupDeps } from '../projectCleanup/deps';
import { createProjectCleanup } from '../projectCleanup/service';
import { throttle } from '../projectCleanup/throttle';
import { sendToContents } from './send';

/**
 * The window's side of project clean-up. It can start a scan, stop it, and ask for folders to be
 * deleted, so it answers the main window only, and the window names what to delete by the
 * location and folder path a scan reported, never by an absolute path. The service checks every
 * request again against the rules the scan used.
 */

export interface ProjectCleanupHandlerOptions {
  /** True for the windows that may use these channels (the main window, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
}

const MAX_ITEMS = 500;
/** How often a scan may tell the window how many files it has looked at. */
const PROGRESS_GAP_MS = 150;

const idText = z.string().min(1).max(200);
const requestIdText = z.string().min(1).max(100);

const removeItemsSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('folder'),
        locationId: idText,
        relPath: z.string().min(1).max(1024),
      }),
      z.object({ kind: z.literal('studio'), videoId: idText }),
    ]),
  )
  .min(1)
  .max(MAX_ITEMS);

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`That ${label} is not valid.`);
  return result.data;
}

export function registerProjectCleanupHandlers(options: ProjectCleanupHandlerOptions = {}): void {
  const service = createProjectCleanup(createCleanupDeps());
  /** Running scans and removals, by request id, so Cancel can find them. */
  const running = new Map<string, AbortController>();
  /** Projects with something running. A scan and a removal never overlap in one project. */
  const busyProjects = new Set<string>();

  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (options.guard && !options.guard(event)) {
        throw new Error('Project clean-up answers only the main window.');
      }
      return listener(event, ...args);
    });
  };

  /** Runs `work` with the project and the request marked busy until it ends, however it ends. */
  async function exclusive<T>(
    projectId: string,
    requestId: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (busyProjects.has(projectId)) {
      throw new Error('Clean-up is already working on this project.');
    }
    const controller = new AbortController();
    busyProjects.add(projectId);
    running.set(requestId, controller);
    try {
      return await work(controller.signal);
    } finally {
      busyProjects.delete(projectId);
      running.delete(requestId);
    }
  }

  handle(IPC.projectCleanup.scan, (event, rawProject, rawRequest): Promise<ProjectCleanupScan> => {
    const projectId = parse(idText, rawProject, 'project');
    const requestId = parse(requestIdText, rawRequest, 'request');
    return exclusive(projectId, requestId, (signal) => {
      const send = (payload: unknown): void =>
        sendToContents(event.sender, IPC.projectCleanup.onScanEvent, payload);
      const sendProgress = throttle(send, PROGRESS_GAP_MS);
      return service.scan(projectId, {
        requestId,
        signal,
        onEvent: (scanEvent) => (scanEvent.type === 'progress' ? sendProgress : send)(scanEvent),
      });
    });
  });

  handle(IPC.projectCleanup.cancel, (_event, rawRequest): boolean => {
    const controller = running.get(parse(requestIdText, rawRequest, 'request'));
    if (!controller) return false;
    controller.abort();
    return true;
  });

  handle(
    IPC.projectCleanup.remove,
    (event, rawProject, rawRequest, rawItems): Promise<CleanupRemoveResult> => {
      const projectId = parse(idText, rawProject, 'project');
      const requestId = parse(requestIdText, rawRequest, 'request');
      const items: CleanupRemoveItem[] = parse(removeItemsSchema, rawItems, 'list of folders');
      return exclusive(projectId, requestId, (signal) =>
        service.remove(projectId, items, {
          requestId,
          signal,
          onEvent: (removeEvent) =>
            sendToContents(event.sender, IPC.projectCleanup.onRemoveEvent, removeEvent),
        }),
      );
    },
  );
}
