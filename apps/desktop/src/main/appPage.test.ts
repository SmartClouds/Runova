import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('electron', () => ({ shell: { openExternal } }));

const { isAppPage, keepOnAppPage } = await import('./appPage');

/** The app page as the built app loads it: out/renderer/index.html next to out/main. */
const appPage = pathToFileURL(join(__dirname, '../renderer/index.html')).href;

function navigate(contents: EventEmitter, event: 'will-navigate' | 'will-redirect', url: string) {
  const preventDefault = vi.fn();
  contents.emit(event, { preventDefault }, url);
  return preventDefault.mock.calls.length > 0;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  openExternal.mockClear();
  vi.stubEnv('ELECTRON_RENDERER_URL', '');
});

describe('keepOnAppPage', () => {
  it('lets the window move within the app page, with any query or route', () => {
    const contents = new EventEmitter();
    keepOnAppPage(contents as unknown as WebContents);

    expect(navigate(contents, 'will-navigate', `${appPage}?theme=dark#/projects`)).toBe(false);
  });

  it('never lets the window show another page, which would get the whole preload bridge', () => {
    const contents = new EventEmitter();
    keepOnAppPage(contents as unknown as WebContents);

    expect(navigate(contents, 'will-navigate', 'https://example.com/news')).toBe(true);
    expect(navigate(contents, 'will-redirect', 'https://example.com/elsewhere')).toBe(true);
    // A file dropped on the window.
    expect(navigate(contents, 'will-navigate', 'file:///C:/Users/me/Downloads/page.html')).toBe(
      true,
    );
    expect(navigate(contents, 'will-navigate', 'data:text/html,<p>x</p>')).toBe(true);
    // A web link opens in the browser instead, a file or data page nowhere.
    expect(openExternal.mock.calls).toEqual([
      ['https://example.com/news'],
      ['https://example.com/elsewhere'],
    ]);
  });

  it('allows only the dev server origin in development', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(isAppPage('http://localhost:5173/?x=1#/a')).toBe(true);
    expect(isAppPage('http://localhost:5174/')).toBe(false);
    expect(isAppPage(appPage)).toBe(false);
  });
});
