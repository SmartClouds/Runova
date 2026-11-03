import { voicesWithoutChinese } from '@runova/studio';
import { describe, expect, it } from 'vitest';
import type { RunHooks, RunResult } from '../devSetup/runners/packageManagerRunner';
import { createPiperDownloads } from './piperDownloads';

/** The Piper voice library's downloads, with a made-up installer the test moves along by hand. */

function world(options: { engine?: boolean; installed?: string[] } = {}) {
  const installed = new Set(options.installed ?? []);
  const runs = new Map<string, { hooks: RunHooks; finish: (r: RunResult) => void }>();
  const removed: string[] = [];
  let changes = 0;
  let clock = 0;
  const downloads = createPiperDownloads({
    installer: () => ({
      fetchPiperVoice: (id, hooks) =>
        new Promise<RunResult>((resolve) => {
          runs.set(id, {
            hooks,
            finish: (result) => {
              if (result.ok) installed.add(id);
              resolve(result);
            },
          });
        }),
      removePiperVoice: async (id) => {
        removed.push(id);
        installed.delete(id);
      },
    }),
    installed: async () => ({ engine: options.engine ?? true, voices: [...installed] }),
    changed: () => {
      changes++;
    },
    now: () => clock,
    throttleMs: 100,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    downloads,
    runs,
    removed,
    changes: () => changes,
    tick: (ms: number) => {
      clock += ms;
    },
    flush,
  };
}

const OK: RunResult = { ok: true, code: 0, cancelled: false };
const voice = (
  view: Awaited<ReturnType<ReturnType<typeof world>['downloads']['list']>>,
  id: string,
) => view.voices.find((v) => v.id === id);

describe('Piper voice library downloads', () => {
  it('lists every voice with what is on disk, and the pack marked', async () => {
    const w = world({ installed: ['fa_IR-amir-medium'] });
    const view = await w.downloads.list();
    expect(view.engineInstalled).toBe(true);
    expect(view.voices.length).toBeGreaterThan(100);
    expect(voice(view, 'fa_IR-amir-medium')).toMatchObject({ state: 'installed', pack: true });
    expect(voice(view, 'en_GB-vctk-medium')).toMatchObject({
      state: 'absent',
      speakers: 109,
      pack: false,
      license: 'CC BY 4.0',
      nonCommercial: false,
    });
    expect(voicesWithoutChinese(view.voices)).toHaveLength(view.voices.length);
  });

  it('downloads a voice once however often it is asked, shows its progress, then has it', async () => {
    const w = world();
    const started = await w.downloads.download('en_GB-vctk-medium');
    expect(voice(started, 'en_GB-vctk-medium')).toMatchObject({
      state: 'downloading',
      fraction: null,
    });
    await w.downloads.download('en_GB-vctk-medium');
    expect(w.runs.size).toBe(1);
    const run = w.runs.get('en_GB-vctk-medium');
    const before = w.changes();
    run?.hooks.onProgress({ phase: 'downloading', fraction: 0.25 });
    // A second update within the throttle is kept but not announced.
    run?.hooks.onProgress({ phase: 'downloading', fraction: 0.5 });
    expect(w.changes()).toBe(before);
    w.tick(150);
    run?.hooks.onProgress({ phase: 'downloading', fraction: 0.6 });
    expect(w.changes()).toBe(before + 1);
    expect(voice(await w.downloads.list(), 'en_GB-vctk-medium')?.fraction).toBe(0.6);
    run?.finish(OK);
    await w.flush();
    expect(voice(await w.downloads.list(), 'en_GB-vctk-medium')).toMatchObject({
      state: 'installed',
      error: null,
    });
  });

  it('says why a download failed until it is tried again or dismissed', async () => {
    const w = world();
    await w.downloads.download('en_US-amy-low');
    w.runs.get('en_US-amy-low')?.finish({
      ok: false,
      code: null,
      cancelled: false,
      message: 'The download of the Amy voice failed.',
    });
    await w.flush();
    expect(voice(await w.downloads.list(), 'en_US-amy-low')).toMatchObject({
      state: 'absent',
      error: 'The download of the Amy voice failed.',
    });
    const dismissed = await w.downloads.cancel('en_US-amy-low');
    expect(voice(dismissed, 'en_US-amy-low')?.error).toBeNull();
  });

  it('cancels a download where it is, and removes a voice even while it downloads', async () => {
    const w = world({ installed: ['en_US-amy-low'] });
    await w.downloads.download('en_GB-vctk-medium');
    const run = w.runs.get('en_GB-vctk-medium');
    let aborted = false;
    run?.hooks.onCancel?.(() => {
      aborted = true;
      run.finish({ ok: false, code: null, cancelled: true });
    });
    const view = await w.downloads.cancel('en_GB-vctk-medium');
    expect(aborted).toBe(true);
    expect(run?.hooks.token.cancelled).toBe(true);
    expect(voice(view, 'en_GB-vctk-medium')).toMatchObject({ state: 'absent', error: null });

    const gone = await w.downloads.remove('en_US-amy-low');
    expect(w.removed).toEqual(['en_US-amy-low']);
    expect(voice(gone, 'en_US-amy-low')?.state).toBe('absent');
  });

  it('asks for Piper before downloading a voice', async () => {
    const w = world({ engine: false });
    await expect(w.downloads.download('en_US-amy-low')).rejects.toThrow(/^Install Piper first/);
    expect(w.runs.size).toBe(0);
  });
});
