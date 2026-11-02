/** Which stage a set of project secrets belongs to. `custom` covers anything else (qa, demo, ...). */
export type EnvironmentKind = 'development' | 'test' | 'staging' | 'production' | 'custom';

export const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'development',
  'test',
  'staging',
  'production',
  'custom',
];

export const ENVIRONMENT_KIND_LABELS: Record<EnvironmentKind, string> = {
  development: 'Development',
  test: 'Test',
  staging: 'Staging',
  production: 'Production',
  custom: 'Custom',
};

/** The file name a new env file gets by default for each kind. */
export const DEFAULT_ENV_FILE_NAMES: Record<EnvironmentKind, string> = {
  development: '.env.development',
  test: '.env.test',
  staging: '.env.staging',
  production: '.env.production',
  custom: '.env',
};

/** Env files over this size are not something anyone keeps by hand, so they are refused. */
export const MAX_ENV_FILE_BYTES = 1024 * 1024;

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line the entry starts on. */
  line: number;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Reads a .env file the way dotenv and most frameworks do: `KEY=value` lines, `#` comments,
 * an optional `export ` prefix, and single, double or backtick quoted values that may span
 * lines. Lines that don't look like an assignment are skipped rather than rejected, since the
 * point here is counting and listing keys, not refusing a file the project already uses.
 */
export function parseDotenv(text: string): DotenvEntry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries: DotenvEntry[] = [];

  for (let index = 0; index < lines.length; index++) {
    const startLine = index + 1;
    let line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue;

    let rest = line.slice(eq + 1).trimStart();
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      rest = rest.slice(1);
      let closing = findClosingQuote(rest, quote);
      // A quoted value can carry on over the next lines until its quote closes.
      while (closing < 0 && index + 1 < lines.length) {
        index++;
        rest += `\n${lines[index]}`;
        closing = findClosingQuote(rest, quote);
      }
      let value = closing < 0 ? rest : rest.slice(0, closing);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      entries.push({ key, value, line: startLine });
      continue;
    }

    const comment = rest.search(/\s#/);
    const value = (comment >= 0 ? rest.slice(0, comment) : rest).trim();
    entries.push({ key, value, line: startLine });
  }

  return entries;
}

function findClosingQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && quote === '"') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

/** Number of distinct keys in a .env file. A key set twice counts once, like dotenv reads it. */
export function countDotenvKeys(text: string): number {
  return new Set(parseDotenv(text).map((entry) => entry.key)).size;
}

export interface DotenvKeyDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

function dotenvValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const { key, value } of parseDotenv(text)) values.set(key, value);
  return values;
}

/**
 * Which keys one version of a .env file adds, drops or changes compared to another. Only key
 * names come back, never values, so the result is safe to show next to a list of versions.
 * Added and changed keys follow `after`'s order, removed keys follow `before`'s.
 */
export function diffDotenvKeys(before: string, after: string): DotenvKeyDiff {
  const old = dotenvValues(before);
  const next = dotenvValues(after);
  const diff: DotenvKeyDiff = { added: [], removed: [], changed: [] };
  for (const [key, value] of next) {
    if (!old.has(key)) diff.added.push(key);
    else if (old.get(key) !== value) diff.changed.push(key);
  }
  for (const key of old.keys()) {
    if (!next.has(key)) diff.removed.push(key);
  }
  return diff;
}

/**
 * A bare file name in the `.env` family: `.env`, `.env.production`, `.env.local`, and so on.
 * No folders, so a stored name can be joined onto a project folder without escaping it.
 */
export function isEnvFileName(name: string): boolean {
  return name.length <= 100 && /^\.env(\.[A-Za-z0-9_-]+)*$/.test(name);
}

/** `.env.example` and friends hold placeholders for the repo, not real secrets. */
export function isEnvTemplateFileName(name: string): boolean {
  return /\.(example|sample|template|dist)$/i.test(name);
}

/** Best guess at which environment a file belongs to, from its name alone. */
export function guessEnvironmentKind(fileName: string): EnvironmentKind {
  const parts = fileName.toLowerCase().split('.').slice(2);
  if (parts.length === 0) return 'development';
  if (parts.some((part) => part === 'production' || part === 'prod')) return 'production';
  if (parts.some((part) => part === 'staging' || part === 'stage')) return 'staging';
  if (parts.some((part) => part === 'test' || part === 'testing')) return 'test';
  if (parts.some((part) => part === 'development' || part === 'dev' || part === 'local')) {
    return 'development';
  }
  return 'custom';
}
