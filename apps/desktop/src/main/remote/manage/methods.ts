import type { Project } from '@runova/core';
import type { ManageProject, ManageTerminal, ManageTerminalProcess } from '@runova/protocol';
import { deployMethods, type ManageDeployDeps } from './deployMethods';
import { gitMethods, type ManageGitDeps } from './gitMethods';
import {
  type ManageErrorTrackingDeps,
  type ManageMonitoringDeps,
  type ManagePipelineDeps,
  opsMethods,
} from './opsMethods';
import { ManageError, type ManageMethods } from './session';
import { type ManageStatusDeps, statusMethods } from './statusMethods';
import { type ManageStudioDeps, studioMethods } from './studioMethods';
import { type ManageVaultDeps, vaultMethods } from './vaultMethods';

export interface TerminalSnapshot {
  data: string;
  cols: number;
  rows: number;
}

/** What the methods need from the rest of the app, so each can be tested without it. */
export interface ManageMethodDeps {
  listProjects(): Promise<Project[]>;
  listTerminals(): Promise<ManageTerminal[]>;
  /** The shell a session already runs, which an attach has to name or it would be recorded wrong. */
  terminalShell(sessionId: string): string;
  /** The screen as it stands, or null when the session has ended. Never takes a size. */
  attachTerminal(sessionId: string, shell: string): Promise<TerminalSnapshot | null>;
  onTerminalOutput(sessionId: string, listener: (data: string) => void): () => void;
  onTerminalExit(sessionId: string, listener: () => void): () => void;
  writeTerminal(sessionId: string, data: string): void;
  terminalProcesses(sessionId: string): Promise<ManageTerminalProcess[]>;
  git: ManageGitDeps;
  status: ManageStatusDeps;
  vault: ManageVaultDeps;
  deploy: ManageDeployDeps;
  /** Takes a phone off this computer's trusted list. */
  forgetPhone(key: string): Promise<void>;
  monitoring: ManageMonitoringDeps;
  pipelines: ManagePipelineDeps;
  errorTracking: ManageErrorTrackingDeps;
  studio: ManageStudioDeps;
}

/** Far past anything typed or pasted on a phone. */
const MAX_INPUT_CHARS = 64 * 1024;

function toManageProject(project: Project): ManageProject {
  return {
    id: project.id,
    name: project.name,
    tags: project.tags,
    pinned: project.pinned === true,
    archived: project.archived === true,
    iconBgColor: project.iconBgColor ?? null,
    iconColor: project.iconColor ?? null,
    hasRepository: Boolean(project.repoUrl),
  };
}

function sessionIdOf(params: unknown): string {
  const sessionId = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new ManageError('bad-params', 'Say which terminal.');
  }
  return sessionId;
}

/** Every method a phone can reach, by the names in `MANAGE_METHODS`. */
export function createManageMethods(deps: ManageMethodDeps): ManageMethods {
  return {
    calls: {
      'projects.list': async () => (await deps.listProjects()).map(toManageProject),
      'phone.forget': async (_params, context) => {
        await deps.forgetPhone(context.phone.key);
        return { ok: true, message: 'This computer has forgotten this phone.' };
      },
      'terminals.list': () => deps.listTerminals(),
      'terminals.processes': (params) => deps.terminalProcesses(sessionIdOf(params)),
      'terminals.write': (params) => {
        const sessionId = sessionIdOf(params);
        const data = (params as { data?: unknown }).data;
        if (typeof data !== 'string' || data.length > MAX_INPUT_CHARS) {
          throw new ManageError('bad-params', 'That is too much to send at once.');
        }
        deps.writeTerminal(sessionId, data);
      },
      ...gitMethods(deps.git),
      ...statusMethods(deps.status),
      ...vaultMethods(deps.vault),
      ...deployMethods(deps.deploy),
      ...opsMethods(deps.monitoring, deps.pipelines, deps.errorTracking),
      ...studioMethods(deps.studio),
    },
    streams: {
      'terminals.follow': async (params, sink) => {
        const sessionId = sessionIdOf(params);
        const snapshot = await deps.attachTerminal(sessionId, deps.terminalShell(sessionId));
        if (!snapshot) throw new ManageError('bad-params', 'That terminal has ended.');
        sink.event({ snapshot });
        // Only now: output from before this point is already in the snapshot.
        const encoder = new TextEncoder();
        const stopOutput = deps.onTerminalOutput(sessionId, (data) =>
          sink.binary(encoder.encode(data)),
        );
        const stopExit = deps.onTerminalExit(sessionId, () => sink.end());
        return () => {
          stopOutput();
          stopExit();
        };
      },
    },
  };
}
