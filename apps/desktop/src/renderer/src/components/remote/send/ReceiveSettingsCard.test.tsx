import { EMPTY_FILE_SEND_STATE, type FileSendState } from '@shared/fileSend';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFileSendStore } from '@/stores/fileSendStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ReceiveSettingsCard } from './ReceiveSettingsCard';

function show(settings: Partial<FileSendState['settings']> = {}) {
  const view = renderWithProviders(<ReceiveSettingsCard />, {
    bridge: { 'fileSend.chooseSaveFolder': async () => 'D:\\Inbox' },
  });
  act(() =>
    useFileSendStore.getState().set({
      ...EMPTY_FILE_SEND_STATE,
      available: true,
      settings: {
        receiveFrom: 'everyone',
        autoAcceptOwn: false,
        saveFolder: 'C:\\Users\\sam\\Downloads',
        defaultSaveFolder: 'C:\\Users\\sam\\Downloads',
        ...settings,
      },
    }),
  );
  return view;
}

describe('receiving on this computer', () => {
  it('says who may send files here, and changes it', async () => {
    const { user, bridge } = show();

    expect(screen.getByRole('radio', { name: 'My devices and teammates' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('radio', { name: 'Only my devices' }));
    await user.click(screen.getByRole('radio', { name: 'No one' }));

    expect(bridge.$fn('fileSend.updateSettings').mock.calls).toEqual([
      [{ receiveFrom: 'own' }],
      [{ receiveFrom: 'nobody' }],
    ]);
  });

  it('takes files from my own devices without asking once switched on', async () => {
    const { user, bridge } = show();

    await user.click(
      screen.getByRole('switch', { name: 'Accept from my own devices without asking' }),
    );

    expect(bridge.$fn('fileSend.updateSettings')).toHaveBeenCalledWith({ autoAcceptOwn: true });
  });

  it('changes the save folder, and goes back to Downloads', async () => {
    const { user, bridge } = show({ saveFolder: 'D:\\Inbox' });

    expect(screen.getByText('D:\\Inbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: 'Use Downloads' }));

    expect(bridge.$fn('fileSend.chooseSaveFolder')).toHaveBeenCalled();
    expect(bridge.$fn('fileSend.updateSettings')).toHaveBeenCalledWith({ saveFolder: null });
  });

  it('offers no reset while files already go to Downloads', () => {
    show();

    expect(screen.queryByRole('button', { name: 'Use Downloads' })).not.toBeInTheDocument();
  });
});
