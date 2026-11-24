import { align, isSubsequence, isWordStart, wordStarts } from './fuzzyScore';

/**
 * Ranking for the explorer's file search and the workspace search dialog. The whole file list
 * comes over once and every keystroke is matched here: `indexOf` for the common case, and a
 * lining-up by the starts of words (see fuzzyScore) only for paths with no straight match. A
 * query that is a glob or a `/regex/` skips the ranking and is matched by one compiled
 * expression instead.
 */

export interface FileHit {
  /** Where the path sits in the list that was searched. */
  index: number;
  /** Path relative to the project root, with forward slashes. */
  path: string;
  /** Where the file name starts inside `path`. */
  nameStart: number;
  /** [start, end) ranges in `path` that matched, for highlighting. */
  ranges: [number, number][];
  score: number;
}

export interface FileSearchResult {
  hits: FileHit[];
  /** How many files matched, which can be more than `hits` holds. */
  total: number;
  /** Set when the query was a `/regex/` that does not compile. */
  invalid?: true;
}

export const DEFAULT_SEARCH_LIMIT = 200;

/**
 * Score floors, best first. Each match adds up to 99 on top, so a weaker kind of match can
 * never outrank a better one.
 */
const NAME_EXACT = 900;
const NAME_START = 800;
const NAME_PART = 700;
const NAME_WORDS = 650;
const PATH_PART = 600;
const PATH_WORDS = 550;
const NAME_SCATTERED = 500;

interface Match {
  score: number;
  ranges: [number, number][];
}

/** An early, word-aligned run scores highest. Always between 0 and 99. */
function runBonus(original: string, at: number, from: number): number {
  return Math.max(0, 60 - (at - from)) + (isWordStart(original, at) ? 39 : 0);
}

/** The best place `query` sits whole in `lower`, from `from` on: the one with the most bonus. */
function bestRun(original: string, lower: string, query: string, from: number): Match | null {
  let best: Match | null = null;
  for (let at = lower.indexOf(query, from); at !== -1; at = lower.indexOf(query, at + 1)) {
    const score = runBonus(original, at, from);
    if (!best || score > best.score) best = { score, ranges: [[at, at + query.length]] };
    if (score >= 99) break;
  }
  return best;
}

/** Fewer pieces and fewer skipped letters score higher. Always between 0 and 99. */
function piecesBonus(pieces: number, gaps: number): number {
  return Math.max(0, 99 - 10 * (pieces - 1) - Math.min(49, gaps));
}

/** The path being matched, with its word starts worked out once, the first time they are needed. */
interface Subject {
  path: string;
  lower: string;
  nameStart: number;
  starts: Uint8Array | null;
}

function startsOf(subject: Subject): Uint8Array {
  subject.starts ??= wordStarts(subject.path);
  return subject.starts;
}

/** How one path scores against one word of the query, or null when it does not match at all. */
function matchTerm(subject: Subject, term: string): Match | null {
  const { path, lower, nameStart } = subject;
  const byPath = term.includes('/');
  if (!byPath) {
    if (lower.length - nameStart === term.length && lower.endsWith(term)) {
      return { score: NAME_EXACT + 99, ranges: [[nameStart, lower.length]] };
    }
    const run = bestRun(path, lower, term, nameStart);
    if (run) {
      const floor = run.ranges[0][0] === nameStart ? NAME_START : NAME_PART;
      return { score: floor + run.score, ranges: run.ranges };
    }
    if (isSubsequence(lower, term, nameStart, lower.length)) {
      const words = align(lower, startsOf(subject), term, nameStart, lower.length, true);
      if (words) {
        return { score: NAME_WORDS + piecesBonus(words.pieces, words.gaps), ranges: words.ranges };
      }
    }
  }
  const run = bestRun(path, lower, term, 0);
  if (run) return { score: PATH_PART + run.score, ranges: run.ranges };
  // Across folders the pieces must start words, and the last one has to reach the file name.
  const words = align(lower, startsOf(subject), term, 0, lower.length, true, nameStart);
  if (words) {
    return { score: PATH_WORDS + piecesBonus(words.pieces, words.gaps), ranges: words.ranges };
  }
  if (byPath || !isSubsequence(lower, term, nameStart, lower.length)) return null;
  // Scattered letters only inside the name, and only close together.
  const scattered = align(lower, startsOf(subject), term, nameStart, lower.length, false);
  if (!scattered || scattered.last - scattered.first + 1 > term.length * 2 + 2) return null;
  return {
    score: NAME_SCATTERED + piecesBonus(1, scattered.gaps * 3 + scattered.pieces),
    ranges: scattered.ranges,
  };
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/**
 * How a path scores against the whole query. Words typed apart can come in any order, each
 * scoring on its own, with the weakest deciding. They are also tried run together, since
 * `git panel` usually means `GitPanel`, and the better reading wins.
 */
function matchPath(
  path: string,
  lower: string,
  nameStart: number,
  terms: readonly string[],
): Match | null {
  const subject: Subject = { path, lower, nameStart, starts: null };
  const together = matchTerm(subject, terms.join(''));
  if (terms.length === 1) return together;
  let weakest = Number.POSITIVE_INFINITY;
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const match = matchTerm(subject, term);
    if (!match) return together;
    weakest = Math.min(weakest, match.score);
    ranges.push(...match.ranges);
  }
  if (together && together.score >= weakest) return together;
  return { score: weakest, ranges: mergeRanges(ranges) };
}

/** A bit per letter and one for any digit: a query letter missing from a path rules it out. */
function letterMask(lower: string): number {
  let mask = 0;
  for (let at = 0; at < lower.length; at += 1) {
    const code = lower.charCodeAt(at);
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) mask |= 1 << 26;
  }
  return mask;
}

/**
 * The list laid out once for matching, kept beside the index so a keystroke does not lowercase
 * the whole project again. A path whose lowercase form is a different length (a handful of
 * letters do that) keeps its original, and matches case-sensitively.
 *
 * It also remembers which entries could match the last query. Typing on only narrows a search,
 * so the next keystroke looks at those instead of the whole list.
 */
export interface PreparedSearch {
  lowered: string[];
  nameStarts: Int32Array;
  masks: Uint32Array;
  last: { key: string; candidates: Uint32Array } | null;
}

export function prepareSearch(files: readonly string[]): PreparedSearch {
  const lowered = new Array<string>(files.length);
  const nameStarts = new Int32Array(files.length);
  const masks = new Uint32Array(files.length);
  for (const [index, path] of files.entries()) {
    const lower = path.toLowerCase();
    const kept = lower.length === path.length ? lower : path;
    lowered[index] = kept;
    nameStarts[index] = kept.lastIndexOf('/') + 1;
    masks[index] = letterMask(kept);
  }
  return { lowered, nameStarts, masks, last: null };
}

/**
 * A path from the index, as a path on disk. The root comes from the main process, so its
 * separator is the one this system uses.
 */
export function toAbsolutePath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${separator === '/' ? relative : relative.replaceAll('/', separator)}`;
}

/** The words of a query, lowercased, with backslashes read as the folder separator. */
function queryTerms(query: string): string[] {
  return query.toLowerCase().replaceAll('\\', '/').split(/\s+/).filter(Boolean);
}

/** Every file a pattern lets through is as good as any other, so length and name decide. */
const PATTERN_SCORE = 0;

/** Something between two slashes: `/\.test\.tsx?$/`. */
const REGEX_QUERY = /^\/(.+)\/$/;
const GLOB_WILDCARD = /[*?]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * A glob as a regular expression. `*` stays inside a folder, `**` goes through them, `?` is one
 * character. The pattern has to line up with the end of the path and with the start of a folder
 * name, so `*.md` finds Markdown files anywhere and `docs/*.md` finds them in any `docs`. Each
 * run of fixed text is a capture group, which is what gets highlighted.
 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  let fixed = '';
  const flush = (): void => {
    if (fixed) source += `(${escapeRegExp(fixed)})`;
    fixed = '';
  };
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at];
    if (char === '?') {
      flush();
      source += '[^/]';
    } else if (char === '*') {
      flush();
      let end = at;
      while (glob[end + 1] === '*') end += 1;
      if (end === at) {
        source += '[^/]*';
      } else if (glob[end + 1] === '/') {
        // `**/` also stands for no folder at all.
        source += '(?:.*/)?';
        end += 1;
      } else {
        source += '.*';
      }
      at = end;
    } else {
      fixed += char;
    }
  }
  flush();
  return new RegExp(`(?:^|/)${source}$`, 'id');
}

/**
 * The query as a pattern, when it is one: a `/regex/` or a glob with a `*` or `?` in it. Null
 * for an ordinary search, and 'invalid' for a regex that does not compile.
 */
function compilePattern(query: string): { regex: RegExp; glob: boolean } | 'invalid' | null {
  const literal = REGEX_QUERY.exec(query);
  if (literal) {
    try {
      return { regex: new RegExp(literal[1], 'i'), glob: false };
    } catch {
      return 'invalid';
    }
  }
  return GLOB_WILDCARD.test(query) ? { regex: globToRegExp(query), glob: true } : null;
}

function patternRanges(match: RegExpExecArray, glob: boolean): [number, number][] {
  if (!glob) {
    return match[0] ? [[match.index, match.index + match[0].length]] : [];
  }
  return (match.indices ?? []).slice(1).flatMap((range) => (range ? [[range[0], range[1]]] : []));
}

function matchPattern(
  files: readonly string[],
  pattern: { regex: RegExp; glob: boolean },
): FileHit[] {
  const hits: FileHit[] = [];
  for (const [index, path] of files.entries()) {
    const match = pattern.regex.exec(path);
    if (!match) continue;
    hits.push({
      index,
      path,
      nameStart: path.lastIndexOf('/') + 1,
      ranges: patternRanges(match, pattern.glob),
      score: PATTERN_SCORE,
    });
  }
  return hits;
}

function matchPlain(
  files: readonly string[],
  query: string,
  given: PreparedSearch | undefined,
): FileHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const prepared = given ?? prepareSearch(files);
  const { lowered, nameStarts, masks } = prepared;
  const key = terms.join(' ');
  const queryMask = letterMask(terms.join(''));
  const previous = prepared.last && key.startsWith(prepared.last.key) ? prepared.last : null;
  const count = previous ? previous.candidates.length : files.length;

  // Anything that could match goes on the list for the next, longer query; only what does
  // match becomes a hit.
  const candidates: number[] = [];
  const hits: FileHit[] = [];
  for (let at = 0; at < count; at += 1) {
    const index = previous ? previous.candidates[at] : at;
    if ((queryMask & ~masks[index]) !== 0) continue;
    const lower = lowered[index];
    if (!terms.every((term) => isSubsequence(lower, term, 0, lower.length))) continue;
    candidates.push(index);
    const path = files[index];
    const match = matchPath(path, lower, nameStarts[index], terms);
    if (!match) continue;
    hits.push({
      index,
      path,
      nameStart: nameStarts[index],
      ranges: match.ranges,
      score: match.score,
    });
  }
  prepared.last = { key, candidates: Uint32Array.from(candidates) };
  return hits;
}

/**
 * `patterns` lets a query be a glob (`*.md`, `docs/*.ts`) or a regular expression between
 * slashes (`/\.test\.tsx?$/`). It is off by default because other callers search names that
 * are not paths, where a `*` or a slash is just a character.
 */
export function searchFiles(
  files: readonly string[],
  query: string,
  options: { limit?: number; prepared?: PreparedSearch; patterns?: boolean } = {},
): FileSearchResult {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const pattern = options.patterns ? compilePattern(query.trim()) : null;
  if (pattern === 'invalid') return { hits: [], total: 0, invalid: true };
  const hits = pattern ? matchPattern(files, pattern) : matchPlain(files, query, options.prepared);
  const total = hits.length;
  // Same score: the shorter, then alphabetical path, so the order never wanders between runs.
  // Equal strings (two symbols with one name) keep the order they were given in.
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index),
  );
  return { hits: hits.length > limit ? hits.slice(0, limit) : hits, total };
}
