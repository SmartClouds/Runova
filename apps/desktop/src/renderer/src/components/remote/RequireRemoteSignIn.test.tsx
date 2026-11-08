// @vitest-environment jsdom
import type { AccountStatus } from '@shared/accountTypes';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RequireRemoteSignIn } from './RequireRemoteSignIn';

const SIGNED_IN: AccountStatus = {
  state: 'signed-in',
  deviceId: 'd',
  sessionId: 1,
  account: { id: 1, email: 'sam@example.com', displayName: 'Sam' },
  rememberedOnDisk: true,
  needsSignIn: false,
};

function show(status: AccountStatus) {
  return renderWithProviders(
    <RequireRemoteSignIn title="Sign in to host this computer" text="It needs an account.">
      <p>The panel</p>
    </RequireRemoteSignIn>,
    { bridge: { 'account.status': status } },
  );
}

describe('RequireRemoteSignIn', () => {
  it('shows what it guards to someone signed in', async () => {
    show(SIGNED_IN);

    expect(await screen.findByText('The panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in to Runova' })).not.toBeInTheDocument();
  });

  it('asks a signed-out person to sign in, and starts it from the button', async () => {
    const { user, bridge } = show({ state: 'signed-out', deviceId: 'd' });

    const button = await screen.findByRole('button', { name: 'Sign in to Runova' });
    expect(screen.getByText('Sign in to host this computer')).toBeInTheDocument();
    expect(screen.queryByText('The panel')).not.toBeInTheDocument();

    await user.click(button);

    expect(bridge.$fn('account.signIn')).toHaveBeenCalled();
  });

  it('asks again when the server ended the session', async () => {
    show({ ...SIGNED_IN, needsSignIn: true });

    expect(await screen.findByRole('button', { name: 'Sign in to Runova' })).toBeInTheDocument();
    expect(screen.queryByText('The panel')).not.toBeInTheDocument();
  });

  it('says it is waiting while the browser sign-in is open', async () => {
    show({ state: 'signing-in', deviceId: 'd' });

    expect(await screen.findByRole('button', { name: 'Waiting for the browser…' })).toBeDisabled();
  });

  it('opens by itself the moment sign-in finishes', async () => {
    const { bridge } = show({ state: 'signed-out', deviceId: 'd' });
    await screen.findByRole('button', { name: 'Sign in to Runova' });

    bridge.$fn('account.status').mockResolvedValue(SIGNED_IN);
    await act(async () => bridge.$emit('account.onChanged', SIGNED_IN));

    expect(await screen.findByText('The panel')).toBeInTheDocument();
  });
});
