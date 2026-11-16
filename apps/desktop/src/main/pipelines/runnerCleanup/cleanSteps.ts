/**
 * What a cleanup does to the machine, item by item (E104). The plan turns a scan into these, and
 * the POSIX and PowerShell scripts turn these into commands. Only main ever holds them: the window
 * names items by id.
 */

export type DockerPrune = 'containers' | 'dangling' | 'images' | 'buildCache';

export type CleanAction =
  /** Deletes the path. A link is removed, never followed. */
  | { kind: 'remove'; path: string }
  /** Deletes what is inside the folder and keeps the folder. */
  | { kind: 'empty'; path: string }
  /** Deletes files under the folder last written more than `days` ago. */
  | { kind: 'oldLogs'; path: string; days: number }
  | { kind: 'docker'; prune: DockerPrune }
  /** Runs the tool's own clean command when it is on PATH, else empties `fallback`. */
  | { kind: 'toolCommand'; tool: string; args: string[]; fallback: string }
  /** Stops and removes the runner's service, then deletes its folder. */
  | { kind: 'removeRunner'; path: string };

export interface CleanStep {
  id: string;
  /** A runner folder: the step is skipped when a job is running from it. */
  busyGuard: string | null;
  /** Measured before and after, so the answer is what was really freed. Empty for Docker. */
  measure: string[];
  actions: CleanAction[];
}

export interface ScriptOptions {
  /**
   * Look for runners only under these folders and not in the service list. Tests use it so a
   * scan or a scheduled run never touches a real runner on the machine running the tests.
   */
  onlyRoots?: string[];
  /** Leaves Docker out of a scan. Tests use it so they never wait on the machine's Docker. */
  skipDocker?: boolean;
}

export const DOCKER_ARGS: Record<DockerPrune, string[]> = {
  containers: ['container', 'prune', '-f'],
  dangling: ['image', 'prune', '-f'],
  images: ['image', 'prune', '-a', '-f'],
  buildCache: ['builder', 'prune', '-f'],
};

export const SKIPPED_BUSY = 'A job started on this runner, so it was left alone';
