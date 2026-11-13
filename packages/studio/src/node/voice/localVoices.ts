import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWav } from '../../voice/wav.js';
import { type FfmpegTools, runTool } from '../render/ffmpegTool.js';
import type { LocalSpeakers } from './engines.js';
import { createOmniVoiceSpeaker } from './omnivoice.js';
import { createPiperSpeaker } from './piper.js';
import type { StudioVoiceHost } from './voiceKeys.js';
import type { VoiceProfiles } from './voiceProfiles.js';

/**
 * The voices on this computer, made from what Dev Setup installed (E37): a Piper speaker and an
 * OmniVoice speaker, each built once and kept while its install stays where it is. Also turns a
 * take recorded for a voice profile into the steady, trimmed WAV a cloning engine wants.
 */

export interface LocalVoicesDeps {
  host: StudioVoiceHost | undefined;
  profiles: VoiceProfiles;
  /** Scratch space for pieces and takes. */
  workDir: () => Promise<string>;
  /** Studio's own files, where the OmniVoice sidecar script is. */
  assetsRoot: string;
  tools: () => Promise<FfmpegTools | null>;
  newId: () => string;
  onLog?: (line: string) => void;
}

/** How long a take for a voice profile may be; OmniVoice clones best from 3 to 10 seconds. */
export const TAKE_SECONDS = { min: 3, max: 60 } as const;

/**
 * What a take goes through: the silence at either end trimmed, then the level evened out.
 *
 * Between the two, the take is made 48 kHz and padded with silence to a whole tenth of a second.
 * loudnorm in ffmpeg 6.1 (the one Ubuntu 24.04 ships) never finishes when its input ends one
 * sample past a tenth of a second: ffmpeg idles at no CPU and the take never comes back. Where
 * the trim ends depends on the recording, so without the padding that hit one take in a few
 * hundred. Newer ffmpeg does not have the bug, and the padding adds under 0.1 s of silence.
 */
export const TAKE_FILTER =
  'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB,areverse,' +
  'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB,areverse,' +
  'aresample=48000,asetnsamples=n=4800:p=1,loudnorm=I=-20:TP=-2';

export function createLocalVoices(deps: LocalVoicesDeps) {
  let piper: { key: string; speak: NonNullable<LocalSpeakers['piper']> } | null = null;
  let omnivoice: {
    key: string;
    speak: ReturnType<typeof createOmniVoiceSpeaker>;
  } | null = null;

  async function speakers(): Promise<LocalSpeakers> {
    const tools = await deps.host?.local?.();
    const work = join(await deps.workDir(), 'local');
    const found: LocalSpeakers = {};
    if (tools?.piper && tools.piper.voices.length > 0) {
      const key = `${tools.piper.python}|${tools.piper.voicesDir}`;
      if (piper?.key !== key) {
        piper = {
          key,
          speak: createPiperSpeaker({
            python: tools.piper.python,
            prefixArgs: tools.piper.prefixArgs,
            voicesDir: tools.piper.voicesDir,
            workDir: work,
          }),
        };
      }
      found.piper = piper.speak;
    }
    if (tools?.omnivoice) {
      const key = `${tools.omnivoice.python}|${tools.omnivoice.modelDir}`;
      if (omnivoice?.key !== key) {
        await omnivoice?.speak.stop();
        omnivoice = {
          key,
          speak: createOmniVoiceSpeaker({
            python: tools.omnivoice.python,
            prefixArgs: tools.omnivoice.prefixArgs,
            script: join(deps.assetsRoot, 'assets', 'voice', 'omnivoice_server.py'),
            modelDir: tools.omnivoice.modelDir,
            workDir: work,
            profiles: deps.profiles,
            onLog: deps.onLog,
          }),
        };
      }
      found.omnivoice = omnivoice.speak;
    }
    return found;
  }

  /**
   * A recording from the browser made into a voice profile's take: one channel at 24 kHz, the
   * silence at either end trimmed, and the level evened out. Resolves to the WAV and its length;
   * the caller removes it when done.
   */
  async function prepareTake(bytes: Uint8Array, mimeType: string) {
    const tools = await deps.tools();
    if (!tools) {
      throw new Error(
        'Voice profiles need ffmpeg, which is not installed yet. Install it from Dev Tools, Dev Setup (Studio).',
      );
    }
    const dir = join(await deps.workDir(), 'takes');
    await mkdir(dir, { recursive: true });
    const id = deps.newId();
    const input = join(dir, `${id}.${mimeType.includes('wav') ? 'wav' : 'webm'}`);
    const wav = join(dir, `${id}-take.wav`);
    await writeFile(input, bytes);
    try {
      await runTool(tools.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-af',
        TAKE_FILTER,
        '-ac',
        '1',
        '-ar',
        '24000',
        '-c:a',
        'pcm_s16le',
        wav,
      ]);
    } finally {
      await rm(input, { force: true });
    }
    const seconds = parseWav(await readFile(wav)).seconds;
    if (seconds < TAKE_SECONDS.min || seconds > TAKE_SECONDS.max) {
      await rm(wav, { force: true });
      throw new Error(
        `Record ${TAKE_SECONDS.min} to ${TAKE_SECONDS.max} seconds of speech; this take has ${seconds.toFixed(1)} s once its silence is trimmed. Six to ten seconds clones best.`,
      );
    }
    return { wav, seconds };
  }

  return {
    speakers,
    prepareTake,
    async stop() {
      await omnivoice?.speak.stop();
    },
  };
}
