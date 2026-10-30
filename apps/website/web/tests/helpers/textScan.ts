import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The site's text scan (T014), shared by every page test: a built page must not name the mobile
 * version of Runova (the forbidden block in docs/epics/40-website.md) and must not use an em dash.
 */

export interface TextProblem {
  kind: 'phrase' | 'em-dash';
  /** The forbidden phrase in lower case, or the em dash itself. */
  match: string;
  /** The text around the match. */
  context: string;
}

const specFile = fileURLToPath(new URL('../../../../../docs/epics/40-website.md', import.meta.url));

let phrases: string[] | undefined;

/** The phrases in the spec's `forbidden` block, lower case, up to the first line starting with `#`. */
export function forbiddenPhrases(): string[] {
  if (phrases) return phrases;
  const spec = readFileSync(specFile, 'utf8');
  const block = /```forbidden\r?\n([\s\S]*?)```/.exec(spec)?.[1] ?? '';
  const found: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('#')) break;
    if (line.trim()) found.push(line.trim().toLowerCase());
  }
  phrases = found;
  return found;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/**
 * What a visitor or a crawler reads in a page: the text, every attribute value and the JSON-LD.
 * Styles and other scripts are left out. Tags become spaces, so a phrase split by markup still
 * matches, and runs of whitespace collapse to one space.
 */
export function readableText(html: string): string {
  const parts: string[] = [];
  const withoutCode = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attributes: string, body: string) =>
      /type="application\/ld\+json"/i.test(attributes) ? ` <script${attributes}> ${body} ` : ' ',
    );
  const text = withoutCode.replace(/<[^>]*>/g, (tag) => {
    for (const attribute of tag.matchAll(/[\w:-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      parts.push(attribute[1] ?? attribute[2] ?? '');
    }
    return ' ';
  });
  parts.unshift(text);
  return decodeEntities(parts.join(' ')).replace(/\s+/g, ' ');
}

function around(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 40), index + length + 40).trim();
}

/** Every forbidden phrase and em dash in a page. An empty list means the page passes. */
export function scanHtml(html: string): TextProblem[] {
  const text = readableText(html);
  const lower = text.toLowerCase();
  const problems: TextProblem[] = [];
  for (const phrase of forbiddenPhrases()) {
    let index = lower.indexOf(phrase);
    while (index >= 0) {
      problems.push({ kind: 'phrase', match: phrase, context: around(text, index, phrase.length) });
      index = lower.indexOf(phrase, index + phrase.length);
    }
  }
  for (const dash of text.matchAll(/—/g)) {
    problems.push({ kind: 'em-dash', match: '—', context: around(text, dash.index, 1) });
  }
  return problems;
}
