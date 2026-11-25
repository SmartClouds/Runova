import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CleanupLoading, scanProgress } from './CleanupLoading';

describe('scanProgress', () => {
  it('starts on the first step before the machine reports any', () => {
    expect(scanProgress([])).toEqual({ current: 0, percent: 12.5 });
  });

  it('counts the steps before the running one as done', () => {
    expect(scanProgress(['runners', 'docker', 'caches'])).toEqual({ current: 2, percent: 62.5 });
  });

  it('stays on the first step for a step it does not know', () => {
    expect(scanProgress(['something-new']).current).toBe(0);
  });
});

describe('CleanupLoading', () => {
  it('shows every step on the clean tab with the one running marked', () => {
    render(<CleanupLoading tab="clean" seen={['runners', 'docker']} machineName="build server" />);
    expect(screen.getByText('Scanning build server')).toBeInTheDocument();
    expect(screen.getByText('2 of 4')).toBeInTheDocument();
    expect(screen.getByText('Checking Docker').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.getByRole('progressbar', { name: 'Scan progress' })).toHaveAttribute(
      'aria-valuenow',
      '38',
    );
  });

  it('says on the schedule tab that the job is read last', () => {
    render(<CleanupLoading tab="schedule" seen={['runners']} machineName="build server" />);
    expect(screen.getByText('Scanning build server')).toBeInTheDocument();
    expect(
      screen.getByText('The scheduled job is read last, once the folders and caches are measured.'),
    ).toBeInTheDocument();
  });

  it('names the schedule step on the schedule tab once it runs', () => {
    render(
      <CleanupLoading
        tab="schedule"
        seen={['runners', 'docker', 'caches', 'schedule']}
        machineName="build server"
      />,
    );
    expect(
      screen.getByText('Reading the scheduled job', { selector: 'span.truncate' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Looking for a cleanup job Runova left on build server.'),
    ).toBeInTheDocument();
  });
});
