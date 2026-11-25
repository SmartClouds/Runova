import type { RunnerCleanupScan, RunnerCleanupScanResult } from '@shared/apiTypes';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { RunnerCleanupDialog } = await import('./RunnerCleanupDialog');
const { useRunnerCleanupStore } = await import('@/stores/runnerCleanupStore');

const GB = 1024 ** 3;
const SSH = { kind: 'ssh' as const, serverId: 's1' };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const scan: RunnerCleanupScan = {
  scanId: 'scan-1',
  os: 'linux',
  scannedAt: Date.now(),
  disk: { usedBytes: 80 * GB, totalBytes: 100 * GB, mount: '/' },
  groups: [
    {
      id: 'r0',
      kind: 'runner',
      title: 'build-01',
      status: 'idle',
      items: [
        {
          id: 'r0-temp',
          label: 'Temporary files',
          why: 'Left by jobs.',
          bytes: GB,
          risk: 'safe',
          picked: true,
        },
        {
          id: 'r0-actions',
          label: 'Downloaded actions',
          why: 'Copies.',
          bytes: 2 * GB,
          risk: 'slows',
          picked: false,
        },
      ],
    },
  ],
  schedule: { installed: false, job: 'cron', schedule: null },
  notes: ['Docker is installed but Runova could not use it.'],
};

function open(bridge: Record<string, unknown>) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <RunnerCleanupDialog open onOpenChange={onOpenChange} link={SSH} machineName="build server" />,
    { bridge },
  );
  return { ...view, onOpenChange };
}

beforeEach(() => {
  useRunnerCleanupStore.setState({ machines: {} });
  vi.clearAllMocks();
});

describe('RunnerCleanupDialog', () => {
  it('scans the machine when it opens and shows each step', async () => {
    const answer = deferred<RunnerCleanupScanResult>();
    const { bridge } = open({ 'runnerCleanup.scan': () => answer.promise });
    expect(screen.getByRole('heading', { name: 'Clean up build server' })).toBeInTheDocument();
    expect(bridge.$fn('runnerCleanup.scan')).toHaveBeenCalledWith(SSH);
    expect(await screen.findByText('Finding runner folders')).toBeInTheDocument();
    answer.resolve({ ok: true, scan });
    expect(await screen.findByText('Up to 3.00 GB can be freed')).toBeInTheDocument();
  });

  it('shows the scan on the schedule tab too, then the job form', async () => {
    const answer = deferred<RunnerCleanupScanResult>();
    open({ 'runnerCleanup.scan': () => answer.promise });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(await screen.findByRole('progressbar', { name: 'Scan progress' })).toBeInTheDocument();
    expect(screen.getByText('Scanning build server')).toBeInTheDocument();
    answer.resolve({ ok: true, scan });
    expect(await screen.findByText('No scheduled cleanup yet')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Scan progress' })).not.toBeInTheDocument();
  });

  it('shows the disk, the notes and the findings, with the safe picks made', async () => {
    open({ 'runnerCleanup.scan': async () => ({ ok: true, scan }) });
    expect(await screen.findByText('80.0 GB of 100 GB used on /')).toBeInTheDocument();
    expect(screen.getByText('79% after cleanup')).toBeInTheDocument();
    expect(screen.getByText(scan.notes[0])).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Temporary files' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Downloaded actions' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Clean up 1.00 GB' })).toBeEnabled();
  });

  it('picks all, none or the recommended set', async () => {
    open({ 'runnerCleanup.scan': async () => ({ ok: true, scan }) });
    fireEvent.click(await screen.findByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'Clean up 3.00 GB' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(screen.getByRole('button', { name: 'Clean up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recommended' }));
    expect(screen.getByRole('button', { name: 'Clean up 1.00 GB' })).toBeEnabled();
  });

  it('confirms, cleans the picks and shows what was freed', async () => {
    const { bridge } = open({
      'runnerCleanup.scan': async () => ({ ok: true, scan }),
      'runnerCleanup.clean': async () => ({
        ok: true,
        outcomes: [{ id: 'r0-temp', status: 'done', freedBytes: GB }],
        freedBytes: GB,
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up 1.00 GB' }));
    await waitFor(() =>
      expect(bridge.$fn('runnerCleanup.clean')).toHaveBeenCalledWith({
        link: SSH,
        scanId: 'scan-1',
        itemIds: ['r0-temp'],
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Free 1.00 GB on build server?', variant: 'destructive' }),
    );
    expect(await screen.findByText('Freed 1.00 GB on build server.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeEnabled();
  });

  it('does nothing when the confirm is turned down', async () => {
    confirm.mockResolvedValueOnce(false);
    const clean = vi.fn();
    open({ 'runnerCleanup.scan': async () => ({ ok: true, scan }), 'runnerCleanup.clean': clean });
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up 1.00 GB' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(clean).not.toHaveBeenCalled();
  });

  it('says when there is nothing to clean', async () => {
    open({
      'runnerCleanup.scan': async () => ({ ok: true, scan: { ...scan, groups: [], notes: [] } }),
    });
    expect(await screen.findByText('Nothing to clean up on build server')).toBeInTheDocument();
  });

  it('offers to unlock the vault when the login is locked away', async () => {
    open({
      'runnerCleanup.scan': async () => ({ ok: false, reason: 'locked', error: 'Vault is locked' }),
    });
    expect(await screen.findByText('The Servers vault is locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  });

  it('offers to try again after a failure', async () => {
    let calls = 0;
    open({
      'runnerCleanup.scan': async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, reason: 'unreachable', error: 'Connection refused' }
          : { ok: true, scan };
      },
    });
    expect(await screen.findByText('Connection refused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Up to 3.00 GB can be freed')).toBeInTheDocument();
  });

  it('has a schedule tab with the job form', async () => {
    open({ 'runnerCleanup.scan': async () => ({ ok: true, scan }) });
    await screen.findByText('Up to 3.00 GB can be freed');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(screen.getByText('No scheduled cleanup yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument();
  });
});
