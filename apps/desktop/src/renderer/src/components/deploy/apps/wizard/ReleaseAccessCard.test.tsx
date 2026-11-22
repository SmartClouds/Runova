import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { SERVER } from '../testing/fixtures';
import { ReleaseAccessCard } from './ReleaseAccessCard';

/**
 * The server's access to a repository's releases (E105). Besides pasting a fine-grained token,
 * an Admin can hand the server the GitHub CLI's own sign-in, but only after accepting that it can
 * do much more than read releases. The token itself never comes to this window.
 */

const NONE = {
  repository: 'acme/shop',
  access: 'none',
  message: 'The server cannot read the releases of acme/shop on its own.',
};

const STORED = { id: 't1', repository: 'acme/shop', createdAtUnixMs: 1, updatedAtUnixMs: 1 };

function renderCard(bridge: Record<string, unknown> = {}, canAdmin = true) {
  return renderWithProviders(
    <ReleaseAccessCard serverId={SERVER.id} repository="acme/shop" canAdmin={canAdmin} />,
    {
      bridge: {
        'deploy.listServers': [SERVER],
        'deployStacks.releaseAccess': NONE,
        'deployStacks.saveReleaseTokenFromGh': STORED,
        'shell.openExternal': async () => undefined,
        ...bridge,
      },
    },
  );
}

async function openForm(user: ReturnType<typeof renderCard>['user']) {
  const card = await screen.findByRole('region', { name: 'Server access to the releases' });
  await user.click(await within(card).findByRole('button', { name: /Give the server access/ }));
  return card;
}

describe('ReleaseAccessCard', () => {
  it('opens the new-token page with a read-only token for the owner filled in', async () => {
    const { user, bridge } = renderCard();
    const card = await openForm(user);

    await user.click(within(card).getByRole('button', { name: /Open GitHub/ }));

    const url = new URL(bridge.$fn('shell.openExternal').mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      'https://github.com/settings/personal-access-tokens/new',
    );
    expect(url.searchParams.get('target_name')).toBe('acme');
    expect(url.searchParams.get('contents')).toBe('read');
  });

  it('stores the gh sign-in only after the broader scopes are accepted', async () => {
    const { user, bridge } = renderCard();
    const card = await openForm(user);

    await user.click(within(card).getByRole('button', { name: /Use my gh sign-in/ }));

    const warning = within(card).getByRole('group', { name: 'The gh sign-in' });
    expect(within(warning).getByText(/every repository/)).toBeInTheDocument();
    expect(within(warning).getByText(/gh auth logout/)).toBeInTheDocument();
    const store = within(card).getByRole('button', { name: /Store the gh sign-in/ });
    expect(store).toBeDisabled();

    await user.click(within(warning).getByRole('checkbox'));
    await user.click(store);

    await waitFor(() =>
      expect(bridge.$fn('deployStacks.saveReleaseTokenFromGh')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        repository: 'acme/shop',
        acceptBroaderScopes: true,
      }),
    );
    await waitFor(() => expect(bridge.$fn('deployStacks.releaseAccess')).toHaveBeenCalledTimes(2));
  });

  it('says why the gh sign-in could not be stored', async () => {
    const { user } = renderCard({
      'deployStacks.saveReleaseTokenFromGh': async () => {
        throw new Error('The GitHub CLI is not signed in. Run "gh auth login" first.');
      },
    });
    const card = await openForm(user);

    await user.click(within(card).getByRole('button', { name: /Use my gh sign-in/ }));
    await user.click(within(card).getByRole('checkbox'));
    await user.click(within(card).getByRole('button', { name: /Store the gh sign-in/ }));

    expect(await within(card).findByRole('alert')).toHaveTextContent('gh auth login');
  });

  it('lets the person back out of the gh sign-in to paste a token instead', async () => {
    const { user } = renderCard();
    const card = await openForm(user);

    await user.click(within(card).getByRole('button', { name: /Use my gh sign-in/ }));
    await user.click(within(card).getByRole('button', { name: /Paste a token instead/ }));

    expect(within(card).queryByRole('group', { name: 'The gh sign-in' })).not.toBeInTheDocument();
    expect(within(card).getByLabelText('Token')).toBeInTheDocument();
  });

  it('offers nothing to store to someone who is not an Admin', async () => {
    renderCard({}, false);
    const card = await screen.findByRole('region', { name: 'Server access to the releases' });

    expect(within(card).queryByRole('button', { name: /Give the server access/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: /gh sign-in/ })).toBeNull();
  });
});
