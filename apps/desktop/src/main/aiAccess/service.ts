import type { AppSettings } from '@runova/core';
import { BrowserWindow } from 'electron';
import { aiAccessSettingsOf } from '../../shared/aiAccessSettings';
import type { AiApprovalDecision } from '../../shared/aiAccessTypes';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import { terminalSessionInfo } from '../ipc/terminal';
import { focusMainWindow, getMainWindow } from '../mainWindow';
import { setAiAccessHttpHandlers } from '../notifications/hookServer';
import { showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import { createApprovalBroker } from './approvals';
import { createApprovalAttention } from './attention';
import { aiAccessActivity } from './audit';
import { identifyCaller } from './identity';
import { projectForFolder } from './projectMatch';
import { createToolRegistry } from './registry';
import { createAiAccessServer } from './server';
import { allAiTools } from './tools';

/**
 * AI access put together: the tools, the approvals waiting on the user (announced to every
 * window), the server the hook server hands /app-mcp/* calls to, and the record of what agents did.
 */

/** Long enough to read a diff, short enough that a forgotten agent does not wait for ever. */
export const AI_ACCESS_APPROVAL_TIMEOUT_MS = 4 * 60 * 1000;

const callForAttention = createApprovalAttention({
  isFocused: () => BrowserWindow.getFocusedWindow() !== null,
  flash: () => getMainWindow()?.flashFrame(true),
  notify: ({ title, body }) =>
    showOsNotification({ title, body, route: '', onClick: () => focusMainWindow() }),
});

export const aiAccessBroker = createApprovalBroker({
  timeoutMs: AI_ACCESS_APPROVAL_TIMEOUT_MS,
  onChange: () => {
    const approvals = aiAccessBroker.listForWindow();
    broadcastToWindows(IPC.aiAccess.onApprovalsChanged, approvals);
    callForAttention(approvals);
  },
});

export const aiAccessRegistry = createToolRegistry(allAiTools());

export const aiAccessServer = createAiAccessServer({
  registry: aiAccessRegistry,
  broker: aiAccessBroker,
  settings: async () => aiAccessSettingsOf(await store.getSettings()),
  identify: (hello) => identifyCaller(hello, terminalSessionInfo),
  async findProject(id) {
    const project = (await store.getProjects()).find((one) => one.id === id);
    return project ? { id: project.id, name: project.name } : null;
  },
  async projectForFolder(cwd) {
    const project = projectForFolder(await store.getProjects(), cwd);
    return project ? { id: project.id, name: project.name } : null;
  },
  record: (entry) => aiAccessActivity.record(entry).catch(() => undefined),
  dataChanged: (change) => broadcastToWindows(IPC.aiAccess.onDataChanged, change),
});

aiAccessActivity.subscribe((entry) => broadcastToWindows(IPC.aiAccess.onActivity, entry));

/** Attaches the /app-mcp/* routes to the hook server. */
export function startAiAccess(): void {
  setAiAccessHttpHandlers({ handle: (route, body) => aiAccessServer[route](body) });
}

export function stopAiAccess(): void {
  setAiAccessHttpHandlers(null);
  aiAccessBroker.reset();
}

/** Turning access off drops every "allow for this session" and denies what is still waiting. */
export function applyAiAccessSettings(next: AppSettings): void {
  if (!aiAccessSettingsOf(next).enabled) aiAccessBroker.reset();
}

export function decideFromWindow(id: string, decision: AiApprovalDecision): boolean {
  return aiAccessBroker.decide(id, decision, { channel: 'modal' }) !== null;
}
