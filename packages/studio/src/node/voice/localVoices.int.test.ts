import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { realTools } from '../../test/ffmpegTools.js';
import { useTempDirs } from '../../test/tempDir.js';
import { encodeWav, parseWav } from '../../voice/wav.js';
import { createLocalVoices } from './localVoices.js';
import type { VoiceProfiles } from './voiceProfiles.js';

/**
 * A voice profile's take prepared by the real ffmpeg. loudnorm in ffmpeg 6.1 (Ubuntu 24.04's)
 * never finished for some takes, depending on where the trim ended. Each tone below is one of
 * them: with the filter as it was before the padding in TAKE_FILTER, Ubuntu 24.04's ffmpeg idled
 * on it until killed. Other ffmpeg versions run these in well under a second either way.
 */

const tools = realTools();
const tempDir = useTempDirs();
const RATE = 48_000;

/** A steady tone of exactly `samples` samples, loud from the first to the last, so nothing is trimmed. */
function tone(samples: number): Uint8Array {
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 200 * i) / RATE + 1) * 12_000), true);
  }
  return encodeWav(pcm, RATE);
}

describe.skipIf(!tools)('a voice take with the real ffmpeg', () => {
  for (const samples of [3.2 * RATE, 3.7 * RATE, 5 * RATE]) {
    it(`trims and levels a take of ${samples} samples`, { timeout: 30_000 }, async () => {
      const root = await tempDir();
      let n = 0;
      const voices = createLocalVoices({
        host: undefined,
        profiles: {} as VoiceProfiles,
        workDir: async () => root,
        assetsRoot: root,
        tools: async () => tools,
        newId: () => `take${++n}`,
      });
      const take = await voices.prepareTake(tone(samples), 'audio/wav');
      const wav = parseWav(new Uint8Array(await readFile(take.wav)));
      expect(wav.sampleRate).toBe(24_000);
      expect(wav.channels).toBe(1);
      // The padding rounds the trimmed take up to the next tenth of a second (the trim itself
      // may keep a sample or two more than it was given).
      expect(take.seconds).toBeGreaterThanOrEqual(samples / RATE - 0.01);
      expect(take.seconds).toBeLessThanOrEqual(samples / RATE + 0.11);
    });
  }
});
