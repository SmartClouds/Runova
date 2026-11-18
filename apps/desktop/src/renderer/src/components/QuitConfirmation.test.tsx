import type { OpenSessionSummary } from '@shared/apiTypes';
import { QUIT_CONFIRM_LABEL, QUIT_CONFIRM_TITLE } from '@shared/quitConfirmation';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';
import { ConfirmDialogHost } from './ConfirmDialog';
import { QuitConfirmation } from './QuitConfirmation';

/**
 * Main asks the renderer before closing the window while agents or server connections are still
 * up, and blocks on the answer. If this component ever failed to answer, the app would hang on
 * quit, so every test here follows the reply all the way back to app.answerQuit.
 */

function summary(overrides: Partial<OpenSessionSummary> = {}): OpenSessionSummary {
  return { clis: 2, ssh: 0, rdp: 0, fileSends: 0, clisKeepRunning: false, ...overrides };
}

/** The component renders nothing of its own; the question goes through the shared modal. */
function renderQuitFlow() {
  return renderWithProviders(
    <>
      <QuitConfirmation />
      <ConfirmDialogHost />
    </>,
  );
}

describe('QuitConfirmation', () => {
  it('subscribes to the main process and shows nothing until it is asked', () => {
    const { bridge } = renderQuitFlow();

    expect(bridge.$listenerCount('app.onConfirmQuit')).toBe(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the confirmation with what is still running', async () => {
    const { bridge } = renderQuitFlow();

    act(() => bridge.$emit('app.onConfirmQuit', summary({ clis: 2, ssh: 1 })));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(QUIT_CONFIRM_TITLE);
    expect(dialog.textContent).toContain('2 CLI sessions and 1 SSH connection');
    expect(screen.getByRole('button', { name: QUIT_CONFIRM_LABEL })).toBeTruthy();
  });

  it('tells main to go ahead when the user confirms', async () => {
    const { bridge, user } = renderQuitFlow();
    act(() => bridge.$emit('app.onConfirmQuit', summary()));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: QUIT_CONFIRM_LABEL }));

    await waitFor(() => expect(bridge.$fn('app.answerQuit')).toHaveBeenCalledWith(true));
  });

  it('tells main to stay open when the user cancels', async () => {
    const { bridge, user } = renderQuitFlow();
    act(() => bridge.$emit('app.onConfirmQuit', summary({ clis: 0, rdp: 1 })));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(bridge.$fn('app.answerQuit')).toHaveBeenCalledWith(false));
  });

  it('still answers when the window is closed twice in a row', async () => {
    const { bridge, user } = renderQuitFlow();

    act(() => bridge.$emit('app.onConfirmQuit', summary()));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bridge.$fn('app.answerQuit')).toHaveBeenCalledWith(false));

    act(() => bridge.$emit('app.onConfirmQuit', summary({ clis: 1, clisKeepRunning: true })));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('running in the background');

    await user.click(screen.getByRole('button', { name: QUIT_CONFIRM_LABEL }));
    await waitFor(() => expect(bridge.$fn('app.answerQuit')).toHaveBeenLastCalledWith(true));
  });

  it('stops listening once the shell unmounts', () => {
    const { bridge, unmount } = renderQuitFlow();

    unmount();

    expect(bridge.$listenerCount('app.onConfirmQuit')).toBe(0);
  });
});
