// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { BrowserNavState } from '@/lib/browser/browserRuntime';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BrowserToolbar, type BrowserToolbarProps } from './BrowserToolbar';

const nav: BrowserNavState = {
  url: 'http://localhost:5173/pricing',
  title: 'Pricing',
  faviconUrl: null,
  loading: false,
  canGoBack: true,
  canGoForward: false,
  webContentsId: 42,
  error: null,
};

function setup(overrides: Partial<BrowserToolbarProps> = {}) {
  const props: BrowserToolbarProps = {
    nav,
    viewport: 'responsive',
    picking: null,
    commentCount: 0,
    focusAddressToken: 0,
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onStop: vi.fn(),
    onPick: vi.fn(),
    onViewport: vi.fn(),
    onDevTools: vi.fn(),
    onOpenExternal: vi.fn(),
    onCopyUrl: vi.fn(),
    ...overrides,
  };
  return { ...renderWithProviders(<BrowserToolbar {...props} />), props };
}

describe('navigation buttons', () => {
  it('goes back and forward only when there is history that way', async () => {
    const { user, props } = setup();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('reloads, or stops while loading', async () => {
    const { user, props, unmount } = setup();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(props.onReload).toHaveBeenCalledWith(false);
    unmount();
    const loading = setup({ nav: { ...nav, loading: true } });
    await loading.user.click(screen.getByRole('button', { name: 'Stop loading' }));
    expect(loading.props.onStop).toHaveBeenCalled();
  });
});

describe('address bar', () => {
  it('shows the address without its scheme until focused', async () => {
    const { user } = setup();
    const input = screen.getByRole('textbox', { name: 'Address' });
    expect(input).toHaveValue('localhost:5173/pricing');
    await user.click(input);
    expect(input).toHaveValue('http://localhost:5173/pricing');
  });

  it('opens what was typed on Enter', async () => {
    const { user, props } = setup();
    const input = screen.getByRole('textbox', { name: 'Address' });
    await user.click(input);
    await user.clear(input);
    await user.type(input, 'localhost:3000{Enter}');
    expect(props.onNavigate).toHaveBeenCalledWith('http://localhost:3000/');
  });

  it('keeps what was typed before the focus frame selects the address', async () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      const { user, props } = setup();
      const input = screen.getByRole('textbox', { name: 'Address' });
      await user.click(input);
      await user.clear(input);
      await user.type(input, 'lo');
      for (const frame of frames.splice(0)) frame(0);
      await user.keyboard('calhost:3000{Enter}');
      expect(props.onNavigate).toHaveBeenCalledWith('http://localhost:3000/');
    } finally {
      raf.mockRestore();
    }
  });

  it('puts the address back on Esc', async () => {
    const { user, props } = setup();
    const input = screen.getByRole('textbox', { name: 'Address' });
    await user.click(input);
    await user.clear(input);
    await user.type(input, 'nothing{Escape}');
    expect(input).toHaveValue('localhost:5173/pricing');
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('warns about a plain http site, but not about a local one', () => {
    const { unmount } = setup();
    expect(screen.queryByText('Not secure')).toBeNull();
    unmount();
    setup({ nav: { ...nav, url: 'http://example.com/' } });
    expect(screen.getByText('Not secure')).toBeInTheDocument();
  });

  it('takes focus when asked', () => {
    const { rerender, props } = setup();
    rerender(
      <TooltipProvider>
        <BrowserToolbar {...props} focusAddressToken={1} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveFocus();
  });

  it('shows a progress bar while loading', () => {
    setup({ nav: { ...nav, loading: true } });
    expect(screen.getByRole('progressbar', { name: 'Loading page' })).toBeInTheDocument();
  });
});

describe('element tools', () => {
  it('toggles picking to copy and to comment, showing which is on', async () => {
    const { user, props, unmount } = setup();
    await user.click(screen.getByRole('button', { name: /Pick an element to copy/ }));
    expect(props.onPick).toHaveBeenCalledWith('copy');
    await user.click(screen.getByRole('button', { name: /Comment on an element/ }));
    expect(props.onPick).toHaveBeenCalledWith('comment');
    unmount();
    setup({ picking: 'comment', commentCount: 3 });
    expect(screen.getByRole('button', { name: /Comment on an element/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('menus', () => {
  it('switches the device size', async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole('button', { name: /Device size/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Mobile/ }));
    expect(props.onViewport).toHaveBeenCalledWith('mobile');
  });

  it('opens DevTools, the system browser and copies the address', async () => {
    const { user, props } = setup();
    for (const item of ['Open DevTools', 'Open in system browser', 'Copy address']) {
      await user.click(screen.getByRole('button', { name: 'More' }));
      await user.click(await screen.findByRole('menuitem', { name: new RegExp(item) }));
    }
    expect(props.onDevTools).toHaveBeenCalled();
    expect(props.onOpenExternal).toHaveBeenCalled();
    expect(props.onCopyUrl).toHaveBeenCalled();
  });

  it('keeps the page tools off while there is no page', () => {
    setup({ nav: { ...nav, url: '' } });
    expect(screen.getByRole('button', { name: /Comment on an element/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
  });

  it('does not treat Enter inside the address as a page shortcut', () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Address' }), { key: 'Enter' });
    expect(props.onNavigate).toHaveBeenCalledWith('http://localhost:5173/pricing');
  });
});
