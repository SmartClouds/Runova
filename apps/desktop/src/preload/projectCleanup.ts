import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type {
  CleanupRemoveEvent,
  CleanupRemoveItem,
  CleanupRemoveResult,
  CleanupScanEvent,
  ProjectCleanupScan,
} from '../shared/projectCleanupTypes';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * Project clean-up (E49): what a project weighs and the folders it can rebuild, and deleting the
 * ones the person picks. A request id ties a running scan or removal to its progress events and
 * to Cancel. Folders are named by the location and path a scan reported, never by a full path.
 */
export function createProjectCleanup(subscribe: Subscribe) {
  return {
    scan: (projectId: string, requestId: string): Promise<ProjectCleanupScan> =>
      ipcRenderer.invoke(IPC.projectCleanup.scan, projectId, requestId),
    cancel: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.projectCleanup.cancel, requestId),
    remove: (
      projectId: string,
      requestId: string,
      items: CleanupRemoveItem[],
    ): Promise<CleanupRemoveResult> =>
      ipcRenderer.invoke(IPC.projectCleanup.remove, projectId, requestId, items),
    onScanEvent: (callback: (event: CleanupScanEvent) => void): (() => void) =>
      subscribe(IPC.projectCleanup.onScanEvent, callback),
    onRemoveEvent: (callback: (event: CleanupRemoveEvent) => void): (() => void) =>
      subscribe(IPC.projectCleanup.onRemoveEvent, callback),
  };
}
