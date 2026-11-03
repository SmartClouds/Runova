import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import { aiAccessSettingsOf } from '../../shared/aiAccessSettings';
import type { AiApprovalDecision, AiExternalClientId } from '../../shared/aiAccessTypes';
import { IPC } from '../../shared/ipcChannels';
import { aiAccessActivity } from '../aiAccess/audit';
import { AI_ACCESS_MCP_SCRIPT } from '../aiAccess/bridgeScript';
import { aiAccessConfigSnippet, aiAccessLaunchArgs, aiAccessMcpFiles } from '../aiAccess/config';
import {
  connectExternalClient,
  disconnectExternalClient,
  externalClientStatus,
  machineExternalDeps,
} from '../aiAccess/external';
import { aiAccessBroker, aiAccessRegistry, decideFromWindow } from '../aiAccess/service';
import { store } from '../store';

/** The window's side of AI access (E46): Settings, the approval dialog and new agent tabs. */

const DECISIONS: readonly AiApprovalDecision[] = ['allow', 'allow_session', 'deny'];
const EXTERNAL_CLIENTS: readonly AiExternalClientId[] = ['claude', 'codex'];

async function externalDeps() {
  const files = await aiAccessMcpFiles();
  return machineExternalDeps(
    files?.script ?? join(app.getPath('userData'), 'ai-access', AI_ACCESS_MCP_SCRIPT),
  );
}

function isExternalClient(value: unknown): value is AiExternalClientId {
  return EXTERNAL_CLIENTS.includes(value as AiExternalClientId);
}

const UNKNOWN_CLIENT = { ok: false as const, error: 'Runova cannot connect that app.' };

export function registerAiAccessHandlers(): void {
  ipcMain.handle(IPC.aiAccess.listTools, () => aiAccessRegistry.infos());
  ipcMain.handle(IPC.aiAccess.pendingApprovals, () => aiAccessBroker.listForWindow());
  ipcMain.handle(IPC.aiAccess.decide, (_event, args: { id?: unknown; decision?: unknown }) => {
    const decision = DECISIONS.find((one) => one === args?.decision);
    if (typeof args?.id !== 'string' || !decision) return false;
    return decideFromWindow(args.id, decision);
  });
  ipcMain.handle(IPC.aiAccess.activity, () => aiAccessActivity.list());
  ipcMain.handle(IPC.aiAccess.clearActivity, () => aiAccessActivity.clear());
  ipcMain.handle(IPC.aiAccess.externalStatus, async () =>
    externalClientStatus(await externalDeps()),
  );
  ipcMain.handle(IPC.aiAccess.connectExternal, async (_event, id: unknown) =>
    isExternalClient(id) ? connectExternalClient(id, await externalDeps()) : UNKNOWN_CLIENT,
  );
  ipcMain.handle(IPC.aiAccess.disconnectExternal, async (_event, id: unknown) =>
    isExternalClient(id) ? disconnectExternalClient(id, await externalDeps()) : UNKNOWN_CLIENT,
  );
  ipcMain.handle(IPC.aiAccess.configSnippet, () => aiAccessConfigSnippet());
  ipcMain.handle(IPC.aiAccess.launchArgs, async (_event, cliId: unknown) => {
    if (typeof cliId !== 'string') return [];
    return aiAccessLaunchArgs(cliId, aiAccessSettingsOf(await store.getSettings()));
  });
}
