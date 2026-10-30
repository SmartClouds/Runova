import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Loader } from 'astro/loaders';
import {
  HELP_CATEGORIES,
  parseArticle,
  resolveHelpLink,
} from '../../../../../desktop/src/shared/help/parse';
import { applyHelpFilter } from './filter';

/**
 * The app's help articles as site pages (docs/epics/40-website.md, Help articles on the site). The
 * Markdown files in apps/desktop/src/shared/help/articles are read as they are, through the app's
 * own parser, so titles, categories and anchors match the Help page in the app.
 */

export { HELP_CATEGORIES };

/** The articles folder, relative to the site root. */
export const HELP_ARTICLES_DIR = '../../desktop/src/shared/help/articles';

export interface HelpTocItem {
  /** The heading's anchor, the same one the app gives it. */
  id: string;
  heading: string;
  level: 2 | 3;
}

export interface HelpArticleData {
  title: string;
  category: string;
  order: number;
  summary: string;
  keywords: string[];
  /** The in-app route the article is about, when there is one. */
  route?: string;
  toc: HelpTocItem[];
}

export interface HelpArticleEntry {
  /** The file name without `.md`, which is also the page's slug. */
  id: string;
  data: HelpArticleData;
  /** The Markdown body, filtered and with links pointing at site pages. */
  body: string;
}

/** `vault.md#unlock` becomes `/help/vault#unlock`; anchors on the page and outside links stay. */
function rewriteLinks(markdown: string, slug: string): string {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (link, href: string) => {
    if (href.startsWith('#')) return link;
    const target = resolveHelpLink(href, slug);
    if (!target) return link;
    return `](/help/${target.slug}${target.anchor ? `#${target.anchor}` : ''})`;
  });
}

/**
 * Placeholders such as `<name>` are text in the app, which does not render HTML. Outside code they
 * are escaped here so the site's Markdown renderer does not read them as tags.
 */
function escapePlaceholders(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) => (index % 2 === 1 ? part : part.replace(/<(?!https?:)/g, '&lt;')))
        .join('');
    })
    .join('\n');
}

export function prepareHelpArticle(fileName: string, source: string): HelpArticleEntry {
  const slug = fileName.replace(/\.md$/, '');
  const article = parseArticle(slug, applyHelpFilter(fileName, source));
  return {
    id: slug,
    data: {
      title: article.title,
      category: article.category,
      order: article.order,
      summary: article.summary,
      keywords: article.keywords,
      ...(article.route ? { route: article.route } : {}),
      toc: article.sections
        .filter((section) => section.level !== 0)
        .map((section) => ({
          id: section.id,
          heading: section.heading,
          level: section.level as 2 | 3,
        })),
    },
    body: escapePlaceholders(rewriteLinks(article.body, slug)),
  };
}

/** Every `.md` file in a folder, prepared for the site. */
export function readHelpArticles(dir: string): HelpArticleEntry[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => prepareHelpArticle(name, readFileSync(resolve(dir, name), 'utf8')));
}

const CALLOUT_LABELS: Record<string, string> = { note: 'Note', tip: 'Tip', warning: 'Warning' };

/**
 * The rendered HTML with the app's heading anchors (the `##` and `###` headings in order, as the
 * table of contents lists them) and `> [!NOTE]`, `[!TIP]` and `[!WARNING]` quotes as callouts.
 */
export function finishHelpHtml(html: string, toc: HelpTocItem[]): string {
  let next = 0;
  return html
    .replace(/<h([23])((?:\s[^>]*)?)>/g, (tag, level: string, attributes: string) => {
      const item = toc[next];
      if (!item || String(item.level) !== level) return tag;
      next += 1;
      const rest = attributes.replace(/\s+id="[^"]*"/, '');
      return `<h${level} id="${item.id}"${rest}>`;
    })
    .replace(
      /<blockquote>(\s*)<p>\[!(NOTE|TIP|WARNING)\]\s*/gi,
      (_, space: string, kind: string) => {
        const key = kind.toLowerCase();
        return `<blockquote class="callout" data-callout="${key}">${space}<p><strong>${CALLOUT_LABELS[key]}:</strong> `;
      },
    );
}

/** The Astro content loader for the `help` collection. */
export function helpLoader({ base }: { base: string }): Loader {
  return {
    name: 'help-articles',
    async load({ store, parseData, renderMarkdown, generateDigest, config, watcher }) {
      const dir = resolve(fileURLToPath(config.root), base);
      const sync = async () => {
        store.clear();
        for (const entry of readHelpArticles(dir)) {
          const data = await parseData({ id: entry.id, data: { ...entry.data } });
          const rendered = await renderMarkdown(entry.body);
          store.set({
            id: entry.id,
            data,
            body: entry.body,
            digest: generateDigest(entry.body + JSON.stringify(entry.data)),
            rendered: { ...rendered, html: finishHelpHtml(rendered.html, entry.data.toc) },
          });
        }
      };
      await sync();
      watcher?.add(dir);
      watcher?.on('change', (path) => {
        if (resolve(path).startsWith(dir)) void sync();
      });
    },
  };
}

/** Anything with an id and the fields the help center orders by. */
export interface OrderedHelpArticle {
  id: string;
  data: Pick<HelpArticleData, 'title' | 'category' | 'order'>;
}

function categoryIndex(category: string): number {
  const index = (HELP_CATEGORIES as readonly string[]).indexOf(category);
  return index === -1 ? HELP_CATEGORIES.length : index;
}

/** The order of the help center: category as the app lists them, then `order`, then title. */
export function sortHelpArticles<T extends OrderedHelpArticle>(articles: T[]): T[] {
  return [...articles].sort(
    (a, b) =>
      categoryIndex(a.data.category) - categoryIndex(b.data.category) ||
      a.data.order - b.data.order ||
      a.data.title.localeCompare(b.data.title),
  );
}

export function helpByCategory<T extends OrderedHelpArticle>(
  sorted: T[],
): Array<{ category: string; articles: T[] }> {
  return HELP_CATEGORIES.map((category) => ({
    category: category as string,
    articles: sorted.filter((article) => article.data.category === category),
  })).filter((group) => group.articles.length > 0);
}

/** The articles before and after one, in the help center's order. */
export function helpNeighbours<T extends OrderedHelpArticle>(
  sorted: T[],
  id: string,
): { previous?: T; next?: T } {
  const index = sorted.findIndex((article) => article.id === id);
  const previous = index > 0 ? sorted[index - 1] : undefined;
  const next = index >= 0 ? sorted[index + 1] : undefined;
  return { ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
}
