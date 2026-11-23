import { describe, expect, it } from 'vitest';
import {
  hasShellControlChars,
  quoteAllForShell,
  quoteForShell,
  quoteForTyping,
  shellKindFor,
} from './shellQuote.js';

describe('shellQuote', () => {
  it('maps shells to quoting families', () => {
    expect(shellKindFor('powershell.exe', 'win32')).toBe('powershell');
    expect(shellKindFor('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd');
    expect(shellKindFor('/usr/bin/fish', 'darwin')).toBe('fish');
    expect(shellKindFor('zsh', 'darwin')).toBe('posix');
    expect(shellKindFor(undefined, 'win32')).toBe('powershell');
    expect(shellKindFor(undefined, 'linux')).toBe('posix');
  });

  it('leaves safe words alone', () => {
    expect(quoteForShell('--settings', 'posix')).toBe('--settings');
    expect(quoteForShell('C:\\tools\\a.json', 'powershell')).toBe('C:\\tools\\a.json');
  });

  it('quotes spaces and quotes per shell', () => {
    const path = "C:\\My Files\\it's.txt";
    expect(quoteForShell(path, 'powershell')).toBe("'C:\\My Files\\it''s.txt'");
    expect(quoteForShell('a "b" c', 'cmd')).toBe('"a ""b"" c"');
    expect(quoteForShell("/tmp/it's here", 'posix')).toBe("'/tmp/it'\\''s here'");
    expect(quoteForShell("a\\b 'c'", 'fish')).toBe("'a\\\\b \\'c\\''");
  });

  it('quotes backslashes on POSIX shells', () => {
    expect(quoteForShell('a\\b', 'posix')).toBe("'a\\b'");
  });

  it('joins multiple values', () => {
    expect(quoteAllForShell(['a', 'b c'], 'posix')).toBe("a 'b c'");
  });

  it('doubles the curly single quotes PowerShell also ends a string at', () => {
    for (const code of [0x2018, 0x2019, 0x201a, 0x201b]) {
      const quote = String.fromCharCode(code);
      const name = `C:\\Downloads\\report${quote}; Write-Output hi; ${quote}.png`;
      expect(quoteForShell(name, 'powershell')).toBe(
        `'C:\\Downloads\\report${quote}${quote}; Write-Output hi; ${quote}${quote}.png'`,
      );
    }
    expect(quoteForShell("a'b", 'powershell')).toBe("'a''b'");
  });
});

describe('quoteForTyping', () => {
  const controls = [
    ...Array.from({ length: 0x20 }, (_, code) => code),
    0x7f,
    ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
  ];

  it('refuses text holding a C0 control, DEL or a C1 control, for every shell', () => {
    for (const code of controls) {
      const path = `/tmp/x${String.fromCharCode(code)}echo hi #.png`;
      expect(hasShellControlChars(path)).toBe(true);
      for (const kind of ['posix', 'fish', 'powershell', 'cmd'] as const) {
        expect(() => quoteForTyping(path, kind)).toThrow(/control characters/);
      }
    }
  });

  it('quotes everything else the same as quoteForShell', () => {
    for (const value of ['/home/me/a file.png', "it's", 'caf\u00e9 \u00a0x', 'plain']) {
      expect(hasShellControlChars(value)).toBe(false);
      expect(quoteForTyping(value, 'posix')).toBe(quoteForShell(value, 'posix'));
    }
  });

  it('leaves quoteForShell itself working for scripts that hold newlines', () => {
    expect(quoteForShell('echo a\necho b', 'posix')).toBe("'echo a\necho b'");
  });
});
