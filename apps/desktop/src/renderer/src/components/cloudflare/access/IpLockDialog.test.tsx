import type { CloudflareDnsRecord } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { A_RECORD, IP_LOCK_RULE, ipcError, ZONE } from '../testing/fixtures';

/**
 * Adding or changing an IP limit (E97): a name of the zone (or all of them), the whole name or one
 * path, and the addresses that get in, with a sentence that says it back and a warning when this
 * computer would be shut out.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { IpLockDialog } = await import('./IpLockDialog');

const RECORDS: CloudflareDnsRecord[] = [
  { ...A_RECORD, id: '1'.repeat(32), name: 'app.example.com' },
  { ...A_RECORD, id: '2'.repeat(32), name: 'shop.example.com', proxied: false },
  { ...A_RECORD, id: '3'.repeat(32), type: 'CNAME', name: 'www.example.com', content: 'x.io' },
  { ...A_RECORD, id: '4'.repeat(32), type: 'TXT', name: 'txt.example.com', content: 'v=spf1' },
  { ...A_RECORD, id: '5'.repeat(32), name: '*.example.com' },
];

const HERE = '203.0.113.77';

function renderDialog(
  bridge: Record<string, unknown> = {},
  existing?: { id: string; expression: string; action: string },
) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <IpLockDialog zone={ZONE} open onOpenChange={onOpenChange} existing={existing} />,
    {
      bridge: {
        'cloudflare.listRecords': async () => RECORDS,
        'ipGeo.lookup': async () => ({ ip: HERE, country: 'X', countryCode: 'XX' }),
        ...bridge,
      },
    },
  );
  return { ...view, onOpenChange };
}

async function pickName(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Name' }));
  await user.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('IpLockDialog', () => {
  it('offers the names behind the proxy, and every name at once', async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Name' }));
    const names = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(names).toEqual(['Every name in example.com', 'app.example.com', 'www.example.com']);
  });

  it('limits a whole name to the typed addresses, saying it back first', async () => {
    const createCustomRule = vi.fn(async () => [IP_LOCK_RULE]);
    const { onOpenChange } = renderDialog({ 'cloudflare.createCustomRule': createCustomRule });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Limit by IP address' });
    const add = within(dialog).getByRole('button', { name: 'Add limit' });
    expect(add).toBeDisabled();

    await pickName(user, 'app.example.com');
    await user.type(within(dialog).getByLabelText('Addresses that get in'), '198.51.100.7, ');
    await user.type(within(dialog).getByLabelText('Addresses that get in'), '10.0.0.0/8{Enter}');

    expect(
      within(dialog).getByText(
        "Only 198.51.100.7 and 10.0.0.0/8 can open app.example.com. Everyone else gets Cloudflare's block page.",
      ),
    ).toBeInTheDocument();
    await user.click(add);

    expect(createCustomRule).toHaveBeenCalledWith(ZONE.id, {
      description: 'Only listed IPs, app.example.com',
      spec: {
        kind: 'ip-lock',
        hostname: 'app.example.com',
        path: null,
        match: 'prefix',
        ips: ['198.51.100.7', '10.0.0.0/8'],
      },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith(
      'Only the listed addresses can open app.example.com now.',
    );
  });

  it('warns when this computer is left out, and adds it in one click', async () => {
    renderDialog();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Limit by IP address' });
    await user.type(within(dialog).getByLabelText('Addresses that get in'), '198.51.100.7 ');

    expect(
      await within(dialog).findByText(/This computer \(203\.0\.113\.77\) is not on the list/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: `Add this computer, ${HERE}` }));

    expect(within(dialog).getByRole('list', { name: 'Listed addresses' })).toHaveTextContent(HERE);
    expect(within(dialog).queryByText(/is not on the list/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Add this computer/ })).toBeNull();
  });

  it('counts this computer as in when a listed range covers it', async () => {
    renderDialog();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Limit by IP address' });
    await user.type(within(dialog).getByLabelText('Addresses that get in'), '203.0.113.0/24 ');
    await screen.findByRole('button', { name: /Add limit/ });
    expect(within(dialog).queryByText(/is not on the list/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Add this computer/ })).toBeNull();
  });

  it('says why a typed address cannot be used', async () => {
    renderDialog();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Limit by IP address' });
    await user.type(within(dialog).getByLabelText('Addresses that get in'), 'office ');
    expect(
      within(dialog).getByText(/This is not an IP address or a range like 203.0.113.0\/24./),
    ).toBeInTheDocument();
  });

  it('limits one path, or a path and everything under it', async () => {
    const createCustomRule = vi.fn(async () => [IP_LOCK_RULE]);
    renderDialog({ 'cloudflare.createCustomRule': createCustomRule });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Limit by IP address' });
    await pickName(user, 'Every name in example.com');
    await user.click(within(dialog).getByRole('radio', { name: 'One path' }));
    const path = within(dialog).getByLabelText('Path');
    await user.type(path, 'wp-login.php');
    await user.type(within(dialog).getByLabelText('Addresses that get in'), '198.51.100.7 ');

    expect(
      within(dialog).getByText('A path starts with a slash, like /wp-login.php.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add limit' })).toBeDisabled();

    await user.clear(path);
    await user.type(path, '/wp-login.php');
    await user.click(within(dialog).getByRole('radio', { name: 'Only this path' }));
    expect(
      within(dialog).getByText(/can open \/wp-login\.php, on every name in example\.com\./),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add limit' }));

    expect(createCustomRule).toHaveBeenCalledWith(ZONE.id, {
      description: 'Only listed IPs, every name /wp-login.php',
      spec: {
        kind: 'ip-lock',
        hostname: null,
        path: '/wp-login.php',
        match: 'exact',
        ips: ['198.51.100.7'],
      },
    });
  });

  it('changes an existing limit in place', async () => {
    const updateCustomRule = vi.fn(async () => [IP_LOCK_RULE]);
    renderDialog({ 'cloudflare.updateCustomRule': updateCustomRule }, IP_LOCK_RULE);
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Change the IP limit' });
    expect(within(dialog).getByRole('combobox', { name: 'Name' })).toHaveTextContent(
      'app.example.com',
    );
    expect(within(dialog).getByLabelText('Path')).toHaveValue('/admin');

    await user.click(within(dialog).getByRole('button', { name: 'Remove 203.0.113.10' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(updateCustomRule).toHaveBeenCalledWith(ZONE.id, IP_LOCK_RULE.id, {
      description: 'Only listed IPs, app.example.com/admin*',
      spec: {
        kind: 'ip-lock',
        hostname: 'app.example.com',
        path: '/admin',
        match: 'prefix',
        ips: ['198.51.100.0/24'],
      },
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Saved the IP limit for app.example.com/admin and below.',
      ),
    );
  });

  it('keeps the dialog open with what Cloudflare said when it refuses', async () => {
    const { onOpenChange } = renderDialog({
      'cloudflare.createCustomRule': async () => {
        throw ipcError('createCustomRule', 'Exceeded maximum number of rules in the phase.');
      },
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Limit by IP address' });
    await pickName(user, 'app.example.com');
    await user.type(within(dialog).getByLabelText('Addresses that get in'), '198.51.100.7 ');
    await user.click(within(dialog).getByRole('button', { name: 'Add limit' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('maximum number of rules');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
