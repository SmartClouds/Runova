import { z } from 'zod';
import { remoteManager } from '../../remote/manager';
import { store } from '../../store';
import { defineTool } from '../registry';
import { plural } from './shared';

/**
 * Remote control tools: what the Remote page shows about this computer (hosting, who is connected,
 * the outgoing session) and the devices and Remote Desktop servers saved there. Pairing codes,
 * device tokens and passwords are never handed out. The one change on offer is stopping hosting,
 * which cuts off everyone controlling this computer, so it is sensitive.
 */

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export const remoteTools = [
  defineTool({
    name: 'remote_status',
    area: 'remote',
    title: 'Show remote control status',
    description:
      'Whether this computer is hosting remote control, which devices are connected to it, and the state of its own outgoing remote session. The pairing code is not included.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'Show the remote control status' }),
    async run() {
      const state = remoteManager.getState();
      return {
        data: {
          deviceName: state.deviceName,
          hosting: state.hosting,
          hostAddress: state.hosting && state.hostIp ? `${state.hostIp}:${state.hostPort}` : null,
          inputSupported: state.inputSupported,
          pairingCodeActive: state.pairing !== null,
          pairingCodeExpiresAt: state.pairing ? iso(state.pairing.expiresAt) : null,
          connectedDevices: state.peers.map((peer) => ({
            deviceName: peer.deviceName,
            address: peer.address,
            connectedAt: iso(peer.connectedAt),
          })),
          outgoing: {
            status: state.connection.status,
            remoteDeviceName: state.connection.remoteDeviceName,
            intent: state.connection.intent,
            error: state.connection.error ?? null,
          },
        },
      };
    },
  }),

  defineTool({
    name: 'remote_list_devices',
    area: 'remote',
    title: 'List saved remote devices',
    description:
      'The remote control devices and Remote Desktop servers saved on the Remote page, with their address and when they were last used. No tokens or passwords are included.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List the saved remote devices' }),
    async run() {
      const [devices, rdp] = await Promise.all([
        remoteManager.listSavedServers(),
        store.getRdpServers(),
      ]);
      return {
        data: {
          devices: devices.map((device) => ({
            id: device.id,
            name: device.nickname,
            deviceName: device.deviceName,
            address: `${device.ip}:${device.port}`,
            lastConnectedAt: iso(device.lastConnectedAt),
          })),
          remoteDesktop: rdp.map((server) => ({
            id: server.id,
            name: server.nickname,
            address: `${server.host}:${server.port}`,
            username: server.domain ? `${server.domain}\\${server.username}` : server.username,
            hasSavedPassword: server.secretEnvelope != null,
            lastConnectedAt: iso(server.lastConnectedAt),
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'remote_stop_hosting',
    area: 'remote',
    title: 'Stop hosting remote control',
    description:
      'Stops this computer from accepting remote control and disconnects every device controlling it now, as the Stop button on the Remote page does.',
    risk: 'sensitive',
    input: z.object({}),
    preview() {
      const state = remoteManager.getState();
      return {
        title: 'Stop letting other devices control this computer',
        summary: state.hosting
          ? `${plural(state.peers.length, 'device')} connected now will be disconnected.`
          : 'This computer is not hosting right now.',
      };
    },
    async run() {
      const state = remoteManager.getState();
      if (!state.hosting) return { text: 'This computer was not hosting remote control.' };
      remoteManager.stopHost();
      const count = state.peers.length;
      return {
        text: `Stopped hosting remote control. ${plural(count, 'device')} ${count === 1 ? 'was' : 'were'} disconnected.`,
      };
    },
  }),
];
