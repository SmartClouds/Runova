import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { video } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { VideoCard } = await import('./VideoCard');

function renderCard(
  props: Partial<Parameters<typeof VideoCard>[0]> = {},
  overrides: Record<string, unknown> = {},
) {
  const onOpen = vi.fn();
  const view = renderWithProviders(<VideoCard video={video()} onOpen={onOpen} {...props} />, {
    bridge: overrides,
  });
  return { ...view, onOpen };
}

async function openMenu(user: ReturnType<typeof renderCard>['user']) {
  await user.click(screen.getByRole('button', { name: 'More for Launch film' }));
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
  confirm.mockResolvedValue(true);
});

describe('VideoCard', () => {
  it('shows Persian titles right to left', () => {
    renderCard({ video: video({ title: 'فیلم معرفی' }) });
    expect(screen.getByText('فیلم معرفی')).toHaveAttribute('dir', 'rtl');
  });

  it('says when it was last opened', () => {
    renderCard({ video: video({ lastOpenedAt: Date.now() - 2 * 3600_000 }) });
    expect(screen.getByText('Opened 2 hours ago')).toBeInTheDocument();
  });

  it('opens the video from anywhere on the card, once', async () => {
    const { user, onOpen } = renderCard();
    await user.click(screen.getByText(/^Created /));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Launch film' }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('does not open the video when the menu is used', async () => {
    const { user, onOpen } = renderCard();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Open folder/ }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not underline or recolour the title on hover', () => {
    renderCard();
    const title = screen.getByRole('button', { name: 'Launch film' });
    expect(title.className).not.toMatch(/underline/);
    expect(title.className).not.toMatch(/hover:text-/);
  });

  it('sits on the same lifting card a project does, and lifts only an openable one', () => {
    const { unmount } = renderCard();
    const card = screen.getByRole('article', { name: 'Launch film' });
    expect(card.className).toMatch(/\bglass\b/);
    expect(card.className).toMatch(/hover:-translate-y-0\.5/);
    expect(card.className).toMatch(/hover:ring-primary\/30/);
    unmount();
    renderCard({ video: video({ missing: true }) });
    expect(screen.getByRole('article', { name: 'Launch film' }).className).not.toMatch(
      /hover:-translate-y/,
    );
  });

  it('shows its grip and pin only on hover or focus, unless the video is pinned', () => {
    const { unmount } = renderCard({ draggable: true, onTogglePin: vi.fn() });
    const reveal = /opacity-0 .*group-hover:opacity-100/;
    expect(screen.getByRole('img', { name: 'Drag to reorder' }).className).toMatch(reveal);
    expect(screen.getByRole('button', { name: 'Pin to top' }).className).toMatch(reveal);
    unmount();
    renderCard({ video: video({ pinned: true }), draggable: true, onTogglePin: vi.fn() });
    expect(screen.getByRole('button', { name: 'Unpin video' }).className).toMatch(/opacity-100/);
  });

  it('pins without opening the video', async () => {
    const onTogglePin = vi.fn();
    const { user, onOpen } = renderCard({ onTogglePin });
    await user.click(screen.getByRole('button', { name: 'Pin to top' }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('has no grip or pin where the card cannot be moved', () => {
    renderCard();
    expect(screen.queryByRole('img', { name: 'Drag to reorder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin to top' })).not.toBeInTheDocument();
  });

  it('opens the folder in the file manager', async () => {
    const { user, bridge } = renderCard();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Open folder/ }));
    expect(bridge.$fn('studio.revealVideo')).toHaveBeenCalledWith(video().id);
  });

  it('moves a video and puts the old copy in the trash when the user agrees', async () => {
    const moved = video({ folder: 'D:\\Archive\\Launch-film-v1aaaaaa' });
    const { user, bridge } = renderCard(
      {},
      {
        'studio.pickFolder': async () => 'D:\\Archive',
        'studio.move': async () => ({ video: moved, oldFolder: video().folder }),
      },
    );
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Move to another folder/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.trashOldFolder')).toHaveBeenCalledWith(video().folder),
    );
    expect(bridge.$fn('studio.move')).toHaveBeenCalledWith(video().id, 'D:\\Archive');
  });

  it('keeps the old copy when the user says so', async () => {
    confirm.mockResolvedValue(false);
    const { user, bridge } = renderCard(
      {},
      {
        'studio.pickFolder': async () => 'D:\\Archive',
        'studio.move': async () => ({ video: video(), oldFolder: video().folder }),
      },
    );
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Move to another folder/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(() => bridge.$fn('studio.trashOldFolder')).toThrow();
  });

  it('explains a move that failed', async () => {
    const { user } = renderCard(
      {},
      {
        'studio.pickFolder': async () => 'C:\\code\\shop',
        'studio.move': async () => {
          throw new Error("Videos can't be stored inside the project's folder.");
        },
      },
    );
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Move to another folder/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Videos can't be stored inside the project's folder.",
      ),
    );
  });

  it('removes a video from the library after asking, keeping its files', async () => {
    const { user, bridge } = renderCard();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Remove from library/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.removeFromLibrary')).toHaveBeenCalledWith(video().id),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: 'Remove from library' }),
    );
  });

  it('leaves it in the library when the user cancels', async () => {
    confirm.mockResolvedValue(false);
    const { user, bridge } = renderCard();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /Remove from library/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(() => bridge.$fn('studio.removeFromLibrary')).toThrow();
  });

  it('offers to locate a video whose folder disappeared, and cannot open it meanwhile', async () => {
    const { user, bridge, onOpen } = renderCard(
      { video: video({ missing: true }) },
      {
        'studio.pickFolder': async () => 'D:\\Found',
        'studio.locate': async () => video({ folder: 'D:\\Found' }),
      },
    );
    expect(screen.getByText(/The folder is gone/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Launch film' }));
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Locate' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.locate')).toHaveBeenCalledWith(video().id, 'D:\\Found'),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('explains a folder that is not this video', async () => {
    const { user } = renderCard(
      { video: video({ missing: true }) },
      {
        'studio.pickFolder': async () => 'D:\\Other',
        'studio.locate': async () => {
          throw new Error('That folder holds a different video.');
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Locate' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That folder holds a different video.'),
    );
  });

  it('names the project, or says it was removed', () => {
    const { unmount } = renderCard({
      video: video({ linkedProjectId: 'p1' }),
      projectName: 'Shop',
    });
    expect(screen.getByText('Shop')).toBeInTheDocument();
    unmount();
    renderCard({ video: video({ linkedProjectId: 'gone' }), projectName: null });
    expect(screen.getByText('Removed project')).toBeInTheDocument();
  });
});
