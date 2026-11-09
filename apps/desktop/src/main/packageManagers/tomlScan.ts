/**
 * A reader for the parts of TOML that dependency files use. It keeps the offset of every value,
 * because an update has to change one version and leave the rest of a hand-kept file exactly as it
 * was, comments and line endings included.
 */

export interface TomlEntry {
  /** The table the key is under, as written: `tool.poetry.dependencies`. Empty at the top. */
  table: string;
  /** Goes up with every table header, which tells the entries of `[[package]]` apart. */
  tableIndex: number;
  key: string;
  /** The raw value, quotes and brackets included. */
  text: string;
  start: number;
  end: number;
}

export interface TomlString {
  value: string;
  /** Offsets in the file of the text between the quotes. */
  start: number;
  end: number;
}

const QUOTES = new Set(['"', "'"]);

/** The index just past the string that opens at `at`, or the end of its line if it never closes. */
function skipString(source: string, at: number): number {
  const quote = source[at];
  const triple = quote.repeat(3);
  if (source.startsWith(triple, at)) {
    const close = source.indexOf(triple, at + 3);
    return close === -1 ? source.length : close + 3;
  }
  for (let index = at + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\n') return index;
    if (char === '\\' && quote === '"') index += 1;
    else if (char === quote) return index + 1;
  }
  return source.length;
}

function lineEnd(source: string, from: number): number {
  const index = source.indexOf('\n', from);
  return index === -1 ? source.length : index;
}

/** Where the value starting at `start` ends: the line break outside of any bracket. */
function valueEnd(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (QUOTES.has(char)) {
      index = skipString(source, index);
      continue;
    }
    if (char === '#') {
      if (depth === 0) return index;
      index = lineEnd(source, index);
      continue;
    }
    if (char === '\n' && depth === 0) return index;
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
    index += 1;
  }
  return source.length;
}

function equalsIndex(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (QUOTES.has(char)) index = skipString(line, index) - 1;
    else if (char === '=') return index;
  }
  return -1;
}

function cleanKey(raw: string): string {
  const key = raw.trim();
  return /^(["']).*\1$/.test(key) ? key.slice(1, -1) : key;
}

export function scanToml(source: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  let table = '';
  let tableIndex = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const end = lineEnd(source, cursor);
    const line = source.slice(cursor, end);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      cursor = end + 1;
      continue;
    }
    const header = /^\[\[?(.+?)\]\]?\s*(?:#.*)?$/.exec(trimmed);
    if (header) {
      table = header[1].trim();
      tableIndex += 1;
      cursor = end + 1;
      continue;
    }
    const equals = equalsIndex(line);
    if (equals === -1) {
      cursor = end + 1;
      continue;
    }
    let start = cursor + equals + 1;
    while (source[start] === ' ' || source[start] === '\t') start += 1;
    const stop = valueEnd(source, start);
    let valueStop = stop;
    while (valueStop > start && /\s/.test(source[valueStop - 1])) valueStop -= 1;
    entries.push({
      table,
      tableIndex,
      key: cleanKey(line.slice(0, equals)),
      text: source.slice(start, valueStop),
      start,
      end: valueStop,
    });
    cursor = lineEnd(source, stop) + 1;
  }
  return entries;
}

/** The value as a string, when it is one. */
export function stringValue(entry: TomlEntry): TomlString | null {
  if (!QUOTES.has(entry.text[0]) || skipString(entry.text, 0) !== entry.text.length) return null;
  return {
    value: entry.text.slice(1, -1),
    start: entry.start + 1,
    end: entry.end - 1,
  };
}

/** Visits the strings directly inside the outer bracket, with the text that came before each. */
function directStrings(
  entry: TomlEntry,
  visit: (found: TomlString, before: string) => boolean,
): void {
  const { text } = entry;
  let depth = 0;
  let before = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (QUOTES.has(char)) {
      const close = skipString(text, index);
      if (
        depth === 1 &&
        visit(
          {
            value: text.slice(index + 1, close - 1),
            start: entry.start + index + 1,
            end: entry.start + close - 1,
          },
          before,
        )
      ) {
        return;
      }
      index = close;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    if (depth === 1 && (char === ',' || char === '{')) before = '';
    else if (depth === 1) before += char;
    index += 1;
  }
}

/** The plain strings of an array, leaving out any nested inside a table in it. */
export function arrayStrings(entry: TomlEntry): TomlString[] {
  if (entry.text[0] !== '[') return [];
  const found: TomlString[] = [];
  directStrings(entry, (one) => {
    found.push(one);
    return false;
  });
  return found;
}

/** One string field of an inline table: `version` in `{ version = "1", features = [] }`. */
export function inlineString(entry: TomlEntry, field: string): TomlString | null {
  if (entry.text[0] !== '{') return null;
  let found: TomlString | null = null;
  directStrings(entry, (one, before) => {
    if (before.replace(/[\s=]/g, '') !== field) return false;
    found = one;
    return true;
  });
  return found;
}

/** Whether an inline table sets a field, whatever its value is. */
export function inlineHas(entry: TomlEntry, field: string): boolean {
  return (
    entry.text[0] === '{' &&
    new RegExp(`[{,]\\s*${field.replace('.', '\\.')}\\s*=`).test(entry.text)
  );
}

/** Every version of each package in a `[[package]]` lock file (uv, Poetry, Cargo). */
export function lockedVersions(
  source: string,
  normalize: (name: string) => string,
): Map<string, string[]> {
  const byTable = new Map<number, { name?: string; version?: string }>();
  for (const entry of scanToml(source)) {
    if (entry.table !== 'package' || (entry.key !== 'name' && entry.key !== 'version')) continue;
    const row = byTable.get(entry.tableIndex) ?? {};
    row[entry.key] = stringValue(entry)?.value;
    byTable.set(entry.tableIndex, row);
  }
  const locked = new Map<string, string[]>();
  for (const { name, version } of byTable.values()) {
    if (!name || !version) continue;
    const key = normalize(name);
    locked.set(key, [...(locked.get(key) ?? []), version]);
  }
  return locked;
}
