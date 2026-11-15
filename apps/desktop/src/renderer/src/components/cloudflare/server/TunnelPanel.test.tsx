import type { CloudflareTunnelPlan } from '@shared/cloudflareTypes';
import type {
  CloudflareTunnelStatus,
  FirewallChangeSetInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

/**
 * E95 in the Firewall section: the tunnel's state in one line with the facts that matter, a
 * setup that shows each name's fate and runs its steps in order before handing the firewall
 * change to the countdown, SSH choices that need a passing test over their route (and an Owner
 * for Closed), break-glass for Owners, and turning off with the ports' fate chosen.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { TunnelPanel } = await import('./TunnelPanel');

const ACCOUNT = '699d98642c564d2e855e9661899b7252';

const OFF: CloudflareTunnelStatus = {
  enabled: false,
  state: 'off',
  sshMode: 'open',
  webPorts: [80, 443],
  sshPorts: [22],
  openRules: [],
  warnings: [],
  connections: 0,
  cloudflaredInstalled: false,
  breakGlassEnabled: false,
  breakGlassDelayMinutes: 30,
  breakGlassOpen: false,
};

const CONNECTED: CloudflareTunnelStatus = {
  ...OFF,
  enabled: true,
  state: 'connected',
  connections: 4,
  cloudflaredInstalled: true,
  tunnelId: '6ff42ae2-765d-4adf-8112-31c55c1551ef',
  tunnelName: 'runova-production',
  accountTag: ACCOUNT,
  sshHostname: 'ssh-production.example.com',
  tunnelPort: 18080,
  cloudflaredVersion: '2025.10.1',
};

const CHANGE: FirewallChangeSetInfo = {
  id: '00000000-0000-4000-9000-000000000007',
  state: 'awaitingConfirmation',
  backend: 'ufw',
  summary: 'remove Allow 80/tcp',
  commands: ['ufw delete allow 80/tcp', 'ufw delete allow 443/tcp'],
  createdAtUnixMs: Date.now(),
  guardOverridden: false,
};

const PLAN: CloudflareTunnelPlan = {
  status: OFF,
  accounts: [{ cloudflareAccountId: ACCOUNT, label: 'Work', domains: ['blog.example.com'] }],
  domains: [
    {
      domain: 'blog.example.com',
      role: 'site',
      zoneId: 'z'.repeat(32),
      zoneName: 'example.com',
      cloudflareAccountId: ACCOUNT,
      routed: false,
    },
    {
      domain: 'shop.example.net',
      role: 'site',
      zoneId: null,
      zoneName: null,
      cloudflareAccountId: null,
      routed: false,
    },
  ],
  coreDomain: null,
  ports: {
    changes: [{ kind: 'removeRule', ruleId: 'r80' }],
    notes: [],
    firewall: {
      summary: CHANGE.summary,
      commands: CHANGE.commands,
      notes: [],
      resultingRules: [],
      resultingActive: true,
      resultingDefaultIncoming: 'deny',
      guard: { blocked: false, reasons: [], checked: [] },
      needsStepUp: false,
      confirmWithinSeconds: 60,
    },
  },
  suggestedSshHostname: 'ssh-production.example.com',
  blocker: null,
};

function render(
  bridge: Record<string, unknown>,
  roles: { canAdmin?: boolean; canOwn?: boolean } = {},
) {
  const onApplied = vi.fn();
  const view = renderWithProviders(
    <TunnelPanel
      serverId="srv-1"
      serverName="Production"
      signedIn
      canAdmin={roles.canAdmin ?? true}
      canOwn={roles.canOwn ?? false}
      busy={false}
      originLocked={false}
      onApplied={onApplied}
    />,
    { bridge },
  );
  return { ...view, onApplied };
}

describe('TunnelPanel', () => {
  it('says what the tunnel does while it is off, and Viewers get no buttons', async () => {
    render({ 'cloudflareTunnel.status': async () => OFF }, { canAdmin: false });

    expect(await screen.findByText('Off: no tunnel on this server')).toBeTruthy();
    expect(screen.getByText(/ports 80 and 443 close to everyone/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up tunnel' })).toBeNull();
  });

  it('shows a connected tunnel with its facts and the next steps', async () => {
    render({ 'cloudflareTunnel.status': async () => CONNECTED });

    expect(
      await screen.findByText('On: no open web ports, everything comes through the tunnel'),
    ).toBeTruthy();
    expect(screen.getByText('runova-production')).toBeTruthy();
    expect(screen.getByText('Open as the firewall has it')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change SSH access' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up tunnel' })).toBeNull();
  });

  it('sets up in order: tunnel, connection, names, then the ports for the countdown', async () => {
    let status = OFF;
    const { user, bridge, onApplied } = render({
      'cloudflareTunnel.status': async () => status,
      'cloudflareTunnel.plan': async () => PLAN,
      'cloudflareTunnel.setUp': async () => {
        status = { ...CONNECTED, state: 'portsOpen' };
        return {
          id: 'job',
          kind: 'cloudflareTunnelSetup',
          title: 'Set up',
          state: 'running',
          createdAtUnixMs: 0,
          logLines: 0,
          cancellable: false,
        };
      },
      'cloudflareTunnel.route': async () => ({
        routed: ['blog.example.com', 'ssh-production.example.com'],
        skipped: ['shop.example.net'],
      }),
      'cloudflareTunnel.closePorts': async () => ({
        status: { ...CONNECTED, state: 'pending' },
        changeSet: CHANGE,
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Set up tunnel' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Put Production behind a Cloudflare Tunnel',
    });
    expect(await within(dialog).findByText('Will go through the tunnel')).toBeTruthy();
    expect(
      within(dialog).getByText('Not in a connected Cloudflare account: stops answering'),
    ).toBeTruthy();
    expect(within(dialog).getByText(CHANGE.commands[0] as string, { exact: false })).toBeTruthy();
    const start = within(dialog).getByRole('button', { name: 'Set up tunnel' });
    expect(start).toHaveProperty('disabled', true);

    await user.click(within(dialog).getByRole('checkbox', { name: /stops answering/ }));
    await user.click(start);

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(CHANGE));
    expect(bridge.$fn('cloudflareTunnel.setUp')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      cloudflareAccountId: ACCOUNT,
      sshHostname: 'ssh-production.example.com',
    });
    expect(bridge.$fn('cloudflareTunnel.route')).toHaveBeenCalledWith('srv-1');
    expect(bridge.$fn('cloudflareTunnel.closePorts')).toHaveBeenCalledWith('srv-1');
  });

  it('stops at the step that failed and says why, leaving the ports alone', async () => {
    const closePorts = vi.fn();
    const { user } = render({
      'cloudflareTunnel.status': async () => OFF,
      'cloudflareTunnel.plan': async () => ({ ...PLAN, domains: PLAN.domains.slice(0, 1) }),
      'cloudflareTunnel.setUp': async () => {
        throw new Error("Error invoking remote method 'x': Error: nginx is not running here.");
      },
      'cloudflareTunnel.closePorts': closePorts,
    });

    await user.click(await screen.findByRole('button', { name: 'Set up tunnel' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Set up tunnel' }));

    expect(await within(dialog).findByText(/nginx is not running here/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(closePorts).not.toHaveBeenCalled();
  });

  it('applies Cloudflare only SSH only after a test through the tunnel got in', async () => {
    const probe = vi.fn(async () => ({
      ok: true,
      client: '127.0.0.1',
      message: 'SSH gets in through the tunnel.',
    }));
    const { user, bridge, onApplied } = render({
      'cloudflareTunnel.status': async () => CONNECTED,
      'cloudflareTunnel.previewSsh': async () => PLAN.ports,
      'cloudflareTunnel.probeSsh': probe,
      'cloudflareTunnel.applySsh': async () => ({ status: CONNECTED, changeSet: CHANGE }),
    });

    await user.click(await screen.findByRole('button', { name: 'Change SSH access' }));
    const dialog = await screen.findByRole('dialog', { name: 'Who may open SSH' });
    await user.click(within(dialog).getByRole('radio', { name: /Cloudflare only/ }));
    const apply = within(dialog).getByRole('button', { name: 'Apply' });
    expect(apply).toHaveProperty('disabled', true);

    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText('SSH gets in through the tunnel.')).toBeTruthy();
    await user.click(apply);

    expect(probe).toHaveBeenCalledWith('srv-1', 'cloudflare');
    expect(bridge.$fn('cloudflareTunnel.applySsh')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      mode: 'cloudflare',
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(CHANGE));
  });

  it('keeps Closed for Owners, with the phrase and the password', async () => {
    const preview = {
      ...PLAN.ports,
      firewall: {
        ...PLAN.ports.firewall!,
        guard: {
          blocked: true,
          reasons: ['No SSH remains.'],
          checked: [],
          confirmationPhrase: 'apply without the ssh check',
        },
      },
    };
    const admin = render({
      'cloudflareTunnel.status': async () => CONNECTED,
      'cloudflareTunnel.previewSsh': async () => preview,
    });
    await admin.user.click(await screen.findByRole('button', { name: 'Change SSH access' }));
    const closed = within(await screen.findByRole('dialog')).getByRole('radio', {
      name: /Closed to everyone/,
    });
    expect(closed).toHaveProperty('disabled', true);
    expect(within(closed).getByText('Only an Owner can close SSH to everyone.')).toBeTruthy();
    admin.unmount();

    const owner = render(
      {
        'cloudflareTunnel.status': async () => CONNECTED,
        'cloudflareTunnel.previewSsh': async () => preview,
        'cloudflareTunnel.applySsh': async () => ({ status: CONNECTED, changeSet: CHANGE }),
      },
      { canOwn: true },
    );
    await owner.user.click(await screen.findByRole('button', { name: 'Change SSH access' }));
    const dialog = await screen.findByRole('dialog');
    await owner.user.click(within(dialog).getByRole('radio', { name: /Closed to everyone/ }));
    await owner.user.type(
      await within(dialog).findByLabelText(/Type/),
      'apply without the ssh check',
    );
    await owner.user.type(within(dialog).getByLabelText('Your password on the server core'), 'pw');
    await owner.user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    expect(owner.bridge.$fn('cloudflareTunnel.applySsh')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      mode: 'closed',
      overrideConfirmation: 'apply without the ssh check',
      password: 'pw',
    });
  });

  it('lets an Owner turn break-glass on, with the delay', async () => {
    const { user, bridge } = render(
      {
        'cloudflareTunnel.status': async () => CONNECTED,
        'cloudflareTunnel.breakGlass': async () => ({ ...CONNECTED, breakGlassEnabled: true }),
      },
      { canOwn: true },
    );

    await user.click(
      await screen.findByRole('switch', { name: 'Reopen SSH if the tunnel stays down' }),
    );

    expect(bridge.$fn('cloudflareTunnel.breakGlass')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      enabled: true,
      delayMinutes: 30,
    });
    expect(await screen.findByText(/After 30 minutes down/)).toBeTruthy();
  });

  it('turns off keeping the ports closed for the IP lock when asked', async () => {
    const { user, bridge, onApplied } = render({
      'cloudflareTunnel.status': async () => CONNECTED,
      'cloudflareTunnel.previewOff': async () => PLAN.ports,
      'cloudflareTunnel.turnOff': async () => ({
        status: { ...CONNECTED, state: 'pending' },
        changeSet: CHANGE,
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn the tunnel off on Production' });
    await user.click(within(dialog).getByRole('radio', { name: 'Keep closed for the IP lock' }));
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));

    expect(bridge.$fn('cloudflareTunnel.turnOff')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      reopenWeb: false,
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(CHANGE));
  });
});
