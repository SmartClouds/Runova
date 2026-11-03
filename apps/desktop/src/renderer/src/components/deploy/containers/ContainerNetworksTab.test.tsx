import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { dockerBridge, SERVER, seededDocker, T0 } from './testing/fixtures';

/**
 * The drawer's Networks tab: every network a container is on with its addresses there, a picker
 * to join another one, and leaving one after a confirmation. Viewers only read.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { ContainersPanel } = await import('./ContainersPanel');

async function openNetworks(name: string, bridge: Record<string, unknown> = {}, roles?: string[]) {
  const view = renderWithProviders(
    <>
      <ContainersPanel server={SERVER} />
      <ConfirmDialogHost />
    </>,
    { bridge: { ...dockerBridge(roles), ...bridge } },
  );
  // The first render of a file pays for loading the screen; give it time on a busy machine.
  const list = await screen.findByRole('list', { name: 'Containers' }, { timeout: 10_000 });
  await view.user.click(within(list).getByRole('button', { name: `Open ${name}` }));
  const drawer = await screen.findByRole('dialog', { name }, { timeout: 10_000 });
  await view.user.click(within(drawer).getByRole('tab', { name: 'Networks' }));
  const panel = within(drawer).getByRole('tabpanel');
  return { ...view, drawer, panel };
}

describe('the Networks tab', () => {
  it('shows each network with its addresses, gateway and the names it answers to', async () => {
    const { panel } = await openNetworks('shop-api-1');
    const row = await within(panel).findByRole('listitem', { name: 'shop_default' });
    expect(within(row).getByText('172.20.0.5')).toBeInTheDocument();
    expect(within(row).getByText('172.20.0.1')).toBeInTheDocument();
    expect(within(row).getByText('02:42:ac:14:00:05')).toBeInTheDocument();
    expect(within(row).getByText('shop-api-1, api')).toBeInTheDocument();
    expect(within(row).getByText('Project shop')).toBeInTheDocument();
  });

  it('offers only networks the container can join, and joins one', async () => {
    const { user, bridge, panel } = await openNetworks('shop-api-1');
    await user.click(await within(panel).findByRole('combobox', { name: 'Network to join' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['bridge172.17.0.0/16']);

    await user.click(screen.getByRole('option', { name: /bridge/ }));
    await user.click(within(panel).getByRole('button', { name: 'Join network' }));

    await waitFor(() =>
      expect(bridge.$fn('deployDocker.joinNetwork')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        container: 'shop-api-1',
        network: 'bridge',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('shop-api-1 joined bridge.');
    const row = await within(panel).findByRole('listitem', { name: 'bridge' });
    expect(within(row).getByText('172.17.0.9')).toBeInTheDocument();
  });

  it('asks before leaving a network, and says when it is the last one', async () => {
    const { user, bridge, panel } = await openNetworks('shop-api-1');
    const row = await within(panel).findByRole('listitem', { name: 'shop_default' });
    await user.click(within(row).getByRole('button', { name: 'Leave shop_default' }));

    const confirm = await screen.findByRole('dialog', {
      name: 'Take shop-api-1 off shop_default?',
    });
    expect(within(confirm).getByText(/no other network/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Leave the network' }));

    await waitFor(() =>
      expect(bridge.$fn('deployDocker.leaveNetwork')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        container: 'shop-api-1',
        network: 'shop_default',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('shop-api-1 left shop_default.');
    expect(await within(panel).findByText('This container is on no network.')).toBeInTheDocument();
  });

  it('keeps the network when the confirmation is turned down', async () => {
    const leave = vi.fn(async () => undefined);
    const { user, panel } = await openNetworks('shop-api-1', {
      'deployDocker.leaveNetwork': leave,
    });
    const row = await within(panel).findByRole('listitem', { name: 'shop_default' });
    await user.click(within(row).getByRole('button', { name: 'Leave shop_default' }));
    const confirm = await screen.findByRole('dialog', {
      name: 'Take shop-api-1 off shop_default?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Take shop-api-1/ })).toBeNull(),
    );
    expect(leave).not.toHaveBeenCalled();
    expect(within(panel).getByRole('listitem', { name: 'shop_default' })).toBeInTheDocument();
  });

  it('says what the core said when a join fails', async () => {
    const { user, panel } = await openNetworks('shop-api-1', {
      'deployDocker.joinNetwork': async () => {
        throw new Error(
          "Error invoking remote method 'deployDocker:joinNetwork': Error: network bridge not found",
        );
      },
    });
    await user.click(await within(panel).findByRole('combobox', { name: 'Network to join' }));
    await user.click(await screen.findByRole('option', { name: /bridge/ }));
    await user.click(within(panel).getByRole('button', { name: 'Join network' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network bridge not found'));
  });

  it('notes that compose puts its own networks back, only for a compose container', async () => {
    const compose = await openNetworks('shop-api-1');
    expect(await within(compose.panel).findByText(/compose file/)).toBeInTheDocument();
    compose.unmount();

    const { panel } = await openNetworks('toolbox');
    await within(panel).findByRole('listitem', { name: 'bridge' });
    expect(within(panel).queryByText(/compose file/)).toBeNull();
  });

  it('reads the container again when the engine says something joined or left a network', async () => {
    const { bridge, panel } = await openNetworks('shop-api-1');
    await within(panel).findByRole('listitem', { name: 'shop_default' });
    await waitFor(() => expect(bridge.$listenerCount('deployDocker.onEvents')).toBe(1));
    const reads = bridge.$fn('deployDocker.inspect').mock.calls.length;
    act(() =>
      bridge.$emit('deployDocker.onEvents', {
        subscriptionId: 'events-1',
        serverId: SERVER.id,
        events: [{ type: 'network', action: 'connect', actorId: 'net', atUnixMs: T0, cursor: '9' }],
      }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployDocker.inspect').mock.calls.length).toBeGreaterThan(reads),
    );
  });

  it('lets a Viewer read the networks without changing them', async () => {
    const { panel } = await openNetworks('shop-api-1', {}, ['viewer']);
    const row = await within(panel).findByRole('listitem', { name: 'shop_default' });
    expect(within(row).queryByRole('button', { name: /Leave/ })).toBeNull();
    expect(within(panel).queryByRole('combobox', { name: 'Network to join' })).toBeNull();
  });

  it("explains that a container on the server's own network cannot join others", async () => {
    const docker = seededDocker();
    const toolbox = docker.require('toolbox');
    toolbox.details.networks = [{ network: 'host' }];
    const { panel } = await openNetworks('toolbox', {
      'deployDocker.inspect': async () => docker.details(toolbox),
    });
    expect(await within(panel).findByText(/shares the server's own network/)).toBeInTheDocument();
    expect(within(panel).queryByRole('combobox', { name: 'Network to join' })).toBeNull();
  });
});
