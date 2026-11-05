import type { Project } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { ChooseFolderButton, needsFolder } = await import('./ChooseFolderButton');

const project = { id: 'p1', name: 'Shop', folderPath: '' } as Project;

describe('ChooseFolderButton', () => {
  it('knows a synced project that has no folder here', () => {
    expect(needsFolder(project)).toBe(true);
    expect(needsFolder({ folderPath: 'C:\\src\\shop' })).toBe(false);
  });

  it('sets the folder picked on this computer only', async () => {
    const view = renderWithProviders(<ChooseFolderButton project={project} />, {
      bridge: {
        'projects.pickFolder': () => '/Users/sam/shop',
        'projects.update': { ...project, folderPath: '/Users/sam/shop' },
      },
    });

    await view.user.click(screen.getByRole('button', { name: /Choose folder/ }));

    await waitFor(() =>
      expect(view.bridge.$fn('projects.update')).toHaveBeenCalledWith('p1', {
        folderPath: '/Users/sam/shop',
      }),
    );
  });

  it('does nothing when the picker is cancelled', async () => {
    const update = vi.fn();
    const view = renderWithProviders(<ChooseFolderButton project={project} />, {
      bridge: { 'projects.pickFolder': () => null, 'projects.update': update },
    });

    await view.user.click(screen.getByRole('button', { name: /Choose folder/ }));

    await waitFor(() => expect(view.bridge.$fn('projects.pickFolder')).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });
});
