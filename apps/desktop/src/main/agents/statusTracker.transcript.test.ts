import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ipc/send', () => ({ broadcastToWindows: () => undefined }));
vi.mock('../mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../notifications/osNotification', () => ({ showOsNotification: () => undefined }));
vi.mock('../notifications/petNotifier', () => ({ speakOnPet: () => true }));
vi.mock('../power/keepAwake', () => ({ keepAwake: { setBusy: () => undefined } }));
vi.mock('../worktrees/resolve', () => ({ scopeDisplayName: () => null }));
vi.mock('../store', () => ({
  store: {
    getSettings: async () => ({}),
    updateSettings: async () => undefined,
    getLastRunInfoByCli: async () => ({}),
    setLastRunInfoByCli: async () => undefined,
  },
}));

const { agentStatus } = await import('./statusTracker');

/**
 * Claude Code names its transcript on SessionStart, before it has written the file. The Relay
 * context meter reads that path later, so it must be kept even though it cannot be watched yet.
 */
describe('agentStatus transcript path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-transcript-'));

  afterEach(() => {
    agentStatus.unpin('leg-1');
    agentStatus.sync([]);
  });

  it('keeps a transcript path reported before the file exists', async () => {
    agentStatus.pin({ sessionId: 'leg-1', projectId: 'p1', cliId: 'claude-code', title: 'T001' });
    const path = join(dir, 'not-yet.jsonl');
    await agentStatus.runInfo('leg-1', { transcriptPath: path });
    expect(agentStatus.transcriptPath('leg-1')).toBe(path);

    // Once the file is there, a later hook with the same path starts watching it.
    writeFileSync(path, '');
    await agentStatus.runInfo('leg-1', { transcriptPath: path });
    expect(agentStatus.transcriptPath('leg-1')).toBe(path);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a path that is not a transcript', async () => {
    agentStatus.pin({ sessionId: 'leg-1', projectId: 'p1', cliId: 'claude-code', title: 'T001' });
    await agentStatus.runInfo('leg-1', { transcriptPath: 'relative/t.jsonl' });
    expect(agentStatus.transcriptPath('leg-1')).toBeNull();
  });
});

describe('agentStatus run info from the transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-effort-'));
  const reply = (model: string): string =>
    JSON.stringify({ type: 'assistant', message: { model, content: [] } });
  const stdout = (text: string): string =>
    JSON.stringify({
      type: 'user',
      message: { content: `<local-command-stdout>${text}</local-command-stdout>` },
    });

  afterEach(() => {
    agentStatus.unpin('leg-2');
    agentStatus.sync([]);
  });

  it('reads the effort of the newest /effort switch', async () => {
    agentStatus.pin({ sessionId: 'leg-2', projectId: 'p1', cliId: 'claude-code', title: 'T002' });
    const path = join(dir, 'effort.jsonl');
    writeFileSync(
      path,
      [
        stdout('Set effort level to low (this session only): Quick answers.'),
        reply('claude-opus-5-5'),
        stdout('Set effort level to xhigh (this session only): Deeper reasoning.'),
        '',
      ].join('\n'),
    );
    await agentStatus.runInfo('leg-2', { transcriptPath: path, effort: 'medium' });
    expect(agentStatus.runInfos()['leg-2']).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'xhigh',
    });
  });

  it('keeps the reported effort when the session never switched', async () => {
    agentStatus.pin({ sessionId: 'leg-2', projectId: 'p1', cliId: 'claude-code', title: 'T002' });
    const path = join(dir, 'no-effort.jsonl');
    writeFileSync(path, `${reply('claude-sonnet-5-5')}\n`);
    await agentStatus.runInfo('leg-2', { transcriptPath: path, effort: 'high' });
    expect(agentStatus.runInfos()['leg-2']).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
  });
});
