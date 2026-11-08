import {
  type AnywhereDirectoryEntry,
  type AnywhereState,
  EMPTY_ANYWHERE_STATE,
} from '@shared/anywhere';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useAnywhereStore } from '@/stores/anywhereStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AnywherePanel } from './AnywherePanel';

function entry(change: Partial<AnywhereDirectoryEntry>): AnywhereDirectoryEntry {
  return {
    id: 2,
    remoteId: '111222333',
    name: "Kim's laptop",
    platform: 'macos',
    kind: 'app',
    identityKey: 'k',
    unattendedEnabled: false,
    online: true,
    lastSeenAt: '2026-11-08T09:00:00Z',
    owner: { userId: 4, displayName: 'Kim', email: 'kim@example.com' },
    teams: [{ id: 10, name: 'Ops' }],
    ...change,
  };
}

const online: AnywhereState = {
  ...EMPTY_ANYWHERE_STATE,
  status: 'online',
  account: { displayName: 'Sam', email: 'sam@example.com' },
  device: { id: 1, remoteId: '482193775', name: "Sam's desk", platform: 'windows' },
  teams: [{ id: 10, name: 'Ops' }],
};

function show(state: AnywhereState) {
  const view = renderWithProviders(<AnywherePanel />);
  act(() => useAnywhereStore.getState().set(state));
  return view;
}

describe('AnywherePanel signed out', () => {
  it('explains the feature and signs in', async () => {
    const { bridge } = show(EMPTY_ANYWHERE_STATE);

    expect(
      screen.getByRole('heading', { name: 'Reach your computers from anywhere' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to Runova' }));

    expect(bridge.$fn('account.signIn')).toHaveBeenCalled();
  });
});

describe('AnywherePanel signed in', () => {
  it('shows this computer ID and that nobody can connect yet', () => {
    show(online);

    expect(
      screen.getByRole('group', { name: 'Runova ID 482 193 775, online' }),
    ).toBeInTheDocument();
    expect(screen.getByText("Sam's desk")).toBeInTheDocument();
    expect(screen.getByText('Nobody can connect yet')).toBeInTheDocument();
  });

  it('sums up the ways in that are on', () => {
    show({
      ...online,
      settings: { ...online.settings, passwordSet: true, allowOwnDevices: true, teamIds: [10] },
    });

    expect(screen.getByText('Password set')).toBeInTheDocument();
    expect(screen.getByText('My computers')).toBeInTheDocument();
    expect(screen.getByText('Ops can ask')).toBeInTheDocument();
  });

  it('says when connections are paused', () => {
    show({
      ...online,
      settings: { ...online.settings, acceptConnections: false, passwordSet: true },
    });

    expect(screen.getByText('Not taking connections')).toBeInTheDocument();
  });

  it('groups digits as they are typed and connects by ID', async () => {
    const { bridge } = show(online);
    const field = screen.getByRole('textbox', { name: 'Runova ID' });

    await userEvent.type(field, '1112223334');
    expect(field).toHaveValue('111 222 333');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(bridge.$fn('anywhere.connect')).toHaveBeenCalledWith({
      remoteId: '111222333',
      intent: 'control',
    });
  });

  it('connects on Enter, and only with a whole ID', async () => {
    const { bridge } = show(online);
    const field = screen.getByRole('textbox', { name: 'Runova ID' });

    await userEvent.type(field, '1234');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    await userEvent.type(field, '56789{Enter}');

    expect(bridge.$fn('anywhere.connect')).toHaveBeenCalledWith({
      remoteId: '123456789',
      intent: 'control',
    });
  });

  it('lists my other computers and my teammates computers, and connects to one', async () => {
    const { bridge } = show({
      ...online,
      directory: {
        mine: [
          entry({
            id: 1,
            remoteId: '482193775',
            name: "Sam's desk",
            owner: { userId: 3, displayName: 'Sam', email: '' },
          }),
          entry({
            id: 5,
            remoteId: '555666777',
            name: 'Home PC',
            online: false,
            owner: { userId: 3, displayName: 'Sam', email: '' },
          }),
        ],
        teammates: [entry({})],
      },
    });

    const mine = screen.getByRole('list', { name: 'My computers' });
    expect(within(mine).queryByText("Sam's desk")).toBeNull();
    expect(within(mine).getByText('Home PC')).toBeInTheDocument();
    expect(within(mine).getByText('Offline')).toBeInTheDocument();
    const teammates = screen.getByRole('list', { name: 'Teammates' });
    expect(within(teammates).getByText("Kim's laptop")).toBeInTheDocument();
    expect(within(teammates).getByText(/Kim · Ops/)).toBeInTheDocument();

    await userEvent.click(
      within(teammates).getByRole('button', { name: "Connect to Kim's laptop" }),
    );
    await userEvent.click(
      within(teammates).getByRole('button', { name: "Open files on Kim's laptop" }),
    );

    expect(bridge.$fn('anywhere.connect')).toHaveBeenNthCalledWith(1, {
      remoteId: '111222333',
      intent: 'control',
    });
    expect(bridge.$fn('anywhere.connect')).toHaveBeenNthCalledWith(2, {
      remoteId: '111222333',
      intent: 'files',
    });
  });

  it('remembers recent connections and which have a saved password', async () => {
    const { bridge } = show({
      ...online,
      recent: [
        {
          remoteId: '900800700',
          name: '',
          platform: 'linux',
          at: Date.now() - 60_000,
          savedPassword: true,
        },
      ],
    });

    const recent = screen.getByRole('list', { name: 'Recent' });
    expect(within(recent).getByText('900 800 700')).toBeInTheDocument();
    expect(within(recent).getByLabelText('Password saved')).toBeInTheDocument();
    await userEvent.click(within(recent).getByRole('button', { name: 'Forget 900 800 700' }));

    expect(bridge.$fn('anywhere.forgetRecent')).toHaveBeenCalledWith('900800700');
  });

  it('invites the person to connect when there is nothing to list yet', () => {
    show(online);

    expect(
      screen.getByText(/Type the ID shown in Runova on the other computer/),
    ).toBeInTheDocument();
  });

  it('shows who is connected here and ends a session', async () => {
    const { bridge } = show({
      ...online,
      hosted: [
        {
          sessionId: 's1',
          controllerName: 'Kim',
          controllerEmail: 'kim@example.com',
          deviceName: "Kim's laptop",
          transport: 'direct',
          intent: 'control',
          permissions: { control: true, clipboard: true, files: false },
          startedAt: Date.now(),
          safetyCode: '123456',
        },
      ],
    });

    expect(screen.getByText('Kim is connected to this computer')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'End session with Kim' }));

    expect(bridge.$fn('anywhere.endHosted')).toHaveBeenCalledWith('s1');
  });

  it('warns while password access is locked', () => {
    show({ ...online, passwordLockedUntil: Date.now() + 10 * 60_000 });

    expect(screen.getByText(/Password access is locked/)).toBeInTheDocument();
  });

  it('asks for the macOS permissions the host still needs', async () => {
    const { bridge } = show({
      ...online,
      readiness: { controlUnavailable: null, needs: ['accessibility', 'screen'] },
    });

    expect(screen.getByText(/macOS needs your permission/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow control' }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow screen recording' }));

    expect(bridge.$fn('anywhere.grantPermission')).toHaveBeenNthCalledWith(1, 'accessibility');
    expect(bridge.$fn('anywhere.grantPermission')).toHaveBeenNthCalledWith(2, 'screen');
  });

  it('says when this computer can be seen but not controlled', () => {
    show({
      ...online,
      readiness: { controlUnavailable: 'This computer runs Wayland.', needs: [] },
    });

    expect(screen.getByText('This computer runs Wayland.')).toBeInTheDocument();
  });

  it('opens the access settings', async () => {
    show(online);

    await userEvent.click(screen.getByRole('button', { name: 'Access settings' }));

    expect(
      screen.getByRole('dialog', { name: 'Who can connect to this computer' }),
    ).toBeInTheDocument();
  });

  it('shows the connection in progress', () => {
    show({
      ...online,
      outgoing: {
        phase: 'requesting',
        remoteId: '111222333',
        hostName: '',
        platform: null,
        mode: 'ask',
        intent: 'control',
        transport: null,
        safetyCode: null,
        ringsUntil: null,
        error: null,
        wrongPassword: false,
      },
    });

    expect(screen.getByRole('dialog', { name: 'Connecting to 111 222 333' })).toBeInTheDocument();
  });
});
