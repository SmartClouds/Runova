import { STUDIO_PIPER } from '@runova/core';
import { z } from 'zod';
import { voicesWithoutChinese } from './voices.js';

/**
 * Studio's Piper voice library: every Piper voice model Studio offers, which of them are on this
 * computer, and the ones downloading. The pack comes with Dev Setup; any other voice is downloaded
 * here, one model at a time, and a model with several speakers brings all of them.
 */

export interface PiperVoiceModelView {
  id: string;
  label: string;
  locale: string;
  /** The language in English, such as German. */
  language: string;
  quality: string;
  /** Bytes to download. */
  size: number;
  license: string;
  nonCommercial: boolean;
  /** Where its recordings came from, to read their terms. */
  source: string | null;
  /** How many voices it speaks with; one for most. */
  speakers: number;
  /** Comes with Dev Setup's Piper voices. */
  pack: boolean;
  state: 'absent' | 'downloading' | 'installed';
  /** How far a download is, from 0 to 1, or null before its size is known. */
  fraction: number | null;
  /** Why the last download stopped short. */
  error: string | null;
}

export interface PiperLibraryView {
  /** Piper itself is installed; without it no voice can be downloaded. */
  engineInstalled: boolean;
  voices: PiperVoiceModelView[];
}

/** A download in progress or one that failed, by voice. */
export interface PiperDownloadState {
  running: boolean;
  fraction: number | null;
  error: string | null;
}

export const piperVoiceInput = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .refine(
      (id) => STUDIO_PIPER.voices.some((v) => v.id === id),
      'Studio does not offer that voice.',
    ),
});

export function piperLibraryView(
  engineInstalled: boolean,
  installed: readonly string[],
  downloads: ReadonlyMap<string, PiperDownloadState>,
): PiperLibraryView {
  const have = new Set(installed);
  return {
    engineInstalled,
    voices: voicesWithoutChinese(STUDIO_PIPER.voices).map((v) => {
      const download = downloads.get(v.id);
      return {
        id: v.id,
        label: v.label,
        locale: v.locale,
        language: v.language,
        quality: v.quality,
        size: v.files.reduce((sum, f) => sum + f.size, 0),
        license: v.license,
        nonCommercial: v.nonCommercial,
        source: v.source ?? null,
        speakers: v.speakers?.length ?? 1,
        pack: v.pack === true,
        state: download?.running ? 'downloading' : have.has(v.id) ? 'installed' : 'absent',
        fraction: download?.running ? download.fraction : null,
        error: download && !download.running ? download.error : null,
      };
    }),
  };
}
