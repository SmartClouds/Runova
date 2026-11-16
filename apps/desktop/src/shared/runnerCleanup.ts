import type { RunnerCleanupSchedule } from './apiTypes';

/**
 * What a new scheduled runner cleanup starts from (E104): weekly, early Sunday morning, the safe
 * leftovers plus checkouts nobody used for a week. Shared so the form and the scripts agree.
 */
export const DEFAULT_RUNNER_CLEANUP_SCHEDULE: RunnerCleanupSchedule = {
  frequency: 'weekly',
  weekday: 0,
  dayOfMonth: 1,
  time: '03:00',
  rules: {
    temp: true,
    actions: false,
    oldVersions: true,
    toolKeepNewest: true,
    logsOlderThanDays: 14,
    checkoutsOlderThanDays: 7,
    dockerOlderThanHours: 72,
    packageCaches: false,
  },
};
