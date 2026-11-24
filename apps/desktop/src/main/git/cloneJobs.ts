import { normalizeCloneUrl } from '@runova/core';
import type { CloneJob, StartCloneInput, StartCloneResult } from '../../shared/apiTypes';
import type { CloneOutcome, CloneRunOptions } from './cloneRepo';

/**
 * Clones that run in the background. A clone of a big repo takes minutes, and the user should be
 * free to close the dialog and go elsewhere in the app meanwhile, so the job lives here in main
 * rather than in the page that started it. Every change goes to every window as the whole list,
 * so a window that reloads (or opens late) catches up with one `list()`.
 */

/** About eight updates a second: smooth enough for a bar, cheap enough for IPC. */
export const PROGRESS_EMIT_MS = 125;
/** A finished clone stays long enough for the check mark to be seen, then makes way. */
export const SUCCESS_LINGER_MS = 8000;

const NOT_CLONABLE_MESSAGE = 'That address cannot be cloned. Use a github.com/owner/repo link.';
const ATTACH_CONFIRM_MESSAGE =
  'This folder already has files. Confirm to connect it to the repository.';

export interface CloneJobProject {
  id: string;
  name: string;
  folderPath: string;
  repoUrl?: string;
}

export interface CloneJobsDeps {
  getProject(projectId: string): Promise<CloneJobProject>;
  inspectFolder(folder: string): Promise<'repo' | 'empty' | 'files'>;
  clone(
    folder: string,
    url: string,
    attach: boolean,
    options: CloneRunOptions,
  ): Promise<CloneOutcome>;
  saveRepoUrl(projectId: string, url: string): Promise<void>;
  broadcast(jobs: CloneJob[]): void;
  notify(notification: { title: string; body: string; route: string }): void;
  isAppFocused(): boolean;
  now?: () => number;
  newId?: () => string;
}

export interface CloneJobs {
  start(input: StartCloneInput): Promise<StartCloneResult>;
  list(): CloneJob[];
  /** Stops a running job. False when there is nothing running by that id. */
  cancel(id: string): boolean;
  /** Forgets a finished job. A running one has to be stopped first. */
  dismiss(id: string): boolean;
}

interface Entry {
  job: CloneJob;
  controller: AbortController;
}

function sameFolder(a: string, b: string): boolean {
  const clean = (path: string) => path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  // Windows and macOS file systems ignore case, and a duplicate clone there would collide.
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

export function createCloneJobs(deps: CloneJobsDeps): CloneJobs {
  const now = deps.now ?? Date.now;
  let counter = 0;
  const newId = deps.newId ?? (() => `clone-${now().toString(36)}-${++counter}`);
  const entries = new Map<string, Entry>();
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  const snapshot = (): CloneJob[] => [...entries.values()].map((entry) => ({ ...entry.job }));

  function emitNow(): void {
    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }
    lastEmitAt = now();
    deps.broadcast(snapshot());
  }

  function emitSoon(): void {
    if (trailing) return;
    const wait = lastEmitAt + PROGRESS_EMIT_MS - now();
    if (wait <= 0) {
      emitNow();
      return;
    }
    trailing = setTimeout(emitNow, wait);
  }

  function runningFor(folder: string): Entry | undefined {
    for (const entry of entries.values()) {
      if (entry.job.status === 'running' && sameFolder(entry.job.folderPath, folder)) return entry;
    }
    return undefined;
  }

  function forgetFinished(projectId: string): void {
    for (const [id, entry] of entries) {
      if (entry.job.projectId === projectId && entry.job.status !== 'running') entries.delete(id);
    }
  }

  function finish(entry: Entry, outcome: CloneOutcome): void {
    const { job } = entry;
    job.finishedAt = now();
    job.message = outcome.message;
    if (outcome.ok) {
      job.status = 'succeeded';
      job.percent = 100;
    } else {
      job.status = outcome.cancelled || entry.controller.signal.aborted ? 'cancelled' : 'failed';
    }
    emitNow();

    if (job.status === 'succeeded') {
      const timer = setTimeout(() => {
        if (entries.get(job.id) !== entry) return;
        entries.delete(job.id);
        emitNow();
      }, SUCCESS_LINGER_MS);
      (timer as { unref?: () => void }).unref?.();
    }

    if (job.status === 'cancelled' || deps.isAppFocused()) return;
    const route = `/projects/${job.projectId}?tab=git`;
    deps.notify(
      job.status === 'succeeded'
        ? {
            title: `${job.projectName} is ready`,
            body: `${job.attach ? 'Connected to' : 'Cloned'} ${job.repoLabel}.`,
            route,
          }
        : { title: `Couldn't clone ${job.projectName}`, body: job.message ?? '', route },
    );
  }

  async function start(input: StartCloneInput): Promise<StartCloneResult> {
    const project = await deps.getProject(input.projectId);
    const typed = input.repoUrl?.trim();
    const url = normalizeCloneUrl(typed || project.repoUrl || '');
    if (!url) return { ok: false, message: NOT_CLONABLE_MESSAGE };

    const running = runningFor(project.folderPath);
    if (running) return { ok: true, message: 'Already cloning.', job: { ...running.job } };

    const folderState = await deps.inspectFolder(project.folderPath);
    if (folderState === 'repo') {
      return { ok: true, skipped: true, message: 'Folder is already a git repository.' };
    }
    const attach = folderState === 'files';
    if (attach && input.attach !== true) {
      return { ok: false, needsAttachConfirm: true, message: ATTACH_CONFIRM_MESSAGE };
    }

    forgetFinished(project.id);
    const entry: Entry = {
      controller: new AbortController(),
      job: {
        id: newId(),
        projectId: project.id,
        projectName: project.name,
        repoUrl: url,
        repoLabel: url.replace(/^https:\/\/github\.com\//i, ''),
        folderPath: project.folderPath,
        attach,
        status: 'running',
        phase: null,
        percent: 0,
        startedAt: now(),
      },
    };
    entries.set(entry.job.id, entry);
    emitNow();

    const options: CloneRunOptions = {
      signal: entry.controller.signal,
      onProgress: (progress) => {
        if (entry.job.status !== 'running') return;
        entry.job.phase = progress.phase;
        entry.job.percent = progress.percent;
        entry.job.receivedBytes = progress.receivedBytes ?? entry.job.receivedBytes;
        entry.job.bytesPerSecond = progress.bytesPerSecond;
        emitSoon();
      },
    };
    void deps
      .clone(project.folderPath, url, attach, options)
      .then(async (outcome) => {
        if (outcome.ok && typed && url !== project.repoUrl) {
          await deps.saveRepoUrl(project.id, url).catch(() => undefined);
        }
        finish(entry, outcome);
      })
      .catch((error: unknown) => {
        finish(entry, { ok: false, message: (error as Error)?.message || 'Clone failed.' });
      });

    return { ok: true, message: 'Cloning.', job: { ...entry.job } };
  }

  return {
    start,
    list: snapshot,
    cancel(id) {
      const entry = entries.get(id);
      if (!entry || entry.job.status !== 'running' || entry.controller.signal.aborted) return false;
      entry.controller.abort();
      return true;
    },
    dismiss(id) {
      const entry = entries.get(id);
      if (!entry || entry.job.status === 'running') return false;
      entries.delete(id);
      emitNow();
      return true;
    },
  };
}
