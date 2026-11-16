import type { RunnerCleanupSchedule } from '../../../shared/apiTypes';
import { CACHE_TOOLS, cacheEntriesFor } from './cacheCatalog';
import {
  type CleanAction,
  type CleanStep,
  DOCKER_ARGS,
  type ScriptOptions,
  SKIPPED_BUSY,
} from './cleanSteps';
import { CONFIG_PREFIX, configLine, cronLine, LAUNCHD_LABEL, launchdPlist } from './schedule';
import { shQuote } from './shellText';

/**
 * The runner cleanup's scripts for Linux and macOS (E104). They run under plain `sh` (dash on
 * Debian, bash elsewhere, busybox ash on Alpine) and only use flags GNU and BSD tools share:
 * `du -sk`, `df -Pk`, `find -maxdepth/-mindepth/-mtime`, `ps -A -o args=`. Every path that goes in
 * is quoted with `shQuote`.
 *
 * Each script is sent on stdin to POSIX_RUNNER, which reads all of it before running it, so a
 * command inside that reads stdin cannot swallow the rest of the script.
 */

export const POSIX_RUNNER = `sh -c 'S=$(cat); eval "$S"'`;

const JOB_BEGIN = '# >>> runova runner cleanup';
const JOB_END = '# <<< runova runner cleanup';
const JOB_DELIMITER = 'RUNOVA_JOB_END';
const PLIST_DELIMITER = 'RUNOVA_PLIST_END';

/** Where the job, its log and its lock live: `~/.runova`. */
const JOB_DIR = '"$RV_HOME/.runova"';

function rootsLine(options: ScriptOptions): string {
  if (options.onlyRoots?.length) {
    return `RV_ONLY_ROOTS=1\nRV_ROOTS_LIST=$(printf '%s\\n' ${options.onlyRoots.map(shQuote).join(' ')})`;
  }
  return `RV_ONLY_ROOTS=\nRV_ROOTS_LIST=$(printf '%s\\n' "$RV_HOME" /opt /srv /home /Users /actions-runner /runner /root)`;
}

/** The functions every script shares: output, sizes, finding runners and whether one is busy. */
function lib(options: ScriptOptions): string {
  return `PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/sbin"
RV_HOME="\${HOME:-}"
[ -n "$RV_HOME" ] || RV_HOME=$(cd ~ 2>/dev/null && pwd)
${rootsLine(options)}
rv_out() { printf '%s' "$1"; shift; for rv_f in "$@"; do printf '\\t%s' "$rv_f"; done; printf '\\n'; }
rv_kb() { rv_k=$(du -sk "$1" 2>/dev/null | awk 'NR==1 {print $1}'); echo "\${rv_k:-0}"; }
rv_runners() {
  {
    while IFS= read -r rv_r; do
      [ -n "$rv_r" ] && [ -d "$rv_r" ] || continue
      find "$rv_r" -maxdepth 5 \\( -name _work -o -name node_modules -o -name .git -o -name Library -o -name proc \\) -prune -o -path '*/bin*/Runner.Listener' -print 2>/dev/null | sed 's:/bin[^/]*/Runner.Listener$::'
    done <<RV_ROOTS_END
$RV_ROOTS_LIST
RV_ROOTS_END
    if [ -z "$RV_ONLY_ROOTS" ]; then
      for rv_s in /etc/systemd/system/actions.runner.*.service; do
        [ -f "$rv_s" ] && sed -n 's/^WorkingDirectory=//p' "$rv_s"
      done
      for rv_s in "$RV_HOME"/Library/LaunchAgents/actions.runner.*.plist; do
        [ -f "$rv_s" ] && tr -d '\\n\\t' < "$rv_s" | sed -n 's:.*<key>WorkingDirectory</key> *<string>\\([^<]*\\)</string>.*:\\1:p'
      done
    fi
  } | sed 's:/*$::' | awk 'NF && !seen[$0]++'
}
rv_busy() { ps -A -o args= 2>/dev/null | grep -F -e "$1/bin" | grep -q 'Runner.Worker'; }
rv_real() { (cd "$1" 2>/dev/null && pwd -P); }
rv_oldversions() {
  rv_lb=$(rv_real "$1/bin")
  rv_le=$(rv_real "$1/externals")
  [ -n "$rv_lb" ] || return 0
  for rv_v in "$1"/bin.* "$1"/externals.*; do
    [ -d "$rv_v" ] && [ ! -L "$rv_v" ] || continue
    rv_rv=$(rv_real "$rv_v")
    if [ "$rv_rv" = "$rv_lb" ] || [ "$rv_rv" = "$rv_le" ]; then continue; fi
    printf '%s\\n' "$rv_v"
  done
}
rv_docker() {
  RV_DOCKER=""
  command -v docker >/dev/null 2>&1 || return 1
  if docker info >/dev/null 2>&1; then RV_DOCKER="docker"; return 0; fi
  if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then RV_DOCKER="sudo -n docker"; return 0; fi
  return 2
}
`;
}

/** The parts that delete. They note the first error and carry on, so one locked file never stops the rest. */
const DELETE_LIB = `RV_ERR=""
rv_err() { [ -n "$RV_ERR" ] || RV_ERR=$(printf '%s' "$1" | tr '\\t\\r' '  ' | awk 'NF {print; exit}'); [ -n "$RV_ERR" ] || RV_ERR="failed"; }
rv_rm() { if [ -e "$1" ] || [ -L "$1" ]; then RV_E=$(rm -rf -- "$1" 2>&1) || rv_err "$RV_E"; fi; }
rv_empty() { if [ -d "$1" ] && [ ! -L "$1" ]; then RV_E=$(find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>&1) || rv_err "$RV_E"; fi; }
rv_oldlogs() { if [ -d "$1" ]; then RV_E=$(find "$1" -type f -mtime +"$2" -exec rm -f -- {} + 2>&1) || rv_err "$RV_E"; fi; }
rv_sum() { rv_t=0; for rv_p in "$@"; do rv_n=$(rv_kb "$rv_p"); rv_t=$((rv_t + rv_n)); done; echo "$rv_t"; }
rv_docker_prune() {
  RV_FREED=""
  [ -n "$RV_DOCKER" ] || rv_docker
  if [ -z "$RV_DOCKER" ]; then rv_err "Docker is not reachable on this machine"; return; fi
  RV_O=$($RV_DOCKER $1 2>&1) || { rv_err "$RV_O"; return; }
  RV_FREED=$(printf '%s\\n' "$RV_O" | sed -n -e 's/^Total reclaimed space:[[:space:]]*//p' -e 's/^Total:[[:space:]]*//p' | tail -n 1)
}
rv_unservice() {
  rv_u="$1"
  [ -f "$rv_u/.service" ] || return 0
  if [ ! -f "$rv_u/svc.sh" ]; then rv_err "The runner has a service but no svc.sh to remove it with"; return 1; fi
  if [ "$(uname -s)" = Darwin ]; then
    (cd "$rv_u" || exit 1; ./svc.sh stop; ./svc.sh uninstall) >/dev/null 2>&1
    return 0
  fi
  if [ "$(id -u)" = 0 ]; then rv_sudo=""
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then rv_sudo="sudo -n"
  else rv_err "Removing its service needs sudo. On the machine, run: cd $rv_u && sudo ./svc.sh stop && sudo ./svc.sh uninstall"; return 1
  fi
  (cd "$rv_u" || exit 1; $rv_sudo ./svc.sh stop; $rv_sudo ./svc.sh uninstall) >/dev/null 2>&1
  return 0
}
`;

/** The cache folders of one OS as `id|relative path` words for a `for` loop. */
function cacheWords(os: 'linux' | 'macos'): string {
  return cacheEntriesFor(os)
    .map((entry) => shQuote(`${entry.id}|${entry.rel}`))
    .join(' ');
}

const SCAN_RUNNER = `rv_scan_runner() {
  rv_d="$1"
  rv_out runner "$rv_d"
  if [ -f "$rv_d/.runner" ]; then
    rv_out runnerfile "$rv_d"
    rv_out runnerjson "$rv_d" "$(base64 < "$rv_d/.runner" 2>/dev/null | tr -d '\\n')"
  fi
  if [ -f "$rv_d/config.sh" ] || [ -f "$rv_d/config.cmd" ]; then rv_out configured "$rv_d"; fi
  [ -f "$rv_d/.service" ] && rv_out service "$rv_d" "$(head -n 1 "$rv_d/.service")"
  rv_busy "$rv_d" && rv_out busy "$rv_d"
  if [ -d "$rv_d/_work" ]; then
    for rv_p in "$rv_d"/_work/*; do
      [ -d "$rv_p" ] && [ ! -L "$rv_p" ] || continue
      case "\${rv_p##*/}" in
        _temp) rv_kind=temp ;;
        _actions) rv_kind=actions ;;
        _update) rv_kind=update ;;
        _*) continue ;;
        *) rv_kind=checkout ;;
      esac
      rv_out size "$rv_d" "$rv_kind" "$(rv_kb "$rv_p")" "$rv_p"
    done
    for rv_p in "$rv_d"/_work/_tool/*/*; do
      [ -d "$rv_p" ] && [ ! -L "$rv_p" ] || continue
      rv_out size "$rv_d" tool "$(rv_kb "$rv_p")" "$rv_p"
    done
  fi
  if [ -d "$rv_d/_diag" ]; then
    rv_old=$(find "$rv_d/_diag" -type f -mtime +7 -exec du -k {} + 2>/dev/null | awk '{s += $1} END {print s + 0}')
    rv_out size "$rv_d" diag "$rv_old" "$rv_d/_diag"
  fi
  rv_oldversions "$rv_d" | while IFS= read -r rv_v; do
    [ -n "$rv_v" ] && rv_out size "$rv_d" oldver "$(rv_kb "$rv_v")" "$rv_v"
  done
  rv_out size "$rv_d" total "$(rv_kb "$rv_d")" "$rv_d"
}
`;

export function posixScanScript(options: ScriptOptions = {}): string {
  return `${lib(options)}${SCAN_RUNNER}
rv_out os "$(uname -s)"
rv_out home "$RV_HOME"
rv_out step runners
RV_LIST=$(rv_runners)
while IFS= read -r rv_dir; do
  [ -n "$rv_dir" ] && [ -d "$rv_dir" ] || continue
  rv_scan_runner "$rv_dir"
done <<RV_LIST_END
$RV_LIST
RV_LIST_END
rv_out step docker
${options.skipDocker ? 'RV_DS=1' : 'rv_docker; RV_DS=$?'}
if [ "$RV_DS" = 0 ]; then
  if [ "$RV_DOCKER" = docker ]; then rv_out docker ok docker; else rv_out docker ok sudo; fi
  $RV_DOCKER system df --format '{{json .}}' 2>/dev/null | awk '{print "dockerdf\\t" $0}'
  $RV_DOCKER image ls --filter dangling=true --format '{{.Size}}' 2>/dev/null | awk 'NF {print "dockerdangling\\t" $0}'
elif [ "$RV_DS" = 2 ]; then rv_out docker denied
else rv_out docker missing
fi
rv_out step caches
case "$(uname -s)" in
  Darwin) RV_CACHES="${cacheWords('macos')}" ;;
  *) RV_CACHES="${cacheWords('linux')}" ;;
esac
RV_HOMES=$({
  printf '%s\\n' "$RV_HOME"
  printf '%s\\n' "$RV_LIST" | while IFS= read -r rv_dir; do
    case "$rv_dir" in
      /home/*/*|/Users/*/*) printf '%s\\n' "$rv_dir" | cut -d/ -f1-3 ;;
      /root/*) echo /root ;;
    esac
  done
} | awk 'NF && !seen[$0]++')
while IFS= read -r rv_h; do
  [ -n "$rv_h" ] && [ -d "$rv_h" ] || continue
  eval "set -- $RV_CACHES"
  for rv_e in "$@"; do
    rv_id=\${rv_e%%|*}
    rv_rel=\${rv_e#*|}
    [ -d "$rv_h/$rv_rel" ] && rv_out cache "$rv_id" "$rv_h" "$(rv_kb "$rv_h/$rv_rel")" "$rv_h/$rv_rel"
  done
done <<RV_HOMES_END
$RV_HOMES
RV_HOMES_END
for rv_t in ${CACHE_TOOLS.join(' ')}; do command -v "$rv_t" >/dev/null 2>&1 && rv_out tool "$rv_t"; done
RV_DISKAT="$RV_HOME"
RV_FIRST=$(printf '%s\\n' "$RV_LIST" | awk 'NF {print; exit}')
[ -n "$RV_FIRST" ] && [ -d "$RV_FIRST" ] && RV_DISKAT="$RV_FIRST"
df -Pk "$RV_DISKAT" 2>/dev/null | awk 'NR == 2 {print "disk\\t" $0}'
rv_out step schedule
if [ -f ${JOB_DIR}/runner-cleanup.sh ]; then
  awk -v p=${shQuote(CONFIG_PREFIX)} 'index($0, p) == 1 {print "schedconfig\\t" substr($0, length(p) + 1); exit}' ${JOB_DIR}/runner-cleanup.sh
fi
case "$(uname -s)" in
  Darwin) [ -f "$RV_HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist" ] && rv_out sched installed launchd ;;
  *)
    if command -v crontab >/dev/null 2>&1; then
      crontab -l 2>/dev/null | grep -q ${shQuote(`^${JOB_BEGIN}$`)} && rv_out sched installed cron
    else
      rv_out nocron
    fi
    ;;
esac
[ -f ${JOB_DIR}/runner-cleanup.log ] && tail -n 1 ${JOB_DIR}/runner-cleanup.log | awk 'NF {print "schedlog\\t" $0}'
exit 0
`;
}

function actionLine(action: CleanAction): string {
  switch (action.kind) {
    case 'remove':
      return `rv_rm ${shQuote(action.path)}`;
    case 'empty':
      return `rv_empty ${shQuote(action.path)}`;
    case 'oldLogs':
      return `rv_oldlogs ${shQuote(action.path)} ${Math.max(1, Math.floor(action.days))}`;
    case 'docker':
      return `rv_docker_prune ${shQuote(DOCKER_ARGS[action.prune].join(' '))}`;
    case 'toolCommand': {
      const command = [action.tool, ...action.args].map(shQuote).join(' ');
      return [
        `if command -v ${shQuote(action.tool)} >/dev/null 2>&1; then`,
        `  RV_E=$(${command} 2>&1) || rv_err "$RV_E"`,
        'else',
        `  rv_empty ${shQuote(action.fallback)}`,
        'fi',
      ].join('\n');
    }
    case 'removeRunner':
      return `rv_unservice ${shQuote(action.path)} && rv_rm ${shQuote(action.path)}`;
  }
}

function stepBlock(step: CleanStep): string {
  const isDocker = step.actions.some((action) => action.kind === 'docker');
  const measure = step.measure.map(shQuote).join(' ');
  const body = isDocker
    ? [
        ...step.actions.map(actionLine),
        'if [ -z "$RV_ERR" ]; then rv_out @@donehuman "$RV_ID" "$RV_FREED"; else rv_out @@fail "$RV_ID" 0 "$RV_ERR"; fi',
      ]
    : [
        `RV_B=$(rv_sum ${measure})`,
        ...step.actions.map(actionLine),
        `RV_A=$(rv_sum ${measure})`,
        'RV_X=$((RV_B - RV_A))',
        'if [ -z "$RV_ERR" ]; then rv_out @@done "$RV_ID" "$RV_X"; else rv_out @@fail "$RV_ID" "$RV_X" "$RV_ERR"; fi',
      ];
  const lines = [`RV_ID=${shQuote(step.id)}`, 'RV_ERR=""'];
  if (step.busyGuard) {
    lines.push(
      `if rv_busy ${shQuote(step.busyGuard)}; then`,
      `  rv_out @@skip "$RV_ID" ${shQuote(SKIPPED_BUSY)}`,
      'else',
      ...body.map((line) => `  ${line}`),
      'fi',
    );
  } else {
    lines.push(...body);
  }
  return lines.join('\n');
}

export function posixCleanScript(steps: CleanStep[]): string {
  return `${lib({})}${DELETE_LIB}${steps.map(stepBlock).join('\n')}\nexit 0\n`;
}

function packageCacheLines(): string[] {
  const linux = cacheEntriesFor('linux');
  const mac = cacheEntriesFor('macos');
  const branch = (entries: typeof linux) =>
    entries.map((entry) => {
      const folder = `"$RV_HOME"/${shQuote(entry.rel)}`;
      if (!entry.command) return `    rv_empty ${folder}`;
      const command = [entry.command.tool, ...entry.command.args].map(shQuote).join(' ');
      return `    if command -v ${shQuote(entry.command.tool)} >/dev/null 2>&1; then ${command} >/dev/null 2>&1 || rv_err x; else rv_empty ${folder}; fi`;
    });
  return [
    'case "$(uname -s)" in',
    '  Darwin)',
    ...branch(mac),
    '    ;;',
    '  *)',
    ...branch(linux),
    '    ;;',
    'esac',
  ];
}

/** The script the scheduled job runs. It finds the runners again each time, so new ones are covered. */
export function posixJobScript(
  schedule: RunnerCleanupSchedule,
  options: ScriptOptions = {},
): string {
  const { rules } = schedule;
  const perRunner: string[] = [];
  if (rules.temp) perRunner.push('rv_empty "$rv_d/_work/_temp"');
  if (rules.actions) perRunner.push('rv_rm "$rv_d/_work/_actions"');
  if (rules.logsOlderThanDays !== null) {
    perRunner.push(`rv_oldlogs "$rv_d/_diag" ${rules.logsOlderThanDays}`);
  }
  if (rules.checkoutsOlderThanDays !== null) {
    perRunner.push(
      'for rv_p in "$rv_d"/_work/*; do',
      '  [ -d "$rv_p" ] && [ ! -L "$rv_p" ] || continue',
      '  case "${rv_p##*/}" in _*) continue ;; esac',
      `  [ -z "$(find "$rv_p" -maxdepth 2 -mtime -${rules.checkoutsOlderThanDays} 2>/dev/null | head -n 1)" ] && rv_rm "$rv_p"`,
      'done',
    );
  }
  if (rules.oldVersions) {
    perRunner.push(
      'rv_oldversions "$rv_d" | while IFS= read -r rv_v; do [ -n "$rv_v" ] && rv_rm "$rv_v"; done',
    );
  }
  if (rules.toolKeepNewest) {
    perRunner.push(
      'for rv_t in "$rv_d"/_work/_tool/*; do',
      '  [ -d "$rv_t" ] || continue',
      '  for rv_v in "$rv_t"/*; do [ -d "$rv_v" ] && printf \'%s\\n\' "${rv_v##*/}"; done | sort -t. -k1,1n -k2,2n -k3,3n | sed \'$d\' | while IFS= read -r rv_v; do rv_rm "$rv_t/$rv_v"; done',
      'done',
    );
  }
  const machine: string[] = [];
  if (rules.dockerOlderThanHours !== null) {
    const until = `--filter until=${rules.dockerOlderThanHours}h`;
    machine.push(
      `rv_docker_prune 'container prune -f ${until}'`,
      `rv_docker_prune 'image prune -f ${until}'`,
      `rv_docker_prune 'builder prune -f ${until}'`,
    );
  }
  if (rules.packageCaches) machine.push(...packageCacheLines());

  return `#!/bin/sh
# Runova runner cleanup. Runova set this up; change or remove it from the Pipelines page.
${configLine(schedule)}
${lib(options)}${DELETE_LIB}
RV_JOBDIR=${JOB_DIR}
RV_LOG="$RV_JOBDIR/runner-cleanup.log"
mkdir -p "$RV_JOBDIR"
mkdir "$RV_JOBDIR/runner-cleanup.lock" 2>/dev/null || exit 0
trap 'rmdir "$RV_JOBDIR/runner-cleanup.lock" 2>/dev/null' EXIT INT TERM
rv_avail() { df -Pk "$RV_HOME" 2>/dev/null | awk 'NR == 2 {print $4}'; }
RV_F0=$(rv_avail)
RV_LIST=$(rv_runners)
while IFS= read -r rv_d; do
  [ -n "$rv_d" ] && [ -d "$rv_d" ] || continue
  rv_busy "$rv_d" && continue
${perRunner.map((line) => `  ${line}`).join('\n')}
  :
done <<RV_LIST_END
$RV_LIST
RV_LIST_END
${machine.join('\n')}
RV_F1=$(rv_avail)
RV_FREED=$(( \${RV_F1:-0} - \${RV_F0:-0} ))
[ "$RV_FREED" -gt 0 ] || RV_FREED=0
if [ -z "$RV_ERR" ]; then RV_STATUS=ok; else RV_STATUS=failed; fi
printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RV_FREED" "$RV_STATUS" >> "$RV_LOG"
tail -n 200 "$RV_LOG" > "$RV_LOG.tmp" 2>/dev/null && mv "$RV_LOG.tmp" "$RV_LOG"
exit 0
`;
}

function writeJob(schedule: RunnerCleanupSchedule): string {
  const job = posixJobScript(schedule);
  if (job.split('\n').includes(JOB_DELIMITER)) throw new Error('The job script cannot be written.');
  return `RV_JOBDIR="$HOME/.runova"
mkdir -p "$RV_JOBDIR" || { printf '@@error\\t%s\\n' "Could not create $RV_JOBDIR"; exit 0; }
cat > "$RV_JOBDIR/runner-cleanup.sh" <<'${JOB_DELIMITER}'
${job}${JOB_DELIMITER}
chmod 700 "$RV_JOBDIR/runner-cleanup.sh"
`;
}

/** Drops Runova's block from the crontab on stdin and leaves every other line alone. */
const WITHOUT_BLOCK = `awk -v b=${shQuote(JOB_BEGIN)} -v e=${shQuote(JOB_END)} '$0 == b {skip = 1} !skip {print} $0 == e {skip = 0}'`;

/** Writes the job and registers it: a crontab block on Linux, a LaunchAgent on macOS. */
export function posixInstallScript(schedule: RunnerCleanupSchedule, os: 'linux' | 'macos'): string {
  if (os === 'macos') {
    const plist = launchdPlist(schedule, '${HOME}/.runova/runner-cleanup.sh');
    return `${writeJob(schedule)}RV_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$RV_PLIST" <<${PLIST_DELIMITER}
${plist}${PLIST_DELIMITER}
RV_UID=$(id -u)
launchctl bootout "gui/$RV_UID/${LAUNCHD_LABEL}" >/dev/null 2>&1
if launchctl bootstrap "gui/$RV_UID" "$RV_PLIST" >/dev/null 2>&1 || launchctl load -w "$RV_PLIST" >/dev/null 2>&1; then
  printf '@@ok\\n'
else
  printf '@@ok\\tlater\\n'
fi
`;
  }
  const line = cronLine(schedule, '/bin/sh "$HOME/.runova/runner-cleanup.sh" >/dev/null 2>&1');
  return `if ! command -v crontab >/dev/null 2>&1; then printf '@@error\\tnocron\\n'; exit 0; fi
${writeJob(schedule)}if { crontab -l 2>/dev/null | ${WITHOUT_BLOCK}; printf '%s\\n' ${shQuote(JOB_BEGIN)} ${shQuote(line)} ${shQuote(JOB_END)}; } | crontab -; then
  printf '@@ok\\n'
else
  printf '@@error\\t%s\\n' 'crontab did not take the new entry'
fi
`;
}

export function posixRemoveScript(os: 'linux' | 'macos'): string {
  const files = 'rm -f "$HOME/.runova/runner-cleanup.sh" "$HOME/.runova/runner-cleanup.log"';
  if (os === 'macos') {
    return `RV_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 || launchctl unload -w "$RV_PLIST" >/dev/null 2>&1
rm -f "$RV_PLIST"
${files}
printf '@@ok\\n'
`;
  }
  return `if command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -q ${shQuote(`^${JOB_BEGIN}$`)}; then
    crontab -l 2>/dev/null | ${WITHOUT_BLOCK} | crontab - || { printf '@@error\\t%s\\n' 'crontab did not take the change'; exit 0; }
  fi
fi
${files}
printf '@@ok\\n'
`;
}

function eitherOs(mac: string, linux: string): string {
  return `printf 'os\t%s\n' "$(uname -s)"
if [ "$(uname -s)" = Darwin ]; then
${mac}
else
${linux}
fi
`;
}

/** Install for whichever of Linux and macOS the server turns out to be. */
export function posixInstallAnyScript(schedule: RunnerCleanupSchedule): string {
  return eitherOs(posixInstallScript(schedule, 'macos'), posixInstallScript(schedule, 'linux'));
}

export function posixRemoveAnyScript(): string {
  return eitherOs(posixRemoveScript('macos'), posixRemoveScript('linux'));
}
