import { describe, expect, it } from 'vitest';
import {
  macCommands,
  pickInputBackend,
  type ScreenGeometry,
  windowsCommands,
  x11Commands,
} from './backends';

const geometry: ScreenGeometry = { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1.5 };

describe('picking an input backend', () => {
  it('drives Windows, macOS and X11, and says why it can not on Wayland', () => {
    expect(pickInputBackend('win32', {})).toEqual({ kind: 'windows' });
    expect(pickInputBackend('darwin', {})).toEqual({ kind: 'macos' });
    expect(pickInputBackend('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toEqual({
      kind: 'x11',
    });
    expect(pickInputBackend('linux', { DISPLAY: ':1' })).toEqual({ kind: 'x11' });
    expect(
      pickInputBackend('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }),
    ).toMatchObject({
      kind: 'none',
      reason: expect.stringMatching(/Wayland/),
    });
    expect(pickInputBackend('linux', {})).toMatchObject({
      kind: 'none',
      reason: expect.stringMatching(/display/),
    });
    expect(pickInputBackend('freebsd', {})).toMatchObject({ kind: 'none' });
  });
});

describe('Windows commands', () => {
  it('moves in physical pixels and clicks where the controller pointed', () => {
    expect(windowsCommands({ k: 'down', x: 0.5, y: 0.5, button: 'left' }, geometry)).toEqual([
      'M 1440 810',
      'E 2 0',
    ]);
    expect(windowsCommands({ k: 'up', x: 1, y: 1, button: 'right' }, geometry)).toEqual([
      'M 2879 1619',
      'E 16 0',
    ]);
  });

  it('scrolls a notch at a time and types text as Unicode', () => {
    expect(windowsCommands({ k: 'wheel', x: 0, y: 0, dx: 0, dy: 1 }, geometry)).toEqual([
      `E 2048 ${0x100000000 - 120}`,
    ]);
    expect(windowsCommands({ k: 'text', text: 'hé' }, geometry)).toEqual(['T 104', 'T 233']);
    expect(windowsCommands({ k: 'key', code: 'ArrowLeft', down: false }, geometry)).toEqual([
      'K 37 3',
    ]);
    expect(windowsCommands({ k: 'key', code: 'Unknown', down: true }, geometry)).toEqual([]);
  });
});

describe('macOS commands', () => {
  const retina: ScreenGeometry = { x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2 };

  it('moves in points, not pixels, from the display origin', () => {
    expect(macCommands({ k: 'move', x: 0.5, y: 0.5 }, retina)).toEqual(['M 720 450']);
    expect(macCommands({ k: 'move', x: 0, y: 0 }, { ...retina, x: -1440 })).toEqual(['M -1440 0']);
  });

  it('presses the right button at the pointer', () => {
    expect(macCommands({ k: 'down', x: 0.1, y: 0.1, button: 'right' }, retina)).toEqual([
      'M 144 90',
      'D 1 144 90',
    ]);
    expect(macCommands({ k: 'up', x: 0.1, y: 0.1, button: 'middle' }, retina)).toEqual([
      'M 144 90',
      'U 2 144 90',
    ]);
  });

  it('scrolls by lines and maps keys to macOS key codes', () => {
    expect(macCommands({ k: 'wheel', x: 0, y: 0, dx: 0, dy: 2 }, retina)).toEqual(['W -2 0']);
    expect(macCommands({ k: 'key', code: 'Enter', down: true }, retina)).toEqual(['K 36 1']);
    expect(macCommands({ k: 'key', code: 'MetaLeft', down: false }, retina)).toEqual(['K 55 0']);
    expect(macCommands({ k: 'text', text: 'a😀' }, retina)).toEqual(['T 97', 'T 128512']);
  });
});

describe('X11 commands', () => {
  const x11: ScreenGeometry = { x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1 };

  it('moves in root window pixels and uses X button numbers', () => {
    expect(x11Commands({ k: 'move', x: 0.25, y: 0.5 }, x11)).toEqual(['M 640 720']);
    expect(x11Commands({ k: 'down', x: 0, y: 0, button: 'middle' }, x11)).toEqual([
      'M 0 0',
      'B 2 1',
    ]);
    expect(x11Commands({ k: 'up', x: 0, y: 0, button: 'right' }, x11)).toEqual(['M 0 0', 'B 3 0']);
  });

  it('scrolls with buttons 4 and 5, one click per notch', () => {
    expect(x11Commands({ k: 'wheel', x: 0, y: 0, dx: 0, dy: 2 }, x11)).toEqual([
      'B 5 1',
      'B 5 0',
      'B 5 1',
      'B 5 0',
    ]);
    expect(x11Commands({ k: 'wheel', x: 0, y: 0, dx: 0, dy: -1 }, x11)).toEqual(['B 4 1', 'B 4 0']);
  });

  it('sends keysyms for keys and code points for text', () => {
    expect(x11Commands({ k: 'key', code: 'Enter', down: true }, x11)).toEqual([`K ${0xff0d} 1`]);
    expect(x11Commands({ k: 'key', code: 'F12', down: false }, x11)).toEqual([`K ${0xffc9} 0`]);
    expect(x11Commands({ k: 'text', text: 'Ab' }, x11)).toEqual(['T 65', 'T 98']);
  });
});
