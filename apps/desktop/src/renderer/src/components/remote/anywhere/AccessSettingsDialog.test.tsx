import { type AnywhereState, EMPTY_ANYWHERE_STATE } from '@shared/anywhere';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AccessSettingsDialog } from './AccessSettingsDialog';

function state(change: Partial<AnywhereState['settings']> = {}): AnywhereState {
  return {
    ...EMPTY_ANYWHERE_STATE,
    status: 'online',
    teams: [
      { id: 10, name: 'Ops' },
      { id: 11, name: 'Design' },
    ],
    settings: { ...EMPTY_ANYWHERE_STATE.settings, ...change },
  };
}

function open(s: AnywhereState, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <AccessSettingsDialog state={s} open onOpenChange={() => undefined} />,
    { bridge },
  );
}

describe('AccessSettingsDialog', () => {
  it('turns on connecting from the owner other computers without asking', async () => {
    const { bridge } = open(state());

    await userEvent.click(
      screen.getByRole('switch', { name: 'My other computers connect without asking' }),
    );

    expect(bridge.$fn('anywhere.updateSettings')).toHaveBeenCalledWith({ allowOwnDevices: true });
  });

  it('shows the computer to a team', async () => {
    const { bridge } = open(state({ teamIds: [11] }));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Ops' }));

    expect(bridge.$fn('anywhere.updateSettings')).toHaveBeenCalledWith({ teamIds: [11, 10] });
  });

  it('says there are no teams yet and where to make one', () => {
    open({ ...state(), teams: [] });

    expect(screen.getByText(/You are not in a team yet/)).toBeInTheDocument();
  });

  it('stops letting in a teammate who was always allowed', async () => {
    const { bridge } = open(state({ alwaysAllow: [{ userId: 4, displayName: 'Kim' }] }));

    await userEvent.click(
      screen.getByRole('button', { name: 'Stop letting Kim in without asking' }),
    );

    expect(bridge.$fn('anywhere.updateSettings')).toHaveBeenCalledWith({ removeAlwaysAllow: [4] });
  });

  it('rates a new password as it is typed, and will not set a weak one', async () => {
    open(state());

    await userEvent.type(screen.getByLabelText('New password'), 'short');

    expect(screen.getByText(/at least 10 characters/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled();
  });

  it('sets a good password and confirms it', async () => {
    const { bridge } = open(state());

    await userEvent.type(screen.getByLabelText('New password'), 'purple monkey dishwasher 42');
    expect(screen.getByRole('meter', { name: 'Password strength' })).toHaveAttribute(
      'aria-valuenow',
      '4',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(bridge.$fn('anywhere.setPassword')).toHaveBeenCalledWith('purple monkey dishwasher 42');
    await waitFor(() => expect(screen.getByLabelText('New password')).toHaveValue(''));
  });

  it('removes the password', async () => {
    const { bridge } = open(state({ passwordSet: true }));

    expect(screen.getByText('A password is set')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove password' }));

    expect(bridge.$fn('anywhere.setPassword')).toHaveBeenCalledWith(null);
  });

  it('can not set a password without a keychain to keep it in', () => {
    open(state({ canKeepSecrets: false }));

    expect(screen.getByText(/no keychain/)).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeDisabled();
  });

  it('changes what a new session may do', async () => {
    const { bridge } = open(state());

    await userEvent.click(screen.getByRole('switch', { name: 'Send and receive files' }));

    expect(bridge.$fn('anywhere.updateSettings')).toHaveBeenCalledWith({
      defaultPermissions: { control: true, clipboard: true, files: true },
    });
  });

  it('can always go through the relay to keep this computer address private', async () => {
    const { bridge } = open(state());

    await userEvent.click(
      screen.getByRole('switch', { name: 'Always connect through the Runova relay' }),
    );

    expect(bridge.$fn('anywhere.updateSettings')).toHaveBeenCalledWith({ alwaysRelay: true });
  });
});
