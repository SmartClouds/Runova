import { getCliDefinition } from '@runova/core';
import type { CallerHello, CallerIdentity } from './server';
import { isAiAccessSessionKey } from './sessionKey';

/**
 * Who is calling. A call counts as coming from a Runova tab only when it carries that tab's key
 * and the tab is still open; anything else is another app. The name the user sees comes from the
 * tab's CLI when there is one, else from the name the MCP client gave itself.
 */

const KNOWN_CLIENTS: [RegExp, string][] = [
  [/claude/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/copilot/i, 'GitHub Copilot'],
  [/gemini/i, 'Gemini CLI'],
  [/cursor/i, 'Cursor'],
];

export function agentLabel({ cliId, clientName }: { cliId?: string; clientName?: string }): string {
  const fromCli = cliId ? getCliDefinition(cliId)?.label : undefined;
  if (fromCli) return fromCli;
  const name = clientName?.trim();
  if (!name) return 'An AI agent';
  return KNOWN_CLIENTS.find(([pattern]) => pattern.test(name))?.[1] ?? name.slice(0, 60);
}

interface TabInfo {
  projectId?: string;
  cliId?: string;
}

export function identifyCaller(
  hello: CallerHello,
  lookupTab: (sessionId: string) => TabInfo | undefined,
): CallerIdentity {
  const tab =
    hello.sessionId && isAiAccessSessionKey(hello.sessionId, hello.sessionKey)
      ? lookupTab(hello.sessionId)
      : undefined;
  if (!tab) {
    return {
      kind: 'external',
      agent: agentLabel({ clientName: hello.clientName }),
      projectId: null,
    };
  }
  return {
    kind: 'runova',
    agent: agentLabel({ cliId: tab.cliId, clientName: hello.clientName }),
    projectId: tab.projectId ?? null,
  };
}
