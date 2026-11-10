import type { RemoteInputEvent } from '../../../shared/remoteProtocol';

/**
 * How a remote controller's mouse and keyboard reach this computer, per OS (E63). Each one keeps a
 * small helper process alive and feeds it one short command per line, so no native module has to
 * be built or shipped:
 *
 * - Windows: PowerShell calling `SendInput` and friends.
 * - macOS: `osascript` (JavaScript for Automation) posting CGEvents. It needs the Accessibility
 *   permission, which macOS asks the person to grant.
 * - Linux on X11: `python3` calling XTest through ctypes, using libraries every X desktop has.
 * - Linux on Wayland: none yet. The compositor does not let one app drive the others without its
 *   remote-desktop portal, so a Wayland host is view only for now.
 *
 * The translation from a controller's event to the helper's commands is pure and tested here.
 */

/** The captured display, in the units Electron reports (DIP) plus its scale factor. */
export interface ScreenGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export type InputBackend =
  | { kind: 'windows' }
  | { kind: 'macos' }
  | { kind: 'x11' }
  | { kind: 'none'; reason: string };

export function pickInputBackend(
  platform: string,
  env: Record<string, string | undefined>,
): InputBackend {
  if (platform === 'win32') return { kind: 'windows' };
  if (platform === 'darwin') return { kind: 'macos' };
  if (platform === 'linux') {
    if (env.XDG_SESSION_TYPE === 'wayland' || (env.WAYLAND_DISPLAY && !env.DISPLAY)) {
      return {
        kind: 'none',
        reason:
          'This computer runs Wayland, which does not let Runova move the mouse or type yet. Others can see the screen but not control it. Sign in to an X11 session for full control.',
      };
    }
    if (env.DISPLAY) return { kind: 'x11' };
    return { kind: 'none', reason: 'No graphical display was found to control.' };
  }
  return { kind: 'none', reason: 'Remote control is not available on this operating system.' };
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max - 1, Math.round(value)));
}

/** A normalized point in physical pixels of the display, as Win32 and X11 want it. */
function physical(x: number, y: number, g: ScreenGeometry): [number, number] {
  const w = Math.round(g.width * g.scaleFactor);
  const h = Math.round(g.height * g.scaleFactor);
  return [clamp(x * w, w), clamp(y * h, h)];
}

/** A normalized point in global display points, as Quartz wants it. */
function points(x: number, y: number, g: ScreenGeometry): [number, number] {
  return [g.x + clamp(x * g.width, g.width), g.y + clamp(y * g.height, g.height)];
}

// --- Windows -------------------------------------------------------------------

const MOUSEEVENTF = {
  leftdown: 0x0002,
  leftup: 0x0004,
  rightdown: 0x0008,
  rightup: 0x0010,
  middledown: 0x0020,
  middleup: 0x0040,
  wheel: 0x0800,
} as const;

/** DOM `KeyboardEvent.code` to Win32 virtual-key code, for keys a Unicode character can not stand for. */
const VK_BY_CODE: Record<string, number> = {
  Enter: 0x0d,
  NumpadEnter: 0x0d,
  Tab: 0x09,
  Backspace: 0x08,
  Delete: 0x2e,
  Escape: 0x1b,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Insert: 0x2d,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  CapsLock: 0x14,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
};

const EXTENDED_CODES = new Set([
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete',
  'NumpadEnter',
  'ControlRight',
  'AltRight',
]);

export function windowsCommands(event: RemoteInputEvent, g: ScreenGeometry): string[] {
  switch (event.k) {
    case 'move': {
      const [x, y] = physical(event.x, event.y, g);
      return [`M ${x} ${y}`];
    }
    case 'down':
    case 'up': {
      const [x, y] = physical(event.x, event.y, g);
      const flag = MOUSEEVENTF[`${event.button}${event.k}` as keyof typeof MOUSEEVENTF];
      // Move first so the click lands where the controller pointed.
      return [`M ${x} ${y}`, `E ${flag} 0`];
    }
    case 'wheel': {
      // One notch is WHEEL_DELTA (120); scrolling down is a negative wheel value in Win32.
      const delta = Math.round(-event.dy) * 120;
      return [`E ${MOUSEEVENTF.wheel} ${delta < 0 ? delta + 0x100000000 : delta}`];
    }
    case 'key': {
      const vk = VK_BY_CODE[event.code];
      if (vk === undefined) return [];
      let flags = event.down ? 0 : 0x0002;
      if (EXTENDED_CODES.has(event.code)) flags |= 0x0001;
      return [`K ${vk} ${flags}`];
    }
    case 'text': {
      const out: string[] = [];
      for (const ch of event.text) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && cp <= 0xffff) out.push(`T ${cp}`);
      }
      return out;
    }
    default:
      return [];
  }
}

export const WINDOWS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public class RemoteInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void TypeChar(ushort c) {
    INPUT[] a = new INPUT[2];
    a[0].type = 1; a[0].U.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 0x0004, time = 0, dwExtraInfo = IntPtr.Zero };
    a[1].type = 1; a[1].U.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 0x0004 | 0x0002, time = 0, dwExtraInfo = IntPtr.Zero };
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
Add-Type -TypeDefinition $src
[RemoteInput]::SetProcessDPIAware() | Out-Null
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line.Length -eq 0) { continue }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'M' { [RemoteInput]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
      'E' { [RemoteInput]::mouse_event([uint32]$p[1], 0, 0, [uint32]$p[2], [IntPtr]::Zero) }
      'K' { [RemoteInput]::keybd_event([byte][int]$p[1], 0, [uint32]$p[2], [IntPtr]::Zero) }
      'T' { [RemoteInput]::TypeChar([uint16][int]$p[1]) }
      'Q' { break }
    }
  } catch {
    # Malformed command from a version-skewed parent process; drop and keep reading.
  }
}
`;

// --- macOS ---------------------------------------------------------------------

/** DOM `KeyboardEvent.code` to macOS virtual key code (Carbon's kVK_* values). */
const MAC_KEY_BY_CODE: Record<string, number> = {
  Enter: 36,
  NumpadEnter: 76,
  Tab: 48,
  Backspace: 51,
  Delete: 117,
  Escape: 53,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
  ShiftLeft: 56,
  ShiftRight: 60,
  ControlLeft: 59,
  ControlRight: 62,
  AltLeft: 58,
  AltRight: 61,
  MetaLeft: 55,
  MetaRight: 54,
  CapsLock: 57,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
};

const BUTTON_INDEX = { left: 0, right: 1, middle: 2 } as const;

export function macCommands(event: RemoteInputEvent, g: ScreenGeometry): string[] {
  switch (event.k) {
    case 'move': {
      const [x, y] = points(event.x, event.y, g);
      return [`M ${x} ${y}`];
    }
    case 'down':
    case 'up': {
      const [x, y] = points(event.x, event.y, g);
      return [
        `M ${x} ${y}`,
        `${event.k === 'down' ? 'D' : 'U'} ${BUTTON_INDEX[event.button]} ${x} ${y}`,
      ];
    }
    case 'wheel':
      // Quartz scrolls content up for a positive value; the controller's dy > 0 means "scroll down".
      return [`W ${-Math.round(event.dy)} ${-Math.round(event.dx)}`];
    case 'key': {
      const code = MAC_KEY_BY_CODE[event.code];
      return code === undefined ? [] : [`K ${code} ${event.down ? 1 : 0}`];
    }
    case 'text':
      return [...event.text].map((ch) => `T ${ch.codePointAt(0)}`);
    default:
      return [];
  }
}

/** JavaScript for Automation, run by `osascript -l JavaScript`, reading commands from stdin. */
export const MAC_HELPER = String.raw`
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
var DOWN = [1, 3, 25], UP = [2, 4, 26], DRAG = [6, 7, 27];
var held = -1;
function post(e) { $.CGEventPost(0, e); }
function mouse(type, x, y, button) { post($.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), button)); }
function handle(line) {
  var p = line.split(' ');
  switch (p[0]) {
    case 'M': mouse(held >= 0 ? DRAG[held] : 5, +p[1], +p[2], held >= 0 ? held : 0); break;
    case 'D': held = +p[1]; mouse(DOWN[held], +p[2], +p[3], held); break;
    case 'U': mouse(UP[+p[1]], +p[2], +p[3], +p[1]); held = -1; break;
    case 'W': post($.CGEventCreateScrollWheelEvent($(), 1, 2, +p[1], +p[2])); break;
    case 'K': post($.CGEventCreateKeyboardEvent($(), +p[1], p[2] === '1')); break;
    case 'T':
      var s = $.NSString.stringWithString(String.fromCodePoint(+p[1]));
      var down = $.CGEventCreateKeyboardEvent($(), 0, true);
      var up = $.CGEventCreateKeyboardEvent($(), 0, false);
      var length = s.length;
      var buffer = $.NSMutableData.dataWithLength(length * 2);
      s.getCharactersRange(buffer.mutableBytes, $.NSMakeRange(0, length));
      $.CGEventKeyboardSetUnicodeString(down, length, buffer.bytes);
      $.CGEventKeyboardSetUnicodeString(up, length, buffer.bytes);
      post(down); post(up);
      break;
  }
}
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput;
  var pending = '';
  for (;;) {
    var data = input.availableData;
    if (data.length === 0) return;
    pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    var lines = pending.split('\n');
    pending = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] === 'Q') return;
      try { if (lines[i]) handle(lines[i]); } catch (e) {}
    }
  }
}
`;

// --- X11 -----------------------------------------------------------------------

/** DOM `KeyboardEvent.code` to X11 keysym. */
const X11_KEYSYM_BY_CODE: Record<string, number> = {
  Enter: 0xff0d,
  NumpadEnter: 0xff8d,
  Tab: 0xff09,
  Backspace: 0xff08,
  Delete: 0xffff,
  Escape: 0xff1b,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  Insert: 0xff63,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
  CapsLock: 0xffe5,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
};

const X11_BUTTON = { left: 1, middle: 2, right: 3 } as const;

export function x11Commands(event: RemoteInputEvent, g: ScreenGeometry): string[] {
  switch (event.k) {
    case 'move': {
      const [x, y] = physical(event.x, event.y, g);
      return [`M ${x} ${y}`];
    }
    case 'down':
    case 'up': {
      const [x, y] = physical(event.x, event.y, g);
      return [`M ${x} ${y}`, `B ${X11_BUTTON[event.button]} ${event.k === 'down' ? 1 : 0}`];
    }
    case 'wheel': {
      const notches = Math.round(event.dy);
      const button = notches > 0 ? 5 : 4;
      return Array.from({ length: Math.abs(notches) }, () => [
        `B ${button} 1`,
        `B ${button} 0`,
      ]).flat();
    }
    case 'key': {
      const keysym = X11_KEYSYM_BY_CODE[event.code];
      return keysym === undefined ? [] : [`K ${keysym} ${event.down ? 1 : 0}`];
    }
    case 'text':
      return [...event.text].map((ch) => `T ${ch.codePointAt(0)}`);
    default:
      return [];
  }
}

/**
 * `python3` with ctypes over libX11 and libXtst, which every X desktop has. Text goes through one
 * spare keycode remapped to each character in turn, the way xdotool types what is not on the
 * keyboard layout.
 */
export const X11_HELPER = String.raw`
import sys, ctypes, ctypes.util
x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library('X11') or 'libX11.so.6')
xtst = ctypes.cdll.LoadLibrary(ctypes.util.find_library('Xtst') or 'libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XChangeKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_ulong), ctypes.c_int]
x11.XDisplayKeycodes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
x11.XGetKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
x11.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x11.XOpenDisplay(None)
if not d:
    sys.exit(2)

def spare_keycode():
    low, high = ctypes.c_int(), ctypes.c_int()
    x11.XDisplayKeycodes(d, ctypes.byref(low), ctypes.byref(high))
    per = ctypes.c_int()
    syms = x11.XGetKeyboardMapping(d, low.value, high.value - low.value + 1, ctypes.byref(per))
    try:
        for i in range(high.value - low.value, -1, -1):
            if all(syms[i * per.value + j] == 0 for j in range(per.value)):
                return low.value + i
    finally:
        x11.XFree(syms)
    return high.value

spare = spare_keycode()

def type_char(codepoint):
    keysym = codepoint if codepoint < 0x100 else 0x01000000 | codepoint
    pair = (ctypes.c_ulong * 2)(keysym, keysym)
    x11.XChangeKeyboardMapping(d, spare, 2, pair, 1)
    x11.XSync(d, 0)
    xtst.XTestFakeKeyEvent(d, spare, 1, 0)
    xtst.XTestFakeKeyEvent(d, spare, 0, 0)
    x11.XSync(d, 0)

try:
    for line in sys.stdin:
        p = line.split()
        if not p:
            continue
        try:
            if p[0] == 'Q':
                break
            if p[0] == 'M':
                xtst.XTestFakeMotionEvent(d, -1, int(p[1]), int(p[2]), 0)
            elif p[0] == 'B':
                xtst.XTestFakeButtonEvent(d, int(p[1]), int(p[2]), 0)
            elif p[0] == 'K':
                code = x11.XKeysymToKeycode(d, int(p[1]))
                if code:
                    xtst.XTestFakeKeyEvent(d, code, int(p[2]), 0)
            elif p[0] == 'T':
                type_char(int(p[1]))
            x11.XFlush(d)
        except Exception:
            pass
finally:
    empty = (ctypes.c_ulong * 1)(0)
    x11.XChangeKeyboardMapping(d, spare, 1, empty, 1)
    x11.XSync(d, 0)
    x11.XCloseDisplay(d)
`;
