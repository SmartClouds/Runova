import { permissionDeniedMessage } from '@shared/cloudflare/permissions';
import { encodeCloudflareError } from '@shared/cloudflareErrors';
import type { CloudflareAnyPermissionId } from '@shared/cloudflareTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { GuidedFix } from './GuidedFix';

/**
 * When Cloudflare refuses a step for want of a permission, the fix walks through the token page
 * click by click, so nobody has to guess what "edit the token" means.
 */

function refused(id: CloudflareAnyPermissionId): Error {
  return new Error(encodeCloudflareError('missing-permission', permissionDeniedMessage(id), id));
}

function steps(): string[] {
  const list = screen.getByRole('list', { name: 'How to add it' });
  return within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list)
    .map((item) => item.textContent ?? '');
}

describe('GuidedFix', () => {
  it('walks through adding an account permission on the token page', () => {
    renderWithProviders(<GuidedFix error={refused('tunnel')} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The Cloudflare token cannot manage Cloudflare Tunnels yet.');
    expect(within(alert).getByText('Account > Cloudflare Tunnel > Edit')).toBeTruthy();
    expect(steps()).toEqual([
      "Click Open Cloudflare's token page below. Find the token you gave Runova in the list, click the ⋯ button at the end of its row and choose Edit.",
      'Under Permissions, click + Add more to get a new row, and set its three drop-downs to Account, then Cloudflare Tunnel, then Edit.',
      'Under Account Resources, check that it says Include with your account (or All accounts) next to it.',
      'Click Continue to summary, then Update token. The token stays the same, so there is nothing new to paste into Runova.',
      'Come back here and try again.',
    ]);
    expect(
      within(alert).getByRole('button', { name: "Open Cloudflare's token page" }),
    ).toBeTruthy();
  });

  it('gives one row per permission when a fix needs two', () => {
    renderWithProviders(<GuidedFix error={refused('access')} />);

    expect(steps()[1]).toBe(
      'Under Permissions, click + Add more to get a new row, and set its three drop-downs to these, one row each:Account, then Access: Apps and Policies, then Edit.Account, then Access: Service Tokens, then Edit.',
    );
  });

  it('points a zone permission at Zone Resources and a user one at neither', () => {
    const { unmount } = renderWithProviders(<GuidedFix error={refused('dns')} />);
    expect(steps()[2]).toMatch(/^Under Zone Resources, check that your domain is included/);
    unmount();

    renderWithProviders(<GuidedFix error={refused('apiTokens')} />);
    expect(steps()).toHaveLength(4);
    expect(steps()[1]).toMatch(/User, then API Tokens, then Edit\.$/);
  });

  it('names its own retry button in the last step', async () => {
    const onRetry = vi.fn();
    const { user } = renderWithProviders(
      <GuidedFix error={refused('turnstile')} onRetry={onRetry} />,
    );

    expect(steps().at(-1)).toBe('Come back here and click I added it, try again.');
    await user.click(screen.getByRole('button', { name: 'I added it, try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows other failures as they are, without steps', () => {
    renderWithProviders(<GuidedFix error={new Error('The server did not answer.')} />);

    expect(screen.getByRole('alert')).toHaveTextContent('The server did not answer.');
    expect(screen.queryByRole('list', { name: 'How to add it' })).toBeNull();
  });
});
