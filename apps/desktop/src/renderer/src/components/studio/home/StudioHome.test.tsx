import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { PROJECT, settings, video } from '../testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { StudioHome } = await import('./StudioHome');

function renderHome(overrides: Record<string, unknown> = {}) {
  const onOpen = vi.fn();
  const view = renderWithProviders(<StudioHome onOpen={onOpen} onOpenDevSetup={vi.fn()} />, {
    bridge: {
      'projects.list': async () => [PROJECT],
      'studio.list': async () => [],
      'studio.settings': async () => settings(),
      ...overrides,
    },
  });
  return { ...view, onOpen };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('StudioHome', () => {
  it('shimmers a card at a time while the library loads', () => {
    renderHome({ 'studio.list': () => new Promise(() => undefined) });
    expect(screen.getByLabelText('Loading videos')).toHaveAttribute('aria-busy', 'true');
  });

  it('offers to make the first video when the library is empty', async () => {
    const { user } = renderHome();
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /New video/ });
    await user.click(buttons.at(-1) as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'New video' })).toBeInTheDocument();
  });

  it('shows each video with the project it belongs to, and opens one on click', async () => {
    const forProject = video({
      id: 'v2bbbbbbbbbbbbbb',
      title: 'Shop teaser',
      linkedProjectId: 'p1',
    });
    const { user, onOpen } = renderHome({ 'studio.list': async () => [forProject, video()] });
    const card = await screen.findByRole('article', { name: 'Shop teaser' });
    expect(within(card).getByText('Shop')).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'Launch film' })).getByText('Standalone'),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Shop teaser' }));
    expect(onOpen).toHaveBeenCalledWith(forProject);
  });

  it('lists only standalone videos when asked', async () => {
    const { user, bridge } = renderHome();
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('radio', { name: 'Standalone' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.list')).toHaveBeenCalledWith({ projectId: null }),
    );
  });

  it('says so when the library does not load, and tries again', async () => {
    let calls = 0;
    const { user } = renderHome({
      'studio.list': async () => {
        calls += 1;
        if (calls === 1) throw new Error('disk gone');
        return [];
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('disk gone');
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
  });

  it('adds an existing video folder', async () => {
    const { user, bridge } = renderHome({
      'studio.pickFolder': async () => 'D:\\Old\\Film-abc',
      'studio.addExisting': async () => video({ title: 'Old film' }),
    });
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('button', { name: /Add existing folder/ }));
    await waitFor(() =>
      expect(bridge.$fn('studio.addExisting')).toHaveBeenCalledWith('D:\\Old\\Film-abc'),
    );
    expect(toast.success).toHaveBeenCalledWith('Added "Old film" to the library.');
  });

  it('explains why a folder could not be added', async () => {
    const { user } = renderHome({
      'studio.pickFolder': async () => 'D:\\Random',
      'studio.addExisting': async () => {
        throw new Error(
          "Error invoking remote method 'studio:addExisting': Error: D:\\Random is not a Studio video folder.",
        );
      },
    });
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('button', { name: /Add existing folder/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('D:\\Random is not a Studio video folder.'),
    );
  });

  it('does nothing when the folder picker is cancelled', async () => {
    const { user, bridge } = renderHome({ 'studio.pickFolder': async () => null });
    await screen.findByText('No videos yet');
    await user.click(screen.getByRole('button', { name: /Add existing folder/ }));
    await waitFor(() => expect(bridge.$fn('studio.pickFolder')).toHaveBeenCalled());
    expect(() => bridge.$fn('studio.addExisting')).toThrow();
  });

  it('opens the saved recipes and starts a new video from one', async () => {
    const recipe = {
      id: 'r1',
      name: 'Explainer',
      brief: 'Explain the product',
      styleId: null,
      language: 'en',
      aspect: '1:1',
      targetSeconds: 45,
      scenario: { cliId: null },
      createdAt: 1,
      updatedAt: 1,
    };
    const { user } = renderHome({ 'studioAi.recipes': async () => [recipe] });
    await user.click(await screen.findByRole('button', { name: /Recipes/ }));
    const list = await screen.findByRole('dialog', { name: 'Recipes' });
    await user.click(await within(list).findByRole('button', { name: 'Use' }));
    const dialog = await screen.findByRole('dialog', { name: 'New video' });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('What is the video about?')).toHaveValue(
        'Explain the product',
      ),
    );
  });
});

describe('the order of the library', () => {
  const A = video({ id: 'vaaaaaaaaaaaaaaa', title: 'Alpha' });
  const B = video({ id: 'vbbbbbbbbbbbbbbb', title: 'Beta' });
  const C = video({ id: 'vccccccccccccccc', title: 'Gamma' });

  /** Lays the cards out one under another, 100px apart, so a drag has somewhere to land. */
  function stackCards() {
    const place = (element: HTMLElement) =>
      Array.from(element.parentElement?.children ?? []).indexOf(element);
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(0);
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return place(this) * 100;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90);
  }

  afterEach(() => vi.restoreAllMocks());

  const grip = (title: string) =>
    within(screen.getByRole('article', { name: title })).getByRole('img', {
      name: 'Drag to reorder',
    });

  it('saves the order a card is dragged into, and the card glides there', async () => {
    stackCards();
    const { bridge } = renderHome({ 'studio.list': async () => [A, B, C] });
    await screen.findByRole('article', { name: 'Alpha' });
    const handle = grip('Alpha');
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: 215, pointerId: 1 });
    // While held, the card follows the pointer and the others make room.
    expect(screen.getByRole('article', { name: 'Alpha' }).style.transform).toBe(
      'translate(0px, 200px)',
    );
    expect(screen.getByRole('article', { name: 'Beta' }).style.transform).toBe(
      'translate(0px, -100px)',
    );
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() =>
      expect(bridge.$fn('studio.reorder')).toHaveBeenCalledWith([B.id, C.id, A.id]),
    );
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
      'Beta',
      'Gamma',
      'Alpha',
    ]);
  });

  it('only reorders the whole library, never a filtered part of it', async () => {
    const { user } = renderHome({ 'studio.list': async () => [A, B] });
    await screen.findByRole('article', { name: 'Alpha' });
    expect(grip('Alpha')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Standalone' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: 'Alpha' })).queryByRole('img', {
          name: 'Drag to reorder',
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it('pins a video to its own group on top, and unpins it', async () => {
    let list = [A, B];
    const { user, bridge } = renderHome({
      'studio.list': async () => list,
      'studio.setPinned': async (id: string, pinned: boolean) => {
        list = list.map((v) => (v.id === id ? { ...v, pinned } : v));
        list.sort((x, y) => Number(y.pinned) - Number(x.pinned));
      },
    });
    const beta = await screen.findByRole('article', { name: 'Beta' });
    await user.click(within(beta).getByRole('button', { name: 'Pin to top' }));
    expect(bridge.$fn('studio.setPinned')).toHaveBeenCalledWith(B.id, true);
    const pinned = await screen.findByRole('region', { name: 'Pinned videos' });
    expect(within(pinned).getByRole('article', { name: 'Beta' })).toBeInTheDocument();
    expect(within(pinned).getByText('Pinned')).toBeInTheDocument();
    const unpin = within(pinned).getByRole('button', { name: 'Unpin video' });
    expect(unpin).toHaveAttribute('aria-pressed', 'true');
    await user.click(unpin);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Pinned videos' })).not.toBeInTheDocument(),
    );
  });
});
