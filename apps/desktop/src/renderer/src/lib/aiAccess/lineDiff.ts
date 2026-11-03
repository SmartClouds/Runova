/**
 * A line diff for the AI access approval dialog: the before and after of a file an agent wants to
 * change. Env files are short, so a plain longest-common-subsequence table is fast enough and
 * gives the order a reader expects (removed lines right before the lines that replace them).
 */

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

function linesOf(text: string): string[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i] });
      i += 1;
    } else {
      out.push({ kind: 'added', text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ kind: 'removed', text: a[i] });
  for (; j < b.length; j += 1) out.push({ kind: 'added', text: b[j] });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length,
  };
}

export const MASK = '••••••';

/** "KEY=value" shows as "KEY=••••••". Comments and blank lines stay; anything else is hidden. */
export function maskEnvLine(line: string): string {
  if (!line.trim() || line.trimStart().startsWith('#')) return line;
  const match = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=)/.exec(line);
  return match ? `${match[1]}${MASK}` : MASK;
}
