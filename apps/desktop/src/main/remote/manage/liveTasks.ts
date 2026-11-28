import { IPC } from '../../../shared/ipcChannels';
import { broadcastToWindows } from '../../ipc/send';
import { buildRelayBoard, projectRelayFolder, relayTaskDetail } from '../../relay/board';
import { schedulePlanCommit } from '../../relay/planCommit';
import { cancelPlanner, decomposeRequest } from '../../relay/planner';
import { redoTasks } from '../../relay/redo';
import { getRelayRuntime } from '../../relay/runtime';
import { applyProposalFiles, setTaskStatusFile } from '../../relay/taskFiles';
import type { ManageTaskDeps } from './taskMethods';

function runtime() {
  const live = getRelayRuntime();
  if (!live) throw new Error('Relay is still starting on the computer. Try again in a moment.');
  return live;
}

/** The plan and its tasks (E124), through the same services the desktop's Tasks views use. */
export const liveTasks: ManageTaskDeps = {
  folder: async (projectId) => (await projectRelayFolder(projectId)).folder,
  board: (projectId) => buildRelayBoard(projectId),
  detail: (projectId, taskId) => relayTaskDetail(projectId, taskId),
  setStatus: async (projectId, taskId, status) => {
    const { folder } = await projectRelayFolder(projectId);
    if (!(await setTaskStatusFile(folder, taskId, status))) {
      throw new Error(`There is no task ${taskId}.`);
    }
  },
  decompose: (input) => decomposeRequest(input),
  cancelPlanner: (requestId) => cancelPlanner(requestId),
  applyProposal: async (projectId, proposal, mode) =>
    applyProposalFiles((await projectRelayFolder(projectId)).folder, proposal, { mode }),
  redo: async (input) => {
    const { folder } = await projectRelayFolder(input.projectId);
    const { redone, warnings } = await redoTasks(folder, input);
    if (!input.start || redone.length === 0) return { redone, warnings, started: false };
    const outcome = await runtime().start({
      projectId: input.projectId,
      only: redone,
      trigger: { kind: 'now' },
    });
    return outcome.ok
      ? { redone, warnings, started: true }
      : { redone, warnings, started: false, error: outcome.error };
  },
  start: (projectId) => runtime().start({ projectId, trigger: { kind: 'now' } }),
  pause: (relayId) => runtime().pause(relayId),
  resume: (relayId) => runtime().resume(relayId),
  active: (projectId) => getRelayRuntime()?.active(projectId) ?? null,
  changed: (projectId) => {
    broadcastToWindows(IPC.relay.onChanged, { projectId, reason: 'files' });
    schedulePlanCommit(projectId);
  },
};
