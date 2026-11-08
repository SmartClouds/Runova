import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RemoteIdDial } from './RemoteIdDial';

describe('RemoteIdDial', () => {
  it('reads the ID out in three groups, and names it as one number for screen readers', () => {
    render(<RemoteIdDial remoteId="482193775" presence="online" />);

    const dial = screen.getByRole('group', { name: 'Runova ID 482 193 775, online' });
    expect(dial).toHaveTextContent('482193775');
    expect(screen.getAllByTestId('id-group').map((g) => g.textContent)).toEqual([
      '482',
      '193',
      '775',
    ]);
  });

  it('shows placeholders while the ID is not known yet', () => {
    render(<RemoteIdDial remoteId={null} presence="starting" />);

    expect(
      screen.getByRole('group', { name: 'Runova ID not ready yet, connecting' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('id-group').map((g) => g.textContent)).toEqual([
      '···',
      '···',
      '···',
    ]);
  });

  it('copies the ID without spaces', () => {
    renderWithProviders(<RemoteIdDial remoteId="482193775" presence="offline" copy />);

    expect(screen.getByRole('button', { name: 'Copy ID' })).toBeInTheDocument();
  });
});
