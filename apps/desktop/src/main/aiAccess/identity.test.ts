import { describe, expect, it } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * Who is calling. An agent counts as one in a Runova tab only with that tab's key and while the
 * tab is still open; anything else is another app. The name shown to the user comes from the tab's
 * CLI, or else from what the MCP client called itself.
 */

useTempUserData();

const load = async () => ({ ...(await import('./identity')), ...(await import('./sessionKey')) });

const tabs = new Map([['tab-1', { projectId: 'p1', cliId: 'claude-code', createdAt: 0 }]]);
const lookup = (id: string) => tabs.get(id);

describe('identifyCaller', () => {
  it('trusts a Runova tab that shows its own key', async () => {
    const { identifyCaller, aiAccessSessionKey } = await load();

    expect(
      identifyCaller(
        {
          connectionId: 'c',
          sessionId: 'tab-1',
          sessionKey: aiAccessSessionKey('tab-1'),
          clientName: 'claude-code',
        },
        lookup,
      ),
    ).toEqual({ kind: 'runova', agent: 'Claude Code', projectId: 'p1' });
  });

  it('treats a borrowed session id, a wrong key or a closed tab as another app', async () => {
    const { identifyCaller, aiAccessSessionKey } = await load();

    expect(identifyCaller({ connectionId: 'c', sessionId: 'tab-1' }, lookup).kind).toBe('external');
    expect(
      identifyCaller(
        { connectionId: 'c', sessionId: 'tab-1', sessionKey: aiAccessSessionKey('tab-2') },
        lookup,
      ).kind,
    ).toBe('external');
    expect(
      identifyCaller(
        { connectionId: 'c', sessionId: 'tab-9', sessionKey: aiAccessSessionKey('tab-9') },
        lookup,
      ),
    ).toEqual({ kind: 'external', agent: 'An AI agent', projectId: null });
  });

  it('names other apps by what their MCP client calls itself', async () => {
    const { agentLabel } = await load();

    expect(agentLabel({ clientName: 'claude-code' })).toBe('Claude Code');
    expect(agentLabel({ clientName: 'codex-mcp-client' })).toBe('Codex');
    expect(agentLabel({ clientName: 'Visual Studio Code' })).toBe('Visual Studio Code');
    expect(agentLabel({ cliId: 'codex-cli', clientName: 'something' })).toBe('Codex');
    expect(agentLabel({})).toBe('An AI agent');
  });
});
