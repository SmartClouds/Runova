import type {
  RunnerCleanupFailure,
  RunnerCleanupItemOutcome,
  RunnerCleanupProgress,
  RunnerCleanupScan,
  RunnerCleanupScheduleState,
  RunnerMachineLink,
} from '@shared/apiTypes';
import { toast } from 'sonner';
import { create } from 'zustand';
import { defaultPicks } from '@/components/pipelines/cleanup/cleanupView';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { formatBytes } from '@/lib/format';

/**
 * The runner cleanup's state per machine (E104), kept outside the dialog so a scan or a cleanup
 * keeps going, and keeps its progress, when the dialog is closed. A finished cleanup says what it
 * freed in a toast, wherever the person is.
 */

export type CleanupPhase = 'idle' | 'scanning' | 'ready' | 'cleaning' | 'done' | 'failed';

export interface MachineCleanup {
  phase: CleanupPhase;
  /** The scan steps seen so far, in order. */
  steps: string[];
  scan: RunnerCleanupScan | null;
  picks: string[];
  /** Items the running cleanup has not answered for yet. */
  running: string[];
  outcomes: Record<string, RunnerCleanupItemOutcome>;
  freedBytes: number;
  error: { reason: RunnerCleanupFailure; message: string } | null;
}

const IDLE: MachineCleanup = {
  phase: 'idle',
  steps: [],
  scan: null,
  picks: [],
  running: [],
  outcomes: {},
  freedBytes: 0,
  error: null,
};

interface RunnerCleanupStore {
  machines: Record<string, MachineCleanup>;
  scan: (link: RunnerMachineLink) => Promise<void>;
  cancelScan: (link: RunnerMachineLink) => Promise<void>;
  setPicks: (machine: string, picks: string[]) => void;
  clean: (link: RunnerMachineLink, machineName: string) => Promise<void>;
  setScheduleState: (machine: string, schedule: RunnerCleanupScheduleState) => void;
}

export function machineKeyOf(link: RunnerMachineLink): string {
  return link.kind === 'local' ? 'local' : `ssh:${link.serverId}`;
}

export function machineState(store: { machines: Record<string, MachineCleanup> }, machine: string) {
  return store.machines[machine] ?? IDLE;
}

function listen(machine: string, onProgress: (progress: RunnerCleanupProgress) => void) {
  return window.runova.runnerCleanup.onProgress((progress) => {
    if (progress.machine === machine) onProgress(progress);
  });
}

export const useRunnerCleanupStore = create<RunnerCleanupStore>((set, get) => {
  const update = (machine: string, change: Partial<MachineCleanup>) =>
    set((store) => ({
      machines: { ...store.machines, [machine]: { ...machineState(store, machine), ...change } },
    }));

  return {
    machines: {},

    async scan(link) {
      const machine = machineKeyOf(link);
      const current = machineState(get(), machine);
      if (current.phase === 'scanning' || current.phase === 'cleaning') return;
      update(machine, { ...IDLE, phase: 'scanning' });
      const stop = listen(machine, (progress) => {
        if (progress.phase !== 'scan') return;
        const { steps } = machineState(get(), machine);
        if (!steps.includes(progress.step)) update(machine, { steps: [...steps, progress.step] });
      });
      try {
        const result = await window.runova.runnerCleanup.scan(link);
        if (result.ok) {
          update(machine, {
            phase: 'ready',
            scan: result.scan,
            picks: [...defaultPicks(result.scan)],
            error: null,
          });
        } else {
          update(machine, {
            phase: 'failed',
            error: { reason: result.reason, message: result.error },
          });
        }
      } catch (error) {
        update(machine, {
          phase: 'failed',
          error: {
            reason: 'unreachable',
            message: ipcErrorMessage(error, 'Could not scan the machine.'),
          },
        });
      } finally {
        stop();
      }
    },

    async cancelScan(link) {
      try {
        await window.runova.runnerCleanup.cancel(link);
      } catch {
        // The scan then simply finishes on its own.
      }
    },

    setPicks(machine, picks) {
      update(machine, { picks });
    },

    async clean(link, machineName) {
      const machine = machineKeyOf(link);
      const { scan, picks, phase } = machineState(get(), machine);
      if (!scan || picks.length === 0 || phase === 'cleaning' || phase === 'scanning') return;
      update(machine, {
        phase: 'cleaning',
        running: picks,
        outcomes: {},
        freedBytes: 0,
        error: null,
      });
      const stop = listen(machine, (progress) => {
        if (progress.phase !== 'clean') return;
        const { machine: _machine, phase: _phase, ...outcome } = progress;
        const state = machineState(get(), machine);
        update(machine, {
          outcomes: { ...state.outcomes, [outcome.id]: outcome },
          running: state.running.filter((id) => id !== outcome.id),
        });
      });
      try {
        const result = await window.runova.runnerCleanup.clean({
          link,
          scanId: scan.scanId,
          itemIds: picks,
        });
        if (!result.ok) {
          update(machine, {
            phase: 'failed',
            running: [],
            error: { reason: result.reason, message: result.error },
          });
          toast.error(`Could not clean up ${machineName}: ${result.error}`);
          return;
        }
        update(machine, {
          phase: 'done',
          running: [],
          outcomes: Object.fromEntries(result.outcomes.map((outcome) => [outcome.id, outcome])),
          freedBytes: result.freedBytes,
        });
        const failed = result.outcomes.filter((outcome) => outcome.status === 'failed').length;
        const freed = `Freed ${formatBytes(result.freedBytes)} on ${machineName}`;
        if (failed === 0) toast.success(freed);
        else
          toast.warning(
            `${freed}. ${failed} ${failed === 1 ? 'item' : 'items'} could not be removed.`,
          );
      } catch (error) {
        const message = ipcErrorMessage(error, 'The cleanup did not finish.');
        update(machine, {
          phase: 'failed',
          running: [],
          error: { reason: 'unreachable', message },
        });
        toast.error(`Could not clean up ${machineName}: ${message}`);
      } finally {
        stop();
      }
    },

    setScheduleState(machine, schedule) {
      const { scan } = machineState(get(), machine);
      if (scan) update(machine, { scan: { ...scan, schedule } });
    },
  };
});
