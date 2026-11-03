import { type PiperDownloadState, type PiperLibraryView, piperLibraryView } from '@runova/studio';
import type { StudioToolsInstaller } from '../devSetup/runners/studioTools';
import type { CancelToken } from '../process/spawnStreaming';

/**
 * Downloads for Studio's Piper voice library (E37), in the main process so they carry on while the
 * library is closed. Each voice downloads once at a time, a cancel stops it where it is (what
 * arrived is kept for the next try), and every change is announced so open windows refresh, a
 * few times a second at most while bytes arrive.
 */

export interface PiperDownloadsDeps {
  installer: () => Pick<StudioToolsInstaller, 'fetchPiperVoice' | 'removePiperVoice'>;
  /** Piper and the voices on disk, as Studio sees them. */
  installed: () => Promise<{ engine: boolean; voices: readonly string[] }>;
  /** Tells the windows the library changed. */
  changed: () => void;
  now?: () => number;
  /** Least time between two progress announcements. */
  throttleMs?: number;
}

interface Running extends PiperDownloadState {
  token: CancelToken;
  abort: (() => void) | null;
  done: Promise<void>;
}

export function createPiperDownloads(deps: PiperDownloadsDeps) {
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? 250;
  const downloads = new Map<string, Running>();
  let lastAnnounced = 0;

  function announce(force: boolean): void {
    const at = now();
    if (!force && at - lastAnnounced < throttleMs) return;
    lastAnnounced = at;
    deps.changed();
  }

  async function list(): Promise<PiperLibraryView> {
    const { engine, voices } = await deps.installed();
    return piperLibraryView(engine, voices, downloads);
  }

  /** Starts downloading a voice and returns at once; the library shows how it goes. */
  async function download(id: string): Promise<PiperLibraryView> {
    if (!downloads.get(id)?.running) {
      if (!(await deps.installed()).engine) {
        throw new Error('Install Piper first, from Agent Tools, Dev Setup (Studio).');
      }
      const state: Running = {
        running: true,
        fraction: null,
        error: null,
        token: { cancelled: false, child: null },
        abort: null,
        done: Promise.resolve(),
      };
      downloads.set(id, state);
      state.done = deps
        .installer()
        .fetchPiperVoice(id, {
          token: state.token,
          onCancel: (abort) => {
            state.abort = abort;
          },
          onProgress: (update) => {
            if (update.fraction === undefined || update.phase !== 'downloading') return;
            state.fraction = update.fraction;
            announce(false);
          },
          onLine: () => undefined,
        })
        .then(
          (result) => {
            state.running = false;
            state.error = result.ok || result.cancelled ? null : (result.message ?? 'It failed.');
          },
          (error: unknown) => {
            state.running = false;
            state.error = error instanceof Error ? error.message : String(error);
          },
        )
        .then(() => {
          // A finished or cancelled download leaves nothing to show; a failed one says why.
          if (!state.error && downloads.get(id) === state) downloads.delete(id);
          announce(true);
        });
      announce(true);
    }
    return list();
  }

  async function cancel(id: string): Promise<PiperLibraryView> {
    const state = downloads.get(id);
    if (state?.running) {
      state.token.cancelled = true;
      state.abort?.();
      await state.done;
    } else if (state) {
      downloads.delete(id);
      announce(true);
    }
    return list();
  }

  /** Deletes a voice, stopping its download first. */
  async function remove(id: string): Promise<PiperLibraryView> {
    if (downloads.get(id)?.running) await cancel(id);
    downloads.delete(id);
    await deps.installer().removePiperVoice(id);
    announce(true);
    return list();
  }

  return { list, download, cancel, remove };
}

export type PiperDownloads = ReturnType<typeof createPiperDownloads>;
