import { describe, expect, it } from 'vitest';
import { studioAudioInputs } from '../api.js';
import { piperLibraryView, piperVoiceInput } from './piperLibrary.js';

describe('Piper voice library', () => {
  it('lists every voice once, without Chinese, with its size, speakers and state', () => {
    const view = piperLibraryView(
      true,
      ['fa_IR-amir-medium', 'en_GB-vctk-medium'],
      new Map([
        ['en_US-amy-low', { running: true, fraction: 0.4, error: null }],
        ['de_DE-thorsten-high', { running: false, fraction: null, error: 'It failed.' }],
      ]),
    );
    expect(view.engineInstalled).toBe(true);
    expect(new Set(view.voices.map((v) => v.id)).size).toBe(view.voices.length);
    expect(view.voices.some((v) => /^zh/.test(v.locale))).toBe(false);
    const byId = (id: string) => view.voices.find((v) => v.id === id);
    expect(byId('fa_IR-amir-medium')).toMatchObject({
      state: 'installed',
      pack: true,
      speakers: 1,
      size: 63_531_379 + 4958,
      language: 'Persian',
    });
    expect(byId('en_GB-vctk-medium')).toMatchObject({ state: 'installed', speakers: 109 });
    expect(byId('en_US-amy-low')).toMatchObject({ state: 'downloading', fraction: 0.4 });
    expect(byId('de_DE-thorsten-high')).toMatchObject({ state: 'absent', error: 'It failed.' });
    expect(byId('en_US-amy-medium')).toMatchObject({
      state: 'absent',
      license: 'Unknown',
      nonCommercial: true,
    });
  });

  it('takes only a voice Studio offers', () => {
    expect(piperVoiceInput.safeParse({ id: 'en_GB-vctk-medium' }).success).toBe(true);
    expect(piperVoiceInput.safeParse({ id: 'pt_PT-tugão-medium' }).success).toBe(true);
    expect(piperVoiceInput.safeParse({ id: '../../evil' }).success).toBe(false);
    expect(piperVoiceInput.safeParse({ id: 'zh_CN-huayan-medium' }).success).toBe(false);
  });

  it('lets a scene name one speaker of a Piper model', () => {
    const speak = (voiceRef: string) =>
      studioAudioInputs.speak.safeParse({ videoId: 'v1', sceneIds: ['s1'], voiceRef }).success;
    expect(speak('piper:en_GB-vctk-medium#12')).toBe(true);
    expect(speak('piper:pt_PT-tugão-medium')).toBe(true);
    expect(speak('openai:marin')).toBe(true);
    expect(speak('piper:en_GB-vctk-medium#')).toBe(false);
    expect(speak('piper:en_GB-vctk-medium#12#3')).toBe(false);
    expect(speak('piper:../x')).toBe(false);
  });
});
