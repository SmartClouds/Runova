import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { DSN, projectKey } from './testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { ErrorProjectKeysDialog } = await import('./ErrorProjectKeysDialog');

/**
 * The DSN of a Sentry project that is already linked: read from Sentry each time it opens, since
 * Runova keeps no keys, with the setup snippet for the project's platform.
 */

const OLD_DSN = 'https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/203';
const KEYS_URL = 'https://sentry.io/settings/acme/projects/storefront-web/keys/';

const web = {
  connectionId: 'c1',
  remoteSlug: 'storefront-web',
  remoteName: 'storefront-web',
  platform: 'javascript-react',
};
const api = {
  connectionId: 'c1',
  remoteSlug: 'storefront-api',
  remoteName: 'storefront-api',
  platform: 'node',
};

function renderDialog(targets = [web], bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <ErrorProjectKeysDialog open onOpenChange={vi.fn()} targets={targets} />,
    {
      bridge: {
        'errorTracking.projectKeys': async () => ({
          keys: [
            projectKey(),
            projectKey({ id: 'k2', name: 'Old key', isActive: false, dsn: OLD_DSN }),
          ],
          keysUrl: KEYS_URL,
        }),
        ...bridge,
      },
    },
  );
}

describe('ErrorProjectKeysDialog', () => {
  it('reads the keys of the project and sets up its platform', async () => {
    const { bridge } = renderDialog();
    const view = await screen.findByRole('dialog', { name: 'DSN for storefront-web' });
    const list = await within(view).findByRole('list', { name: 'Client keys' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Default.*Active/),
      expect.stringMatching(/Old key.*Disabled/),
    ]);
    expect(within(rows[0]).getByLabelText('DSN')).toHaveTextContent(DSN);
    expect(within(rows[1]).getByLabelText('DSN')).toHaveTextContent(OLD_DSN);
    expect(bridge.$fn('errorTracking.projectKeys')).toHaveBeenCalledWith({
      connectionId: 'c1',
      remoteSlug: 'storefront-web',
    });

    expect(within(view).getByRole('combobox', { name: 'Snippet platform' })).toHaveTextContent(
      'React',
    );
    expect(within(view).getByRole('region', { name: 'Init code' })).toHaveTextContent(DSN);
    expect(within(view).getByRole('link', { name: /Manage keys in Sentry/ })).toHaveAttribute(
      'href',
      KEYS_URL,
    );
  });

  it('picks between the linked projects', async () => {
    const { user, bridge } = renderDialog([web, api]);
    const view = await screen.findByRole('dialog', { name: 'DSN' });
    await within(view).findByRole('list', { name: 'Client keys' });
    await user.click(within(view).getByRole('combobox', { name: 'Sentry project' }));
    await user.click(await screen.findByRole('option', { name: 'storefront-api' }));
    await waitFor(() =>
      expect(bridge.$fn('errorTracking.projectKeys')).toHaveBeenLastCalledWith({
        connectionId: 'c1',
        remoteSlug: 'storefront-api',
      }),
    );
    expect(within(view).getByRole('combobox', { name: 'Snippet platform' })).toHaveTextContent(
      'Node.js',
    );
  });

  it('shows a failure with a way to try again', async () => {
    let calls = 0;
    const { user } = renderDialog([web], {
      'errorTracking.projectKeys': async () => {
        calls += 1;
        throw new Error('Sentry could not find that.');
      },
    });
    const view = await screen.findByRole('dialog', { name: 'DSN for storefront-web' });
    expect(await within(view).findByRole('alert')).toHaveTextContent(
      'Could not read the keys: Sentry could not find that.',
    );
    await user.click(within(view).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it('says so when the project has no key', async () => {
    renderDialog([web], { 'errorTracking.projectKeys': { keys: [], keysUrl: KEYS_URL } });
    const view = await screen.findByRole('dialog', { name: 'DSN for storefront-web' });
    expect(await within(view).findByText(/has no client key/)).toBeInTheDocument();
    expect(within(view).queryByRole('region', { name: 'Init code' })).toBeNull();
  });
});
