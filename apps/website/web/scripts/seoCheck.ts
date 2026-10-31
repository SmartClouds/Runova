// The build check from docs/epics/40-website.md (SEO rules): every built page has one title, one
// meta description of 70 to 160 characters and one canonical link, no two pages share a title or a
// description, and every JSON-LD block parses and matches its schema.org type. `bun run build` runs it over dist/client.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type JsonLdBlock, jsonLdProblems } from './jsonLdCheck';

export interface BuiltPage {
  /** The URL path, such as `/features/ship`. */
  path: string;
  html: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** The value of `name` in the attributes of a tag, decoded. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decode(match[1] ?? match[2] ?? match[3]) : undefined;
}

/** What the check reads from a page's markup. */
export function pageMeta(html: string) {
  const titles = [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) =>
    decode(m[1]).trim(),
  );
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  return {
    titles,
    descriptions: metas
      .filter((tag) => attribute(tag, 'name') === 'description')
      .map((tag) => attribute(tag, 'content') ?? ''),
    canonicals: links
      .filter((tag) => attribute(tag, 'rel') === 'canonical')
      .map((tag) => attribute(tag, 'href') ?? ''),
    jsonLd: [
      ...html.matchAll(
        /<script\b[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
      ),
    ].map((m) => m[1]),
  };
}

/** Everything wrong with `pages`, one line each; empty when the build passes. */
export function seoProblems(pages: BuiltPage[]): string[] {
  const problems: string[] = [];
  const byTitle = new Map<string, string>();
  const byDescription = new Map<string, string>();
  const blocks: JsonLdBlock[] = [];
  for (const { path, html } of pages) {
    const meta = pageMeta(html);
    const count = (list: string[], what: string) => {
      if (list.length !== 1) problems.push(`${path} has ${list.length} ${what}`);
    };
    count(meta.titles, 'titles');
    count(meta.descriptions, 'meta descriptions');
    count(meta.canonicals, 'canonical links');

    const [title] = meta.titles;
    const [description] = meta.descriptions;
    if (description !== undefined && (description.length < 70 || description.length > 160)) {
      problems.push(`${path} has a description of ${description.length} characters, not 70 to 160`);
    }
    for (const [value, seen, what] of [
      [title, byTitle, 'title'],
      [description, byDescription, 'description'],
    ] as const) {
      if (value === undefined) continue;
      const other = seen.get(value);
      if (other) problems.push(`${other} and ${path} share the ${what} "${value}"`);
      else seen.set(value, path);
    }
    for (const json of meta.jsonLd) blocks.push({ path, json });
  }
  problems.push(...jsonLdProblems(blocks));
  return problems;
}

/** Every HTML page under the build's client folder, leaving out Pagefind's and Astro's files. */
export function builtPages(clientDir: string): BuiltPage[] {
  const pages: BuiltPage[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === clientDir && (entry.name === 'pagefind' || entry.name.startsWith('_')))
          continue;
        walk(full);
      } else if (entry.name.endsWith('.html')) {
        const file = relative(clientDir, full).split(sep).join('/');
        const path = `/${file.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '')}`;
        pages.push({ path, html: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(clientDir);
  return pages;
}

if (import.meta.main) {
  const clientDir = fileURLToPath(new URL('../dist/client', import.meta.url));
  const pages = builtPages(clientDir);
  const problems = seoProblems(pages);
  for (const problem of problems) console.error(`SEO check: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `SEO check: ${pages.length} pages, every title and description unique, JSON-LD valid.`,
  );
}
