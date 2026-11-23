/**
 * Quoting for text typed into an interactive shell: a dropped file path, or an argument in a
 * launch command. Each shell family has its own rules, and getting them wrong either breaks
 * paths with spaces or, worse, runs part of a file name as a command.
 */

export type ShellKind = 'powershell' | 'cmd' | 'posix' | 'fish';

export function shellKindFor(shell: string | undefined, platform: string): ShellKind {
  const name = (shell ?? '').toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  if (
    name === 'powershell.exe' ||
    name === 'pwsh.exe' ||
    name === 'pwsh' ||
    name === 'powershell'
  ) {
    return 'powershell';
  }
  if (name === 'cmd.exe' || name === 'cmd') return 'cmd';
  if (name === 'fish') return 'fish';
  if (name === 'bash' || name === 'zsh' || name === 'sh') return 'posix';
  return platform === 'win32' ? 'powershell' : 'posix';
}

/** Characters every shell here treats literally, so such a word needs no quotes at all. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

export function quoteForShell(value: string, kind: ShellKind): string {
  // A backslash is an escape character in POSIX shells and fish, but literal on Windows.
  const backslashIsSpecial = kind === 'posix' || kind === 'fish';
  if (value.length > 0 && SAFE_WORD.test(value) && !(backslashIsSpecial && value.includes('\\'))) {
    return value;
  }
  switch (kind) {
    case 'powershell':
      // Single quotes are literal in PowerShell; a quote inside is written twice. PowerShell also
      // ends a single-quoted string at U+2018 to U+201B, so those are written twice as well.
      return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote)}'`;
    case 'cmd':
      return `"${value.replace(/"/g, '""')}"`;
    case 'fish':
      return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    case 'posix':
      return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}

/**
 * True when the text holds a C0 control character, DEL or a C1 control character. Quotes do not
 * help with these once the text is typed into a terminal: the line editor acts on them as keys
 * (Ctrl-U wipes the line, for one), so whatever follows would run as a command.
 */
export function hasShellControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * quoteForShell for text that will be typed into an interactive shell as keystrokes, such as a
 * dropped file path. It throws when the text holds control characters, since no quoting keeps
 * those from acting on the line.
 */
export function quoteForTyping(value: string, kind: ShellKind): string {
  if (hasShellControlChars(value)) {
    throw new Error('That text holds control characters, so it cannot be typed into a shell.');
  }
  return quoteForShell(value, kind);
}

/** Joins several values as separate words, e.g. multiple dropped files. */
export function quoteAllForShell(values: string[], kind: ShellKind): string {
  return values.map((value) => quoteForShell(value, kind)).join(' ');
}
