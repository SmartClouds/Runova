import { type ChildProcess, spawn } from 'node:child_process';
import type { CaptureRouteInput, StudioCaptureHost } from '@runova/studio/node';
import {
  BrowserWindow,
  desktopCapturer,
  type NativeImage,
  net,
  type Session,
  screen,
  session,
} from 'electron';

/**
 * The Pictures step's hands (E58): runs the linked project's command, opens its pages in a hidden
 * offscreen window and takes them as pictures, and captures a desktop app's window. Like the scene
 * windows, pages are drawn offscreen (capturePage on a hidden window fails on this hardware) and
 * the picture is taken once the page has stopped changing.
 *
 * The project's own app is trusted the way its developer trusts it, but its window still gets no
 * preload, no Node, no permissions, and cannot leave the app's own address.
 */

export interface ProjectCaptureDeps {
  /** The environment a project's command runs with: the app's tool folders on PATH. */
  env(): Promise<NodeJS.ProcessEnv>;
  /** Stops a command and everything it started. */
  killTree(child: ChildProcess): void;
}

/** How long a command may print nothing like an address before Studio tries the one it knows. */
const QUIET_MS = 20_000;
/** How long a page's picture must stay the same before it counts as drawn. */
const STEADY_MS = 400;
const SETTLE_LIMIT_MS = 5000;

const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s'"`)]*)?/i;

// biome-ignore lint/suspicious/noControlCharactersInRegex: color codes are what this removes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The first local address in a line a dev server printed, as vite, next and others print it. */
export function detectLocalUrl(line: string): string | null {
  const found = LOCAL_URL.exec(line.replace(ANSI, ''));
  return found ? found[0].replace(/[.,;]+$/, '') : null;
}

const prepared = new WeakSet<Session>();

function captureSession(partition: string): Session {
  const ses = session.fromPartition(partition);
  if (prepared.has(ses)) return ses;
  prepared.add(ses);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One page step, run in the page; returns an error message, or null. */
function stepScript(step: NonNullable<CaptureRouteInput['steps']>[number]): string {
  const json = JSON.stringify(step);
  return `(() => {
    const step = ${json};
    if (step.do === 'wait') return null;
    const el = step.selector ? document.querySelector(step.selector) : null;
    if (step.selector && !el) return 'There is no ' + step.selector + ' on the page.';
    if (step.do === 'click') { el.scrollIntoView({ block: 'center' }); el.click(); return null; }
    if (step.do === 'type') {
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, step.text); else el.value = step.text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return null;
    }
    if (step.do === 'scroll') { (el || document.scrollingElement || document.body).scrollTo(0, step.y); return null; }
    return null;
  })()`;
}

export function createProjectCapture(deps: ProjectCaptureDeps): StudioCaptureHost {
  const running = new Map<string, ChildProcess>();

  async function captureRoute(input: CaptureRouteInput): Promise<Uint8Array> {
    const origin = new URL(input.url).origin;
    const width = Math.round(input.width * input.scale);
    const height = Math.round(input.height * input.scale);
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      enableLargerThanScreen: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        session: captureSession(input.partition),
        spellcheck: false,
        zoomFactor: input.scale,
      },
    });
    let latest: NativeImage | null = null;
    let status = 0;
    try {
      win.setContentSize(width, height);
      const wc = win.webContents;
      wc.setFrameRate(30);
      wc.on('paint', (_event, _dirty, image) => {
        latest = image;
      });
      wc.on('did-navigate', (_event, _url, code) => {
        status = code;
      });
      // The app may move between its own pages; anywhere else is refused.
      wc.on('will-navigate', (event, target) => {
        if (new URL(target).origin !== origin) event.preventDefault();
      });
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      if (input.theme) {
        wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: input.theme }],
        });
      }
      const until = Date.now() + input.timeoutMs;
      await wc.loadURL(input.url).catch((error: unknown) => {
        throw new Error(
          `The page did not open: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (status >= 400) throw new Error(`The page did not load: ${status}.`);
      await wc.insertCSS('::-webkit-scrollbar { display: none !important; }');
      if (input.waitFor) {
        const selector = JSON.stringify(input.waitFor);
        for (;;) {
          const found = await wc
            .executeJavaScript(`!!document.querySelector(${selector})`)
            .catch(() => false);
          if (found) break;
          if (Date.now() > until) throw new Error(`${input.waitFor} never showed on the page.`);
          await sleep(200);
        }
      }
      for (const step of input.steps ?? []) {
        const problem: string | null = await wc.executeJavaScript(stepScript(step));
        if (problem) throw new Error(problem);
        await sleep(step.do === 'wait' ? step.ms : 300);
      }
      await wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
      // The picture counts once it has stayed the same for a moment: animations and late images
      // settle first.
      const started = Date.now();
      let previous: { bitmap: Buffer; at: number } | null = null;
      for (;;) {
        wc.invalidate();
        await sleep(60);
        const now = Date.now();
        const image = latest as NativeImage | null;
        if (!image) {
          if (now - started > SETTLE_LIMIT_MS) throw new Error('The page drew nothing.');
          continue;
        }
        const bitmap = image.toBitmap();
        const same = previous?.bitmap.equals(bitmap) ?? false;
        if (now - started > SETTLE_LIMIT_MS || (same && now - (previous?.at ?? now) >= STEADY_MS)) {
          return new Uint8Array(image.toPNG());
        }
        if (!same) previous = { bitmap, at: now };
      }
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  return {
    async startApp({ key, folder, command, onLine, signal }) {
      const old = running.get(key);
      if (old && old.exitCode === null) deps.killTree(old);
      const env = { ...(await deps.env()), FORCE_COLOR: '0', BROWSER: 'none' };
      const child =
        process.platform === 'win32'
          ? // /s takes the outer quotes off and runs the rest as typed, as a terminal would.
            spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
              cwd: folder,
              env,
              windowsHide: true,
              windowsVerbatimArguments: true,
            })
          : spawn(command, { cwd: folder, env, shell: true, detached: true });
      running.set(key, child);
      return new Promise<{ url: string | null }>((resolve, reject) => {
        let settled = false;
        const tail: string[] = [];
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(quiet);
          fn();
        };
        const quiet = setTimeout(() => finish(() => resolve({ url: null })), QUIET_MS);
        const take = (chunk: Buffer) => {
          for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
            const line = raw.replace(ANSI, '').trimEnd();
            if (!line) continue;
            onLine(line);
            tail.push(line);
            if (tail.length > 5) tail.shift();
            const url = detectLocalUrl(line);
            if (url) finish(() => resolve({ url }));
          }
        };
        child.stdout?.on('data', take);
        child.stderr?.on('data', take);
        child.on('error', (error) => finish(() => reject(error)));
        child.on('exit', (code) => {
          if (running.get(key) === child) running.delete(key);
          finish(() =>
            reject(
              new Error(
                `The app stopped (exit code ${code ?? 'none'}) before it was ready.${tail.length ? ` It said: ${tail.join(' / ')}` : ''}`,
              ),
            ),
          );
        });
        signal.addEventListener(
          'abort',
          () => {
            deps.killTree(child);
            finish(() => reject(new Error('Stopped.')));
          },
          { once: true },
        );
      });
    },

    async stopApp(key) {
      const child = running.get(key);
      running.delete(key);
      if (child && child.exitCode === null) deps.killTree(child);
    },

    async probe(url) {
      try {
        // Any answer counts, even an error page: something is serving there.
        await net.fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
        return true;
      } catch {
        return false;
      }
    },

    captureRoute,

    async listWindows() {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 320, height: 200 },
      });
      return sources
        .filter((s) => s.name.trim() && !s.thumbnail.isEmpty())
        .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
    },

    async captureWindow(sourceId) {
      // The thumbnail is the window itself when it is asked for at the screen's full size.
      const display = screen.getPrimaryDisplay();
      const scale = display.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: {
          width: Math.round(display.size.width * scale),
          height: Math.round(display.size.height * scale),
        },
      });
      const source = sources.find((s) => s.id === sourceId);
      if (!source || source.thumbnail.isEmpty()) {
        throw new Error('That window is gone or minimized. Bring it back and try again.');
      }
      return new Uint8Array(source.thumbnail.toPNG());
    },

    async openSignIn({ partition, url }) {
      const win = new BrowserWindow({
        width: 1280,
        height: 860,
        title: 'Sign in for screenshots',
        autoHideMenuBar: true,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          session: captureSession(partition),
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await win.loadURL(url);
    },
  };
}
