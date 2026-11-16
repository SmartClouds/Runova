/**
 * Putting values into the scripts the runner cleanup runs (E104). Every path that goes into a
 * script goes through one of these, so a folder name can never turn into a command.
 */

/** A POSIX shell literal: single quotes stop every expansion, and a quote inside is spliced in. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A PowerShell literal string: only a single quote means anything inside one, and it is doubled. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** What `powershell -EncodedCommand` takes: the script as UTF-16LE, in base64. */
export function toEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
