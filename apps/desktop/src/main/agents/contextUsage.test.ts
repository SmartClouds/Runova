import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextUsageFor, readSessionContextUsage } from './contextUsage';

const tracker = vi.hoisted(() => ({
  transcriptPath: vi.fn((_id: string): string | null => null),
  model: vi.fn((_id: string): string | undefined => undefined),
}));
vi.mock('./statusTracker', () => ({ agentStatus: tracker }));

function reply(input: number, read: number, create: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: `m${input}`,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: create,
        output_tokens: 50,
      },
    },
  });
}

describe('contextUsageFor', () => {
  it('measures against the window the model implies', () => {
    expect(contextUsageFor(84_100, 'claude-opus-5-5')).toEqual({
      tokens: 84_100,
      window: 200_000,
    });
    expect(contextUsageFor(84_100, 'claude-opus-5-5[1m]')).toEqual({
      tokens: 84_100,
      window: 1_000_000,
    });
  });

  it('assumes the standard window when the model is not known yet', () => {
    expect(contextUsageFor(5_000, undefined)).toEqual({ tokens: 5_000, window: 200_000 });
  });

  it('takes the 1M window when the context is already past the standard one', () => {
    // Transcripts record the model id without its `[1m]` suffix.
    expect(contextUsageFor(250_000, 'claude-opus-5-5')).toEqual({
      tokens: 250_000,
      window: 1_000_000,
    });
  });
});

describe('readSessionContextUsage', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runova-context-usage-'));
    tracker.transcriptPath.mockReset().mockReturnValue(null);
    tracker.model.mockReset().mockReturnValue(undefined);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is null while the session has not reported a transcript', async () => {
    expect(await readSessionContextUsage('tab-1')).toBeNull();
  });

  it('is null before the first reply', async () => {
    const path = join(dir, 'abc.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    tracker.transcriptPath.mockReturnValue(path);
    expect(await readSessionContextUsage('tab-1')).toBeNull();
  });

  it('reads the latest reply of the tab its transcript belongs to', async () => {
    const path = join(dir, 'abc.jsonl');
    writeFileSync(path, `${reply(10, 1_000, 0)}\n${reply(100, 80_000, 4_000)}\n`);
    tracker.transcriptPath.mockImplementation((id) => (id === 'tab-1' ? path : null));
    tracker.model.mockImplementation((id) => (id === 'tab-1' ? 'claude-opus-5-5[1m]' : undefined));
    expect(await readSessionContextUsage('tab-1')).toEqual({ tokens: 84_100, window: 1_000_000 });
    expect(await readSessionContextUsage('tab-2')).toBeNull();
  });
});
