/**
 * Lining a query up with a name when it is not a plain substring. Two ways are allowed, both
 * strict enough that a long query cannot wander through a long path picking up letters:
 *
 * - by words: the query comes in pieces, and every piece starts where a word starts
 *   (`PreRenSec` and `prs` both find `PreRenameSecrets`);
 * - scattered: the letters may sit anywhere in the name, but the first one starts a word and the
 *   whole match stays short (`gtpnl` finds `GitPanel`).
 *
 * Both pick the best of every possible lining-up, not the first one found, so the highlight lands
 * on the starts of words rather than on whatever letter came first.
 */

/** What a character is, for finding where words start. Char codes, since this runs per letter. */
const OTHER = 0;
const SEPARATOR = 1;
const DIGIT = 2;
const UPPER = 3;
const LOWER = 4;

function classOf(text: string, at: number): number {
  const code = text.charCodeAt(at);
  if (code >= 97 && code <= 122) return LOWER;
  if (code >= 65 && code <= 90) return UPPER;
  if (code >= 48 && code <= 57) return DIGIT;
  // \ / - _ . and space
  if (code === 92 || code === 47 || code === 45 || code === 95 || code === 46 || code === 32) {
    return SEPARATOR;
  }
  if (code < 128 || Number.isNaN(code)) return OTHER;
  const char = text[at];
  if (char !== char.toLowerCase()) return UPPER;
  if (char !== char.toUpperCase()) return LOWER;
  return OTHER;
}

function isSeparator(char: string): boolean {
  return classOf(char, 0) === SEPARATOR;
}

/**
 * True at the start, after a separator, at a camelCase hump, where digits begin or end, and at
 * the last capital of a run of them that a word follows (the `S` of `HTTPServer`).
 */
export function isWordStart(text: string, at: number): boolean {
  if (at === 0) return true;
  const kind = classOf(text, at);
  const previous = classOf(text, at - 1);
  if (kind === SEPARATOR) return false;
  if (previous === SEPARATOR) return true;
  if (kind === DIGIT) return previous !== DIGIT;
  if (previous === DIGIT) return true;
  if (kind !== UPPER) return false;
  if (previous !== UPPER) return true;
  return at + 1 < text.length && classOf(text, at + 1) === LOWER;
}

let marks = new Uint8Array(0);

/**
 * A 1 at every word start of `text`, in a buffer shared between calls: it holds until the next
 * call, which is all one path's matching needs.
 */
export function wordStarts(text: string): Uint8Array {
  if (marks.length < text.length) marks = new Uint8Array(text.length * 2);
  for (let at = 0; at < text.length; at += 1) marks[at] = isWordStart(text, at) ? 1 : 0;
  return marks;
}

export interface Alignment {
  /** [start, end) ranges in the text, neighbouring letters merged. */
  ranges: [number, number][];
  /** How many separate runs the query was split into. */
  pieces: number;
  /** Letters skipped before the first match and between the runs. */
  gaps: number;
  first: number;
  last: number;
}

const IMPOSSIBLE = 0x3fffffff;
let costs = new Int32Array(0);
let back = new Int32Array(0);

function reserve(cells: number): void {
  if (costs.length >= cells) return;
  costs = new Int32Array(cells * 2);
  back = new Int32Array(cells * 2);
}

/**
 * The cheapest way to find `query` in `lower[from, to)` letter by letter. Each skipped letter
 * costs two and each matched letter that does not start a word costs one, so of two equally
 * tight matches the one on word starts wins (`prs` is P-R-S in `PreRenameSecrets`, not Pr-S).
 * With `words`, a piece may only start at a word start; without it, only the first piece has
 * to. `starts` comes from wordStarts for the same text. `endFrom` is where the last letter has
 * to land at or after, so a path match can be made to end in the file name.
 */
export function align(
  lower: string,
  starts: Uint8Array,
  query: string,
  from: number,
  to: number,
  words: boolean,
  endFrom = from,
): Alignment | null {
  const width = to - from;
  const length = query.length;
  if (length === 0 || length > width) return null;
  reserve(width * length);
  // Row 0: where the first letter can go. It has to start a word, unless it is a separator.
  const first = query.charCodeAt(0);
  const firstSeparator = isSeparator(query[0]);
  let reachable = false;
  for (let p = 0; p < width; p += 1) {
    const start = starts[from + p];
    const fits = lower.charCodeAt(from + p) === first && (start === 1 || firstSeparator);
    costs[p] = fits ? 2 * p + 1 - start : IMPOSSIBLE;
    back[p] = -1;
    reachable ||= fits;
  }
  if (!reachable) return null;

  for (let j = 1; j < length; j += 1) {
    const row = j * width;
    const above = row - width;
    const wanted = query.charCodeAt(j);
    const anywhere = !words || isSeparator(query[j]);
    // The cheapest earlier cell to jump from, weighed by where it is: cost - 2 * position.
    let bestJump = IMPOSSIBLE;
    let bestFrom = -1;
    reachable = false;
    for (let p = 0; p < width; p += 1) {
      let cost = IMPOSSIBLE;
      let previous = -1;
      if (lower.charCodeAt(from + p) === wanted) {
        const start = starts[from + p];
        const own = 1 - start;
        if (p > 0 && costs[above + p - 1] < IMPOSSIBLE) {
          cost = costs[above + p - 1] + own;
          previous = p - 1;
        }
        if (bestFrom !== -1 && (anywhere || start === 1)) {
          const jump = bestJump + 2 * (p - 1) + own;
          if (jump < cost) {
            cost = jump;
            previous = bestFrom;
          }
        }
      }
      costs[row + p] = cost;
      back[row + p] = previous;
      if (cost < IMPOSSIBLE) reachable = true;
      // Cells up to p - 1 may be jumped from by p + 1 onward; p - 1 itself is a continuation.
      if (p > 0) {
        const candidate = costs[above + p - 1];
        if (candidate < IMPOSSIBLE && candidate - 2 * (p - 1) < bestJump) {
          bestJump = candidate - 2 * (p - 1);
          bestFrom = p - 1;
        }
      }
    }
    // Nothing can hold this letter, so nothing after it can either.
    if (!reachable) return null;
  }

  const lastRow = (length - 1) * width;
  let end = -1;
  for (let p = Math.max(0, endFrom - from); p < width; p += 1) {
    if (
      costs[lastRow + p] < IMPOSSIBLE &&
      (end === -1 || costs[lastRow + p] < costs[lastRow + end])
    ) {
      end = p;
    }
  }
  if (end === -1) return null;

  const positions = new Array<number>(length);
  let at = end;
  for (let j = length - 1; j >= 0; j -= 1) {
    positions[j] = at;
    at = back[j * width + at];
  }
  const ranges: [number, number][] = [];
  let gaps = positions[0];
  for (let j = 0; j < length; j += 1) {
    const position = from + positions[j];
    const lastRange = ranges.at(-1);
    if (lastRange && lastRange[1] === position) lastRange[1] = position + 1;
    else {
      if (lastRange) gaps += position - lastRange[1];
      ranges.push([position, position + 1]);
    }
  }
  return {
    ranges,
    pieces: ranges.length,
    gaps,
    first: from + positions[0],
    last: from + positions[length - 1],
  };
}

/** True when every letter of `query` is in `lower[from, to)`, in order. A cheap first check. */
export function isSubsequence(lower: string, query: string, from: number, to: number): boolean {
  let cursor = from;
  for (let j = 0; j < query.length; j += 1) {
    const at = lower.indexOf(query[j], cursor);
    if (at === -1 || at >= to) return false;
    cursor = at + 1;
  }
  return true;
}
