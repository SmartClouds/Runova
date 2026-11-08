import { describe, expect, it } from 'vitest';
import { type AgentConfigFile, createAgentInstaller } from './agentInstaller';

const config: AgentConfigFile = {
  siteUrl: 'https://runovahq.com',
  remoteId: '482193775',
  deviceId: 7,
  deviceName: 'SAM-DESK',
  identitySeed: 'seed',
  agentSecret: 'ras1.secret',
  passwordSecret: null,
  allowOwnDevices: true,
  alwaysAllow: [4],
  defaultPermissions: { control: true, clipboard: true, files: false },
};

function fake(
  options: { platform?: string; exe?: boolean; queryCode?: number; elevatedCode?: number } = {},
) {
  const runs: { command: string; args: string[] }[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const installer = createAgentInstaller({
    platform: options.platform ?? 'win32',
    resourcesPath: 'C:\\Program Files\\Runova\\resources',
    exists: () => options.exe ?? true,
    run: async (command, args) => {
      runs.push({ command, args });
      if (command === 'sc.exe') return { code: options.queryCode ?? 1060, stdout: '' };
      return { code: 0, stdout: String(options.elevatedCode ?? 0) };
    },
    writePrivateFile: async (content) => {
      written.push(content);
      return 'C:\\Users\\sam\\AppData\\Roaming\\Runova\\agent-config.json';
    },
    removeFile: async (path) => {
      removed.push(path);
    },
  });
  return { installer, runs, written, removed };
}

describe('the background agent installer', () => {
  it('is for Windows, and only when this build carries the agent', () => {
    expect(fake().installer.unavailable()).toBeNull();
    expect(fake({ platform: 'darwin' }).installer.unavailable()).toMatch(/Windows/);
    expect(fake({ exe: false }).installer.unavailable()).toMatch(/does not include/);
  });

  it('asks Windows whether the service exists', async () => {
    expect(await fake({ queryCode: 0 }).installer.installed()).toBe(true);
    expect(await fake({ queryCode: 1060 }).installer.installed()).toBe(false);
    expect(await fake({ platform: 'linux' }).installer.installed()).toBe(false);
  });

  it('hands over the config in a private file and installs as administrator', async () => {
    const { installer, runs, written } = fake();

    await installer.install(config);

    expect(JSON.parse(written[0])).toEqual(config);
    const elevated = runs.find((r) => r.command === 'powershell.exe');
    expect(elevated?.args.join(' ')).toContain('-Verb RunAs');
    expect(elevated?.args.join(' ')).toContain('RunovaAgent.exe');
    expect(elevated?.args.join(' ')).toContain("'install','--config'");
    expect(elevated?.args.join(' ')).toContain('agent-config.json');
  });

  it('removes the private file and says so when Windows was not allowed to go on', async () => {
    const { installer, removed } = fake({ elevatedCode: 1223 });

    await expect(installer.install(config)).rejects.toThrow(/permission/);
    expect(removed).toEqual(['C:\\Users\\sam\\AppData\\Roaming\\Runova\\agent-config.json']);
  });

  it('uninstalls as administrator', async () => {
    const { installer, runs } = fake();

    await installer.uninstall();

    expect(runs.find((r) => r.command === 'powershell.exe')?.args.join(' ')).toContain(
      "'uninstall'",
    );
  });
});
