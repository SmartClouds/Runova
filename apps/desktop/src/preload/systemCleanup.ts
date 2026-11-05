import type {
  CacheProviderId,
  CleanResult,
  CleanSelection,
  SystemCleanEvent,
  SystemCleanupScan,
  SystemCleanupStatus,
  SystemScanEvent,
} from '@runova/core';
import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * Disk Cleanup (E50): the caches package managers and developer tools keep, what they take, and
 * removing old versions or everything. A request id ties a running scan or clean-up to its
 * progress events and to Cancel. Caches, scans and items are named by id, never by path.
 */
export function createSystemCleanup(subscribe: Subscribe) {
  return {
    status: (): Promise<SystemCleanupStatus> => ipcRenderer.invoke(IPC.systemCleanup.status),
    scan: (requestId: string, providerIds?: CacheProviderId[]): Promise<SystemCleanupScan> =>
      ipcRenderer.invoke(IPC.systemCleanup.scan, requestId, providerIds),
    cancel: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.systemCleanup.cancel, requestId),
    clean: (requestId: string, scanId: string, selection: CleanSelection): Promise<CleanResult> =>
      ipcRenderer.invoke(IPC.systemCleanup.clean, requestId, scanId, selection),
    reveal: (providerId: CacheProviderId): Promise<boolean> =>
      ipcRenderer.invoke(IPC.systemCleanup.reveal, providerId),
    onScanEvent: (callback: (event: SystemScanEvent) => void): (() => void) =>
      subscribe(IPC.systemCleanup.onScanEvent, callback),
    onCleanEvent: (callback: (event: SystemCleanEvent) => void): (() => void) =>
      subscribe(IPC.systemCleanup.onCleanEvent, callback),
  };
}
