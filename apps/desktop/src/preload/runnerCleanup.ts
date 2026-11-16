import type { RunnerMachineLink } from '@runova/core';
import { ipcRenderer } from 'electron';
import type {
  RunnerCleanupCleanRequest,
  RunnerCleanupCleanResult,
  RunnerCleanupProgress,
  RunnerCleanupScanResult,
  RunnerCleanupSchedule,
  RunnerCleanupScheduleResult,
} from '../shared/apiTypes';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * Runner cleanup (E104): what a self-hosted runner's machine holds that can go, removing it, and a
 * scheduled job on that machine. The window names a machine link, a scan and item ids, never a path.
 */
export function createRunnerCleanup(subscribe: Subscribe) {
  return {
    scan: (link: RunnerMachineLink): Promise<RunnerCleanupScanResult> =>
      ipcRenderer.invoke(IPC.runnerCleanup.scan, link),
    clean: (request: RunnerCleanupCleanRequest): Promise<RunnerCleanupCleanResult> =>
      ipcRenderer.invoke(IPC.runnerCleanup.clean, request),
    cancel: (link: RunnerMachineLink): Promise<boolean> =>
      ipcRenderer.invoke(IPC.runnerCleanup.cancel, link),
    saveSchedule: (
      link: RunnerMachineLink,
      schedule: RunnerCleanupSchedule,
    ): Promise<RunnerCleanupScheduleResult> =>
      ipcRenderer.invoke(IPC.runnerCleanup.saveSchedule, link, schedule),
    removeSchedule: (link: RunnerMachineLink): Promise<RunnerCleanupScheduleResult> =>
      ipcRenderer.invoke(IPC.runnerCleanup.removeSchedule, link),
    onProgress: (callback: (progress: RunnerCleanupProgress) => void): (() => void) =>
      subscribe(IPC.runnerCleanup.onProgress, callback),
  };
}
