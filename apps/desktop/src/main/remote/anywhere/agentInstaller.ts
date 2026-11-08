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

/** Windows's "the operation was canceled by the user", when the UAC prompt is declined. */
const ERROR_CANCELLED = 1223;
const SERVICE_NAME = 'RunovaAnywhereAgent';

/**
 * Installs and removes the Runova Anywhere agent (E64), the background service that keeps this
 * computer reachable while no one is signed in. Windows asks the person for administrator
 * permission each time. The config, with the agent's secret, goes in a file only this user can
 * read; the agent's installer seals it to the machine and deletes it.
 */
export function createAgentInstaller(deps: {
  platform: string;
  resourcesPath: string;
  exists(path: string): boolean;
  run(command: string, args: string[]): Promise<{ code: number; stdout: string }>;
  writePrivateFile(content: string): Promise<string>;
  removeFile(path: string): Promise<void>;
}): AgentInstaller {
  const exe = join(deps.resourcesPath, 'remote-agent', 'RunovaAgent.exe');

  function unavailable(): string | null {
    if (deps.platform !== 'win32') return 'The background service is available on Windows for now.';
    if (!deps.exists(exe)) return 'This build of Runova does not include the background service.';
    return null;
  }

  /** Runs the agent elevated and returns its exit code, or ERROR_CANCELLED when UAC was declined. */
  async function elevated(args: string[]): Promise<number> {
    const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const script = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      `  $p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${quoted} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
      '  Write-Output $p.ExitCode',
      `} catch { Write-Output ${ERROR_CANCELLED} }`,
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
      if (deps.platform !== 'win32') return false;
      return (await deps.run('sc.exe', ['query', SERVICE_NAME])).code === 0;
    },

    async install(config) {
      const reason = unavailable();
      if (reason) throw new Error(reason);
      const file = await deps.writePrivateFile(JSON.stringify(config));
      const code = await elevated(['install', '--config', `"${file}"`]);
      if (code !== 0) {
        await deps.removeFile(file).catch(() => undefined);
        throw new Error(
          code === ERROR_CANCELLED
            ? 'Windows did not get permission to set up the background service.'
            : `The background service could not be set up (code ${code}).`,
        );
      }
    },

    async uninstall() {
      if (unavailable()) return;
      const code = await elevated(['uninstall']);
      if (code !== 0) {
        throw new Error(
          code === ERROR_CANCELLED
            ? 'Windows did not get permission to remove the background service.'
            : `The background service could not be removed (code ${code}).`,
        );
      }
    },
  };
}
