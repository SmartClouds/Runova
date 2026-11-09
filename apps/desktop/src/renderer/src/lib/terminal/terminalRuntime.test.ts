import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who holds a session's terminal. The xterm side is stubbed; what matters is which element the
 * terminal ends up in, and that a shell starts once however many places ask for it.
 */

const resize = vi.hoisted(() => ({
  schedule: vi.fn(),
  flush: vi.fn(),
  repaint: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('./xtermFactory', () => ({
  createXterm: () => ({
    term: {
      open: vi.fn(),
      write: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      onTitleChange: () => ({ dispose: vi.fn() }),
      options: {},
      cols: 80,
      rows: 24,
      modes: { bracketedPasteMode: false },
    },
    fit: { fit: vi.fn() },
    chipMode: null,
    imagePreview: { dispose: vi.fn() },
  }),
  resolveWorkspaceTerminalTheme: () => ({ theme: {}, wellBackground: '#000' }),
  attachFocusOnClick: () => () => undefined,
  attachTerminalContextMenu: () => () => undefined,
}));
vi.mock('./resizeSync', () => ({ createResizeSync: () => resize }));
vi.mock('./fontReady', () => ({
  whenTerminalFontReady: () => Promise.resolve(),
  onFontsLoaded: vi.fn(),
}));
vi.mock('./pasteFiles', () => ({ attachTerminalPaste: () => () => undefined }));
vi.mock('./terminalRtl', () => ({ attachRtlRendering: () => () => undefined }));

const { terminalRuntime } = await import('./terminalRuntime');

const create = vi.fn((_options: unknown) => Promise.resolve({ snapshot: null }));

let counter = 0;
function spec() {
  counter += 1;
  return { id: `session-${counter}`, projectId: 'p1', initialInput: 'npm ci\r' };
}

function slot(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function parked(): HTMLElement | null {
  return document.getElementById('terminal-parking');
}

beforeEach(() => {
  create.mockClear();
  resize.schedule.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  Object.assign(window, {
    runova: {
      platform: 'win32',
      terminal: {
        create,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('terminalRuntime.start', () => {
  it('starts the shell with no pane showing it', async () => {
    const session = spec();

    terminalRuntime.start(session);

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      sessionId: session.id,
      attachOnly: false,
      initialInput: 'npm ci\r',
    });
    expect(parked()?.childElementCount).toBeGreaterThan(0);
    terminalRuntime.dispose(session.id);
  });

  it('runs the command once when a pane shows the session afterwards', async () => {
    const session = spec();
    const pane = slot();

    terminalRuntime.start(session);
    terminalRuntime.mount(session, pane);

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    expect(pane.childElementCount).toBe(1);
    terminalRuntime.dispose(session.id);
  });
});

describe('terminalRuntime.unmount', () => {
  it('hands the terminal back to the slot that had it before', () => {
    const session = spec();
    const workspace = slot();
    const dialog = slot();
    terminalRuntime.mount(session, workspace);
    const terminal = workspace.firstElementChild;

    terminalRuntime.mount(session, dialog);
    expect(terminal?.parentElement).toBe(dialog);

    terminalRuntime.unmount(session.id, dialog);
    expect(terminal?.parentElement).toBe(workspace);
    expect(resize.schedule).toHaveBeenCalled();
    terminalRuntime.dispose(session.id);
  });

  it('parks the terminal when no slot is left', () => {
    const session = spec();
    const pane = slot();
    terminalRuntime.mount(session, pane);
    const terminal = pane.firstElementChild;

    terminalRuntime.unmount(session.id, pane);

    expect(terminal?.parentElement).toBe(parked());
    terminalRuntime.dispose(session.id);
  });

  it('leaves the terminal where it is when an older slot goes away', () => {
    const session = spec();
    const oldPane = slot();
    const newPane = slot();
    terminalRuntime.mount(session, oldPane);
    terminalRuntime.mount(session, newPane);
    const terminal = newPane.firstElementChild;

    terminalRuntime.unmount(session.id, oldPane);
    expect(terminal?.parentElement).toBe(newPane);

    // The old pane is forgotten, so losing the new one parks it rather than reviving the old.
    terminalRuntime.unmount(session.id, newPane);
    expect(terminal?.parentElement).toBe(parked());
    terminalRuntime.dispose(session.id);
  });
});
