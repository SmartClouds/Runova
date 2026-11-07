import { ipcRenderer } from 'electron';
import type {
  HealthChangedEvent,
  HealthCloudEnableInput,
  HealthCloudPlan,
  HealthCloudSettingsPatch,
  HealthCreateResult,
  HealthSecretReveal,
  HealthSetupPrompt,
  HealthTargetDetail,
  HealthTargetInput,
  HealthTargetSummary,
} from '../shared/healthTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * Project health checks (E22). A stored key or password never comes back through here: create
 * and rotate return the new one once, and every other call only says whether there is one.
 */
export function createHealth() {
  return {
    list: (filter?: { projectId?: string }): Promise<HealthTargetSummary[]> =>
      ipcRenderer.invoke(IPC.health.list, filter),
    get: (targetId: string): Promise<HealthTargetDetail | null> =>
      ipcRenderer.invoke(IPC.health.get, targetId),
    create: (input: HealthTargetInput): Promise<HealthCreateResult> =>
      ipcRenderer.invoke(IPC.health.create, input),
    update: (targetId: string, patch: Partial<HealthTargetInput>): Promise<HealthTargetSummary> =>
      ipcRenderer.invoke(IPC.health.update, targetId, patch),
    remove: (targetId: string): Promise<void> => ipcRenderer.invoke(IPC.health.remove, targetId),
    setPaused: (targetId: string, paused: boolean): Promise<HealthTargetSummary> =>
      ipcRenderer.invoke(IPC.health.setPaused, targetId, paused),
    checkNow: (targetId: string): Promise<HealthTargetDetail> =>
      ipcRenderer.invoke(IPC.health.checkNow, targetId),
    rotateSecret: (targetId: string): Promise<HealthSecretReveal> =>
      ipcRenderer.invoke(IPC.health.rotateSecret, targetId),
    setupPrompt: (targetId: string): Promise<HealthSetupPrompt> =>
      ipcRenderer.invoke(IPC.health.setupPrompt, targetId),
    spec: (): Promise<string> => ipcRenderer.invoke(IPC.health.spec),
    fixPrompt: (targetId: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.health.fixPrompt, targetId),
    diagnoseNow: (targetId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.health.diagnoseNow, targetId),
    cancelDiagnose: (targetId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.health.cancelDiagnose, targetId),
    cloudPlan: (
      which:
        | string
        | { projectId: string; url?: string; allowInsecure?: boolean; runMode?: 'local' | 'cloud' },
    ): Promise<HealthCloudPlan> => ipcRenderer.invoke(IPC.health.cloudPlan, which),
    cloudEnable: (targetId: string, input: HealthCloudEnableInput): Promise<HealthTargetSummary> =>
      ipcRenderer.invoke(IPC.health.cloudEnable, targetId, input),
    cloudDisable: (targetId: string): Promise<HealthTargetSummary> =>
      ipcRenderer.invoke(IPC.health.cloudDisable, targetId),
    cloudSettings: (
      targetId: string,
      patch: HealthCloudSettingsPatch,
    ): Promise<HealthTargetSummary> =>
      ipcRenderer.invoke(IPC.health.cloudSettings, targetId, patch),
    onChanged: (callback: (event: HealthChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: HealthChangedEvent): void =>
        callback(payload);
      ipcRenderer.on(IPC.health.onChanged, listener);
      return () => ipcRenderer.removeListener(IPC.health.onChanged, listener);
    },
  };
}
