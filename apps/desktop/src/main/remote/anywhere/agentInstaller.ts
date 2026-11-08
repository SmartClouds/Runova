import { join } from 'node:path';
import type { AnywherePermissions } from '../../../shared/anywhere';

/** What the agent needs to run; written once, sealed to the machine by the agent's installer. */
export interface AgentConfigFile {
  siteUrl: string;
  remoteId: string;
  deviceId: number;
  deviceName: string;
  identitySeed: string;
  agentSecret: string;
  passwordSecret: string | null;
  allowOwnDevices: boolean;
  alwaysAllow: number[];
  defaultPermissions: AnywherePermissions;
}

export interface AgentInstaller {
  /** Why the background service can not be used here, or null when it can. */
  unavailable(): string | null;
  installed(): Promise<boolean>;
  install(config: AgentConfigFile): Promise<void>;
  uninstall(): Promise<void>;
}

const WINDOWS_SERVICE = 'RunovaAnywhereAgent';
const LINUX_SERVICE = 'runova-anywhere-agent';
const MAC_PLIST = '/Library/LaunchAgents/com.runova.anywhere.agent.plist';

/** The code each system's permission prompt ends with when the person says no. */
const CANCELLED: Record<string, number> = { win32: 1223, darwin: -128, linux: 126 };
const SYSTEM_NAME: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** A word for a POSIX shell, and that shell command as an AppleScript string. */
const shellWord = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const appleScriptString = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Installs and removes the Runova Anywhere agent (E64, E65), the background service that keeps this
 * computer reachable while no one is signed in. The system asks the person for administrator
 * permission each time. The config, with the agent's secret, goes in a file only this user can
 * read; the agent's installer stores it where only the system can read it and deletes the file.
 */
export function createAgentInstaller(deps: {
  platform: string;
  resourcesPath: string;
  exists(path: string): boolean;
  run(command: string, args: string[]): Promise<{ code: number; stdout: string }>;
  writePrivateFile(content: string): Promise<string>;
  removeFile(path: string): Promise<void>;
  /** A private, runnable copy of the agent, for a system where root can not read the app's files. */
  copyExecutable(path: string): Promise<string>;
}): AgentInstaller {
  const exe = join(
    deps.resourcesPath,
    'remote-agent',
    deps.platform === 'win32' ? 'RunovaAgent.exe' : 'RunovaAgent',
  );
  const system = SYSTEM_NAME[deps.platform] ?? 'This system';

  function unavailable(): string | null {
    if (!SYSTEM_NAME[deps.platform])
      return 'The background service is not available on this system.';
    if (!deps.exists(exe)) return 'This build of Runova does not include the background service.';
    return null;
  }

  /** Runs the agent as administrator and returns its exit code, or the prompt's when declined. */
  function elevated(args: string[]): Promise<number> {
    if (deps.platform === 'darwin') return elevatedMac(args);
    if (deps.platform === 'linux') return elevatedLinux(args);
    return elevatedWindows(args);
  }

  async function elevatedMac(args: string[]): Promise<number> {
    const command = [exe, ...args].map(shellWord).join(' ');
    const script = [
      'try',
      `  do shell script ${appleScriptString(command)} with administrator privileges`,
      '  return "0"',
      'on error errorText number errorNumber',
      '  return errorNumber as text',
      'end try',
    ];
    const result = await deps.run(
      'osascript',
      script.flatMap((line) => ['-e', line]),
    );
    const code = Number.parseInt(result.stdout.trim().split(/\s+/).pop() ?? '', 10);
    return Number.isNaN(code) ? result.code : code;
  }

  /** An AppImage's files sit on a mount only this user can read, so root gets its own copy. */
  async function elevatedLinux(args: string[]): Promise<number> {
    const copy = await deps.copyExecutable(exe);
    try {
      return (await deps.run('pkexec', [copy, ...args])).code;
    } finally {
      await deps.removeFile(copy).catch(() => undefined);
    }
  }

  async function elevatedWindows(args: string[]): Promise<number> {
    const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const script = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      `  $p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${quoted} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
      '  Write-Output $p.ExitCode',
      `} catch { Write-Output ${CANCELLED.win32} }`,
    ].join('\n');
    const result = await deps.run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    const code = Number.parseInt(result.stdout.trim().split(/\s+/).pop() ?? '', 10);
    return Number.isNaN(code) ? result.code : code;
  }

  return {
    unavailable,

    async installed() {
      if (deps.platform === 'win32') {
        return (await deps.run('sc.exe', ['query', WINDOWS_SERVICE])).code === 0;
      }
      if (deps.platform === 'linux') {
        return (await deps.run('systemctl', ['is-enabled', LINUX_SERVICE])).code === 0;
      }
      return deps.platform === 'darwin' && deps.exists(MAC_PLIST);
    },

    async install(config) {
      const reason = unavailable();
      if (reason) throw new Error(reason);
      const file = await deps.writePrivateFile(JSON.stringify(config));
      const code = await elevated([
        'install',
        '--config',
        deps.platform === 'win32' ? `"${file}"` : file,
      ]);
      if (code !== 0) {
        await deps.removeFile(file).catch(() => undefined);
        throw new Error(
          code === CANCELLED[deps.platform]
            ? `${system} did not get permission to set up the background service.`
            : `The background service could not be set up (code ${code}).`,
        );
      }
    },

    async uninstall() {
      if (unavailable()) return;
      const code = await elevated(['uninstall']);
      if (code !== 0) {
        throw new Error(
          code === CANCELLED[deps.platform]
            ? `${system} did not get permission to remove the background service.`
            : `The background service could not be removed (code ${code}).`,
        );
      }
    },
  };
}
