import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { signedIn } from '../security/testing/fixtures';
import { JobLogDialog } from './JobLogDialog';
import { ServicesCard } from './ServicesCard';
import { SystemFactsCard } from './SystemFactsCard';
import {
  SERVER,
  STEP_UP_REFUSAL,
  sampleJob,
  sampleServices,
  sampleSystemInfo,
} from './testing/fixtures';
import { type Proof, useProofStepUp } from './useProofStepUp';

/** The Overview's smaller pieces, through the states the page test does not reach. */

describe('SystemFactsCard', () => {
  it('says a reboot is waiting and for what, a clock out of sync, and no swap', () => {
    renderWithProviders(
      <SystemFactsCard
        info={sampleSystemInfo({
          rebootRequired: true,
          rebootRequiredBy: ['linux-image-6.8.0-47-generic'],
          timeSync: { synchronized: false, timeZone: 'Etc/UTC', service: 'chronyd' },
          swapTotalBytes: 0,
          publicAddresses: [],
          cpu: { model: 'Xeon', logicalCores: 8, physicalCores: 4, sockets: 2 },
        })}
        loading={false}
        error={null}
        stale
        now={Date.now()}
        rebooting={false}
      />,
    );
    expect(
      screen.getByText('A reboot is waiting for linux-image-6.8.0-47-generic.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Not in sync')).toBeInTheDocument();
    expect(screen.getByText(/no swap/)).toBeInTheDocument();
    expect(screen.getByText('None found')).toBeInTheDocument();
    expect(screen.getByText(/2 sockets/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reboot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reboot now' })).toBeNull();
  });

  it('offers a reboot right in the warning to someone who may reboot', async () => {
    const onReboot = vi.fn();
    const info = sampleSystemInfo({
      rebootRequired: true,
      rebootRequiredBy: ['linux-image-6.8.0-47-generic'],
    });
    const { user, unmount } = renderWithProviders(
      <SystemFactsCard
        info={info}
        loading={false}
        error={null}
        stale={false}
        now={Date.now()}
        onReboot={onReboot}
        rebooting={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reboot now' }));
    expect(onReboot).toHaveBeenCalledTimes(1);
    unmount();
    renderWithProviders(
      <SystemFactsCard
        info={info}
        loading={false}
        error={null}
        stale={false}
        now={Date.now()}
        onReboot={onReboot}
        rebooting
      />,
    );
    expect(screen.getByRole('button', { name: 'Reboot now' })).toBeDisabled();
  });

  it('keeps only the header reboot when no reboot is waiting', () => {
    renderWithProviders(
      <SystemFactsCard
        info={sampleSystemInfo({ rebootRequired: false, rebootRequiredBy: [] })}
        loading={false}
        error={null}
        stale={false}
        now={Date.now()}
        onReboot={vi.fn()}
        rebooting={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reboot' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reboot now' })).toBeNull();
  });

  it('shimmers, says when the facts failed, and an unknown clock', () => {
    const { unmount } = renderWithProviders(
      <SystemFactsCard
        info={undefined}
        loading
        error={null}
        stale={false}
        now={0}
        rebooting={false}
      />,
    );
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    unmount();
    const failed = renderWithProviders(
      <SystemFactsCard
        info={undefined}
        loading={false}
        error={null}
        stale={false}
        now={0}
        rebooting={false}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("The server's facts did not load.");
    failed.unmount();
    renderWithProviders(
      <SystemFactsCard
        info={sampleSystemInfo({ timeSync: {} })}
        loading={false}
        error={null}
        stale={false}
        now={0}
        rebooting={false}
      />,
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});

describe('ServicesCard', () => {
  it('says each state in words and hides what is not installed', () => {
    const [ssh, docker, nginx] = sampleServices();
    renderWithProviders(
      <ServicesCard
        services={[
          { ...ssh, state: 'failed' },
          { ...docker, state: 'activating' },
          { ...nginx, state: 'notInstalled' },
          { ...ssh, unit: 'cron.service', name: 'Cron', state: 'inactive' },
        ]}
        loading={false}
        error={null}
        stale={false}
        restarting="docker"
        onRestart={vi.fn()}
      />,
    );
    const list = screen.getByRole('list', { name: 'Services' });
    expect(within(list).getByRole('listitem', { name: 'SSH' })).toHaveTextContent('Failed');
    expect(within(list).getByRole('listitem', { name: 'Docker' })).toHaveTextContent('Starting');
    expect(within(list).getByRole('listitem', { name: 'Cron' })).toHaveTextContent('Stopped');
    expect(within(list).queryByRole('listitem', { name: 'nginx' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restart Docker' })).toBeDisabled();
  });

  it('shimmers, fails and has nothing to show', () => {
    const { unmount } = renderWithProviders(
      <ServicesCard services={undefined} loading error={null} stale={false} restarting={null} />,
    );
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    unmount();
    const failed = renderWithProviders(
      <ServicesCard
        services={undefined}
        loading={false}
        error="down"
        stale={false}
        restarting={null}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The services did not load: down');
    failed.unmount();
    renderWithProviders(
      <ServicesCard services={[]} loading={false} error={null} stale={false} restarting={null} />,
    );
    expect(screen.getByText('No services to show.')).toBeInTheDocument();
  });
});

describe('JobLogDialog', () => {
  it('says why a cancel did not go through and shows a finished job as it ended', async () => {
    const { user } = renderWithProviders(
      <JobLogDialog serverId={SERVER.id} job={sampleJob()} canCancel onClose={vi.fn()} />,
      {
        bridge: {
          'deployJobs.watch': () => new Promise(() => undefined),
          'deployJobs.cancel': () => Promise.reject(new Error('Too late to cancel.')),
        },
      },
    );
    expect(screen.getByText('Waiting for output…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel the job' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too late to cancel.');
  });

  it('reports a finished job once, with its error', async () => {
    const onFinished = vi.fn();
    renderWithProviders(
      <JobLogDialog
        serverId={SERVER.id}
        job={sampleJob({ state: 'failed', error: 'dpkg was interrupted', cancellable: false })}
        canCancel
        onClose={vi.fn()}
        onFinished={onFinished}
      />,
      { bridge: { 'deployJobs.watch': () => new Promise(() => undefined) } },
    );
    expect(screen.getByRole('status')).toHaveTextContent('Failed: dpkg was interrupted');
    expect(screen.queryByRole('button', { name: 'Cancel the job' })).toBeNull();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  });
});

function StepUpProbe({ work }: { work: (proof?: Proof) => Promise<string> }) {
  const stepUp = useProofStepUp(SERVER);
  return (
    <>
      <Button
        onClick={() =>
          void stepUp.run(work, 'Rebooting').then(
            (result) => {
              document.body.dataset.result = String(result);
            },
            (error: Error) => {
              document.body.dataset.result = `threw ${error.message}`;
            },
          )
        }
      >
        Go
      </Button>
      {stepUp.dialog}
    </>
  );
}

describe('useProofStepUp', () => {
  it('passes other errors on without asking', async () => {
    const { user } = renderWithProviders(
      <StepUpProbe work={() => Promise.reject(new Error('[core:forbidden] No.'))} />,
    );
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(document.body.dataset.result).toBe('threw [core:forbidden] No.'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives up quietly when the user cancels', async () => {
    const { user } = renderWithProviders(
      <StepUpProbe work={() => Promise.reject(STEP_UP_REFUSAL)} />,
    );
    await user.click(screen.getByRole('button', { name: 'Go' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.body.dataset.result).toBe('undefined'));
  });

  it('takes a code from the authenticator app when two-factor is on', async () => {
    const work = vi.fn().mockRejectedValueOnce(STEP_UP_REFUSAL).mockResolvedValue('done');
    const { user, queryClient } = renderWithProviders(<StepUpProbe work={work} />);
    queryClient.setQueryData(queryKeys.deployAccess(SERVER.id), {
      ...signedIn(),
      user: { userName: 'maria', roles: ['owner'], twoFactorEnabled: true },
    });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /authenticator app/ }));
    await user.type(within(dialog).getByLabelText('Authenticator code'), '123 456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(document.body.dataset.result).toBe('done'));
    expect(work).toHaveBeenLastCalledWith({ totpCode: '123456' });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(work).toHaveBeenCalledTimes(3));
  });

  it('can switch back to the password', async () => {
    const { user, queryClient } = renderWithProviders(
      <StepUpProbe work={() => Promise.reject(STEP_UP_REFUSAL)} />,
    );
    queryClient.setQueryData(queryKeys.deployAccess(SERVER.id), {
      ...signedIn(),
      user: { userName: 'maria', roles: ['owner'], twoFactorEnabled: true },
    });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /authenticator app/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Use your password' }));
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument();
  });
});
