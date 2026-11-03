import {
  type AiAccessClients,
  type AiAccessMode,
  type AiAccessPrompt,
  type AppSettings,
  isAiAccessClients,
  isAiAccessMode,
  isAiAccessPrompt,
} from '@runova/core';

/**
 * The AI access choices in Settings > AI access (E46), read the same way by both processes. A value
 * this version does not know falls back to the safe default, and only `true` turns access on.
 */

export interface AiAccessSettings {
  enabled: boolean;
  mode: AiAccessMode;
  prompt: AiAccessPrompt;
  clients: AiAccessClients;
  attachToTabs: boolean;
}

type SavedAiAccessSettings = Partial<
  Pick<
    AppSettings,
    | 'aiAccessEnabled'
    | 'aiAccessMode'
    | 'aiAccessPrompt'
    | 'aiAccessClients'
    | 'aiAccessAttachToTabs'
  >
>;

export function aiAccessSettingsOf(saved: SavedAiAccessSettings): AiAccessSettings {
  return {
    enabled: saved.aiAccessEnabled === true,
    mode: isAiAccessMode(saved.aiAccessMode) ? saved.aiAccessMode : 'sensitive',
    prompt: isAiAccessPrompt(saved.aiAccessPrompt) ? saved.aiAccessPrompt : 'modal',
    clients: isAiAccessClients(saved.aiAccessClients) ? saved.aiAccessClients : 'runova',
    attachToTabs: saved.aiAccessAttachToTabs !== false,
  };
}

/** The same choices under their settings.json keys, for the store's read-time cleanup. */
export function aiAccessSettingsFields(
  saved: SavedAiAccessSettings,
): Required<SavedAiAccessSettings> {
  const clean = aiAccessSettingsOf(saved);
  return {
    aiAccessEnabled: clean.enabled,
    aiAccessMode: clean.mode,
    aiAccessPrompt: clean.prompt,
    aiAccessClients: clean.clients,
    aiAccessAttachToTabs: clean.attachToTabs,
  };
}
