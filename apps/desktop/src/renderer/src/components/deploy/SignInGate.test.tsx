import type { DeployAccess, DeployConnection } from '@shared/deployTypes';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { SERVER } from './security/testing/fixtures';

/**
 * What a server's section shows while this computer cannot use the core: a spinner while the
 * connection is still being tried, and otherwise the one step that gets it in, offered right here.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SignInGate } = await import('./SignInGate');

function renderGate(access: DeployAccess, connection?: Partial<DeployConnection>) {
  return renderWithProviders(
    <SignInGate server={SERVER} purpose="see and deploy its apps">
      <button type="button">Something else</button>
    </SignInGate>,
    {
      bridge: {
        'deploy.access': async () => access,
        'deploy.connection': async () =>
          connection ? { serverId: SERVER.id, since: 0, ...connection } : null,
      },
    },
  );
}

describe('SignInGate', () => {
  it('offers a sign-in right where the section would be', async () => {
    const { user } = renderGate({ state: 'needs-sign-in' });

    expect(await screen.findByText('Sign in to Production')).toBeTruthy();
    expect(screen.getByText('Sign in to see and deploy its apps.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Something else' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('shows a spinner and the next try while the connection is being tried again', async () => {
    renderGate(
      { state: 'unreachable', message: 'Connection refused' },
      { state: 'reconnecting', retryAt: Date.now() + 4_000, message: 'Connection refused' },
    );

    expect(await screen.findByText('Reconnecting to Production')).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/Next try in \d s/);
    expect(status.textContent).toContain('Last problem: Connection refused');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('says it is connecting while the connection is on its way up', async () => {
    renderGate({ state: 'unreachable' }, { state: 'connecting' });

    expect(await screen.findByText('Connecting to Production')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Waiting for the core');
  });

  it('offers to enroll a computer the core no longer accepts', async () => {
    renderGate({ state: 'needs-re-enroll' });

    expect(await screen.findByText('Production no longer accepts this computer')).toBeTruthy();
    expect(screen.getByText('Enroll it again to see and deploy its apps.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enroll again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use an enrollment code' })).toBeTruthy();
  });

  it('asks again when the core could not be reached', async () => {
    const { user, bridge } = renderGate({ state: 'unreachable', message: 'Timed out' });

    expect(await screen.findByText('Could not reach Production')).toBeTruthy();
    expect(screen.getByText('Timed out')).toBeTruthy();

    bridge.$set('deploy.access', async () => ({ state: 'needs-sign-in' }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Sign in to Production')).toBeTruthy());
  });
});
