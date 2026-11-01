// @vitest-environment jsdom
import './setup/dom';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fillAll, fillPanel, parseLatest } from '../src/components/header/latest';
import { parseDesktopArch, parseDesktopOs } from '../src/lib/download/latest';
import type { LatestEntry } from '../src/lib/latest';
import { DOWNLOAD_LINKS, FEATURE_LINKS, NAV_SECTIONS } from '../src/lib/nav';

const entry = (n: number, extra: Partial<LatestEntry> = {}): LatestEntry => ({
  href: `/news/item-${n}`,
  title: `Item ${n}`,
  summary: `Summary ${n}`,
  meta: `Security · Oct ${n}, 2026`,
  publishedAt: '2026-10-30T00:00:00Z',
  tone: 'security',
  image: null,
  ...extra,
});

function panel(source: 'news' | 'blog') {
  const box = document.createElement('div');
  box.dataset.latest = source;
  box.setAttribute('aria-busy', 'true');
  box.innerHTML = '<span class="mp-skeleton"></span>';
  document.body.append(box);
  return box;
}

describe('parseLatest', () => {
  it('takes both lists, or null for a list the API could not read', () => {
    const latest = { news: [entry(1)], blog: null };
    expect(parseLatest(latest)).toEqual(latest);
  });

  it('turns down a link that leaves the site or is not a link at all', () => {
    for (const href of ['https://example.com/x', '//example.com/x', 'javascript:alert(1)']) {
      expect(parseLatest({ news: [entry(1, { href })], blog: [] })).toBeNull();
    }
    expect(parseLatest({ news: [{ title: 'No href' }], blog: [] })).toBeNull();
    expect(parseLatest('nope')).toBeNull();
  });
});

describe('fillPanel', () => {
  it('shows the newest as the Latest card and the others as rows, in order', () => {
    const box = panel('news');
    fillPanel(box, 'news', [entry(3), entry(2), entry(1)]);
    const links = [...box.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/news/item-3',
      '/news/item-2',
      '/news/item-1',
    ]);
    expect(links[0]).toHaveClass('mp-feature');
    expect(links[0]).toHaveTextContent('Latest');
    expect(box.querySelectorAll('.mp-list > li')).toHaveLength(2);
    expect(box.querySelector('.mp-skeleton')).toBeNull();
    expect(box).not.toHaveAttribute('aria-busy');
  });

  it('writes titles as text, never as markup', () => {
    const box = panel('news');
    fillPanel(box, 'news', [entry(1, { title: '<img src=x onerror=alert(1)>' })]);
    expect(box.querySelector('img')).toBeNull();
    expect(box).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('drops a cover that fails to load and keeps the tint', () => {
    const box = panel('blog');
    fillPanel(box, 'blog', [entry(1, { href: '/blog/a', image: '/media/a.png' })]);
    const image = box.querySelector('img');
    expect(image).toHaveAttribute('alt', '');
    image?.dispatchEvent(new Event('error'));
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('.mp-art')).toHaveAttribute('data-tone', 'security');
  });

  it('says so when nothing is published, and when the API could not be read', () => {
    const empty = panel('blog');
    fillPanel(empty, 'blog', []);
    expect(empty).toHaveTextContent('No posts yet.');
    const failed = panel('news');
    fillPanel(failed, 'news', null);
    expect(failed).toHaveTextContent('The latest news could not load right now.');
  });
});

describe('fillAll', () => {
  it('fills the dropdown and the phone sheet copies of each panel', () => {
    const boxes = [panel('news'), panel('news'), panel('blog')];
    fillAll({ news: [entry(1)], blog: [entry(2, { href: '/blog/b' })] });
    expect(boxes.map((box) => box.querySelector('a')?.getAttribute('href'))).toEqual([
      '/news/item-1',
      '/news/item-1',
      '/blog/b',
    ]);
  });
});

describe('loadLatest', () => {
  it('reads /nav/latest.json once however often the menu opens', async () => {
    vi.resetModules();
    const fetch = vi.fn(async () => Response.json({ news: [entry(1)], blog: [] }));
    vi.stubGlobal('fetch', fetch);
    const { loadLatest } = await import('../src/components/header/latest');
    const box = panel('news');
    await Promise.all([loadLatest(), loadLatest()]);
    await loadLatest();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/nav/latest.json', expect.anything());
    expect(box.querySelector('a')).toHaveAttribute('href', '/news/item-1');
  });
});

describe('the menu links', () => {
  it('point the download tiles at a system and arch the latest route knows', () => {
    for (const link of DOWNLOAD_LINKS) {
      const url = new URL(link.href, 'https://runovahq.com');
      const [, os] = url.pathname.match(/^\/download\/([a-z]+)\/latest$/) ?? [];
      expect(parseDesktopOs(os), link.href).not.toBeNull();
      const arch = url.searchParams.get('arch');
      if (arch !== null) expect(parseDesktopArch(arch), link.href).not.toBeNull();
    }
  });

  it('point the feature tiles at feature pages that exist', () => {
    for (const link of FEATURE_LINKS) {
      const slug = link.href.replace(/^\/features\//, '');
      expect(existsSync(`src/content/features/${slug}.mdx`), link.href).toBe(true);
    }
  });

  it('give each section a summary and a link to the whole section', () => {
    for (const section of NAV_SECTIONS) {
      expect(section.summary).not.toBe('');
      expect(section.index.href).toMatch(/^(\/|https:\/\/)/);
    }
  });
});
