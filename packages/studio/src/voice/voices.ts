import { STUDIO_PIPER, STUDIO_TTS, type StudioLocalVoice, type StudioTtsVoice } from '@runova/core';
import { withoutChinese } from '../text/languages.js';

/**
 * Voices as a scene names them: `<engine>:<voice id>` in the scene's `voiceRef`, so a video keeps
 * the voice each scene was spoken with. Recorded narration is `recording`.
 */

/** The online engines, each reached with a key. */
export const TTS_ENGINES = ['openai', 'gemini', 'elevenlabs', 'azure'] as const;
export type TtsEngineId = (typeof TTS_ENGINES)[number];

/** The engines that run on this computer, installed from Dev Setup (E37). */
export const LOCAL_ENGINES = ['piper', 'omnivoice'] as const;
export type LocalEngineId = (typeof LOCAL_ENGINES)[number];

export const VOICE_ENGINES = [...TTS_ENGINES, ...LOCAL_ENGINES] as const;
export type VoiceEngineId = (typeof VOICE_ENGINES)[number];

export function isLocalEngine(engine: string): engine is LocalEngineId {
  return (LOCAL_ENGINES as readonly string[]).includes(engine);
}

export const RECORDED_VOICE = 'recording';

export interface VoiceRef {
  engine: VoiceEngineId;
  voice: string;
}

export function formatVoiceRef(ref: VoiceRef): string {
  return `${ref.engine}:${ref.voice}`;
}

export function parseVoiceRef(value: string | null | undefined): VoiceRef | null {
  if (!value) return null;
  const at = value.indexOf(':');
  if (at < 0) return null;
  const engine = value.slice(0, at);
  const voice = value.slice(at + 1);
  if (!(VOICE_ENGINES as readonly string[]).includes(engine) || !voice) return null;
  return { engine: engine as VoiceEngineId, voice };
}

/** Voices without any Chinese one, by locale or by name: Studio never offers Chinese. */
export function voicesWithoutChinese<T extends { locale?: string; label: string }>(
  voices: readonly T[],
): T[] {
  return withoutChinese(voices, (v) => v.locale ?? '').filter(
    (v) => !/\p{Script=Han}/u.test(v.label),
  );
}

/**
 * The voices an engine offers for a language: every voice of an engine whose voices speak any
 * language, and only that language's voices of an engine with one voice per locale.
 */
export function voicesFor(
  engine: TtsEngineId,
  lang: string,
  extra: readonly StudioTtsVoice[] = [],
): StudioTtsVoice[] {
  const all = voicesWithoutChinese([...STUDIO_TTS[engine].voices, ...extra]);
  const primary = lang.split('-')[0]?.toLowerCase() ?? '';
  const local = all.filter((v) => {
    const locale = v.locale?.toLowerCase();
    return locale === primary || locale?.startsWith(`${primary}-`);
  });
  return all.some((v) => v.locale) ? local : all;
}

/**
 * A Piper voice as a scene names it: the model, and for a model with several speakers the speaker's
 * number after a `#` (`en_GB-vctk-medium#12`). Null when the model is not one Studio offers or
 * the speaker is not one of its speakers.
 */
export function parsePiperVoice(
  id: string,
): { model: StudioLocalVoice; speaker: number | null } | null {
  const hash = id.indexOf('#');
  const modelId = hash < 0 ? id : id.slice(0, hash);
  const model = STUDIO_PIPER.voices.find((v) => v.id === modelId);
  if (!model) return null;
  if (hash < 0) return { model, speaker: model.speakers ? 0 : null };
  const speaker = /^\d{1,4}$/.test(id.slice(hash + 1)) ? Number(id.slice(hash + 1)) : -1;
  if (!model.speakers || speaker < 0 || speaker >= model.speakers.length) return null;
  return { model, speaker };
}

/** One Piper voice to pick: a model with one speaker, or one speaker of a model with several. */
export interface PiperVoiceChoice {
  id: string;
  label: string;
  locale: string;
  gender?: 'female' | 'male';
  license: string;
  nonCommercial: boolean;
}

/** The Piper models for a language, only those installed when the installed ones are given. */
export function piperModelsFor(lang: string, installed?: readonly string[]): StudioLocalVoice[] {
  const primary = lang.split('-')[0]?.toLowerCase() ?? '';
  return voicesWithoutChinese(STUDIO_PIPER.voices).filter(
    (v) =>
      v.locale.toLowerCase().split('-')[0] === primary && (!installed || installed.includes(v.id)),
  );
}

/** Piper's voices for a language, each speaker of a model with several as a voice of its own. */
export function piperVoicesFor(lang: string, installed?: readonly string[]): PiperVoiceChoice[] {
  return piperModelsFor(lang, installed).flatMap((model) => {
    const common = {
      locale: model.locale,
      gender: model.gender,
      license: model.license,
      nonCommercial: model.nonCommercial,
    };
    if (!model.speakers) {
      return [{ ...common, id: model.id, label: `${model.label}, ${qualityLabel(model.quality)}` }];
    }
    return model.speakers.map((name, index) => ({
      ...common,
      id: `${model.id}#${index}`,
      label: `${model.label} ${name}, ${qualityLabel(model.quality)}`,
    }));
  });
}

/** x_low as people say it. */
export function qualityLabel(quality: string): string {
  return quality === 'x_low' ? 'extra low' : quality;
}

/**
 * The narration in a video that is for non-commercial use only, by name: anything OmniVoice spoke
 * (its weights are CC BY-NC) and the Piper voices whose license says so. Empty when all is free.
 */
export function nonCommercialNarration(voiceRefs: readonly (string | null)[]): string[] {
  const names = new Set<string>();
  for (const value of voiceRefs) {
    const ref = parseVoiceRef(value);
    if (ref?.engine === 'omnivoice') names.add('OmniVoice');
    if (ref?.engine === 'piper') {
      const voice = parsePiperVoice(ref.voice)?.model;
      if (voice?.nonCommercial) names.add(`Piper ${voice.label}`);
    }
  }
  return [...names];
}
