import type { AnywhereOutgoing } from '@shared/anywhere';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ConnectionSheet } from './ConnectionSheet';

function outgoing(change: Partial<AnywhereOutgoing> = {}): AnywhereOutgoing {
  return {
    phase: 'waiting',
    remoteId: '482193775',
    hostName: "Sam's desk",
    platform: 'windows',
    mode: 'ask',
    intent: 'control',
    transport: null,
    safetyCode: null,
    ringsUntil: Date.now() + 42_000,
    error: null,
    wrongPassword: false,
    ...change,
  };
}

describe('ConnectionSheet', () => {
  it('says who it is waiting for, counts down, and can be cancelled', async () => {
    const { bridge } = renderWithProviders(<ConnectionSheet outgoing={outgoing()} />);

    expect(screen.getByRole('dialog', { name: "Connecting to Sam's desk" })).toBeInTheDocument();
    expect(screen.getByText(/Waiting for someone at Sam's desk to accept/)).toBeInTheDocument();
    expect(screen.getByText(/4[12] s/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(bridge.$fn('anywhere.disconnect')).toHaveBeenCalled();
  });

  it('marks the steps done so far', () => {
    renderWithProviders(
      <ConnectionSheet outgoing={outgoing({ phase: 'securing', transport: 'direct' })} />,
    );

    const steps = screen.getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'current',
      'todo',
    ]);
    expect(steps.map((s) => s.textContent)).toEqual([
      'Find the computer',
      'Accepted',
      'Secure the connection',
      'Connected',
    ]);
  });

  it('marks every step done once connected', () => {
    renderWithProviders(
      <ConnectionSheet
        outgoing={outgoing({
          phase: 'connected',
          mode: 'password',
          transport: 'direct',
          safetyCode: '111111',
        })}
      />,
    );

    expect(screen.getAllByRole('listitem').map((s) => s.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'done',
    ]);
  });

  it('leaves out the approval step for a password connection, and names a stranger computer by its ID', () => {
    renderWithProviders(
      <ConnectionSheet
        outgoing={outgoing({ phase: 'connecting', mode: 'password', hostName: '' })}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Connecting to 482 193 775' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('asks for the password, and can save it in Runova', async () => {
    const { bridge } = renderWithProviders(
      <ConnectionSheet outgoing={outgoing({ phase: 'needs-password', mode: 'password' })} />,
    );

    expect(
      screen.getByText(/checks it with Sam's desk directly and never sends it/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Password'), 'purple monkey dishwasher');
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Save it in Runova for next time' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(bridge.$fn('anywhere.submitPassword')).toHaveBeenCalledWith(
      'purple monkey dishwasher',
      true,
    );
  });

  it('says plainly when the password was wrong', () => {
    renderWithProviders(
      <ConnectionSheet
        outgoing={outgoing({ phase: 'needs-password', mode: 'password', wrongPassword: true })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That password did not work. Check it with the owner and try again.',
    );
  });

  it('warns about a changed key and lets the person trust it after checking', async () => {
    const { bridge } = renderWithProviders(
      <ConnectionSheet outgoing={outgoing({ phase: 'key-changed' })} />,
    );

    expect(screen.getByText(/key changed since you last connected/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Trust the new key and connect' }));

    expect(bridge.$fn('anywhere.trustNewKey')).toHaveBeenCalled();
  });

  it('shows how it connected and the safety code once connected', async () => {
    const { bridge } = renderWithProviders(
      <ConnectionSheet
        outgoing={outgoing({ phase: 'connected', transport: 'relay', safetyCode: '042917' })}
      />,
    );

    expect(screen.getByText('Through the Runova relay')).toBeInTheDocument();
    expect(screen.getByLabelText('Safety code')).toHaveTextContent('042 917');
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(bridge.$fn('anywhere.disconnect')).toHaveBeenCalled();
  });

  it('explains a failure and offers to try again', async () => {
    const { bridge } = renderWithProviders(
      <ConnectionSheet outgoing={outgoing({ phase: 'failed', error: "Sam's desk declined." })} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("Sam's desk declined.");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(bridge.$fn('anywhere.connect')).toHaveBeenCalledWith({
      remoteId: '482193775',
      intent: 'control',
    });
  });
});
