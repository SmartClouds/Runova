import type { CloudflareCustomRule } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { deferred, IP_LOCK_RULE, ipcError, ZONE } from '../testing/fixtures';

/**
 * The Access tab's IP limits (E97): every custom rule that is an IP limit, in words, with its
 * addresses, a switch, a pencil and a delete. Other custom rules stay on the Security tab.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { IpLockCard } = await import('./IpLockCard');

const OTHER_RULE: CloudflareCustomRule = {
  id: '3a03d665bac047339bb530ecb439a90d',
  description: 'Block Tor exit nodes',
  expression: '(ip.src.country in {"T1"})',
  action: 'block',
  enabled: true,
  lastUpdated: '2024-06-01T12:00:00Z',
};

const WHOLE_ZONE: CloudflareCustomRule = {
  ...IP_LOCK_RULE,
  id: 'f'.repeat(32),
  description: 'Only listed IPs, every name',
  expression:
    '(not starts_with(http.request.uri.path, "/.well-known/acme-challenge/") and not ip.src in {198.51.100.1 198.51.100.2 198.51.100.3 198.51.100.4 198.51.100.5})',
  enabled: false,
};

function renderCard(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <IpLockCard zone={ZONE} />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'cloudflare.listCustomRules': async () => [OTHER_RULE, IP_LOCK_RULE, WHOLE_ZONE],
        'cloudflare.listRecords': async () => [],
        'ipGeo.lookup': async () => ({ ip: '203.0.113.10', country: 'X', countryCode: 'XX' }),
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('IpLockCard', () => {
  it('shows a placeholder while the rules load', () => {
    const { container } = renderCard({
      'cloudflare.listCustomRules': () => deferred<CloudflareCustomRule[]>().promise,
    });
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('lists only the IP limits, each with what it covers and who gets in', async () => {
    renderCard();
    const list = await screen.findByRole('list', { name: 'IP limits in example.com' });
    const items = within(list).getAllByRole('listitem', { name: /./ });
    expect(items).toHaveLength(2);
    expect(screen.queryByText('Block Tor exit nodes')).toBeNull();

    const admin = screen.getByRole('listitem', { name: 'app.example.com/admin and below' });
    expect(within(admin).getByText('203.0.113.10')).toBeInTheDocument();
    expect(within(admin).getByText('198.51.100.0/24')).toBeInTheDocument();
    expect(within(admin).getByText('On')).toBeInTheDocument();

    const zone = screen.getByRole('listitem', { name: 'every name in example.com' });
    expect(within(zone).getByText('198.51.100.1')).toBeInTheDocument();
    expect(within(zone).getByText('+2 more')).toBeInTheDocument();
    expect(within(zone).getByText('Off')).toBeInTheDocument();
  });

  it('explains what a limit is when there are none', async () => {
    renderCard({ 'cloudflare.listCustomRules': async () => [OTHER_RULE] });
    expect(await screen.findByText('No IP limits yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add IP limit' })).toBeEnabled();
  });

  it('says what went wrong, with a way to try again', async () => {
    renderCard({
      'cloudflare.listCustomRules': async () => {
        throw ipcError('listCustomRules', 'This token is not allowed to change WAF custom rules.');
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('WAF custom rules');
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('switches a limit off without losing it', async () => {
    const setCustomRuleEnabled = vi.fn(async () => [{ ...IP_LOCK_RULE, enabled: false }]);
    renderCard({ 'cloudflare.setCustomRuleEnabled': setCustomRuleEnabled });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('switch', { name: 'IP limit for app.example.com/admin and below' }),
    );

    expect(setCustomRuleEnabled).toHaveBeenCalledWith(ZONE.id, IP_LOCK_RULE.id, false);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'app.example.com/admin and below is open to every address again.',
      ),
    );
  });

  it('deletes a limit once confirmed', async () => {
    const deleteCustomRule = vi.fn(async () => [OTHER_RULE]);
    renderCard({ 'cloudflare.deleteCustomRule': deleteCustomRule });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', {
        name: 'Delete IP limit for app.example.com/admin and below',
      }),
    );
    const confirm = await screen.findByRole('dialog', { name: /Delete the IP limit/ });
    await user.click(within(confirm).getByRole('button', { name: 'Delete limit' }));

    expect(deleteCustomRule).toHaveBeenCalledWith(ZONE.id, IP_LOCK_RULE.id);
    expect(await screen.findByText('No IP limits yet')).toBeInTheDocument();
  });

  it('opens a limit to change it, filled in', async () => {
    renderCard();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit IP limit for app.example.com/admin and below',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change the IP limit' });
    expect(within(dialog).getByRole('list', { name: 'Listed addresses' })).toHaveTextContent(
      '198.51.100.0/24',
    );
    expect(within(dialog).getByLabelText('Path')).toHaveValue('/admin');
  });
});
