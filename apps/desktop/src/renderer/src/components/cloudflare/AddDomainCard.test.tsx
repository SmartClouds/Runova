import type { CloudflareAccountStatus, CloudflareZone } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ACCOUNT, deferred, ipcError, ZONE } from './testing/fixtures';

/**
 * Adding a domain: the box takes a domain or a pasted web address, says what is wrong before
 * anything reaches Cloudflare, and offers the open domain instead of a second copy. Once the
 * zone is made, the card turns into the registrar steps, with the two name servers to copy.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { AddDomainCard } = await import('./AddDomainCard');

const CF_ACCOUNT = { id: '01a7362d577a6c3019a474fd6f485823', name: 'Demo Account' };
const CF_OTHER = { id: '5f1e2d3c4b5a69788796a5b4c3d2e1f0', name: 'Agency' };
const WORK: CloudflareAccountStatus = { ...ACCOUNT, id: 'acct-2', label: 'Work' };

const CREATED: CloudflareZone = {
  ...ZONE,
  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  name: 'new-site.org',
  status: 'pending',
  nameServers: ['ada.ns.cloudflare.com', 'kip.ns.cloudflare.com'],
};

function setup(
  options: {
    accounts?: CloudflareAccountStatus[];
    zones?: CloudflareZone[];
    bridge?: Record<string, unknown>;
  } = {},
) {
  const onCancel = vi.fn();
  const onOpen = vi.fn();
  const createZone = vi.fn(async () => CREATED);
  const view = renderWithProviders(
    <AddDomainCard
      accounts={options.accounts ?? [ACCOUNT]}
      zones={options.zones ?? [ZONE]}
      onCancel={onCancel}
      onOpen={onOpen}
    />,
    {
      bridge: {
        'cloudflare.cloudflareAccounts': async () => [CF_ACCOUNT],
        'cloudflare.createZone': createZone,
        ...options.bridge,
      },
    },
  );
  return { ...view, onCancel, onOpen, createZone };
}

function domainBox() {
  return screen.getByRole('textbox', { name: 'Domain' });
}

function addButton() {
  return screen.getByRole('button', { name: 'Add domain' });
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('AddDomainCard: the form', () => {
  it('starts in the domain box and says which Cloudflare account the domain goes into', async () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Add a domain' })).toBeInTheDocument();
    expect(domainBox()).toHaveFocus();
    expect(await screen.findByText('Demo Account')).toBeInTheDocument();
    // One account to choose from, so there is nothing to pick.
    expect(screen.queryByRole('combobox', { name: 'Cloudflare account' })).not.toBeInTheDocument();
  });

  it('adds the domain to the account and moves on to the name servers', async () => {
    const { user, bridge } = setup();
    await screen.findByText('Demo Account');
    await user.type(domainBox(), 'https://New-Site.org/{Enter}');
    await waitFor(() =>
      expect(bridge.$fn('cloudflare.createZone')).toHaveBeenCalledWith('acct-1', {
        name: 'new-site.org',
        cloudflareAccountId: CF_ACCOUNT.id,
      }),
    );
    const heading = await screen.findByRole('heading', {
      name: 'Point new-site.org at Cloudflare',
    });
    expect(heading).toHaveFocus();
    expect(toast.success).toHaveBeenCalledWith('new-site.org is on Cloudflare now.');
  });

  it('puts the new zone in the list right away, so it can be opened', async () => {
    const { user, queryClient } = setup();
    queryClient.setQueryData(queryKeys.cloudflareAccountZones('acct-1'), [ZONE]);
    await screen.findByText('Demo Account');
    await user.type(domainBox(), 'new-site.org');
    await user.click(addButton());
    await screen.findByRole('heading', { name: 'Point new-site.org at Cloudflare' });
    expect(
      queryClient.getQueryData<CloudflareZone[]>(queryKeys.cloudflareAccountZones('acct-1')),
    ).toEqual([ZONE, CREATED]);
  });

  it('says what is wrong with the name without asking Cloudflare', async () => {
    const { user, createZone } = setup();
    await screen.findByText('Demo Account');
    await user.click(addButton());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Type the domain you want to add, like example.com.',
    );
    expect(domainBox()).toHaveAttribute('aria-invalid', 'true');
    await user.type(domainBox(), 'mysite');
    // Typing again clears the complaint until the next try.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(addButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Add the ending too, like example.com.');
    expect(createZone).not.toHaveBeenCalled();
  });

  it('offers the main domain when a www name is typed', async () => {
    const { user } = setup();
    await user.type(domainBox(), 'www.new-site.org');
    await user.click(screen.getByRole('button', { name: 'Use new-site.org' }));
    expect(domainBox()).toHaveValue('new-site.org');
    expect(screen.queryByRole('button', { name: /^Use / })).not.toBeInTheDocument();
  });

  it('offers to open a domain that is already here instead of adding it again', async () => {
    const { user, onOpen, createZone } = setup();
    await screen.findByText('Demo Account');
    await user.type(domainBox(), 'Example.com');
    expect(screen.getByText(/example\.com is already here/)).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Open example.com' }));
    expect(onOpen).toHaveBeenCalledWith(ZONE);
    expect(createZone).not.toHaveBeenCalled();
  });

  it('lets the user pick the account when there is more than one', async () => {
    const { user, bridge } = setup({
      accounts: [ACCOUNT, WORK],
      bridge: {
        'cloudflare.cloudflareAccounts': async (id: string) =>
          id === 'acct-1' ? [CF_ACCOUNT] : [CF_OTHER],
      },
    });
    const picker = await screen.findByRole('combobox', { name: 'Cloudflare account' });
    expect(picker).toHaveTextContent('Demo Account (Cloudflare)');
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Agency (Work)' }));
    await user.type(domainBox(), 'new-site.org');
    await user.click(addButton());
    await waitFor(() =>
      expect(bridge.$fn('cloudflare.createZone')).toHaveBeenCalledWith('acct-2', {
        name: 'new-site.org',
        cloudflareAccountId: CF_OTHER.id,
      }),
    );
  });

  it('shows the button busy while Cloudflare makes the zone', async () => {
    const pending = deferred<CloudflareZone>();
    const { user } = setup({ bridge: { 'cloudflare.createZone': () => pending.promise } });
    await screen.findByText('Demo Account');
    await user.type(domainBox(), 'new-site.org');
    await user.click(addButton());
    const busy = screen.getByRole('button', { name: /Adding/ });
    expect(busy).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    pending.resolve(CREATED);
    await screen.findByRole('heading', { name: 'Point new-site.org at Cloudflare' });
  });

  it("shows Cloudflare's refusal in words and keeps what was typed", async () => {
    const { user } = setup({
      bridge: {
        'cloudflare.createZone': async () => {
          throw ipcError(
            'createZone',
            'new-site.org is already on Cloudflare, in another account.',
          );
        },
      },
    });
    await screen.findByText('Demo Account');
    await user.type(domainBox(), 'new-site.org');
    await user.click(addButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'new-site.org is already on Cloudflare, in another account.',
    );
    expect(domainBox()).toHaveValue('new-site.org');
    expect(addButton()).toBeEnabled();
  });

  it('says exactly what to add to the token when it may not add domains', async () => {
    const { user } = setup({
      bridge: {
        'cloudflare.createZone': async () => {
          throw ipcError(
            'createZone',
            '[cloudflare:missing-permission:zoneEdit] This token is not allowed to add domains.',
          );
        },
      },
    });
    await screen.findByText('Demo Account');
    await user.type(domainBox(), 'new-site.org');
    await user.click(addButton());
    const fix = await screen.findByRole('alert');
    expect(fix).toHaveTextContent('Zone > Zone > Edit');
    expect(within(fix).getByRole('button', { name: /token page/ })).toBeInTheDocument();
  });

  it('explains when no Cloudflare account can be found, and tries again on request', async () => {
    let calls = 0;
    const { user } = setup({
      bridge: {
        'cloudflare.cloudflareAccounts': async () => {
          calls += 1;
          if (calls === 1) throw ipcError('cloudflareAccounts', 'Cloudflare did not name one.');
          return [CF_ACCOUNT];
        },
      },
    });
    expect(await screen.findByText('Cloudflare did not name one.')).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Demo Account')).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it('goes back without adding anything on Cancel or Escape', async () => {
    const { user, onCancel, createZone } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.type(domainBox(), 'new-site.org{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(createZone).not.toHaveBeenCalled();
  });
});

describe('AddDomainCard: the registrar steps', () => {
  async function created() {
    const view = setup();
    await screen.findByText('Demo Account');
    await view.user.type(domainBox(), 'new-site.org');
    await view.user.click(addButton());
    await screen.findByRole('heading', { name: 'Point new-site.org at Cloudflare' });
    return view;
  }

  it('lists the name servers, each with its own copy button', async () => {
    const { user } = await created();
    const list = screen.getByRole('list', { name: 'Cloudflare name servers' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['ada.ns.cloudflare.com', 'kip.ns.cloudflare.com']);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(screen.getByRole('button', { name: 'Copy ada.ns.cloudflare.com' }));
    expect(writeText).toHaveBeenLastCalledWith('ada.ns.cloudflare.com');
    await user.click(screen.getByRole('button', { name: 'Copy both' }));
    expect(writeText).toHaveBeenLastCalledWith('ada.ns.cloudflare.com\nkip.ns.cloudflare.com');
  });

  it('opens the new domain when asked', async () => {
    const { user, onOpen } = await created();
    await user.click(screen.getByRole('button', { name: 'Open new-site.org' }));
    expect(onOpen).toHaveBeenCalledWith(CREATED);
  });
});
