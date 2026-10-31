import type { AccessLevel } from './admin.js';

/**
 * Redis commands as redis-cli reads them: arguments split on spaces, double quotes with the usual
 * escapes, single quotes taken literally.
 */
export function parseRedisLine(line: string): string[] {
  const args: string[] = [];
  let index = 0;
  const text = line.trim();
  while (index < text.length) {
    while (text[index] === ' ' || text[index] === '\t') index++;
    if (index >= text.length) break;
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      index++;
      let value = '';
      let closed = false;
      while (index < text.length) {
        const ch = text[index] as string;
        if (ch === quote) {
          closed = true;
          index++;
          break;
        }
        if (ch === '\\' && quote === '"') {
          const next = text[index + 1];
          if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 2, index + 4))) {
            value += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 4), 16));
            index += 4;
            continue;
          }
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };
          value += next !== undefined && next in escapes ? (escapes[next] as string) : (next ?? '');
          index += 2;
          continue;
        }
        value += ch;
        index++;
      }
      if (!closed) throw new Error('A quote in the command is not closed.');
      args.push(value);
    } else {
      let value = '';
      while (index < text.length && text[index] !== ' ' && text[index] !== '\t')
        value += text[index++];
      args.push(value);
    }
  }
  return args;
}

/** One line of ACL LIST read as a name and an access level. */
export function parseRedisAcl(line: string): {
  name: string;
  enabled: boolean;
  level: AccessLevel;
  superuser: boolean;
} {
  const parts = line.trim().split(/\s+/);
  const name = parts[1] ?? '';
  const rules = new Set(parts.slice(2));
  const superuser = rules.has('+@all') || rules.has('allcommands');
  const level: AccessLevel = superuser
    ? 'admin'
    : rules.has('+@write')
      ? 'write'
      : rules.has('+@read')
        ? 'read'
        : 'none';
  return { name, enabled: rules.has('on'), level, superuser };
}
