import { EMPTY_FILE_SEND_STATE, type SendBatchView } from '@shared/fileSend';
import { act } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileSendStore } from '@/stores/fileSendStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { FileSendToasts } from './FileSendToasts';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }),
}));

function batch(change: Partial<SendBatchView>): SendBatchView {
  return {
    id: 'b1',
    direction: 'in',
    peer: {
      name: 'Ali Rezaei',
      email: '',
      deviceName: "Ali's laptop",
      platform: 'macos',
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
    transferredBytes: 40,
    doneFiles: 0,
    failedFiles: 0,
    bytesPerSecond: null,
    secondsLeft: null,
    startedAt: 0,
    finishedAt: null,
    answerBy: null,
    folder: '/inbox',
    transport: 'direct',
    ...change,
  };
}

function update(batches: SendBatchView[]) {
  act(() =>
    useFileSendStore.getState().set({ ...EMPTY_FILE_SEND_STATE, available: true, batches }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('toasts for sends', () => {
  it('says when files arrive, with the way to their folder', async () => {
    const { bridge } = renderWithProviders(<FileSendToasts />);
    update([batch({})]);

    update([batch({ phase: 'done', doneFiles: 3 })]);

    expect(toast.success).toHaveBeenCalledWith('Received 3 files from Ali Rezaei', {
      description: 'Saved in /inbox',
      action: expect.objectContaining({ label: 'Show in folder' }),
    });
    const action = vi.mocked(toast.success).mock.calls[0][1] as unknown as {
      action: { onClick(): void };
    };
    action.action.onClick();
    expect(bridge.$fn('fileSend.showInFolder')).toHaveBeenCalledWith('b1');
  });

  it('says when a send arrived on the other side', () => {
    renderWithProviders(<FileSendToasts />);
    update([batch({ direction: 'out' })]);

    update([batch({ direction: 'out', phase: 'done', doneFiles: 3 })]);

    expect(toast.success).toHaveBeenCalledWith("Sent 3 files to Ali's laptop", expect.anything());
  });

  it('says why a send did not go through', () => {
    renderWithProviders(<FileSendToasts />);
    update([batch({ direction: 'out' })]);

    update([batch({ direction: 'out', phase: 'declined', reason: 'Declined by Ali.' })]);

    expect(toast.error).toHaveBeenCalledWith("Not sent to Ali's laptop", {
      description: 'Declined by Ali.',
    });
  });

  it('says nothing about what had already finished before', () => {
    renderWithProviders(<FileSendToasts />);

    update([batch({ phase: 'done', doneFiles: 3 })]);

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says nothing when the person here declined or cancelled', () => {
    renderWithProviders(<FileSendToasts />);
    update([batch({ phase: 'asking' })]);

    update([batch({ phase: 'declined', reason: 'You declined.' })]);

    expect(toast.error).not.toHaveBeenCalled();
  });
});
