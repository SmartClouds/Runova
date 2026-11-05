/**
 * What the project clean-up feature passes between the main process and the window: what a
 * scan finds, what a removal is asked to delete, and the progress each of them streams.
 */

/** What kind of weight a folder is. Studio's render cache is its own source, not a folder rule. */
export type CleanupCategory = 'dependencies' | 'build' | 'cache';

/** How a folder comes back after it is deleted, in words and, when there is one, a command. */
export interface RestoreHint {
  label: string;
  command: string | null;
}

/** One folder a scan found that the project can rebuild. */
export interface CleanupCandidate {
  /** `<locationId>:<relPath>`, unique across the scan and what the selection is keyed on. */
  id: string;
  locationId: string;
  /** From the location's folder, with forward slashes on every platform. */
  relPath: string;
  /** The folder's own name (`node_modules`). */
  name: string;
  category: CleanupCategory;
  bytes: number;
  /** Part of `bytes` that other names also point at, so deleting the folder does not free it. */
  sharedBytes: number;
  files: number;
  /** When anything inside last changed, in ms since the epoch; 0 for an empty folder. */
  modifiedAt: number;
  restore: RestoreHint;
  /** Why it cannot be deleted from here, or null when it can. */
  locked: string | null;
}

/** The project folder, or one of the project's worktrees, as the scan looked at it. */
export interface CleanupLocation {
  /** `main` for the project folder, the worktree's id otherwise. */
  id: string;
  label: string;
  path: string;
  branch: string | null;
  isMain: boolean;
  /** Everything in the folder, git history and the offered folders included. */
  totalBytes: number;
  /** The `.git` folder. Read, shown, never offered. */
  gitBytes: number;
  /** Biggest first. */
  candidates: CleanupCandidate[];
  unreadable: number;
}

/** What one Studio video's render cache holds. */
export interface CleanupStudioVideo {
  videoId: string;
  title: string;
  bytes: number;
  /** A render of the video is waiting or running. */
  busy: boolean;
}

export interface ProjectCleanupScan {
  projectId: string;
  scannedAt: number;
  locations: CleanupLocation[];
  studio: CleanupStudioVideo[];
}

/** What a scan streams while it works, so the list can fill in as folders are found. */
export type CleanupScanEvent =
  | { requestId: string; type: 'location'; locationId: string; label: string; isMain: boolean }
  | { requestId: string; type: 'progress'; locationId: string; files: number }
  | { requestId: string; type: 'candidate'; candidate: CleanupCandidate }
  | { requestId: string; type: 'studio'; videos: CleanupStudioVideo[] };

/** Something to delete, named by what the scan reported and never by a path. */
export type CleanupRemoveItem =
  | { kind: 'folder'; locationId: string; relPath: string }
  | { kind: 'studio'; videoId: string };

/** The key an item goes by in progress events: a candidate's `id`, or `studio:<videoId>`. */
export function cleanupItemKey(item: CleanupRemoveItem): string {
  return item.kind === 'folder' ? `${item.locationId}:${item.relPath}` : `studio:${item.videoId}`;
}

export interface CleanupRemoveEvent {
  requestId: string;
  key: string;
  status: 'removing' | 'done' | 'failed';
  /** For `done`: what the scan said deleting it would free. */
  freedBytes?: number;
  /** For `failed`: a sentence for the person, never an error code. */
  error?: string;
}

export interface CleanupRemoveResult {
  freedBytes: number;
  removed: string[];
  failed: { key: string; error: string }[];
}
