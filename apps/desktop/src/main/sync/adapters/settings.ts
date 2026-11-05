import { type AppSettings, syncCollection } from '@runova/core';
import type { LocalItem, SyncAdapter } from '../types';

export interface SettingsPort {
  getSettings: () => Promise<AppSettings>;
  /** `store.updateSettings`: one read, change and write in the settings queue. */
  updateSettings: (
    change: (current: AppSettings) => AppSettings | Promise<AppSettings>,
  ) => Promise<AppSettings>;
}

/**
 * Settings that belong to this computer and never sync:
 * - local paths: `projectsRootPath`, `androidSdkPath`, `androidCapturePath`, and the worktree
 *   folder (`worktrees.baseDir`, left out of the worktree settings that do sync)
 * - windows on this desktop: `usageWidgets`, `promptBuildWidgets`
 * - what is set up on this computer: `deployServerIds`, `runnerMachineLinks` (a runner can be
 *   "this computer"), `skillRepositoryIds` (the repositories list stays here), and the pet's
 *   own images (`desktopPetCustoms`, and `desktopPetCharacterId`, which can name one of them)
 * - its network: `proxy`, since a proxy that is wrong for another computer cuts it off, sync
 *   included, and `ollamaBaseUrl`, usually a server on this computer
 * - its power: `keepAwake`
 * - what agents may do on it: every `aiAccess*` setting stays a choice made on each computer
 * - `newsState`, which the app writes as news is read and notified here
 */
export const DEVICE_SETTINGS = [
  'projectsRootPath',
  'androidSdkPath',
  'androidCapturePath',
  'usageWidgets',
  'promptBuildWidgets',
  'deployServerIds',
  'runnerMachineLinks',
  'skillRepositoryIds',
  'desktopPetCustoms',
  'desktopPetCharacterId',
  'proxy',
  'ollamaBaseUrl',
  'keepAwake',
  'aiAccessEnabled',
  'aiAccessMode',
  'aiAccessPrompt',
  'aiAccessClients',
  'aiAccessAttachToTabs',
  'newsState',
] as const satisfies readonly (keyof AppSettings)[];

/** Keys and tokens kept in plain text in the settings. They travel under `secrets`. */
export const SECRET_SETTINGS = [
  'telegramBotToken',
  'openaiApiKey',
  'geminiApiKey',
  'usageProviderConfigs',
  'securityScannerConfigs',
] as const satisfies readonly (keyof AppSettings)[];

const ID = 'app';
const device = new Set<string>(DEVICE_SETTINGS);
const secret = new Set<string>(SECRET_SETTINGS);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The app settings (E48), as one item. Writes merge into what is here through the settings
 * queue, so this computer's own settings stay as they are and a setting this version does not
 * know is never written. Settings are never removed.
 */
export function settingsAdapter(store: SettingsPort): SyncAdapter {
  return {
    collection: syncCollection('settings'),
    area: 'settings',

    async list(): Promise<LocalItem[]> {
      const current = (await store.getSettings()) as unknown as Record<string, unknown>;
      const value: Record<string, unknown> = {};
      const secrets: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(current)) {
        if (device.has(key)) continue;
        if (secret.has(key)) secrets[key] = field;
        else value[key] = field;
      }
      if (isObject(value.worktrees)) {
        const { baseDir: _here, ...worktrees } = value.worktrees;
        value.worktrees = worktrees;
      }
      value.secrets = secrets;
      return [{ id: ID, teamId: null, value }];
    },

    async apply(incoming: LocalItem): Promise<void> {
      if (incoming.id !== ID) return;
      await store.updateSettings((current) => {
        const next = { ...current } as unknown as Record<string, unknown>;
        const take = (key: string, field: unknown) => {
          if (device.has(key) || !(key in next)) return;
          next[key] =
            key === 'worktrees' && isObject(field)
              ? { ...field, baseDir: current.worktrees.baseDir }
              : field;
        };
        for (const [key, field] of Object.entries(incoming.value)) {
          if (key !== 'secrets' && !secret.has(key)) take(key, field);
        }
        const secrets = incoming.value.secrets;
        if (isObject(secrets)) {
          for (const [key, field] of Object.entries(secrets)) if (secret.has(key)) take(key, field);
        }
        return next as unknown as AppSettings;
      });
    },

    async remove(): Promise<void> {
      // A reset cloud copy or a deleted record leaves this computer's settings alone.
    },
  };
}
