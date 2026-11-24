/**
 * Reads what `git clone --progress` (and `git fetch --progress`) prints on stderr and turns it
 * into one progress bar. Git redraws a line with `\r` while a phase runs and ends it with `\n`,
 * and a chunk from the pipe can stop anywhere, so text is buffered until a line ends.
 */

import type { CloneProgressPhase } from '../../shared/apiTypes';

export type { CloneProgressPhase };

export interface CloneProgress {
  phase: CloneProgressPhase;
  /** The whole clone, 0 to 100. Never goes down. */
  percent: number;
  receivedBytes?: number;
  bytesPerSecond?: number;
}

export interface CloneProgressParser {
  /** Feeds raw stderr. Returns the new progress when it changed, otherwise null. */
  push(chunk: string): CloneProgress | null;
}

/** Where each git phase sits on the bar. Downloading is most of the wait, so it gets most of it. */
const SPANS: Record<string, { phase: CloneProgressPhase; from: number; to: number }> = {
  'enumerating objects': { phase: 'remote', from: 0, to: 0 },
  'counting objects': { phase: 'remote', from: 0, to: 5 },
  'compressing objects': { phase: 'remote', from: 5, to: 10 },
  'receiving objects': { phase: 'receiving', from: 10, to: 75 },
  'resolving deltas': { phase: 'resolving', from: 75, to: 92 },
  'updating files': { phase: 'checkout', from: 92, to: 100 },
  'checking out files': { phase: 'checkout', from: 92, to: 100 },
};

const LINE =
  /^(?:remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s*(?:(\d{1,3})%)?(?:[^,]*,\s*([\d.]+\s*(?:bytes|[KMG]iB))(?:\s*\|\s*([\d.]+\s*(?:bytes|[KMG]iB))\/s)?)?/i;

const UNITS: Record<string, number> = {
  bytes: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/** "12.40 MiB" in bytes, or undefined when it isn't a size git prints. */
export function parseByteSize(text: string): number | undefined {
  const match = /^([\d.]+)\s*(bytes|[KMG]iB)$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = UNITS[(match[2] as string).toLowerCase()];
  if (!Number.isFinite(value) || unit === undefined) return undefined;
  return Math.round(value * unit);
}

export function createCloneProgressParser(): CloneProgressParser {
  let pending = '';
  let last: CloneProgress | null = null;

  function read(line: string): CloneProgress | null {
    const match = LINE.exec(line.trim());
    if (!match) return null;
    const span = SPANS[(match[1] as string).toLowerCase()];
    if (!span) return null;
    const ownPercent = match[2] === undefined ? 0 : Math.min(100, Number(match[2]));
    const overall = Math.round(span.from + ((span.to - span.from) * ownPercent) / 100);
    const next: CloneProgress = {
      phase: span.phase,
      percent: Math.max(last?.percent ?? 0, overall),
    };
    const received = match[3] ? parseByteSize(match[3]) : undefined;
    const rate = match[4] ? parseByteSize(match[4]) : undefined;
    if (received !== undefined) next.receivedBytes = received;
    if (rate !== undefined) next.bytesPerSecond = rate;
    return next;
  }

  function same(a: CloneProgress | null, b: CloneProgress): boolean {
    return (
      a !== null &&
      a.phase === b.phase &&
      a.percent === b.percent &&
      a.receivedBytes === b.receivedBytes &&
      a.bytesPerSecond === b.bytesPerSecond
    );
  }

  return {
    push(chunk) {
      pending += chunk;
      const parts = pending.split(/\r\n|\r|\n/);
      pending = parts.pop() ?? '';
      let changed: CloneProgress | null = null;
      for (const line of parts) {
        const next = read(line);
        if (!next || same(last, next)) continue;
        last = next;
        changed = next;
      }
      return changed;
    },
  };
}
