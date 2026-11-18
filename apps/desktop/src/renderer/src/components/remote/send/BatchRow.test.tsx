import type { SendBatchView } from '@shared/fileSend';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BatchRow } from './BatchRow';

const NOW = 1_000_000;

function batch(change: Partial<SendBatchView> = {}): SendBatchView {
  return {
    id: 'b1',
    direction: 'out',
    peer: {
      name: 'Ali Rezaei',
      email: 'ali@example.com',
      deviceName: 'Office PC',
      platform: 'windows',
      kind: 'computer',
      relation: 'teammate',
      remoteId: '482193775',
    },
    phase: 'transferring',
    reason: null,
    note: null,
    fileCount: 35,
    files: [
      { transferId: 't1', path: 'report.pdf', size: 1_000, transferred: 1_000, status: 'done' },
      {
        transferId: 't2',
        path: 'Holiday/beach.jpg',
        size: 4_000,
        transferred: 0,
        status: 'queued',
      },
    ],
    moreFiles: 33,
    totalBytes: 1_000_000,
    transferredBytes: 460_000,
    doneFiles: 2,
    failedFiles: 0,
    bytesPerSecond: 19_083_264,
    secondsLeft: 70,
    startedAt: NOW - 10_000,
    finishedAt: null,
    answerBy: null,
    folder: null,
    transport: 'direct',
    ...change,
  };
}

function row(view: SendBatchView, compact = false) {
  return renderWithProviders(<BatchRow batch={view} now={NOW} compact={compact} />);
}

describe('a batch in the list', () => {
  it('names who it is with and says what it is doing, wrapping rather than cutting it off', () => {
    row(batch());

    expect(screen.getByRole('status')).not.toHaveClass('truncate');
    expect(screen.getByText('To Office PC')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sending 3 of 35, 18.2 MB/s, about 1 min left',
    );
    expect(screen.getByRole('progressbar', { name: 'To Office PC' })).toHaveAttribute(
      'aria-valuenow',
      '46',
    );
  });

  it('counts down while it waits for an answer, with no number on the bar', () => {
    row(batch({ phase: 'waiting', answerBy: NOW + 52_000, transferredBytes: 0 }));

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for Ali to accept, 52 s');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('cancels what is going', async () => {
    const { user, bridge } = row(batch());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(bridge.$fn('fileSend.cancel')).toHaveBeenCalledWith('b1');
  });

  it('opens the folder of what arrived', async () => {
    const { user, bridge } = row(
      batch({ direction: 'in', phase: 'done', doneFiles: 35, folder: '/inbox' }),
    );

    expect(screen.getByText('From Ali Rezaei')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show in folder' }));

    expect(bridge.$fn('fileSend.showInFolder')).toHaveBeenCalledWith('b1');
  });

  it('sends again a send that did not go through, or lets it go', async () => {
    const { user, bridge } = row(batch({ phase: 'declined', reason: 'Declined by Ali.' }));

    expect(screen.getByRole('status')).toHaveTextContent('Declined by Ali.');
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(bridge.$fn('fileSend.retry')).toHaveBeenCalledWith('b1');
    expect(bridge.$fn('fileSend.dismiss')).toHaveBeenCalledWith('b1');
  });

  it('lists its files on demand, and skips one that has not gone yet', async () => {
    const { user, bridge } = row(batch());

    await user.click(screen.getByRole('button', { name: 'Show files' }));
    // The name leads, so it is what survives a narrow list; its folder follows, quieter.
    expect(screen.getByText('beach.jpg')).toBeInTheDocument();
    expect(screen.getByText('Holiday')).toBeInTheDocument();
    expect(screen.getByText('and 33 more')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip Holiday/beach.jpg' }));

    expect(bridge.$fn('fileSend.cancelFile')).toHaveBeenCalledWith('b1', 't2');
  });

  it('opens a file that arrived', async () => {
    const { user, bridge } = row(
      batch({
        direction: 'in',
        phase: 'done',
        files: [
          {
            transferId: 't1',
            path: 'report.pdf',
            size: 1_000,
            transferred: 1_000,
            status: 'done',
            savedPath: '/inbox/report.pdf',
          },
        ],
        moreFiles: 0,
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Show files' }));
    await user.click(screen.getByRole('button', { name: 'Open report.pdf' }));

    expect(bridge.$fn('fileSend.openFile')).toHaveBeenCalledWith('b1', 't1');
  });

  it('says a failure in full, with no empty runway under a send that never started', () => {
    row(
      batch({
        phase: 'failed',
        transferredBytes: 0,
        reason: 'That device is offline. It needs Runova open and signed in.',
      }),
    );

    expect(screen.getByRole('status')).not.toHaveClass('truncate');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('leaves the file list out when drawn small', () => {
    row(batch(), true);

    expect(screen.queryByRole('button', { name: 'Show files' })).not.toBeInTheDocument();
  });
});
