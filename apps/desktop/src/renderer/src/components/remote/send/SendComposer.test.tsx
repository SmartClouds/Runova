import { EMPTY_FILE_SEND_STATE, type FileSendState, type SendRecipient } from '@shared/fileSend';
import { act, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { useFileSendStore } from '@/stores/fileSendStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SendComposer } from './SendComposer';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }),
}));

const kims: SendRecipient = {
  remoteId: '100000222',
  name: "Kim's laptop",
  platform: 'macos',
  kind: 'computer',
  relation: 'teammate',
  owner: { userId: 2, displayName: 'Kim', email: 'kim@example.com' },
  teams: ['Ops'],
  online: true,
  unavailable: null,
};

const ready: FileSendState = {
  ...EMPTY_FILE_SEND_STATE,
  available: true,
  status: 'online',
  recipients: [kims],
  staged: [
    { id: 'a', name: 'report.pdf', kind: 'file', size: 2_000, fileCount: 1 },
    { id: 'b', name: 'Holiday', kind: 'folder', size: 9_000, fileCount: 34 },
  ],
};

function show(state: FileSendState, bridge: Record<string, unknown> = {}) {
  const view = renderWithProviders(<SendComposer />, {
    bridge: { 'fileSend.send': { batchId: 'b1' }, ...bridge },
  });
  act(() => useFileSendStore.getState().set(state));
  return view;
}

describe('putting a send together', () => {
  it('names what goes where on the button', () => {
    show(ready);
    act(() => useFileSendStore.getState().pick(kims.remoteId));

    expect(screen.getByRole('button', { name: "Send 35 files to Kim's laptop" })).toBeEnabled();
  });

  it('says what is missing before it can send', () => {
    show({ ...ready, staged: [] });

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('Add files or a folder first.')).toBeInTheDocument();
  });

  it('asks for a device once there are files', () => {
    show(ready);

    expect(screen.getByRole('button', { name: 'Send 35 files' })).toBeDisabled();
    expect(screen.getByText('Pick who to send them to.')).toBeInTheDocument();
  });

  it('sends with the note, then clears the note', async () => {
    const { user, bridge } = show(ready);
    act(() => useFileSendStore.getState().pick(kims.remoteId));

    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'For the review');
    await user.click(screen.getByRole('button', { name: "Send 35 files to Kim's laptop" }));

    expect(bridge.$fn('fileSend.send')).toHaveBeenCalledWith({
      remoteId: kims.remoteId,
      note: 'For the review',
    });
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('sends with Ctrl+Enter', async () => {
    const { user, bridge } = show(ready);
    act(() => useFileSendStore.getState().pick(kims.remoteId));

    await user.click(screen.getByRole('textbox', { name: 'Note' }));
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(bridge.$fn('fileSend.send')).toHaveBeenCalled();
  });

  it('says why a send could not start', async () => {
    const { user } = show(ready, {
      'fileSend.send': () => Promise.reject(new Error('That is more than 10,000 files.')),
    });
    act(() => useFileSendStore.getState().pick(kims.remoteId));

    await user.click(screen.getByRole('button', { name: "Send 35 files to Kim's laptop" }));

    expect(toast.error).toHaveBeenCalledWith('That is more than 10,000 files.');
  });

  it('says what could not be added from a pick', async () => {
    const { user } = show(
      { ...ready, staged: [] },
      { 'fileSend.pickFiles': { staged: [], problems: ['empty: There are no files in it.'] } },
    );

    await user.click(screen.getByRole('button', { name: 'Choose files' }));

    expect(toast.warning).toHaveBeenCalledWith('Some of what you picked was left out', {
      description: 'empty: There are no files in it.',
    });
  });

  it('can not send while Runova Anywhere is offline', () => {
    show({ ...ready, available: false, status: 'offline' });
    act(() => useFileSendStore.getState().pick(kims.remoteId));

    expect(screen.getByRole('button', { name: "Send 35 files to Kim's laptop" })).toBeDisabled();
    expect(screen.getByText('Runova Anywhere is not connected right now.')).toBeInTheDocument();
  });
});
