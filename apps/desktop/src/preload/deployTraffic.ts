import { ipcRenderer } from 'electron';
import type {
  AttackSummary,
  BlockAddressResult,
  BlockedAddressInfo,
  DeployAttackListInput,
  DeployAttackSettingsInput,
  DeployAutoBlockInput,
  DeployBlockInput,
  DeployTrafficDeleteInput,
  DeployTrafficDimensionInput,
  DeployTrafficGeolocationInput,
  DeployTrafficLiveEvent,
  DeployTrafficLiveWatchInput,
  DeployTrafficReportInput,
  DeployTrafficSaveResult,
  DeployTrafficSettingsInput,
  DeployUnblockInput,
  TrafficDimensionPage,
  TrafficGeolocationStatus,
  TrafficReport,
  TrafficStatus,
} from '../shared/deployTrafficTypes';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * A server's Traffic section (E109, E110): reports, the settings, attacks and blocking, live
 * visitors, and Cloudflare's visitor location. A missing role comes back as `[core:forbidden]`; a
 * missing step-up (deleting statistics, auto-block) as `[core:stepUpRequired]`: pass the password or
 * a code, as the Telegram calls do.
 */
export function createDeployTraffic(subscribe: Subscribe) {
  return {
    status: (serverId: string): Promise<TrafficStatus> =>
      ipcRenderer.invoke(IPC.deployTraffic.status, serverId),
    report: (input: DeployTrafficReportInput): Promise<TrafficReport> =>
      ipcRenderer.invoke(IPC.deployTraffic.report, input),
    dimension: (input: DeployTrafficDimensionInput): Promise<TrafficDimensionPage> =>
      ipcRenderer.invoke(IPC.deployTraffic.dimension, input),
    saveSettings: (input: DeployTrafficSettingsInput): Promise<DeployTrafficSaveResult> =>
      ipcRenderer.invoke(IPC.deployTraffic.saveSettings, input),
    deleteData: (input: DeployTrafficDeleteInput): Promise<TrafficStatus> =>
      ipcRenderer.invoke(IPC.deployTraffic.deleteData, input),
    attacks: (input: DeployAttackListInput): Promise<AttackSummary> =>
      ipcRenderer.invoke(IPC.deployTraffic.attacks, input),
    saveAttackSettings: (input: DeployAttackSettingsInput): Promise<DeployTrafficSaveResult> =>
      ipcRenderer.invoke(IPC.deployTraffic.saveAttackSettings, input),
    saveAutoBlock: (input: DeployAutoBlockInput): Promise<DeployTrafficSaveResult> =>
      ipcRenderer.invoke(IPC.deployTraffic.saveAutoBlock, input),
    blocked: (serverId: string): Promise<BlockedAddressInfo[]> =>
      ipcRenderer.invoke(IPC.deployTraffic.blocked, serverId),
    block: (input: DeployBlockInput): Promise<BlockAddressResult> =>
      ipcRenderer.invoke(IPC.deployTraffic.block, input),
    unblock: (input: DeployUnblockInput): Promise<void> =>
      ipcRenderer.invoke(IPC.deployTraffic.unblock, input),
    /** Starts live visitors for this window; readings arrive on onLive. */
    watchLive: (input: DeployTrafficLiveWatchInput): Promise<string> =>
      ipcRenderer.invoke(IPC.deployTraffic.watchLive, input),
    unwatchLive: (subscriptionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployTraffic.unwatchLive, subscriptionId),
    onLive: (callback: (event: DeployTrafficLiveEvent) => void): (() => void) =>
      subscribe(IPC.deployTraffic.onLive, callback),
    geolocation: (serverId: string): Promise<TrafficGeolocationStatus> =>
      ipcRenderer.invoke(IPC.deployTraffic.geolocation, serverId),
    turnOnGeolocation: (input: DeployTrafficGeolocationInput): Promise<TrafficGeolocationStatus> =>
      ipcRenderer.invoke(IPC.deployTraffic.turnOnGeolocation, input),
  };
}
