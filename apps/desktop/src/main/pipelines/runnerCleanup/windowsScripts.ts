import type { RunnerCleanupSchedule } from '../../../shared/apiTypes';
import { CACHE_TOOLS, cacheEntriesFor } from './cacheCatalog';
import {
  type CleanAction,
  type CleanStep,
  DOCKER_ARGS,
  type ScriptOptions,
  SKIPPED_BUSY,
} from './cleanSteps';
import {
  CONFIG_PREFIX,
  configLine,
  TASK_NAME,
  TASK_SCRIPT_TOKEN,
  TASK_USER_TOKEN,
  taskXml,
} from './schedule';
import { psQuote, toBase64, toEncodedCommand } from './shellText';

/**
 * The runner cleanup's scripts for Windows (E104), in Windows PowerShell 5.1 so they run on any
 * Windows the runner supports. Paths go in as PowerShell literal strings (`psQuote`).
 *
 * Deleting goes through RvRemove rather than Remove-Item: Windows PowerShell 5.1 can follow a
 * junction while deleting recursively, and git checkouts are full of read-only files that
 * Directory.Delete refuses. RvRemove removes a link without entering it and clears read-only first.
 */

/**
 * Reads the real script as base64 UTF-8 from stdin and runs it. Short and encoded, so it passes
 * through cmd.exe (the default OpenSSH shell, which stops at 8191 characters) or PowerShell intact.
 */
export const WINDOWS_BOOTSTRAP =
  '$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));. ([scriptblock]::Create($s))';

export const WINDOWS_RUNNER = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${toEncodedCommand(WINDOWS_BOOTSTRAP)}`;

const JOB_FOLDER = "(Join-Path $RvLocal 'Runova')";

function list(values: string[]): string {
  return `@(${values.map(psQuote).join(', ')})`;
}

function lib(options: ScriptOptions): string {
  const only = options.onlyRoots?.length ? list(options.onlyRoots) : '@()';
  return `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
$RvHome = $env:USERPROFILE
$RvLocal = $env:LOCALAPPDATA
$RvOnlyRoots = ${only}
$RvTab = [string][char]9
function RvOut { [Console]::Out.WriteLine((@($args | ForEach-Object { [string]$_ }) -join $RvTab)) }
function RvIsLink($Item) { return [bool]($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) }
$RvFast = [bool]('RvSize' -as [type])
if (-not $RvFast) {
  try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System.Collections.Generic;
using System.IO;
public static class RvSize {
  public static long Kb(string path) {
    if (File.Exists(path)) return (new FileInfo(path).Length + 1023) / 1024;
    if (!Directory.Exists(path)) return 0;
    var root = new DirectoryInfo(path);
    if ((root.Attributes & FileAttributes.ReparsePoint) != 0) return 0;
    long total = 0;
    var stack = new Stack<DirectoryInfo>();
    stack.Push(root);
    while (stack.Count > 0) {
      var dir = stack.Pop();
      FileSystemInfo[] entries;
      try { entries = dir.GetFileSystemInfos(); } catch { continue; }
      foreach (var entry in entries) {
        if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) continue;
        var sub = entry as DirectoryInfo;
        if (sub != null) stack.Push(sub); else total += ((FileInfo)entry).Length;
      }
    }
    return (total + 1023) / 1024;
  }
}
'@
    $RvFast = $true
  } catch {}
}
function RvKb([string]$Path) {
  if ($RvFast) { try { return [long][RvSize]::Kb($Path) } catch {} }
  $root = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $root -or (RvIsLink $root)) { return [long]0 }
  if (-not $root.PSIsContainer) { return [long][math]::Ceiling($root.Length / 1024) }
  $total = [long]0
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    $entries = @()
    try { $entries = $dir.GetFileSystemInfos() } catch { continue }
    foreach ($e in $entries) {
      if (RvIsLink $e) { continue }
      if ($e -is [IO.DirectoryInfo]) { $stack.Push($e) } else { $total += $e.Length }
    }
  }
  return [long][math]::Ceiling($total / 1024)
}
function RvIsRunnerDir([string]$Dir) {
  foreach ($b in @(Get-ChildItem -LiteralPath $Dir -Directory -Force -Filter 'bin*')) {
    if (Test-Path -LiteralPath (Join-Path $b.FullName 'Runner.Listener.exe')) { return $true }
  }
  return $false
}
function RvRunners {
  $found = [ordered]@{}
  $roots = New-Object System.Collections.Generic.List[string]
  if ($RvOnlyRoots.Count -gt 0) {
    foreach ($r in $RvOnlyRoots) { $roots.Add($r); foreach ($c in @(Get-ChildItem -LiteralPath $r -Directory -Force)) { $roots.Add($c.FullName); foreach ($g in @(Get-ChildItem -LiteralPath $c.FullName -Directory -Force)) { $roots.Add($g.FullName) } } }
  } else {
    $skip = @('windows', 'program files', 'program files (x86)', 'programdata', 'users', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', '$windows.~bt', '$windows.~ws')
    foreach ($top in @(Get-ChildItem -LiteralPath ($env:SystemDrive + '\\') -Directory -Force)) {
      if ($skip -contains $top.Name.ToLowerInvariant()) { continue }
      $roots.Add($top.FullName)
      foreach ($c in @(Get-ChildItem -LiteralPath $top.FullName -Directory -Force)) { $roots.Add($c.FullName) }
    }
    if ($RvHome) {
      foreach ($top in @(Get-ChildItem -LiteralPath $RvHome -Directory -Force)) {
        if ($top.Name -eq 'AppData') { continue }
        $roots.Add($top.FullName)
        foreach ($c in @(Get-ChildItem -LiteralPath $top.FullName -Directory -Force)) { $roots.Add($c.FullName) }
      }
    }
  }
  foreach ($r in $roots) {
    if (RvIsRunnerDir $r) { $k = $r.TrimEnd('\\').ToLowerInvariant(); if (-not $found.Contains($k)) { $found[$k] = $r.TrimEnd('\\') } }
  }
  if ($RvOnlyRoots.Count -eq 0) {
    foreach ($svc in @(Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%'")) {
      $pn = [string]$svc.PathName
      if ($pn -match '^"([^"]+)"') { $exe = $Matches[1] } else { $exe = ($pn -split ' ')[0] }
      if (-not $exe) { continue }
      $dir = Split-Path -Parent (Split-Path -Parent $exe)
      if ($dir -and (Test-Path -LiteralPath $dir -PathType Container)) { $k = $dir.TrimEnd('\\').ToLowerInvariant(); if (-not $found.Contains($k)) { $found[$k] = $dir.TrimEnd('\\') } }
    }
  }
  return @($found.Values)
}
function RvWorkerPaths { return @(Get-Process -Name 'Runner.Worker' -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Path }) }
function RvBusy([string]$Dir) {
  $prefix = ($Dir.TrimEnd('\\') + '\\bin').ToLowerInvariant()
  foreach ($p in RvWorkerPaths) {
    if (-not $p) { return $true }
    if ($p.ToLowerInvariant().StartsWith($prefix)) { return $true }
  }
  return $false
}
function RvReal([string]$Path) {
  $i = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $i) { return $null }
  if (RvIsLink $i) {
    $t = @($i.Target)[0]
    if ($t) {
      if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path $i.Parent.FullName $t }
      return ([IO.Path]::GetFullPath($t)).TrimEnd('\\').ToLowerInvariant()
    }
  }
  return $i.FullName.TrimEnd('\\').ToLowerInvariant()
}
function RvOldVersions([string]$Dir) {
  $liveBin = RvReal (Join-Path $Dir 'bin')
  $liveExt = RvReal (Join-Path $Dir 'externals')
  if (-not $liveBin) { return @() }
  $out = @()
  foreach ($v in @(Get-ChildItem -LiteralPath $Dir -Directory -Force | Where-Object { $_.Name -like 'bin.*' -or $_.Name -like 'externals.*' })) {
    if (RvIsLink $v) { continue }
    $real = $v.FullName.TrimEnd('\\').ToLowerInvariant()
    if ($real -eq $liveBin -or $real -eq $liveExt) { continue }
    $out += $v.FullName
  }
  return $out
}
function RvOldLogFiles([string]$Dir, [int]$Days) {
  $cut = (Get-Date).AddDays(-$Days)
  return @(Get-ChildItem -LiteralPath $Dir -File -Recurse -Force | Where-Object { $_.LastWriteTime -lt $cut })
}
function RvFree([string]$Path) {
  $drive = Split-Path -Qualifier $Path
  if (-not $drive) { $drive = $env:SystemDrive }
  $disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $drive + "'")
  if ($disk) { return [long]$disk.FreeSpace }
  return [long]0
}
`;
}

const DELETE_LIB = `$script:RvError = $null
function RvErr($Problem) {
  if ($script:RvError) { return }
  $m = ([string]$Problem -replace '[\\t\\r\\n]+', ' ').Trim()
  if (-not $m) { $m = 'failed' }
  $script:RvError = $m
}
function RvRemove([string]$Path) {
  $root = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $root) { return }
  $dirs = New-Object System.Collections.Generic.List[string]
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $i = $stack.Pop()
    # Listed a while ago: a job still running may have swapped this folder for a junction since.
    $i.Refresh()
    if ((RvIsLink $i) -or -not ($i -is [IO.DirectoryInfo])) {
      if ($i -is [IO.DirectoryInfo]) { [IO.Directory]::Delete($i.FullName, $false) }
      else { $i.Attributes = [IO.FileAttributes]::Normal; $i.Delete() }
      continue
    }
    $dirs.Add($i.FullName)
    foreach ($c in $i.GetFileSystemInfos()) { $stack.Push($c) }
  }
  for ($n = $dirs.Count - 1; $n -ge 0; $n--) {
    $d = New-Object IO.DirectoryInfo $dirs[$n]
    $d.Attributes = [IO.FileAttributes]::Directory
    $d.Delete()
  }
}
function RvTry([scriptblock]$Work) { try { & $Work } catch { RvErr $_.Exception.Message } }
function RvEmpty([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item -or (RvIsLink $item) -or -not $item.PSIsContainer) { return }
  foreach ($c in @(Get-ChildItem -LiteralPath $Path -Force)) { RvTry { RvRemove $c.FullName } }
}
function RvOldLogs([string]$Path, [int]$Days) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  foreach ($f in RvOldLogFiles $Path $Days) { RvTry { $f.Attributes = [IO.FileAttributes]::Normal; $f.Delete() } }
}
function RvSum([string[]]$Paths) { $s = [long]0; foreach ($p in $Paths) { $s += RvKb $p }; return $s }
function RvDockerPrune([string[]]$DockerArgs) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { RvErr 'Docker is not installed on this machine'; return '' }
  $o = (& docker @DockerArgs 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { RvErr $o; return '' }
  $m = [regex]::Matches($o, '(?m)^Total(?: reclaimed space)?:\\s*(\\S+)')
  if ($m.Count -gt 0) { return $m[$m.Count - 1].Groups[1].Value }
  return ''
}
function RvIsAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function RvUnservice([string]$Dir) {
  # The runner account can rewrite .service, so the service is the one Windows runs from this
  # runner's bin folder, never a name read from the folder.
  $bin = (Join-Path $Dir 'bin').TrimEnd('\\') + '\\'
  $names = @(Get-CimInstance Win32_Service | Where-Object {
    $p = ([string]$_.PathName).TrimStart('"')
    $p.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object { $_.Name })
  if ($names.Count -eq 0) { return $true }
  if (-not (RvIsAdmin)) { RvErr ('Removing its service needs an administrator shell. Run: ' + (@($names | ForEach-Object { 'sc.exe stop ' + $_ + '; sc.exe delete ' + $_ }) -join '; ')); return $false }
  foreach ($name in $names) { & sc.exe stop $name *> $null }
  Start-Sleep -Seconds 3
  foreach ($name in $names) { & sc.exe delete $name *> $null }
  return $true
}
`;

function cacheLines(): string {
  return cacheEntriesFor('windows')
    .map((entry) => {
      const base = entry.base === 'home' ? '$RvHome' : '$RvLocal';
      return `$p = Join-Path ${base} ${psQuote(entry.rel)}; if (Test-Path -LiteralPath $p -PathType Container) { RvOut 'cache' ${psQuote(entry.id)} $RvHome (RvKb $p) $p }`;
    })
    .join('\n');
}

export function windowsScanScript(options: ScriptOptions = {}): string {
  return `${lib(options)}
RvOut 'os' 'Windows'
RvOut 'home' $RvHome
RvOut 'step' 'runners'
$RvList = @(RvRunners)
$RvWorkers = @(RvWorkerPaths)
foreach ($p in $RvWorkers) { if (-not $p) { RvOut 'busyunknown'; break } }
foreach ($d in $RvList) {
  RvOut 'runner' $d
  $rf = Join-Path $d '.runner'
  if (Test-Path -LiteralPath $rf) {
    RvOut 'runnerfile' $d
    RvOut 'runnerjson' $d ([Convert]::ToBase64String([IO.File]::ReadAllBytes($rf)))
  }
  if ((Test-Path -LiteralPath (Join-Path $d 'config.cmd')) -or (Test-Path -LiteralPath (Join-Path $d 'config.sh'))) { RvOut 'configured' $d }
  $sf = Join-Path $d '.service'
  if (Test-Path -LiteralPath $sf) { RvOut 'service' $d ([string]@(Get-Content -LiteralPath $sf -TotalCount 1)[0]).Trim() }
  $prefix = ($d.TrimEnd('\\') + '\\bin').ToLowerInvariant()
  foreach ($p in $RvWorkers) { if ($p -and $p.ToLowerInvariant().StartsWith($prefix)) { RvOut 'busy' $d; break } }
  $w = Join-Path $d '_work'
  if (Test-Path -LiteralPath $w -PathType Container) {
    foreach ($p in @(Get-ChildItem -LiteralPath $w -Directory -Force)) {
      if (RvIsLink $p) { continue }
      $kind = $null
      if ($p.Name -eq '_temp') { $kind = 'temp' }
      elseif ($p.Name -eq '_actions') { $kind = 'actions' }
      elseif ($p.Name -eq '_update') { $kind = 'update' }
      elseif (-not ($p.Name.StartsWith('_') -or $p.Name.StartsWith('.'))) { $kind = 'checkout' }
      if ($kind) { RvOut 'size' $d $kind (RvKb $p.FullName) $p.FullName }
    }
    foreach ($t in @(Get-ChildItem -LiteralPath (Join-Path $w '_tool') -Directory -Force)) {
      foreach ($v in @(Get-ChildItem -LiteralPath $t.FullName -Directory -Force)) {
        if (-not (RvIsLink $v)) { RvOut 'size' $d 'tool' (RvKb $v.FullName) $v.FullName }
      }
    }
  }
  $diag = Join-Path $d '_diag'
  if (Test-Path -LiteralPath $diag -PathType Container) {
    $old = [long]0
    foreach ($f in RvOldLogFiles $diag 7) { $old += $f.Length }
    RvOut 'size' $d 'diag' ([long][math]::Ceiling($old / 1024)) $diag
  }
  foreach ($v in RvOldVersions $d) { RvOut 'size' $d 'oldver' (RvKb $v) $v }
  RvOut 'size' $d 'total' (RvKb $d) $d
}
RvOut 'step' 'docker'
if (${options.skipDocker ? '$true' : '$false'} -or -not (Get-Command docker -ErrorAction SilentlyContinue)) { RvOut 'docker' 'missing' }
else {
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { RvOut 'docker' 'denied' }
  else {
    RvOut 'docker' 'ok' 'docker'
    foreach ($l in @(& docker system df --format '{{json .}}' 2>$null)) { if ($l) { RvOut 'dockerdf' $l } }
    foreach ($l in @(& docker image ls --filter dangling=true --format '{{.Size}}' 2>$null)) { if ($l) { RvOut 'dockerdangling' $l } }
  }
}
RvOut 'step' 'caches'
${cacheLines()}
foreach ($t in ${list([...CACHE_TOOLS])}) { if (Get-Command $t -ErrorAction SilentlyContinue) { RvOut 'tool' $t } }
$at = $env:SystemDrive
if ($RvList.Count -gt 0) { $q = Split-Path -Qualifier $RvList[0]; if ($q) { $at = $q } }
$disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $at + "'")
if ($disk) { RvOut 'diskwin' $at ([string]$disk.Size) ([string]$disk.FreeSpace) }
RvOut 'step' 'schedule'
$jobDir = ${JOB_FOLDER}
$jobScript = Join-Path $jobDir 'runner-cleanup.ps1'
if (Test-Path -LiteralPath $jobScript) {
  foreach ($l in [IO.File]::ReadAllLines($jobScript)) { if ($l.StartsWith(${psQuote(CONFIG_PREFIX)})) { RvOut 'schedconfig' $l.Substring(${CONFIG_PREFIX.length}); break } }
}
if (Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue) { RvOut 'sched' 'installed' 'task' }
$jobLog = Join-Path $jobDir 'runner-cleanup.log'
if (Test-Path -LiteralPath $jobLog) { $last = @(Get-Content -LiteralPath $jobLog -Tail 1)[0]; if ($last) { RvOut 'schedlog' $last } }
`;
}

function actionLine(action: CleanAction): string {
  switch (action.kind) {
    case 'remove':
      return `RvTry { RvRemove ${psQuote(action.path)} }`;
    case 'empty':
      return `RvEmpty ${psQuote(action.path)}`;
    case 'oldLogs':
      return `RvOldLogs ${psQuote(action.path)} ${Math.max(1, Math.floor(action.days))}`;
    case 'docker':
      return `$RvFreed = RvDockerPrune ${list(DOCKER_ARGS[action.prune])}`;
    case 'toolCommand':
      return [
        `if (Get-Command ${psQuote(action.tool)} -ErrorAction SilentlyContinue) {`,
        `  $o = (& ${[action.tool, ...action.args].map(psQuote).join(' ')} 2>&1 | Out-String)`,
        '  if ($LASTEXITCODE -ne 0) { RvErr $o }',
        `} else { RvEmpty ${psQuote(action.fallback)} }`,
      ].join('\n');
    case 'removeRunner':
      return `RvTry { if (RvUnservice ${psQuote(action.path)}) { RvRemove ${psQuote(action.path)} } }`;
  }
}

function stepBlock(step: CleanStep): string {
  const isDocker = step.actions.some((action) => action.kind === 'docker');
  const measure = list(step.measure);
  const body = isDocker
    ? [
        "$RvFreed = ''",
        ...step.actions.map(actionLine),
        "if (-not $script:RvError) { RvOut '@@donehuman' $RvId $RvFreed } else { RvOut '@@fail' $RvId 0 $script:RvError }",
      ]
    : [
        `$b = RvSum ${measure}`,
        ...step.actions.map(actionLine),
        `$x = [math]::Max([long]0, $b - (RvSum ${measure}))`,
        "if (-not $script:RvError) { RvOut '@@done' $RvId $x } else { RvOut '@@fail' $RvId $x $script:RvError }",
      ];
  const lines = [`$RvId = ${psQuote(step.id)}`, '$script:RvError = $null'];
  if (step.busyGuard) {
    lines.push(
      `if (RvBusy ${psQuote(step.busyGuard)}) { RvOut '@@skip' $RvId ${psQuote(SKIPPED_BUSY)} } else {`,
      ...body.map((line) => `  ${line}`),
      '}',
    );
  } else {
    lines.push(...body);
  }
  return lines.join('\n');
}

export function windowsCleanScript(steps: CleanStep[]): string {
  return `${lib({})}${DELETE_LIB}${steps.map(stepBlock).join('\n')}\n`;
}

export function windowsJobScript(
  schedule: RunnerCleanupSchedule,
  options: ScriptOptions = {},
): string {
  const { rules } = schedule;
  const perRunner: string[] = [];
  if (rules.temp) perRunner.push("RvEmpty (Join-Path $d '_work\\_temp')");
  if (rules.actions) perRunner.push("RvTry { RvRemove (Join-Path $d '_work\\_actions') }");
  if (rules.logsOlderThanDays !== null) {
    perRunner.push(`RvOldLogs (Join-Path $d '_diag') ${rules.logsOlderThanDays}`);
  }
  if (rules.checkoutsOlderThanDays !== null) {
    perRunner.push(
      `$cut = (Get-Date).AddDays(-${rules.checkoutsOlderThanDays})`,
      "foreach ($p in @(Get-ChildItem -LiteralPath (Join-Path $d '_work') -Directory -Force)) {",
      "  if ((RvIsLink $p) -or $p.Name.StartsWith('_') -or $p.Name.StartsWith('.')) { continue }",
      '  $recent = @(Get-ChildItem -LiteralPath $p.FullName -Force -Recurse -Depth 1 | Where-Object { $_.LastWriteTime -gt $cut } | Select-Object -First 1)',
      '  if ($p.LastWriteTime -le $cut -and $recent.Count -eq 0) { RvTry { RvRemove $p.FullName } }',
      '}',
    );
  }
  if (rules.oldVersions) {
    perRunner.push('foreach ($v in RvOldVersions $d) { RvTry { RvRemove $v } }');
  }
  if (rules.toolKeepNewest) {
    perRunner.push(
      "foreach ($t in @(Get-ChildItem -LiteralPath (Join-Path $d '_work\\_tool') -Directory -Force)) {",
      "  $vs = @(Get-ChildItem -LiteralPath $t.FullName -Directory -Force | Sort-Object { $parsed = $null; if ([version]::TryParse(($_.Name -replace '[^0-9.].*$', ''), [ref]$parsed)) { $parsed } else { [version]'0.0' } })",
      '  if ($vs.Count -gt 1) { foreach ($v in $vs[0..($vs.Count - 2)]) { RvTry { RvRemove $v.FullName } } }',
      '}',
    );
  }
  const machine: string[] = [];
  if (rules.dockerOlderThanHours !== null) {
    const until = `until=${rules.dockerOlderThanHours}h`;
    machine.push(
      `if (Get-Command docker -ErrorAction SilentlyContinue) {`,
      ...(['container', 'image', 'builder'] as const).map(
        (what) => `  $null = RvDockerPrune ${list([what, 'prune', '-f', '--filter', until])}`,
      ),
      '}',
    );
  }
  if (rules.packageCaches) {
    for (const entry of cacheEntriesFor('windows')) {
      const folder = `(Join-Path ${entry.base === 'home' ? '$RvHome' : '$RvLocal'} ${psQuote(entry.rel)})`;
      machine.push(
        entry.command
          ? `if (Get-Command ${psQuote(entry.command.tool)} -ErrorAction SilentlyContinue) { $null = (& ${[entry.command.tool, ...entry.command.args].map(psQuote).join(' ')} 2>&1 | Out-String) } else { RvEmpty ${folder} }`
          : `RvEmpty ${folder}`,
      );
    }
  }
  return `# Runova runner cleanup. Runova set this up; change or remove it from the Pipelines page.
${configLine(schedule)}
${lib(options)}${DELETE_LIB}
$jobDir = ${JOB_FOLDER}
New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
$log = Join-Path $jobDir 'runner-cleanup.log'
try { $lock = [IO.File]::Open((Join-Path $jobDir 'runner-cleanup.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { exit 0 }
$f0 = RvFree $RvHome
foreach ($d in @(RvRunners)) {
  if (RvBusy $d) { continue }
${perRunner.map((line) => `  ${line}`).join('\n')}
}
${machine.join('\n')}
$freed = [math]::Max([long]0, [long][math]::Floor(((RvFree $RvHome) - $f0) / 1024))
if ($script:RvError) { $status = 'failed' } else { $status = 'ok' }
$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
Add-Content -LiteralPath $log -Value ($stamp + $RvTab + $freed + $RvTab + $status) -Encoding UTF8
$keep = @(Get-Content -LiteralPath $log -Tail 200)
Set-Content -LiteralPath $log -Value $keep -Encoding UTF8
$lock.Close()
Remove-Item -LiteralPath (Join-Path $jobDir 'runner-cleanup.lock') -Force
`;
}

/** Writes the job script and registers the task: S4U first, signed-in only when that is refused. */
export function windowsInstallScript(schedule: RunnerCleanupSchedule): string {
  return `${lib({})}
$jobDir = ${JOB_FOLDER}
New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
$path = Join-Path $jobDir 'runner-cleanup.ps1'
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toBase64(windowsJobScript(schedule))}'))
[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $true))
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toBase64(taskXml(schedule))}'))
$xml = $xml.Replace('${TASK_USER_TOKEN}', [Security.SecurityElement]::Escape($user)).Replace('${TASK_SCRIPT_TOKEN}', [Security.SecurityElement]::Escape($path))
try {
  Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Xml $xml -Force -ErrorAction Stop | Out-Null
  RvOut '@@ok'
} catch {
  try {
    Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Xml ($xml.Replace('<LogonType>S4U</LogonType>', '<LogonType>InteractiveToken</LogonType>')) -Force -ErrorAction Stop | Out-Null
    RvOut '@@ok' 'interactive'
  } catch {
    RvOut '@@error' (([string]$_.Exception.Message) -replace '[\\r\\n]+', ' ')
  }
}
`;
}

export function windowsRemoveScript(): string {
  return `${lib({})}
Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue
$jobDir = ${JOB_FOLDER}
Remove-Item -LiteralPath (Join-Path $jobDir 'runner-cleanup.ps1') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $jobDir 'runner-cleanup.log') -Force -ErrorAction SilentlyContinue
if (Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue) { RvOut '@@error' 'Task Scheduler kept the task' } else { RvOut '@@ok' }
`;
}
