import type { HealthCloudPlan } from '@shared/healthTypes';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CONSENT_TEXT } from './HealthCloudSection';
import { HealthTargetDialog } from './HealthTargetDialog';
import { environment, project, reveal, target } from './testing/fixtures';

/** "Where it runs" in the monitor dialog (E56): Runova Cloud, its limits and the consent for the key. */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

function plan(overrides: Partial<HealthCloudPlan> = {}): HealthCloudPlan {
  return {
    signedIn: true,
    scopeName: 'Personal',
    canWrite: true,
    accountTypeName: 'Go',
    maxMonitors: 10,
    active: 3,
    minIntervalSec: 300,
    blocked: null,
    action: null,
    telegramLinked: false,
    ...overrides,
  };
}

function bridge(cloudPlan: HealthCloudPlan = plan()) {
  return {
    'environments.list': async () => [environment()],
    'ssh.listServers': [],
    'deployWordPress.listSites': [],
    'health.create': async () => ({ target: target({ id: 'new-1' }), secret: reveal() }),
    'health.cloudPlan': async () => cloudPlan,
    'health.cloudEnable': async () => target({ id: 'new-1', runMode: 'cloud' }),
    'health.cloudDisable': async () => target(),
    'health.update': async () => target(),
    'account.signIn': async () => ({ state: 'signed-in' }),
    'account.openWebsite': async () => undefined,
    'dependencyAlerts.telegramConnect': async () => undefined,
  };
}

function open(editing?: ReturnType<typeof target>) {
  return (
    <HealthTargetDialog
      open
      onOpenChange={() => undefined}
      projects={[project()]}
      defaultProjectId="p1"
      target={editing}
    />
  );
}

async function fillBasics(
  user: ReturnType<typeof renderWithProviders>['user'],
  url = 'https://api.example.com/health',
) {
  await user.type(screen.getByLabelText('Name'), 'API');
  await user.clear(screen.getByLabelText('Endpoint URL'));
  await user.type(screen.getByLabelText('Endpoint URL'), url);
}

describe('Where it runs', () => {
  it('turns a new monitor online only after consent, at an interval the type allows', async () => {
    const { user, bridge: fake } = renderWithProviders(open(), { bridge: bridge() });
    await fillBasics(user);

    await user.click(screen.getByRole('button', { name: 'Runova Cloud' }));

    expect(await screen.findByText('Go · 3 of 10 online')).toBeInTheDocument();
    expect(screen.getByText(/checks every 5 min or slower/)).toBeInTheDocument();
    // Faster than the type allows is not offered, and the choice moved up to the floor.
    const every = screen.getByRole('group', { name: 'Check every' });
    expect(every).not.toHaveTextContent('1 min');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '5 min' })).toHaveAttribute('aria-pressed', 'true'),
    );

    await user.click(screen.getByRole('button', { name: 'Add target' }));
    expect(
      await screen.findByText('Agree to send the address and key to Runova Cloud first.'),
    ).toBeInTheDocument();
    expect(() => fake.$fn('health.create')).toThrow();

    await user.click(screen.getByRole('checkbox', { name: CONSENT_TEXT }));
    await user.click(screen.getByRole('switch', { name: 'Alerts on Telegram' }));
    expect(screen.getByRole('button', { name: 'Link Telegram' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add target' }));

    await waitFor(() =>
      expect(fake.$fn('health.cloudEnable')).toHaveBeenCalledWith('new-1', {
        consent: true,
        intervalSec: 300,
        notifyInApp: true,
        notifyTelegram: true,
      }),
    );
    expect(fake.$fn('health.create')).toHaveBeenCalledOnce();
  });

  it('says to sign in when signed out, and saves nothing', async () => {
    const signedOut = plan({
      signedIn: false,
      blocked: 'Sign in to your Runova account to check this monitor from Runova Cloud.',
      action: 'sign-in',
      accountTypeName: null,
    });
    const { user, bridge: fake } = renderWithProviders(open(), { bridge: bridge(signedOut) });
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Runova Cloud' }));

    expect(await screen.findByText(/Sign in to your Runova account/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(fake.$fn('account.signIn')).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Add target' }));
    expect(() => fake.$fn('health.create')).toThrow();
  });

  it('offers the account types when the limit is reached', async () => {
    const full = plan({
      active: 10,
      blocked:
        'Go allows 10 online monitors, and Personal has 10. Pause one, or choose a type with more.',
      action: 'upgrade',
    });
    const { user, bridge: fake } = renderWithProviders(open(), { bridge: bridge(full) });
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Runova Cloud' }));

    await user.click(await screen.findByRole('button', { name: 'See account types' }));

    expect(fake.$fn('account.openWebsite')).toHaveBeenCalledWith('/account/plan');
  });

  it('says an address on this computer can not be checked from the internet', async () => {
    const { user } = renderWithProviders(open(), { bridge: bridge() });
    await fillBasics(user, 'https://localhost:3000/health');

    await user.click(screen.getByRole('button', { name: 'Runova Cloud' }));

    expect(await screen.findByText(/This address is on this computer/)).toBeInTheDocument();
  });

  it('turns an online monitor back to this computer', async () => {
    const online = target({
      runMode: 'cloud',
      intervalSec: 300,
      cloud: {
        monitorId: 41,
        signedIn: true,
        region: 'eu-central',
        suspendedReason: null,
        notifyInApp: true,
        notifyTelegram: false,
        muted: false,
        canWrite: true,
        confirming: false,
      },
    });
    const { user, bridge: fake } = renderWithProviders(open(online), { bridge: bridge() });

    expect(screen.getByRole('button', { name: 'Runova Cloud' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Already online: no second consent, and mute is there.
    expect(await screen.findByRole('switch', { name: 'Mute for me' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: CONSENT_TEXT })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'This computer' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fake.$fn('health.cloudDisable')).toHaveBeenCalledWith('t1'));
    expect(fake.$fn('health.update')).toHaveBeenCalledOnce();
  });
});
