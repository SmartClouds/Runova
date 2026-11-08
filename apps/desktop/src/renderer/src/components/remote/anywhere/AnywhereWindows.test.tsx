import { type AnywhereIncoming, type AnywhereState, EMPTY_ANYWHERE_STATE } from '@shared/anywhere';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useAnywhereStore } from '@/stores/anywhereStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { HostBarRoute } from './HostBarRoute';
import { IncomingRequestRoute } from './IncomingRequestRoute';

function request(change: Partial<AnywhereIncoming> = {}): AnywhereIncoming {
  return {
    sessionId: 's1',
    mode: 'ask',
    relation: 'teammate',
    intent: 'control',
    controller: {
      userId: 4,
      displayName: 'Kim Lee',
      email: 'kim@example.com',
      deviceName: "Kim's laptop",
      platform: 'macos',
      remoteId: '111222333',
    },
    teams: ['Ops'],
    receivedAt: Date.now(),
    expiresAt: Date.now() + 55_000,
    ...change,
  };
}

function show(element: React.ReactElement, state: Partial<AnywhereState>) {
  const view = renderWithProviders(element);
  act(() =>
    useAnywhereStore.getState().set({ ...EMPTY_ANYWHERE_STATE, status: 'online', ...state }),
  );
  return view;
}

describe('the request window', () => {
  it('says who asks, from where and for what, with a countdown', () => {
    show(<IncomingRequestRoute />, { incoming: [request()] });

    expect(
      screen.getByRole('heading', { name: 'Kim Lee wants to control this computer' }),
    ).toBeInTheDocument();
    expect(screen.getByText('kim@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Kim's laptop/)).toBeInTheDocument();
    expect(screen.getByText('Teammate in Ops')).toBeInTheDocument();
    expect(screen.getByText(/5[45] s/)).toBeInTheDocument();
  });

  it('accepts with the permissions the person picked, and can always allow a teammate', async () => {
    const { bridge } = show(<IncomingRequestRoute />, { incoming: [request()] });

    await userEvent.click(screen.getByRole('switch', { name: 'Use the mouse and keyboard' }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Always let Kim Lee in without asking' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(bridge.$fn('anywhere.respondIncoming')).toHaveBeenCalledWith('s1', {
      accept: true,
      permissions: { control: false, clipboard: true, files: false },
      alwaysAllow: true,
    });
  });

  const phoneRequest = () =>
    request({
      intent: 'manage',
      relation: 'own',
      teams: [],
      controller: {
        userId: 1,
        displayName: 'Sam',
        email: 'sam@example.com',
        deviceName: 'Runova app',
        platform: 'android',
        remoteId: null,
      },
    });

  it('asks about a phone in its own words, with the Vault off to start with', () => {
    show(<IncomingRequestRoute />, { incoming: [phoneRequest()] });

    expect(
      screen.getByRole('heading', { name: 'Runova app wants to manage this computer' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/connect without asking/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Terminals and CLIs' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'The Vault' })).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: 'Share the clipboard' })).not.toBeInTheDocument();
  });

  it('approves a phone with the scopes the person picked', async () => {
    const { bridge } = show(<IncomingRequestRoute />, { incoming: [phoneRequest()] });

    await userEvent.click(screen.getByRole('switch', { name: 'The Vault' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve phone' }));

    expect(bridge.$fn('anywhere.respondIncoming')).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        accept: true,
        scopes: ['terminal', 'git', 'vault', 'ops'],
      }),
    );
  });

  it('declines', async () => {
    const { bridge } = show(<IncomingRequestRoute />, { incoming: [request()] });

    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));

    expect(bridge.$fn('anywhere.respondIncoming')).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ accept: false }),
    );
  });

  it('does not offer "always allow" for the owner own computer, and says it is theirs', () => {
    show(<IncomingRequestRoute />, { incoming: [request({ relation: 'own', teams: [] })] });

    expect(screen.getByText('Your account')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Always let/ })).toBeNull();
  });

  it('asks for files only when that is all the request is for', () => {
    show(<IncomingRequestRoute />, { incoming: [request({ intent: 'files' })] });

    expect(
      screen.getByRole('heading', { name: 'Kim Lee wants to open your files' }),
    ).toBeInTheDocument();
  });

  it('says how many more are waiting', () => {
    show(<IncomingRequestRoute />, { incoming: [request(), request({ sessionId: 's2' })] });

    expect(screen.getByText('1 more waiting')).toBeInTheDocument();
  });
});

describe('the host bar', () => {
  const hosted = {
    sessionId: 's1',
    controllerName: 'Kim Lee',
    controllerEmail: 'kim@example.com',
    deviceName: "Kim's laptop",
    transport: 'direct' as const,
    intent: 'control' as const,
    permissions: { control: true, clipboard: true, files: false },
    startedAt: Date.now() - 65_000,
    safetyCode: '123456',
  };

  it('says who is connected and for how long', () => {
    show(<HostBarRoute />, { hosted: [hosted] });

    expect(screen.getByText('Kim Lee is controlling this computer')).toBeInTheDocument();
    expect(screen.getByText(/^01:\d\d$/)).toBeInTheDocument();
  });

  it('pauses input and ends the session in one click', async () => {
    const { bridge } = show(<HostBarRoute />, { hosted: [hosted] });

    await userEvent.click(screen.getByRole('button', { name: 'Pause input' }));
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));

    expect(bridge.$fn('anywhere.pauseInput')).toHaveBeenCalledWith(true);
    expect(bridge.$fn('anywhere.endHosted')).toHaveBeenCalledWith('s1');
  });

  it('offers to resume while input is paused, and counts several people', () => {
    show(<HostBarRoute />, {
      hosted: [hosted, { ...hosted, sessionId: 's2', controllerName: 'Lee' }],
      inputPaused: true,
    });

    expect(screen.getByText('2 people are connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume input' })).toBeInTheDocument();
  });
});
