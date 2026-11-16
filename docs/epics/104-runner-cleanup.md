# E104 Free disk space on a runner machine

Milestone: standalone (Pipelines). Builds on the runners panel and its machine links
(`RunnersPanel.tsx`, `RunnerMachineStats.tsx`, `runnerMachineStats.ts`) and on E103.

## Goal

Self-hosted runners fill their disk with things nobody looks at: checkouts from earlier jobs,
`_work/_temp`, logs in `_diag`, the `bin.<version>` and `externals.<version>` folders a self-update
leaves behind, folders of runners that were removed from GitHub, Docker leftovers and package
caches. From a runner tile the user sees all of it with sizes, picks what goes, frees it, and can
leave a scheduled job on the machine that keeps doing it. Linux, macOS and Windows, on this
computer or a saved server.

## Tasks

- [x] T1 Types (`shared/apiTypes.ts`) and the shared default schedule (`shared/runnerCleanup.ts`).
- [x] T2 Script helpers (`main/pipelines/runnerCleanup/shellText.ts`, `cacheCatalog.ts`): quoting
  for sh and PowerShell, and the package caches with their path per OS and their tool command.
- [x] T3 Scripts: `posixScripts.ts` (sh, GNU and BSD flags only) and `windowsScripts.ts`
  (Windows PowerShell 5.1) for the scan, the cleanup, the scheduled job, and installing and
  removing that job (crontab block, LaunchAgent, Task Scheduler XML).
- [x] T4 Reading the output (`scanParse.ts`) and the schedule as data (`schedule.ts`).
- [x] T5 The plan (`plan.ts`): groups, items, sizes, risks and default picks, the steps behind
  each item, and which runners are gone (asked of GitHub in `github.ts`).
- [x] T6 Safety (`safety.ts`): no root, home, relative or climbing path, and a runner folder only
  for the step that removes that runner.
- [x] T7 Running it (`machineShell.ts`, `service.ts`, `deps.ts`): SSH lease or a local process,
  OS detection, one operation per machine, the last scan held per machine.
- [x] T8 IPC `runnerCleanup` (scan, clean, cancel, saveSchedule, removeSchedule, onProgress),
  main window only, preload and types.
- [x] T9 Renderer: `cleanupView.ts`, `runnerCleanupStore.ts`, `CleanupItemList`,
  `CleanupScheduleForm`, `RunnerCleanupDialog`, the broom button on linked tiles and **Free
  space** under a disk that is 80% full or more.
- [x] T10 Docs: this file, the delivery status and the Pipelines help article.

## Acceptance criteria

1. A linked runner tile has a broom button; a tile whose disk is 80% full or more also shows
   **Free space**. Both open the cleanup for that machine, which scans at once and shows its
   steps as it goes.
2. The scan finds every runner on the machine (by its listener and by its systemd, launchd or
   Windows service) and shows per runner: temporary files, logs older than 7 days, old runner
   versions, update download, job checkouts, tool versions older than the newest per tool and
   downloaded actions; then Docker (never volumes), package caches and runners that are gone.
3. Safe things and checkouts and older tools of an idle runner start picked; what only slows the
   next job is marked **Downloads again**; whole runners are never picked by default. A runner
   that is running a job has its work folder items turned off with the reason.
4. A runner is called gone only when GitHub plainly lists its repo or org without it (or with a
   different id), or the folder was never registered. A refused or partial answer from GitHub
   leaves it alone.
5. **Clean up** confirms with a list of what goes, then reports each item as done (with what it
   freed), failed (with why) or skipped (a job started). The window can be closed meanwhile; a
   toast says what was freed.
6. The window never sends a path. A stale scan, an unknown id or an unsafe path is refused before
   anything runs.
7. **Schedule** saves a cron job (Linux), a launchd agent (macOS) or a Task Scheduler task
   (Windows) that runs daily, weekly or monthly at a set time with the chosen rules, skips busy
   runners and never removes a whole runner. A scan reads the saved settings and the last run
   back from the machine. **Remove job** takes it away.

## Implementation notes

- The scripts travel on stdin. sh gets `sh -c 'S=$(cat); eval "$S"'`, so a command inside cannot
  swallow the rest of the script; PowerShell gets a short `-EncodedCommand` bootstrap that reads
  the script as base64 from stdin, because cmd.exe (OpenSSH's default shell on Windows) stops at
  8191 characters.
- PowerShell 5.1 can follow a junction while deleting recursively and git leaves read-only files,
  so Windows deletes go through `RvRemove`, which removes a link without entering it and clears
  read-only first. Sizes come from a small C# walker built with `Add-Type` (a 65 GB npm cache took
  17 s with a PowerShell loop), with the loop as a fallback.
- Busy is a live `Runner.Worker` under the runner's `bin`. On Windows a service account's worker
  has no readable path, so every runner counts as busy then.
- Sizes are measured before and after each item, so the figure shown is what really went. Docker
  reports its own reclaimed space.
- The job's settings sit in a `# runova-config:` line in the script on the machine, and each run
  appends `time, KB freed, ok|failed` to a log kept to 200 lines; the machine is the source of
  truth, so nothing is stored in Runova's settings.
- `scripts.int.test.ts` runs the real scan, cleanup and job scripts in PowerShell (Windows) or sh
  (Linux, macOS) against a runner folder built in a temp folder, with the search limited to it
  and Docker left out, so the machine running the tests is never touched. The POSIX scripts were
  also run by hand in Git Bash on Windows.
- Desktop only, like E103.

## Open blockers

None.
