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
  options: {
    platform?: string;
    exe?: boolean;
    plist?: boolean;
    queryCode?: number;
    elevatedCode?: number;
  } = {},
) {
  const runs: { command: string; args: string[] }[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const copied: string[] = [];
  const installer = createAgentInstaller({
    platform: options.platform ?? 'win32',
    resourcesPath: 'C:\\Program Files\\Runova\\resources',
    exists: (path) => (path.endsWith('.plist') ? (options.plist ?? false) : (options.exe ?? true)),
    run: async (command, args) => {
      runs.push({ command, args });
      if (command === 'sc.exe' || command === 'systemctl') {
        return { code: options.queryCode ?? 1060, stdout: '' };
      }
      if (command === 'pkexec') return { code: options.elevatedCode ?? 0, stdout: '' };
      return { code: 0, stdout: String(options.elevatedCode ?? 0) };
    },
    writePrivateFile: async (content) => {
      written.push(content);
      return 'C:\\Users\\sam\\AppData\\Roaming\\Runova\\agent-config.json';
    },
    removeFile: async (path) => {
      removed.push(path);
    },
    copyExecutable: async (path) => {
      copied.push(path);
      return '/home/sam/.config/Runova/agent-setup/RunovaAgent';
    },
  });
  return { installer, runs, written, removed, copied };
}

describe('the background agent installer', () => {
  it('is there on Windows, macOS and Linux when this build carries the agent', () => {
    expect(fake().installer.unavailable()).toBeNull();
    expect(fake({ platform: 'darwin' }).installer.unavailable()).toBeNull();
    expect(fake({ platform: 'linux' }).installer.unavailable()).toBeNull();
    expect(fake({ platform: 'freebsd' }).installer.unavailable()).toMatch(/not available/);
    expect(fake({ exe: false }).installer.unavailable()).toMatch(/does not include/);
  });

  it('asks Windows whether the service exists', async () => {
    expect(await fake({ queryCode: 0 }).installer.installed()).toBe(true);
    expect(await fake({ queryCode: 1060 }).installer.installed()).toBe(false);
  });

  it('asks each system in its own way whether the service is set up', async () => {
    expect(await fake({ platform: 'linux', queryCode: 0 }).installer.installed()).toBe(true);
    expect(await fake({ platform: 'linux', queryCode: 1 }).installer.installed()).toBe(false);
    expect(await fake({ platform: 'darwin', plist: true }).installer.installed()).toBe(true);
    expect(await fake({ platform: 'darwin', plist: false }).installer.installed()).toBe(false);
    expect(await fake({ platform: 'freebsd' }).installer.installed()).toBe(false);
  });

  it('on Linux asks through polkit, running a copy root can reach, then removes the copy', async () => {
    const { installer, runs, copied, removed } = fake({ platform: 'linux' });

    await installer.install(config);

    const elevated = runs.find((r) => r.command === 'pkexec');
    expect(elevated?.args[0]).toBe('/home/sam/.config/Runova/agent-setup/RunovaAgent');
    expect(elevated?.args.slice(1, 3)).toEqual(['install', '--config']);
    expect(copied[0]).toMatch(/remote-agent.RunovaAgent$/);
    expect(removed).toContain('/home/sam/.config/Runova/agent-setup/RunovaAgent');
  });

  it('on Linux says so when the person dismisses the polkit prompt', async () => {
    const { installer, removed } = fake({ platform: 'linux', elevatedCode: 126 });

    await expect(installer.install(config)).rejects.toThrow(/did not get permission/);
    expect(removed).toContain('C:\\Users\\sam\\AppData\\Roaming\\Runova\\agent-config.json');
  });

  it('on macOS asks through an administrator prompt with the paths quoted', async () => {
    const { installer, runs } = fake({ platform: 'darwin' });

    await installer.install(config);

    const elevated = runs.find((r) => r.command === 'osascript');
    const script = elevated?.args.join(' ') ?? '';
    expect(script).toContain('with administrator privileges');
    expect(script).toContain('RunovaAgent');
    expect(script).toContain("'install' '--config'");
  });

  it('on macOS says so when the person cancels the prompt', async () => {
    const { installer } = fake({ platform: 'darwin', elevatedCode: -128 });

    await expect(installer.install(config)).rejects.toThrow(/did not get permission/);
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
