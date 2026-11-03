import { piperVoiceInput, type StudioEvent } from '@runova/studio';
import { IPC } from '../../shared/ipcChannels';
import { createStudioTools, studioToolsRoot } from '../devSetup/runners/managedRuntime';
import type { StudioToolsInstaller } from '../devSetup/runners/studioTools';
import { findLocalVoiceTools } from '../studio/localTools';
import { createPiperDownloads, type PiperDownloads } from '../studio/piperDownloads';
import { broadcastToWindows } from './send';

/**
 * Studio's Piper voice library (E37) over IPC: every voice Studio offers, and downloading or
 * removing one. The downloads live here in the main process, so they carry on while the library
 * is closed, and every window hears when one moves on.
 */

let library: PiperDownloads | null = null;
let tools: StudioToolsInstaller | null = null;

function piperVoiceLibrary(): PiperDownloads {
  library ??= createPiperDownloads({
    // Built the first time a voice is downloaded or removed, like Dev Setup's own installers.
    installer: () => {
      tools ??= createStudioTools();
      return tools;
    },
    installed: async () => {
      const found = await findLocalVoiceTools(studioToolsRoot(), process.platform);
      return { engine: found.piper !== null, voices: found.piper?.voices ?? [] };
    },
    changed: () =>
      broadcastToWindows(IPC.studio.onEvent, {
        type: 'piper-voices-changed',
      } satisfies StudioEvent),
  });
  return library;
}

function voiceId(value: unknown): string {
  const parsed = piperVoiceInput.safeParse(value);
  if (parsed.success) return parsed.data.id;
  throw new Error(
    `That Studio request is not valid: ${parsed.error.issues[0]?.message ?? 'no voice named'}`,
  );
}

/** Adds the library's channels through Studio's own `handle`, which answers the main window only. */
export function registerPiperVoiceHandlers(
  handle: (channel: string, fn: (value: unknown) => unknown) => void,
): void {
  handle(IPC.studioAudio.piperLibrary, () => piperVoiceLibrary().list());
  handle(IPC.studioAudio.downloadPiperVoice, (value) =>
    piperVoiceLibrary().download(voiceId(value)),
  );
  handle(IPC.studioAudio.cancelPiperVoice, (value) => piperVoiceLibrary().cancel(voiceId(value)));
  handle(IPC.studioAudio.removePiperVoice, (value) => piperVoiceLibrary().remove(voiceId(value)));
}
