import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Extra directories where installed CLI tools actually live, for the cases where the installer
 * puts them somewhere PATH does not point.
 *
 * The case that forced this: `pip install semgrep` drops semgrep.exe into a per-user Scripts
 * folder, and neither the python.org installer nor the Microsoft Store build puts that folder on
 * PATH. The install succeeds, and then the Dev Tools card still reads "Not detected" and the
 * Security tab refuses to run the scan, so from the user's side Semgrep simply cannot be
 * installed. Semgrep also re-execs `pysemgrep` by name from that same folder, so recording the
 * absolute path of semgrep.exe would not be enough: the folder has to be on the PATH the child
 * process inherits, or the scan dies with "executing pysemgrep failed".
 *
 * Native installers have the same problem in a different shape. Claude Code's install script, Grok,
 * OpenCode and friends drop their binary into a folder under the home directory and put that
 * folder on PATH only through a shell rc file (or, on Windows, the user PATH in the registry). The
 * app never re-reads rc files, and a macOS app launched from Finder starts with a bare PATH that
 * has none of them, so a CLI installed a minute ago would read as missing until the next login.
 *
 * These go on the end of PATH, never the front, so a copy the user installed deliberately
 * (winget, brew, pipx) still wins.
 */

const PROBE_TIMEOUT_MS = 5000;

/** Prints the interpreter's global and per-user script directories, one per line. */
const SCRIPT_DIRS_SNIPPET =
  'import os,sysconfig;print(sysconfig.get_path("scripts"));print(sysconfig.get_path("scripts", os.name + "_user"))';

/**
 * Spawned directly rather than through cmd.exe: python is a real .exe on every platform, not a
 * .cmd shim, and `cmd /s /c` would eat the quotes around the -c snippet.
 */
const PYTHON_CANDIDATES: Array<[string, string[]]> =
  process.platform === 'win32'
    ? [
        ['python', []],
        ['python3', []],
        ['py', ['-3']],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];

function runPython(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args, '-c', SCRIPT_DIRS_SNIPPET],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.toString()),
    );
  });
}

export async function pythonScriptDirs(): Promise<string[]> {
  for (const [command, args] of PYTHON_CANDIDATES) {
    const stdout = await runPython(command, args);
    if (stdout === null) continue;
    const dirs = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // The first interpreter that answers is the one `pip install` would have used, so stop there
    // rather than merging the script dirs of every Python on the machine.
    if (dirs.length > 0) return dirs;
  }
  return [];
}

function staticDirs(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const dirs = [
      // Claude Code's native installer, Goose, and uv (which is how aider gets installed).
      join(home, '.local', 'bin'),
      join(home, '.grok', 'bin'),
    ];
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push(
        join(localAppData, 'cursor-agent'),
        join(localAppData, 'Programs', 'muse'),
        join(localAppData, 'codegraph', 'current', 'bin'),
        join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
        join(localAppData, 'qwen-code', 'bin'),
        join(localAppData, 'hermes', 'bin'),
      );
    }
    return dirs;
  }
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.strix', 'bin'),
  ];
  if (process.platform === 'darwin') {
    // A packaged app launched from Finder gets a bare PATH with no Homebrew in it.
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  return dirs;
}

/**
 * Every folder a native installer might put a tool into, whether or not it exists yet. A terminal
 * tab that is about to run an install needs these on its PATH up front, because the folder may
 * only be created by that install a moment later. Python's Scripts folders are left out on
 * purpose: finding them means starting Python, which would hold up opening every terminal, and
 * pipx and uv put their tools in ~/.local/bin, which is already here.
 */
export function toolPathCandidates(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of staticDirs()) {
    const key = normalize(dir);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

function currentPath(env: NodeJS.ProcessEnv): string {
  const key = pathKey(env);
  return key ? (env[key] ?? '') : '';
}

/**
 * Windows environment variable names are case-insensitive, but a plain object copy of process.env
 * is not: the real key there is usually `Path`, so writing a new `PATH` key would leave the child
 * with two entries and let it pick either one. Always write back to the key that is already there.
 */
function pathKey(env: NodeJS.ProcessEnv): string | null {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? null;
}

const CACHE_TTL_MS = 5 * 60_000;
let cached: { at: number; dirs: Promise<string[]> } | null = null;
let cachedPython: { at: number; dirs: Promise<string[]> } | null = null;

/** Detection and the install-method lookup both ask for these, and each probe waits on a spawn. */
function cachedPythonScriptDirs(): Promise<string[]> {
  if (!cachedPython || Date.now() - cachedPython.at > CACHE_TTL_MS) {
    cachedPython = { at: Date.now(), dirs: pythonScriptDirs() };
  }
  return cachedPython.dirs;
}

async function discover(): Promise<string[]> {
  const candidates = [...(await cachedPythonScriptDirs()), ...staticDirs()];
  const onPath = new Set(
    currentPath(process.env)
      .split(delimiter)
      .map((entry) => normalize(entry)),
  );
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    const key = normalize(dir);
    if (!key || seen.has(key) || onPath.has(key)) continue;
    seen.add(key);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

function normalize(dir: string): string {
  const trimmed = dir.trim().replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Cached, because every probe and every scan asks for it and answering costs a child process.
 * The TTL is what makes a Python installed midway through a session show up without a restart.
 */
export function getExtraToolPathDirs(): Promise<string[]> {
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    cached = { at: Date.now(), dirs: discover() };
  }
  return cached.dirs;
}

/** Call when the user has just installed something and is asking us to look again. */
export function refreshExtraToolPathDirs(): void {
  cached = null;
  cachedPython = null;
}

/**
 * `env` with the extra directories appended to PATH. Pass the env a child should otherwise get;
 * omit it to extend the app's own.
 */
export async function withToolPath(env?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const base: NodeJS.ProcessEnv = { ...(env ?? process.env) };
  const dirs = await getExtraToolPathDirs();
  if (dirs.length === 0) return base;
  const key = pathKey(base) ?? 'PATH';
  const existing = base[key] ?? '';
  base[key] = existing ? `${existing}${delimiter}${dirs.join(delimiter)}` : dirs.join(delimiter);
  return base;
}
