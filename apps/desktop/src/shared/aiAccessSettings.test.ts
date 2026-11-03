import { describe, expect, it } from 'vitest';
import { aiAccessSettingsOf } from './aiAccessSettings';
import { DEFAULT_SETTINGS } from './defaultSettings';

/**
 * AI access (E46): off until the user turns it on, asks before sensitive actions, asks in the
 * Runova window and only lets agents in Runova's own tabs connect. Whatever settings.json holds is
 * read back into those shapes.
 */

describe('aiAccessSettingsOf', () => {
  it('reads the defaults as off, ask for sensitive, ask in the window, Runova tabs only', () => {
    expect(aiAccessSettingsOf(DEFAULT_SETTINGS)).toEqual({
      enabled: false,
      mode: 'sensitive',
      prompt: 'modal',
      clients: 'runova',
      attachToTabs: true,
    });
  });

  it('keeps what was saved', () => {
    expect(
      aiAccessSettingsOf({
        aiAccessEnabled: true,
        aiAccessMode: 'all',
        aiAccessPrompt: 'cli',
        aiAccessClients: 'both',
        aiAccessAttachToTabs: false,
      }),
    ).toEqual({ enabled: true, mode: 'all', prompt: 'cli', clients: 'both', attachToTabs: false });
  });

  it('drops values this version does not know', () => {
    expect(
      aiAccessSettingsOf({
        aiAccessEnabled: 'yes' as unknown as boolean,
        aiAccessMode: 'FULL' as never,
        aiAccessPrompt: 7 as never,
        aiAccessClients: 'everyone' as never,
        aiAccessAttachToTabs: 'no' as unknown as boolean,
      }),
    ).toEqual({
      enabled: false,
      mode: 'sensitive',
      prompt: 'modal',
      clients: 'runova',
      attachToTabs: true,
    });
  });

  it('reads a file that predates the setting', () => {
    expect(aiAccessSettingsOf({}).enabled).toBe(false);
    expect(aiAccessSettingsOf({}).mode).toBe('sensitive');
  });
});
