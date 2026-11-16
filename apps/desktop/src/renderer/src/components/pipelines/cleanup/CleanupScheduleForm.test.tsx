import type { RunnerCleanupSchedule, RunnerCleanupScheduleState } from '@shared/apiTypes';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CleanupScheduleForm } from './CleanupScheduleForm';

const SSH = { kind: 'ssh' as const, serverId: 's1' };

const saved: RunnerCleanupSchedule = {
  frequency: 'monthly',
  weekday: 3,
  dayOfMonth: 12,
  time: '04:15',
  rules: {
    temp: true,
    actions: true,
    oldVersions: true,
    toolKeepNewest: false,
    logsOlderThanDays: 30,
    checkoutsOlderThanDays: null,
    dockerOlderThanHours: 24,
    packageCaches: false,
  },
};

const off: RunnerCleanupScheduleState = { installed: false, job: 'cron', schedule: null };

function renderForm(state: RunnerCleanupScheduleState, bridge: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  const view = renderWithProviders(
    <CleanupScheduleForm link={SSH} machineName="build server" state={state} onSaved={onSaved} />,
    { bridge },
  );
  return { ...view, onSaved };
}

describe('CleanupScheduleForm', () => {
  it('starts from a weekly default and says what it would set up', () => {
    renderForm(off);
    expect(screen.getByText(/a cron job on build server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sun' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Time')).toHaveValue('03:00');
    expect(screen.getByRole('checkbox', { name: 'Temporary files' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save job' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Remove job' })).not.toBeInTheDocument();
  });

  it('saves what the form holds and reports back', async () => {
    const state: RunnerCleanupScheduleState = { installed: true, job: 'cron', schedule: saved };
    const { bridge, onSaved } = renderForm(off, {
      'runnerCleanup.saveSchedule': async () => ({ ok: true, state }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '22:45' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Package caches' }));
    fireEvent.change(screen.getByLabelText('Runner logs older than, in days'), {
      target: { value: '21' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(state));
    const [link, schedule] = bridge.$fn('runnerCleanup.saveSchedule').mock.calls[0];
    expect(link).toEqual(SSH);
    expect(schedule).toMatchObject({
      frequency: 'daily',
      time: '22:45',
      rules: { packageCaches: true, logsOlderThanDays: 21 },
    });
  });

  it('shows a saved job, its last run, and can remove it', async () => {
    const { bridge, onSaved } = renderForm(
      {
        installed: true,
        job: 'cron',
        schedule: saved,
        lastRun: { at: new Date().toISOString(), freedBytes: 2 * 1024 ** 3, ok: true },
      },
      { 'runnerCleanup.removeSchedule': async () => ({ ok: true, state: off }) },
    );
    expect(screen.getByText('On day 12 of every month at 04:15')).toBeInTheDocument();
    expect(screen.getByText(/freed 2.00 GB/)).toBeInTheDocument();
    expect(screen.getByLabelText('Day of the month')).toHaveValue(12);
    expect(screen.getByRole('checkbox', { name: 'Job checkouts unused for' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Remove job' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(off));
    expect(bridge.$fn('runnerCleanup.removeSchedule')).toHaveBeenCalledWith(SSH);
  });

  it('shows a note and an error from the machine', async () => {
    renderForm(off, {
      'runnerCleanup.saveSchedule': async () => ({
        ok: true,
        state: { installed: true, job: 'launchd', schedule: saved },
        note: 'The job starts working after the next sign-in on that Mac.',
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));
    expect(await screen.findByText(/next sign-in/)).toBeInTheDocument();
  });

  it('says why no job can be set up', () => {
    renderForm({ ...off, unavailable: 'This server has no crontab command.' });
    expect(screen.getByText('This server has no crontab command.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save job' })).toBeDisabled();
  });

  it('will not save a job that removes nothing', () => {
    renderForm({
      installed: false,
      job: 'task',
      schedule: {
        ...saved,
        rules: {
          temp: false,
          actions: false,
          oldVersions: false,
          toolKeepNewest: false,
          logsOlderThanDays: null,
          checkoutsOlderThanDays: null,
          dockerOlderThanHours: null,
          packageCaches: false,
        },
      },
    });
    expect(screen.getByRole('button', { name: 'Save job' })).toBeDisabled();
    expect(screen.getByText(/Pick at least one/)).toBeInTheDocument();
  });
});
