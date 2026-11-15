import type { EmailGateLookup } from '@shared/cloudflareTypes';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CORE_HOST, EMAIL_GATE_PLAN, SITE_HOST, ZONE } from '../testing/fixtures';

/**
 * The email code gate's shortcut on the core domain card and a site (E96): what the gate on that
 * one name is, a click to change it, and nothing at all when no connected zone holds the name.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { EmailGateShortcut } = await import('./EmailGateShortcut');

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function lookup(change: Partial<EmailGateLookup> = {}): EmailGateLookup {
  return { zone: ZONE, readiness: EMAIL_GATE_PLAN.readiness, host: CORE_HOST, ...change };
}

function renderShortcut(found: EmailGateLookup | null, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <EmailGateShortcut hostname="core.example.com" />
      <Where />
    </>,
    { bridge: { 'cloudflareEmailGate.find': async () => found, ...bridge } },
  );
}

describe('EmailGateShortcut', () => {
  it('shows nothing for a name no connected zone holds', async () => {
    const { bridge, container } = renderShortcut(null);
    await waitFor(() =>
      expect(bridge.$fn('cloudflareEmailGate.find')).toHaveBeenCalledWith('core.example.com'),
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('says the gate is on and opens it to change who gets in', async () => {
    const { user } = renderShortcut(lookup());

    await user.click(await screen.findByRole('button', { name: /Email code on/ }));

    expect(
      await screen.findByRole('dialog', { name: 'Email code for core.example.com' }),
    ).toBeTruthy();
  });

  it('offers to put the gate on a name that is open', async () => {
    const { user } = renderShortcut(lookup({ host: SITE_HOST }));

    await user.click(await screen.findByRole('button', { name: /Email code off/ }));

    expect(await screen.findByRole('dialog', { name: 'Ask for an email code' })).toBeTruthy();
  });

  it("sends the user to the zone's Access tab when the account is not set up yet", async () => {
    const { user } = renderShortcut(
      lookup({
        host: SITE_HOST,
        readiness: { organization: false, teamDomain: null, oneTimePin: false },
      }),
    );

    await user.click(await screen.findByRole('button', { name: /Email code off/ }));

    expect(screen.getByTestId('where').textContent).toBe(
      `/deploy?cloudflare=1&zone=${ZONE.id}&tab=access`,
    );
  });

  it('lets this computer through when the gate on the core domain stops it', async () => {
    const through = vi.fn(async () => undefined);
    const { user } = renderShortcut(lookup({ host: { ...CORE_HOST, thisComputerPass: false } }), {
      'cloudflareEmailGate.letThisComputerThrough': through,
    });

    await user.click(await screen.findByRole('button', { name: 'Let this computer through' }));

    await waitFor(() =>
      expect(through).toHaveBeenCalledWith({ zoneId: ZONE.id, hostname: 'core.example.com' }),
    );
  });
});
