import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

const remote = vi.hoisted(() => ({
  hosting: true,
  stopHost: vi.fn(),
}));

vi.mock('../../remote/manager', () => ({
  remoteManager: {
    getState: () => ({
      deviceName: 'DESKTOP-1',
      hosting: remote.hosting,
      hostIp: '192.168.1.5',
      hostPort: 7420,
      inputSupported: true,
      pairing: { code: 'PAIR-SECRET-CODE', qrDataUrl: 'data:image/png;base64,xx', expiresAt: 5000 },
      peers: remote.hosting
        ? [{ id: 'peer-1', deviceName: 'Laptop', address: '192.168.1.8', connectedAt: 1000 }]
        : [],
      connection: { status: 'idle', remoteDeviceName: null, remoteScreen: null, intent: null },
      interfaces: [{ name: 'Wi-Fi', address: '192.168.1.5' }],
    }),
    listSavedServers: async () => [
      {
        id: 'r1',
        nickname: 'Office PC',
        ip: '192.168.1.20',
        port: 7420,
        deviceName: 'OFFICE',
        deviceToken: 'DEVICE-TOKEN-SECRET',
        createdAt: 1,
        lastConnectedAt: 2000,
      },
    ],
    stopHost: remote.stopHost,
  },
}));

/** Remote control tools: what the Remote page shows, and stopping this computer's hosting. */

const userData = useTempUserData();
const context: ToolContext = { projectId: null, callerKind: 'external', agent: 'Codex', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  remote.hosting = true;
  remote.stopHost.mockClear();
  userData.writeData('rdp-servers.json', [
    {
      id: 'rdp-1',
      nickname: 'Build server',
      host: 'build.local',
      port: 3389,
      username: 'admin',
      domain: 'CORP',
      secretEnvelope: { iv: 'x', data: 'RDP-PASSWORD-CIPHER' },
      options: {},
      createdAt: 1,
      lastConnectedAt: null,
    },
  ]);
  const { remoteTools } = await import('./remote');
  tools = new Map(remoteTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('remote tools', () => {
  it('shows hosting and who is connected, without the pairing code', async () => {
    const data = (await run('remote_status')).data;
    expect(data).toMatchObject({
      deviceName: 'DESKTOP-1',
      hosting: true,
      hostAddress: '192.168.1.5:7420',
      pairingCodeActive: true,
      connectedDevices: [expect.objectContaining({ deviceName: 'Laptop' })],
      outgoing: { status: 'idle' },
    });
    expect(JSON.stringify(data)).not.toContain('PAIR-SECRET-CODE');
  });

  it('lists saved remote devices and Remote Desktop servers without tokens or passwords', async () => {
    const data = (await run('remote_list_devices')).data as {
      devices: unknown[];
      remoteDesktop: unknown[];
    };
    expect(data.devices).toEqual([
      expect.objectContaining({ id: 'r1', name: 'Office PC', address: '192.168.1.20:7420' }),
    ]);
    expect(data.remoteDesktop).toEqual([
      expect.objectContaining({ id: 'rdp-1', name: 'Build server', username: 'CORP\\admin' }),
    ]);
    const text = JSON.stringify(data);
    expect(text).not.toContain('DEVICE-TOKEN');
    expect(text).not.toContain('RDP-PASSWORD');
  });

  it('stops hosting, and says so when there was nothing to stop', async () => {
    const tool = tools.get('remote_stop_hosting') as AiTool;
    expect(tool.risk).toBe('sensitive');
    expect(await tool.preview({}, context)).toMatchObject({
      title: 'Stop letting other devices control this computer',
    });
    expect((await run('remote_stop_hosting')).text).toContain('1 device was disconnected');
    expect(remote.stopHost).toHaveBeenCalledTimes(1);

    remote.hosting = false;
    expect((await run('remote_stop_hosting')).text).toContain('was not hosting');
    expect(remote.stopHost).toHaveBeenCalledTimes(1);
  });
});
