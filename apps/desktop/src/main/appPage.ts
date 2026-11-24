import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shell, type WebContents } from 'electron';

/** Whether `url` is the app's own page (the dev server's origin in development). */
export function isAppPage(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return target.origin === new URL(devServer).origin;
  const page = new URL(pathToFileURL(join(__dirname, '../renderer/index.html')).href);
  return target.protocol === 'file:' && target.pathname === page.pathname;
}

/**
 * Keeps a window that has the preload bridge on the app's own page. The bridge is exposed to
 * whatever document the window shows, so a link without a target, an image-map area in a news
 * post or a file dropped on the window would otherwise hand the whole window.runova API to that
 * page. A web link opens in the default browser instead, as a new-window link already does.
 */
export function keepOnAppPage(contents: WebContents): void {
  const stay = (event: { preventDefault(): void }, url: string): void => {
    if (isAppPage(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', stay);
  contents.on('will-redirect', stay);
}
