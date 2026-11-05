import type {
  CleanupLocation,
  CleanupScanEvent,
  CleanupStudioVideo,
  ProjectCleanupScan,
} from '@shared/projectCleanupTypes';

/**
 * What a scan has told the window so far, built from its events, so the list can fill in while the
 * disk is still being read. It is only ever a partial picture: the sizes of a place (its total,
 * its git history) arrive with the final result, which replaces this.
 */

export interface LiveScan {
  locations: CleanupLocation[];
  studio: CleanupStudioVideo[];
  /** Files looked at across every place so far. */
  files: number;
  /** The place being looked through now. */
  lookingIn: string | null;
  /** Files of the places that are finished, since each place counts from zero. */
  finishedFiles: number;
  /** Files of the place being looked through. */
  currentFiles: number;
}

export const EMPTY_LIVE_SCAN: LiveScan = {
  locations: [],
  studio: [],
  files: 0,
  lookingIn: null,
  finishedFiles: 0,
  currentFiles: 0,
};

function placeholder(id: string, label: string, isMain: boolean): CleanupLocation {
  return {
    id,
    label,
    path: '',
    branch: null,
    isMain,
    totalBytes: 0,
    gitBytes: 0,
    candidates: [],
    unreadable: 0,
  };
}

export function applyScanEvent(live: LiveScan, event: CleanupScanEvent): LiveScan {
  switch (event.type) {
    case 'location': {
      const finishedFiles = live.finishedFiles + live.currentFiles;
      return {
        ...live,
        locations: [...live.locations, placeholder(event.locationId, event.label, event.isMain)],
        lookingIn: event.label,
        finishedFiles,
        currentFiles: 0,
        files: finishedFiles,
      };
    }
    case 'progress':
      return { ...live, currentFiles: event.files, files: live.finishedFiles + event.files };
    case 'candidate': {
      const { candidate } = event;
      const known = live.locations.some((location) => location.id === candidate.locationId);
      const locations = known
        ? live.locations
        : [...live.locations, placeholder(candidate.locationId, candidate.locationId, false)];
      return {
        ...live,
        locations: locations.map((location) =>
          location.id === candidate.locationId
            ? { ...location, candidates: [...location.candidates, candidate] }
            : location,
        ),
      };
    }
    case 'studio':
      return { ...live, studio: event.videos };
  }
}

export function liveToScan(projectId: string, live: LiveScan, now: number): ProjectCleanupScan {
  return { projectId, scannedAt: now, locations: live.locations, studio: live.studio };
}
