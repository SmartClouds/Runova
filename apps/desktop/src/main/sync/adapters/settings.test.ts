import type { AppSettings } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/defaultSettings';
import { DEVICE_SETTINGS, SECRET_SETTINGS, settingsAdapter } from './settings';

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    theme: 'dark',
    projectsRootPath: 'C:\\src',
    androidSdkPath: 'C:\\Android',
    worktrees: { baseDir: 'D:\\trees', copyGlobs: ['.env'], deleteBranchOnRemove: true },
    openaiApiKey: 'sk-openai',
    telegramBotToken: '123:bot',
    usageProviderConfigs: { openai: { enabled: true, apiKey: 'sk-usage' } },
    deployServerIds: ['s1'],
    ...overrides,
  };
}

function memorySettings(initial: AppSettings) {
  let current = structuredClone(initial);
  return {
    getSettings: async () => structuredClone(current),
    updateSettings: async (change: (now: AppSettings) => AppSettings | Promise<AppSettings>) => {
      current = structuredClone(await change(structuredClone(current)));
      return current;
    },
    get: () => current,
  };
}

describe('settingsAdapter', () => {
  it('names only settings that exist', () => {
    for (const key of [...DEVICE_SETTINGS, ...SECRET_SETTINGS]) {
      expect(DEFAULT_SETTINGS).toHaveProperty(key);
    }
  });

  it('syncs the settings as one item, without this computer’s own and with the keys apart', async () => {
    const items = await settingsAdapter(memorySettings(settings())).list();

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.id).toBe('app');
    expect(item?.teamId).toBeNull();
    const value = item?.value as Record<string, unknown>;
    expect(value.theme).toBe('dark');
    for (const key of [...DEVICE_SETTINGS, ...SECRET_SETTINGS])
      expect(value).not.toHaveProperty(key);
    expect(value.worktrees).toEqual({ copyGlobs: ['.env'], deleteBranchOnRemove: true });
    expect(value.secrets).toEqual({
      telegramBotToken: '123:bot',
      openaiApiKey: 'sk-openai',
      geminiApiKey: null,
      usageProviderConfigs: { openai: { enabled: true, apiKey: 'sk-usage' } },
      securityScannerConfigs: {},
    });
  });

  it('merges what arrived into the settings here and keeps this computer’s own', async () => {
    const store = memorySettings(settings());
    const [item] = await settingsAdapter(memorySettings(settings())).list();
    const value = {
      ...(item?.value as Record<string, unknown>),
      theme: 'light',
      worktrees: { copyGlobs: [], deleteBranchOnRemove: false },
      secrets: { openaiApiKey: 'sk-new' },
      // Neither a setting this computer keeps for itself nor one it does not know is taken.
      projectsRootPath: '/home/other',
      someFutureSetting: true,
    };

    await settingsAdapter(store).apply({ id: 'app', teamId: null, value });

    const next = store.get() as AppSettings & Record<string, unknown>;
    expect(next.theme).toBe('light');
    expect(next.openaiApiKey).toBe('sk-new');
    expect(next.telegramBotToken).toBe('123:bot');
    expect(next.projectsRootPath).toBe('C:\\src');
    expect(next.androidSdkPath).toBe('C:\\Android');
    expect(next.deployServerIds).toEqual(['s1']);
    expect(next.worktrees).toEqual({
      baseDir: 'D:\\trees',
      copyGlobs: [],
      deleteBranchOnRemove: false,
    });
    expect(next).not.toHaveProperty('someFutureSetting');
  });

  it('never removes the settings', async () => {
    const store = memorySettings(settings());

    await settingsAdapter(store).remove('app');

    expect(store.get().theme).toBe('dark');
  });
});
