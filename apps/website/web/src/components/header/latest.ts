/**
 * Fills the News and Blog panels of the header menu with the newest entries from
 * `/nav/latest.json` (src/lib/latest.ts). It reads them once per page, the first time the visitor
 * reaches for the menu, and draws them with DOM calls only, never as HTML.
 */

import type { Latest, LatestEntry } from '../../lib/latest';

export const LATEST_URL = '/nav/latest.json';

type Source = keyof Latest;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A path on this site, never a scheme or another host. */
const isLocalPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');

const isImage = (value: unknown) =>
  value === null ||
  isLocalPath(value) ||
  (typeof value === 'string' && value.startsWith('https://'));

function isEntry(value: unknown): value is LatestEntry {
  if (!isObject(value)) return false;
  const { href, title, summary, meta, tone, image } = value;
  return (
    isLocalPath(href) &&
    typeof title === 'string' &&
    typeof summary === 'string' &&
    typeof meta === 'string' &&
    typeof tone === 'string' &&
    isImage(image)
  );
}

const isList = (value: unknown) => value === null || (Array.isArray(value) && value.every(isEntry));

/** The response, when it has the shape the panels draw. */
export function parseLatest(value: unknown): Latest | null {
  if (!isObject(value) || !isList(value.news) || !isList(value.blog)) return null;
  return { news: value.news as LatestEntry[] | null, blog: value.blog as LatestEntry[] | null };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function art(className: string, entry: LatestEntry) {
  const box = el('span', className);
  box.dataset.tone = entry.tone;
  box.setAttribute('aria-hidden', 'true');
  if (entry.image) {
    const image = el('img', '');
    image.src = entry.image;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    // A cover that fails to load leaves the tint alone, not a broken image icon.
    image.addEventListener('error', () => image.remove(), { once: true });
    box.append(image);
  }
  return box;
}

function feature(entry: LatestEntry) {
  const link = el('a', 'mp-feature');
  link.href = entry.href;
  link.dataset.tone = entry.tone;
  const copy = el('span', 'mp-copy');
  copy.append(el('span', 'mp-feature-title', entry.title), el('span', 'mp-meta', entry.meta));
  link.append(art('mp-art', entry), el('span', 'mp-badge', 'Latest'), copy);
  return link;
}

function row(entry: LatestEntry) {
  const item = el('li', '');
  const link = el('a', 'mp-row');
  link.href = entry.href;
  const copy = el('span', 'mp-copy');
  copy.append(el('span', 'mp-title', entry.title));
  if (entry.summary) copy.append(el('span', 'mp-summary', entry.summary));
  copy.append(el('span', 'mp-meta', entry.meta));
  link.append(art('mp-row-art', entry), copy);
  item.append(link);
  return item;
}

const WORDS: Record<Source, { none: string; failed: string }> = {
  news: { none: 'No news yet.', failed: 'The latest news could not load right now.' },
  blog: { none: 'No posts yet.', failed: 'The latest posts could not load right now.' },
};

/** Puts `entries` into one panel body: the newest as a card, the rest as rows. */
export function fillPanel(box: HTMLElement, source: Source, entries: LatestEntry[] | null) {
  const [first, ...rest] = entries ?? [];
  if (!first) {
    box.replaceChildren(el('p', 'mp-message', entries ? WORDS[source].none : WORDS[source].failed));
  } else {
    const list = el('ul', 'mp-list');
    list.append(...rest.map(row));
    box.replaceChildren(feature(first), list);
  }
  box.removeAttribute('aria-busy');
  box.dataset.ready = '';
}

/** Every News and Blog panel on the page (the dropdown and the phone sheet each have one). */
export function fillAll(latest: Latest, root: ParentNode = document) {
  for (const box of root.querySelectorAll<HTMLElement>('[data-latest]')) {
    const source = box.dataset.latest;
    if (source === 'news' || source === 'blog') fillPanel(box, source, latest[source]);
  }
}

async function fetchLatest(): Promise<Latest> {
  try {
    const response = await fetch(LATEST_URL, { headers: { accept: 'application/json' } });
    if (response.ok) {
      const latest = parseLatest(await response.json());
      if (latest) return latest;
    }
  } catch {
    // Offline or a bad body: the panels say the entries could not load.
  }
  return { news: null, blog: null };
}

let loading: Promise<void> | null = null;

/** Reads the newest entries the first time it is called, and fills the panels with them. */
export function loadLatest(): Promise<void> {
  loading ??= fetchLatest().then((latest) => fillAll(latest));
  return loading;
}
