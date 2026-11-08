import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hslToHex,
  parseColorBlock,
  parseRadius,
  parseTerminalTheme,
  renderKotlin,
  renderRust,
  renderSwift,
} from './mobile-design.mjs';

test('turns the desktop colors into the same hex the app paints', () => {
  assert.equal(hslToHex('150 100% 45%'), '#00E673');
  assert.equal(hslToHex('0 0% 4%'), '#0A0A0A');
  assert.equal(hslToHex('0 0% 100%'), '#FFFFFF');
  assert.equal(hslToHex('150 100% 23%'), '#00753B');
});

const css = `
:root,
.theme-light {
  --background: 0 0% 96%;
  --primary: 150 100% 23%;
  --radius: 0.625rem;
  --shadow-x: 0 1px 2px rgb(0 0 0 / 5%);
}

.dark,
.theme-dark {
  --background: 0 0% 4%;
  --primary: 150 100% 45%;
}

.vscode-dark {
  --primary: 206 100% 42%;
}
`;

test('reads the variables of the block it is asked for and no other', () => {
  assert.deepEqual(parseColorBlock(css, ':root'), {
    background: '#F5F5F5',
    primary: '#00753B',
  });
  assert.deepEqual(parseColorBlock(css, '.dark'), {
    background: '#0A0A0A',
    primary: '#00E673',
  });
});

test('is not thrown by a comment right before the selector', () => {
  const commented = '/* Light theme: { a comment */\n:root {\n  --primary: 150 100% 23%;\n}\n';

  assert.deepEqual(parseColorBlock(commented, ':root'), { primary: '#00753B' });
});

test('fails loudly when the block is gone, instead of generating an empty theme', () => {
  assert.throws(() => parseColorBlock(css, '.missing'), /\.missing/);
});

test('reads the radius in pixels', () => {
  assert.equal(parseRadius(css), 10);
});

test('reads the terminal theme object', () => {
  const source = `export const TERMINAL_THEME: ITheme = {
  background: TERMINAL_WELL_BG,
  foreground: '#d4ddd6',
  black: '#1a1f1c',
};
export const OTHER: ITheme = { foreground: '#000000' };`;

  assert.deepEqual(parseTerminalTheme(source), { foreground: '#D4DDD6', black: '#1A1F1C' });
});

const tokens = {
  light: { background: '#F5F5F5', 'primary-foreground': '#FFFFFF' },
  dark: { background: '#0A0A0A', 'primary-foreground': '#0A0A0A' },
  terminal: { foreground: '#D4DDD6' },
  radius: 10,
};

test('writes Kotlin with camelCase names and full-alpha colors', () => {
  const kotlin = renderKotlin(tokens);

  assert.match(kotlin, /val primaryForeground: Color/);
  assert.match(kotlin, /background = Color\(0xFF0A0A0A\)/);
  assert.match(kotlin, /const val RADIUS = 10/);
  assert.doesNotMatch(kotlin, /—/);
});

test('writes Swift with the same names and values', () => {
  const swift = renderSwift(tokens);

  assert.match(swift, /let primaryForeground: Color/);
  assert.match(swift, /background: Color\(hex: 0x0A0A0A\)/);
  assert.match(swift, /static let radius: CGFloat = 10/);
});

test('writes the Rust terminal palette in ANSI order', () => {
  const rust = renderRust({
    terminal: {
      black: '#000001',
      red: '#000002',
      green: '#000003',
      yellow: '#000004',
      blue: '#000005',
      magenta: '#000006',
      cyan: '#000007',
      white: '#000008',
      brightBlack: '#000009',
      brightRed: '#00000A',
      brightGreen: '#00000B',
      brightYellow: '#00000C',
      brightBlue: '#00000D',
      brightMagenta: '#00000E',
      brightCyan: '#00000F',
      brightWhite: '#000010',
      foreground: '#D4DDD6',
      background: '#0A1210',
    },
  });

  assert.match(rust, /ANSI: \[u32; 16\] = \[\s+0x000001,\s+0x000002,/);
  assert.match(rust, /0x000010,\s+\];/);
  assert.match(rust, /FOREGROUND: u32 = 0xD4DDD6/);
  assert.match(rust, /BACKGROUND: u32 = 0x0A1210/);
});

test('generates the same text every time, so the drift check can compare it', () => {
  assert.equal(renderKotlin(tokens), renderKotlin(tokens));
  assert.equal(renderSwift(tokens), renderSwift(tokens));
});
