import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { AiAccessActivityEntry } from '../../shared/aiAccessTypes';

/**
 * The record of what agents did through AI access, shown in Settings so the user can see what an
 * agent read or changed and what they allowed. Newest first, capped, kept across restarts.
 */

export const AI_ACCESS_ACTIVITY_LIMIT = 200;

type NewEntry = Omit<AiAccessActivityEntry, 'id' | 'at'>;
type Listener = (entry: AiAccessActivityEntry) => void;

function filePath(): string {
  return join(app.getPath('userData'), 'data', 'ai-access-activity.json');
}

let cache: AiAccessActivityEntry[] | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<Listener>();

function inQueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

async function load(): Promise<AiAccessActivityEntry[]> {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath(), 'utf-8'));
    cache = Array.isArray(parsed) ? (parsed as AiAccessActivityEntry[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function save(entries: AiAccessActivityEntry[]): Promise<void> {
  const path = filePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(entries), 'utf-8');
  await rename(temp, path);
}

export const aiAccessActivity = {
  list(): Promise<AiAccessActivityEntry[]> {
    return inQueue(async () => [...(await load())]);
  },

  record(entry: NewEntry): Promise<AiAccessActivityEntry> {
    return inQueue(async () => {
      const full: AiAccessActivityEntry = { ...entry, id: randomUUID(), at: Date.now() };
      const next = [full, ...(await load())].slice(0, AI_ACCESS_ACTIVITY_LIMIT);
      cache = next;
      await save(next);
      for (const listener of listeners) listener(full);
      return full;
    });
  },

  clear(): Promise<void> {
    return inQueue(async () => {
      cache = [];
      await save([]);
    });
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
