import { EventEmitter } from 'node:events';
import type { CaptureRouteInput } from '@runova/studio/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../../../test/main/fixtures';
import { createProjectCapture } from './projectCapture';

/**
 * The Pictures step against stand-ins for Electron and the project's process: the test plays the
 * page (how it loads, what it paints, what it answers) and the command (what it prints, how it
 * ends). A real page needs a real Electron, so projectCapture.test.ts only covers a real command.
 */

type Listener = (...args: unknown[]) => void;

interface FakeWindow {
  options: Record<string, unknown>;
  contentSize: [number, number] | null;
  destroyed: boolean;
  destroyCalls: number;
  listeners: Record<string, Listener>;
  openHandler: (() => { action: string }) | null;
  scripts: string[];
  css: string[];
  loaded: string[];
  debuggerCommands: [string, unknown][];
  attached: string[];
}

interface FakeSession {
  partition: string;
  requestHandlers: ((c: unknown, p: string, cb: (ok: boolean) => void) => void)[];
  checkHandlers: (() => boolean)[];
}

interface FakeSource {
  id: string;
  name: string;
  thumbnail: {
    isEmpty: () => boolean;
    toDataURL: () => string;
    toPNG: () => Buffer;
  };
}

const page = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  sessions: new Map<string, FakeSession>(),
  /** The picture the page shows on its nth paint, or null while it has drawn nothing. */
  frame: (_paint: number): string | null => 'steady',
  /** The status the page answers with. */
  status: 200,
  loadError: null as unknown,
  /** What a script run in the page answers; a thrown error is a page that went away. */
  exec: (code: string): unknown => (code.startsWith('!!') ? true : null),
  /** Closes the window while the page loads. */
  closesItself: false,
  sources: [] as FakeSource[],
  sourceRequests: [] as unknown[],
  display: { size: { width: 1920, height: 1080 }, scaleFactor: 2 },
  fetch: vi.fn(),
}));

vi.mock('electron', () => {
  class BrowserWindow {
    contentSize: [number, number] | null = null;
    destroyed = false;
    destroyCalls = 0;
    listeners: Record<string, Listener> = {};
    openHandler: FakeWindow['openHandler'] = null;
    scripts: string[] = [];
    css: string[] = [];
    loaded: string[] = [];
    debuggerCommands: [string, unknown][] = [];
    attached: string[] = [];
    webContents: Record<string, unknown>;
    constructor(readonly options: Record<string, unknown>) {
      page.windows.push(this as unknown as FakeWindow);
      const self = this;
      let paints = 0;
      const image = (label: string) => ({
        toBitmap: () => Buffer.from(label),
        toPNG: () => Buffer.from(`png:${label}`),
      });
      this.webContents = {
        setFrameRate: vi.fn(),
        on: (name: string, fn: Listener) => {
          self.listeners[name] = fn;
        },
        setWindowOpenHandler: (fn: FakeWindow['openHandler']) => {
          self.openHandler = fn;
        },
        debugger: {
          attach: (version: string) => self.attached.push(version),
          sendCommand: async (name: string, params: unknown) => {
            self.debuggerCommands.push([name, params]);
          },
        },
        loadURL: async (url: string) => {
          if (page.loadError !== null) throw page.loadError;
          self.loaded.push(url);
          self.listeners['did-navigate']?.({}, url, page.status);
          if (page.closesItself) self.destroyed = true;
        },
        insertCSS: async (css: string) => {
          self.css.push(css);
        },
        executeJavaScript: async (code: string) => {
          self.scripts.push(code);
          return page.exec(code);
        },
        invalidate: () => {
          paints += 1;
          const label = page.frame(paints);
          if (label !== null) self.listeners.paint?.({}, {}, image(label));
        },
      };
    }
    setContentSize(width: number, height: number) {
      this.contentSize = [width, height];
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyCalls += 1;
      this.destroyed = true;
    }
    async loadURL(url: string) {
      this.loaded.push(url);
    }
  }
  return {
    BrowserWindow,
    desktopCapturer: {
      getSources: async (request: unknown) => {
        page.sourceRequests.push(request);
        return page.sources;
      },
    },
    net: { fetch: page.fetch },
    screen: { getPrimaryDisplay: () => page.display },
    session: {
      fromPartition: (partition: string) => {
        const known = page.sessions.get(partition);
        if (known) return known;
        const created: FakeSession = {
          partition,
          requestHandlers: [],
          checkHandlers: [],
          setPermissionRequestHandler(fn: FakeSession['requestHandlers'][number]) {
            created.requestHandlers.push(fn);
          },
          setPermissionCheckHandler(fn: FakeSession['checkHandlers'][number]) {
            created.checkHandlers.push(fn);
          },
        } as FakeSession;
        page.sessions.set(partition, created);
        return created;
      },
    },
  };
});

const proc = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: proc.spawn }));

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;

  say(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }
}

let children: FakeChild[] = [];
const killTree = vi.fn();
let capture: ReturnType<typeof createProjectCapture>;

beforeEach(() => {
  // A new host each time: it remembers the apps it started, by key.
  capture = createProjectCapture({
    env: async () => ({ PATH: '/tools' }),
    killTree: killTree as never,
  });
  page.windows = [];
  page.sessions = new Map();
  page.frame = () => 'steady';
  page.status = 200;
  page.loadError = null;
  page.exec = (code) => (code.startsWith('!!') ? true : null);
  page.closesItself = false;
  page.sources = [];
  page.sourceRequests = [];
  page.display = { size: { width: 1920, height: 1080 }, scaleFactor: 2 };
  page.fetch.mockReset();
  children = [];
  killTree.mockReset();
  proc.spawn.mockReset();
  proc.spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const route = (over: Partial<CaptureRouteInput> = {}): CaptureRouteInput => ({
  partition: 'persist:studio-p1',
  url: 'http://localhost:5173/settings',
  width: 1280,
  height: 720,
  scale: 1.5,
  timeoutMs: 1000,
  ...over,
});

/** Runs the page's timers to the end of a capture. */
async function drive<T>(work: Promise<T>): Promise<T> {
  // Attached now, so a capture that fails before the timers finish is not reported as unhandled.
  work.catch(() => undefined);
  await vi.runAllTimersAsync();
  return work;
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString();

describe('captureRoute', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('takes the page at its output size in a locked down window, then closes it', async () => {
    const picture = await drive(capture.captureRoute(route()));
    expect(text(picture)).toBe('png:steady');

    const [win] = page.windows as [FakeWindow];
    expect(win.options).toMatchObject({ show: false, width: 1920, height: 1080 });
    expect(win.options.webPreferences).toMatchObject({
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1.5,
    });
    expect(win.contentSize).toEqual([1920, 1080]);
    expect(win.loaded).toEqual(['http://localhost:5173/settings']);
    expect(win.css[0]).toContain('::-webkit-scrollbar');
    expect(win.destroyed).toBe(true);
    // No theme was asked for, so the debugger never attaches.
    expect(win.attached).toEqual([]);
  });

  it('waits for the page to stop changing and keeps the last picture', async () => {
    page.frame = (paint) => (paint < 4 ? `moving-${paint}` : 'settled');
    expect(text(await drive(capture.captureRoute(route())))).toBe('png:settled');
  });

  it('takes the picture anyway once a page has been changing for too long', async () => {
    page.frame = (paint) => `moving-${paint}`;
    expect(text(await drive(capture.captureRoute(route())))).toMatch(/^png:moving-\d+$/);
  });

  it('fails plainly when a page never draws', async () => {
    page.frame = () => null;
    await expect(drive(capture.captureRoute(route()))).rejects.toThrow('The page drew nothing.');
    expect(page.windows[0]?.destroyed).toBe(true);
  });

  it('keeps the page inside the app: other addresses and new windows are refused', async () => {
    await drive(capture.captureRoute(route()));
    const [win] = page.windows as [FakeWindow];
    const preventDefault = vi.fn();
    win.listeners['will-navigate']?.({ preventDefault }, 'http://localhost:5173/billing');
    expect(preventDefault).not.toHaveBeenCalled();
    win.listeners['will-navigate']?.({ preventDefault }, 'https://example.com/');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(win.openHandler?.()).toEqual({ action: 'deny' });
  });

  it('refuses the page every permission, and sets a session up once', async () => {
    await drive(capture.captureRoute(route()));
    await drive(capture.captureRoute(route()));
    const session = page.sessions.get('persist:studio-p1') as FakeSession;
    expect(session.requestHandlers).toHaveLength(1);
    const answer = vi.fn();
    session.requestHandlers[0]?.({}, 'media', answer);
    expect(answer).toHaveBeenCalledWith(false);
    expect(session.checkHandlers[0]?.()).toBe(false);
  });

  it('shows the page in the theme the shot asks for', async () => {
    await drive(capture.captureRoute(route({ theme: 'dark' })));
    const [win] = page.windows as [FakeWindow];
    expect(win.attached).toEqual(['1.3']);
    expect(win.debuggerCommands).toEqual([
      [
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
      ],
    ]);
  });

  it('says why a page did not open, whatever came back', async () => {
    page.loadError = new Error('ERR_CONNECTION_REFUSED');
    await expect(drive(capture.captureRoute(route()))).rejects.toThrow(
      'The page did not open: ERR_CONNECTION_REFUSED',
    );
    page.loadError = 'ERR_ABORTED';
    await expect(drive(capture.captureRoute(route()))).rejects.toThrow(
      'The page did not open: ERR_ABORTED',
    );
  });

  it('refuses a page that answered with an error status', async () => {
    page.status = 404;
    await expect(drive(capture.captureRoute(route()))).rejects.toThrow(
      'The page did not load: 404.',
    );
    expect(page.windows[0]?.destroyed).toBe(true);
  });

  it('leaves a window that closed by itself alone', async () => {
    page.closesItself = true;
    await drive(capture.captureRoute(route()));
    expect(page.windows[0]?.destroyCalls).toBe(0);
  });

  it('waits for what the shot names, through a page that is still navigating', async () => {
    let asked = 0;
    page.exec = (code) => {
      if (!code.startsWith('!!')) return null;
      asked += 1;
      if (asked === 1) throw new Error('the frame went away');
      return asked === 3;
    };
    await drive(capture.captureRoute(route({ waitFor: '#form' })));
    expect(asked).toBe(3);
    expect(page.windows[0]?.scripts[0]).toBe('!!document.querySelector("#form")');
  });

  it('gives up on what never shows', async () => {
    page.exec = (code) => (code.startsWith('!!') ? false : null);
    await expect(drive(capture.captureRoute(route({ waitFor: '#form' })))).rejects.toThrow(
      '#form never showed on the page.',
    );
  });

  it('plays the steps in the page in order, before the picture', async () => {
    const steps: CaptureRouteInput['steps'] = [
      { do: 'click', selector: '#tab' },
      { do: 'wait', ms: 500 },
    ];
    await drive(capture.captureRoute(route({ steps })));
    const stepScripts = (page.windows[0] as FakeWindow).scripts.filter((s) =>
      s.includes('const step ='),
    );
    expect(stepScripts).toHaveLength(2);
    expect(stepScripts[0]).toContain('"selector":"#tab"');
    expect(stepScripts[1]).toContain('"ms":500');
  });

  it('stops at the step that could not be played', async () => {
    page.exec = (code) => (code.includes('const step =') ? 'There is no #tab on the page.' : true);
    await expect(
      drive(capture.captureRoute(route({ steps: [{ do: 'click', selector: '#tab' }] }))),
    ).rejects.toThrow('There is no #tab on the page.');
    expect(page.windows[0]?.destroyed).toBe(true);
  });
});

describe('startApp', () => {
  /** Starts a command and waits until it has been spawned. */
  async function start(key = 'p1', signal = new AbortController().signal) {
    const lines: string[] = [];
    const before = children.length;
    const started = capture.startApp({
      key,
      folder: '/projects/shop',
      command: 'npm run dev',
      onLine: (line) => lines.push(line),
      signal,
    });
    started.catch(() => undefined);
    await vi.waitFor(() => expect(children).toHaveLength(before + 1));
    return { started, lines, child: children[before] as FakeChild };
  }

  it('runs the command through cmd on Windows, with color and browsers off', async () => {
    await withPlatform('win32', async () => {
      const { child, started } = await start();
      child.say('Local: http://localhost:3000/\n');
      await started;
    });
    expect(proc.spawn).toHaveBeenCalledWith('cmd.exe', ['/d', '/s', '/c', '"npm run dev"'], {
      cwd: '/projects/shop',
      env: { PATH: '/tools', FORCE_COLOR: '0', BROWSER: 'none' },
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it('runs the command in a shell of its own elsewhere', async () => {
    await withPlatform('linux', async () => {
      const { child, started } = await start();
      child.say('Local: http://localhost:3000/\n');
      await started;
    });
    expect(proc.spawn).toHaveBeenCalledWith('npm run dev', {
      cwd: '/projects/shop',
      env: { PATH: '/tools', FORCE_COLOR: '0', BROWSER: 'none' },
      shell: true,
      detached: true,
    });
  });

  it('passes on what the app prints without color or blank lines, on either stream', async () => {
    const { child, started, lines } = await start();
    child.say('\u001b[32mcompiling\u001b[39m\r\n\r\n');
    child.stderr.emit('data', Buffer.from('a warning\n'));
    child.say('  Local:   http://localhost:5173/\nand after the address\n');
    expect(await started).toEqual({ url: 'http://localhost:5173/' });
    expect(lines).toEqual([
      'compiling',
      'a warning',
      '  Local:   http://localhost:5173/',
      'and after the address',
    ]);
  });

  it('stops the copy still running before starting the same app again', async () => {
    const first = await start();
    const second = await start();
    expect(killTree).toHaveBeenCalledExactlyOnceWith(first.child);
    second.child.say('http://localhost:3000\n');
    await second.started;
  });

  it('does not stop a copy that has already ended', async () => {
    const first = await start();
    first.child.exitCode = 0;
    await start();
    expect(killTree).not.toHaveBeenCalled();
  });

  it('keeps track of the new copy when the old one ends late', async () => {
    const first = await start();
    const second = await start();
    killTree.mockClear();
    first.child.emit('exit', 0);
    await expect(first.started).rejects.toThrow(/exit code 0/);
    await capture.stopApp('p1');
    expect(killTree).toHaveBeenCalledExactlyOnceWith(second.child);
    second.child.say('http://localhost:3000\n');
    await second.started;
  });

  it('reports the last lines the app said when it stops before it is ready', async () => {
    const { child, started } = await start();
    for (const n of [1, 2, 3, 4, 5, 6]) child.say(`line ${n}\n`);
    child.emit('exit', 1);
    await expect(started).rejects.toThrow(
      'The app stopped (exit code 1) before it was ready. It said: line 2 / line 3 / line 4 / line 5 / line 6',
    );
  });

  it('reports an app that was killed before it said anything', async () => {
    const { child, started } = await start();
    child.emit('exit', null);
    await expect(started).rejects.toThrow(
      /^The app stopped \(exit code none\) before it was ready\.$/,
    );
  });

  it('fails with the error when the command cannot start', async () => {
    const { child, started } = await start();
    child.emit('error', new Error('spawn ENOENT'));
    await expect(started).rejects.toThrow('spawn ENOENT');
  });

  it('goes on without an address when the app stays quiet', async () => {
    vi.useFakeTimers();
    const started = capture.startApp({
      key: 'quiet',
      folder: '/projects/shop',
      command: 'npm run dev',
      onLine: () => undefined,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await started).toEqual({ url: null });
    await capture.stopApp('quiet');
  });

  it('stops the app when the user cancels', async () => {
    const abort = new AbortController();
    const { child, started } = await start('p1', abort.signal);
    abort.abort();
    await expect(started).rejects.toThrow('Stopped.');
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('ignores what happens after the answer is in', async () => {
    const { child, started } = await start();
    child.say('http://localhost:3000\n');
    child.say('http://localhost:4000\n');
    child.emit('exit', 1);
    expect(await started).toEqual({ url: 'http://localhost:3000' });
  });
});

describe('stopApp', () => {
  it('has nothing to do for an app it never started', async () => {
    await capture.stopApp('nobody');
    expect(killTree).not.toHaveBeenCalled();
  });

  it('leaves an app that has already ended alone', async () => {
    const started = capture.startApp({
      key: 'ended',
      folder: '/projects/shop',
      command: 'npm run dev',
      onLine: () => undefined,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const child = children[0] as FakeChild;
    child.say('http://localhost:3000\n');
    await started;
    child.exitCode = 0;
    await capture.stopApp('ended');
    expect(killTree).not.toHaveBeenCalled();
  });
});

describe('probe', () => {
  it('counts any answer as something serving, and no answer as nothing', async () => {
    page.fetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(capture.probe('http://localhost:3000')).resolves.toBe(true);
    page.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(capture.probe('http://localhost:3000')).resolves.toBe(false);
  });
});

describe('desktop windows', () => {
  const source = (id: string, name: string, empty = false): FakeSource => ({
    id,
    name,
    thumbnail: {
      isEmpty: () => empty,
      toDataURL: () => `data:image/png;base64,${id}`,
      toPNG: () => Buffer.from(`png:${id}`),
    },
  });

  it('lists the windows that have a name and something to show', async () => {
    page.sources = [source('w1', 'Shop'), source('w2', '   '), source('w3', 'Minimized', true)];
    await expect(capture.listWindows()).resolves.toEqual([
      { id: 'w1', name: 'Shop', thumbnail: 'data:image/png;base64,w1' },
    ]);
  });

  it('takes a window at the size of the screen', async () => {
    page.sources = [source('w1', 'Shop')];
    expect(text(await capture.captureWindow('w1'))).toBe('png:w1');
    expect(page.sourceRequests).toEqual([
      { types: ['window'], thumbnailSize: { width: 3840, height: 2160 } },
    ]);
  });

  it('takes a screen with no scale reported as one to one', async () => {
    page.display = { size: { width: 1600, height: 900 }, scaleFactor: 0 };
    page.sources = [source('w1', 'Shop')];
    await capture.captureWindow('w1');
    expect(page.sourceRequests).toEqual([
      { types: ['window'], thumbnailSize: { width: 1600, height: 900 } },
    ]);
  });

  it('asks for the window back when it is gone or minimized', async () => {
    const gone = 'That window is gone or minimized. Bring it back and try again.';
    page.sources = [source('w1', 'Shop', true)];
    await expect(capture.captureWindow('w1')).rejects.toThrow(gone);
    await expect(capture.captureWindow('w9')).rejects.toThrow(gone);
  });
});

describe('openSignIn', () => {
  it('opens the app in a visible window on the session the shots use', async () => {
    await capture.openSignIn({ partition: 'persist:studio-p2', url: 'http://localhost:3000' });
    const [win] = page.windows as [FakeWindow];
    expect(win.options).toMatchObject({ title: 'Sign in for screenshots' });
    expect(win.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: page.sessions.get('persist:studio-p2'),
    });
    expect(win.loaded).toEqual(['http://localhost:3000']);
    expect(win.openHandler?.()).toEqual({ action: 'deny' });
  });
});
