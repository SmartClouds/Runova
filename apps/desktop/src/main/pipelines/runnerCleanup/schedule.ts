import { z } from 'zod';
import type { RunnerCleanupSchedule } from '../../../shared/apiTypes';
import { DEFAULT_RUNNER_CLEANUP_SCHEDULE } from '../../../shared/runnerCleanup';

/**
 * The scheduled runner cleanup (E104) as data: checking a schedule, the cron line, the launchd
 * plist and the Task Scheduler XML, and the comment line that lets a scan read back what the job
 * on the machine was saved with.
 */

export const DEFAULT_SCHEDULE: RunnerCleanupSchedule = DEFAULT_RUNNER_CLEANUP_SCHEDULE;

export const LAUNCHD_LABEL = 'com.runova.runner-cleanup';
export const TASK_NAME = 'Runova runner cleanup';
export const CONFIG_PREFIX = '# runova-config: ';
/** Put in by the install script on Windows, which knows the account and the script's path. */
export const TASK_USER_TOKEN = '__RUNOVA_USER__';
export const TASK_SCRIPT_TOKEN = '__RUNOVA_SCRIPT__';

const days = z.number().int().min(1).max(365).nullable();

const scheduleSchema = z.strictObject({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  weekday: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  rules: z.strictObject({
    temp: z.boolean(),
    actions: z.boolean(),
    oldVersions: z.boolean(),
    toolKeepNewest: z.boolean(),
    logsOlderThanDays: days,
    checkoutsOlderThanDays: days,
    dockerOlderThanHours: z.number().int().min(1).max(8760).nullable(),
    packageCaches: z.boolean(),
  }),
});

/** A schedule that is safe to write into a script, or null. */
export function normalizeSchedule(value: unknown): RunnerCleanupSchedule | null {
  const result = scheduleSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function configLine(schedule: RunnerCleanupSchedule): string {
  return `${CONFIG_PREFIX}${JSON.stringify(schedule)}`;
}

export function readScheduleConfig(json: string | null): RunnerCleanupSchedule | null {
  if (!json) return null;
  try {
    return normalizeSchedule(JSON.parse(json));
  } catch {
    return null;
  }
}

function hourMinute(schedule: RunnerCleanupSchedule): { hour: number; minute: number } {
  const [hour, minute] = schedule.time.split(':').map(Number);
  return { hour, minute };
}

export function cronLine(schedule: RunnerCleanupSchedule, command: string): string {
  const { hour, minute } = hourMinute(schedule);
  const day = schedule.frequency === 'monthly' ? String(schedule.dayOfMonth) : '*';
  const weekday = schedule.frequency === 'weekly' ? String(schedule.weekday) : '*';
  return `${minute} ${hour} ${day} * ${weekday} ${command}`;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function launchdPlist(schedule: RunnerCleanupSchedule, scriptPath: string): string {
  const { hour, minute } = hourMinute(schedule);
  const when = [
    `<key>Hour</key><integer>${hour}</integer>`,
    `<key>Minute</key><integer>${minute}</integer>`,
  ];
  if (schedule.frequency === 'weekly') {
    when.push(`<key>Weekday</key><integer>${schedule.weekday}</integer>`);
  }
  if (schedule.frequency === 'monthly') {
    when.push(`<key>Day</key><integer>${schedule.dayOfMonth}</integer>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    `  <array><string>/bin/sh</string><string>${xmlEscape(scriptPath)}</string></array>`,
    '  <key>StartCalendarInterval</key>',
    `  <dict>${when.join('')}</dict>`,
    '  <key>ProcessType</key><string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function taskTrigger(schedule: RunnerCleanupSchedule): string {
  if (schedule.frequency === 'daily') {
    return '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>';
  }
  if (schedule.frequency === 'weekly') {
    return `<ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><${WEEKDAYS[schedule.weekday]} /></DaysOfWeek></ScheduleByWeek>`;
  }
  const months = MONTHS.map((month) => `<${month} />`).join('');
  return `<ScheduleByMonth><DaysOfMonth><Day>${schedule.dayOfMonth}</Day></DaysOfMonth><Months>${months}</Months></ScheduleByMonth>`;
}

/**
 * The task as Task Scheduler XML. S4U runs it whether or not the user is signed in, without a
 * stored password; StartWhenAvailable runs a slot the machine slept through once it wakes.
 */
export function taskXml(schedule: RunnerCleanupSchedule): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>Frees disk space on this GitHub Actions runner machine. Set up by Runova.</Description></RegistrationInfo>',
    '  <Triggers>',
    `    <CalendarTrigger><StartBoundary>2026-01-01T${schedule.time}:00</StartBoundary><Enabled>true</Enabled>${taskTrigger(schedule)}</CalendarTrigger>`,
    '  </Triggers>',
    '  <Principals>',
    `    <Principal id="Author"><UserId>${TASK_USER_TOKEN}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${TASK_SCRIPT_TOKEN}"</Arguments></Exec>`,
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/** The newest line of the job's log: `<ISO time>\t<KB freed>\t<ok|failed>`. */
export function parseLastRun(
  line: string | null,
): { at: string; freedBytes: number; ok: boolean } | undefined {
  if (!line) return undefined;
  const [at, kb, status] = line.split('\t');
  if (!at || Number.isNaN(Date.parse(at)) || !status) return undefined;
  const freed = Number(kb);
  return {
    at,
    freedBytes: Number.isFinite(freed) && freed > 0 ? freed * 1024 : 0,
    ok: status === 'ok',
  };
}
