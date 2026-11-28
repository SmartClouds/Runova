import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RedoDialog } from './RedoDialog';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

function open(redo: unknown = async () => ({ redone: ['T004'], warnings: [], started: true })) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <RedoDialog
      open
      onOpenChange={onOpenChange}
      projectId="p1"
      taskIds={['T004']}
      currentAgent={null}
    />,
    {
      bridge: {
        'cli.detectAll': [
          { id: 'claude-code', installed: true },
          { id: 'codex-cli', installed: true },
        ],
        'relay.redo': redo,
      },
    },
  );
  return { ...view, onOpenChange };
}

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('RedoDialog', () => {
  it('redoes the task with the agent picked, learning from the last attempt by default', async () => {
    const { user, bridge, onOpenChange } = open();
    await user.click(screen.getByRole('combobox', { name: 'Agent' }));
    await user.click(await screen.findByRole('option', { name: /Codex/ }));
    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bridge.$fn('relay.redo')).toHaveBeenCalledWith({
      projectId: 'p1',
      taskIds: ['T004'],
      agent: 'codex-cli',
      keepLearnings: true,
      start: true,
    });
    expect(toast.success).toHaveBeenCalledWith('Running T004 again');
  });

  it('starts clean and later when asked, and keeps each task agent when none is picked', async () => {
    const { user, bridge } = open(async () => ({ redone: ['T004'], warnings: [], started: false }));
    await user.click(screen.getByRole('switch', { name: 'Learn from the earlier attempt' }));
    await user.click(screen.getByRole('switch', { name: 'Start now' }));
    await user.click(screen.getByRole('button', { name: 'Redo' }));

    await waitFor(() =>
      expect(bridge.$fn('relay.redo')).toHaveBeenCalledWith(
        expect.objectContaining({ agent: null, keepLearnings: false, start: false }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('T004 will start over');
  });

  it('says when the tasks were reset but the relay did not start', async () => {
    const { user } = open(async () => ({
      redone: ['T004'],
      warnings: ['T009 is not on the board, so it was not redone.'],
      started: false,
      error: 'A relay is already set up on this project.',
    }));
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.warning).toHaveBeenCalledWith('T009 is not on the board, so it was not redone.');
  });
});
