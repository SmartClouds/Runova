import { EMPTY_FILE_SEND_STATE, type SendBatchView, type SendOfferView } from '@shared/fileSend';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFileSendStore } from '@/stores/fileSendStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { FileSendSegment } from './FileSendSegment';

function batch(change: Partial<SendBatchView>): SendBatchView {
  return {
    id: 'b1',
    direction: 'out',
    peer: {
      name: 'Ali',
      email: '',
      deviceName: 'Office PC',
      platform: 'windows',
      kind: 'computer',
      relation: 'teammate',
      remoteId: '482193775',
    },
    phase: 'transferring',
    reason: null,
    note: null,
    fileCount: 3,
    files: [],
    moreFiles: 0,
    totalBytes: 100,
    transferredBytes: 46,
    doneFiles: 1,
    failedFiles: 0,
    bytesPerSecond: null,
    secondsLeft: null,
    startedAt: 0,
    finishedAt: null,
    answerBy: null,
    folder: null,
    transport: 'direct',
    ...change,
  };
}

function show(batches: SendBatchView[], offers: SendOfferView[] = []) {
  const view = renderWithProviders(<FileSendSegment />);
  act(() =>
    useFileSendStore.getState().set({ ...EMPTY_FILE_SEND_STATE, available: true, batches, offers }),
  );
  return view;
}

describe('file sends in the status bar', () => {
  it('stays out of the way while nothing moves', () => {
    const { container } = show([batch({ phase: 'done' })]);

    expect(container).toBeEmptyDOMElement();
  });

  it('says how far a send is', () => {
    show([batch({})]);

    expect(screen.getByRole('button', { name: 'Sending files: 46%' })).toBeInTheDocument();
  });

  it('says how far everything moving is, both ways', () => {
    show([batch({}), batch({ id: 'b2', direction: 'in', totalBytes: 100, transferredBytes: 0 })]);

    expect(
      screen.getByRole('button', { name: 'Sending and receiving files: 23%' }),
    ).toBeInTheDocument();
  });

  it('says when files wait for an answer here', () => {
    show([batch({ direction: 'in', phase: 'asking' })], [{} as SendOfferView]);

    expect(
      screen.getByRole('button', { name: 'Files are waiting for your answer' }),
    ).toBeInTheDocument();
  });

  it('opens on what is moving, with the way to the Send files tab', async () => {
    const { user } = show([batch({})]);

    await user.click(screen.getByRole('button', { name: 'Sending files: 46%' }));

    expect(screen.getByText('To Office PC')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Send files' })).toHaveAttribute(
      'href',
      '/remote?tab=send',
    );
  });
});
