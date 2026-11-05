import { act } from '@testing-library/react';
import { vi } from 'vitest';

interface RenderOptions {
  sitekey: string;
  action: string;
  theme?: string;
  size?: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
}

interface Widget {
  id: string;
  element: HTMLElement;
  options: RenderOptions;
}

/**
 * Cloudflare's `window.turnstile` for component tests: it renders nothing, and a test plays the
 * person passing the check (`solve`), the token running out (`expire`) or the widget failing.
 */
export function fakeTurnstile() {
  const widgets: Widget[] = [];
  const api = {
    render: vi.fn((element: HTMLElement, options: RenderOptions) => {
      const id = `widget-${widgets.length + 1}`;
      widgets.push({ id, element, options });
      return id;
    }),
    reset: vi.fn((_id: string) => {}),
    remove: vi.fn((_id: string) => {}),
  };
  vi.stubGlobal('turnstile', api);

  const widget = (action?: string) => {
    const found = action
      ? widgets.filter((w) => w.options.action === action).at(-1)
      : widgets.at(-1);
    if (!found)
      throw new Error(`No Turnstile widget${action ? ` for ${action}` : ''} was rendered`);
    return found;
  };

  return {
    api,
    widgets,
    widget,
    solve: (token: string, action?: string) => act(() => widget(action).options.callback(token)),
    expire: (action?: string) => act(() => widget(action).options['expired-callback']()),
    fail: (action?: string) => act(() => widget(action).options['error-callback']()),
  };
}

export const captchaOn = { provider: 'turnstile', siteKey: '0x4AAAAAAAsitekey' } as const;
