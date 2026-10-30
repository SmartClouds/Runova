import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import NotFoundPage from '../src/pages/404.astro';
import NewsItemPage from '../src/pages/news/[slug].astro';
import NewsIndex from '../src/pages/news/index.astro';
import { BY_SEVERITY, FIXTURE_NEWS, type FixtureSeverity } from './fixtures/news/items';
import { type FakeNewsApi, startFakeNewsApi } from './helpers/fakeNewsApi';
import { deadApiUrl } from './helpers/fakeReleaseApi';
import { scanHtml } from './helpers/textScan';

const SITE = 'https://runovahq.com';
const LIST_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const ITEM_CACHE = 'public, max-age=300, stale-while-revalidate=600';

type Page = Parameters<AstroContainer['renderToResponse']>[0];

let container: AstroContainer;
let api: FakeNewsApi;
let unavailable: FakeNewsApi;

beforeAll(async () => {
  container = await AstroContainer.create({
    renderers: await loadRenderers([reactRenderer()]),
    astroConfig: { site: SITE },
  });
  api = await startFakeNewsApi();
  unavailable = await startFakeNewsApi({ status: 503 });
});

afterAll(async () => {
  await api?.close();
  await unavailable?.close();
});

interface Rendered {
  response: Response;
  html: string;
}

async function render(
  page: Page,
  path: string,
  params: Record<string, string> = {},
  apiUrl = api.url,
): Promise<Rendered> {
  process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
  const response = await container.renderToResponse(page, {
    request: new Request(`${SITE}${path}`),
    params,
  });
  return { response, html: await response.text() };
}

const list = (query = '') => render(NewsIndex, `/news${query}`);
const itemPage = (slug: string) => render(NewsItemPage, `/news/${slug}`, { slug });

/** The slugs of the news cards on a list page, in order. */
function cardSlugs(html: string): string[] {
  return [...html.matchAll(/<article\b[^>]*\bdata-news-card="([^"]*)"/g)].map((match) => match[1]);
}

/** The markup of the card for `slug`. */
function card(html: string, slug: string): string {
  const start = html.indexOf(`data-news-card="${slug}"`);
  expect(start, `card ${slug}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</article>', start));
}

/** The opening tag and contents of the first element with `attribute`, up to its closing tag. */
function element(html: string, attribute: string, tag = 'span'): string | undefined {
  const match = new RegExp(
    `<${tag}\\b[^>]*\\b${attribute}(?![\\w-])[^>]*>[\\s\\S]*?</${tag}>`,
  ).exec(html);
  return match?.[0];
}

/** Text with tags and entities stripped and spaces collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The lucide icon names in a piece of markup, such as `triangle-alert`. Old alias names are skipped. */
function icons(html: string): string[] {
  return [...html.matchAll(/class="lucide lucide-([a-z0-9-]+)/g)].map((match) => match[1]);
}

function canonical(html: string): string | undefined {
  return /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
}

function meta(html: string, property: string): string | undefined {
  return new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1];
}

function heading(html: string): string {
  return text(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '');
}

/** The checkbox for `name=value` in the filter form, or undefined. */
function checkbox(html: string, name: string, value: string): string | undefined {
  const form = element(html, 'data-news-filters', 'form') ?? '';
  return [...form.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .find((input) => input.includes(`name="${name}"`) && input.includes(`value="${value}"`));
}

const isChecked = (input: string | undefined) => /\bchecked\b/.test(input ?? '');

/** The page's main content, which a not-found news page shares with the site's 404 page. */
function main(html: string): string {
  return /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1].trim() ?? '';
}

const LEVELS: FixtureSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];
const LABELS: Record<FixtureSeverity, string> = {
  info: 'Info',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};
// docs/website/design.md, Severity colors.
const ICONS: Record<FixtureSeverity, string> = {
  info: 'info',
  low: 'shield-check',
  medium: 'shield-alert',
  high: 'triangle-alert',
  critical: 'octagon-alert',
};

describe('/news', () => {
  it('lists the newest twenty items with the list Cache-Control', async () => {
    const { response, html } = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(LIST_CACHE);
    expect(cardSlugs(html)).toEqual(FIXTURE_NEWS.slice(0, 20).map((item) => item.slug));
    expect(canonical(html)).toBe(`${SITE}/news`);
    expect(heading(html)).toBe('Technology news');
    expect(api.requests).toContain('/api/v1/news?page=1&pageSize=20');
  });

  for (const level of LEVELS) {
    it(`shows a ${level} item with its own icon, label and color`, async () => {
      const { html } = await list();
      const item = BY_SEVERITY[level];
      const markup = card(html, item.slug);
      expect(markup).toContain(`data-severity="${level}"`);
      const badge = element(markup, `data-severity-badge="${level}"`);
      expect(badge).toBeDefined();
      expect(icons(badge ?? '')).toEqual([ICONS[level]]);
      expect(text(badge ?? '')).toBe(LABELS[level]);
      expect(badge).toContain(`text-severity-${level}`);
    });
  }

  it('gives every severity level a different icon and label', async () => {
    const { html } = await list();
    const badges = LEVELS.map(
      (level) => element(card(html, BY_SEVERITY[level].slug), 'data-severity-badge') ?? '',
    );
    expect(new Set(badges.map((badge) => icons(badge)[0])).size).toBe(LEVELS.length);
    expect(new Set(badges.map(text)).size).toBe(LEVELS.length);
  });

  it('shows the category, title, summary, date and affected technologies of each item', async () => {
    const { html } = await list();
    const item = FIXTURE_NEWS[0];
    const markup = card(html, item.slug);
    const chip = element(markup, 'data-category-chip="security"');
    expect(text(chip ?? '')).toBe('Security');
    expect(icons(chip ?? '')).toEqual(['shield']);
    expect(markup).toContain(`href="/news/${item.slug}"`);
    expect(text(markup)).toContain(item.title);
    expect(text(markup)).toContain(item.summary);
    expect(markup).toContain(`datetime="${new Date(item.publishedAt).toISOString()}"`);
    const technologies = element(markup, 'aria-label="Affected technologies"', 'ul') ?? '';
    expect(text(technologies)).toContain('OpenSSH >=9.8.0 <10.3.0');
    expect(text(technologies)).toContain('fixed in 10.3.0');
  });

  it('gives each category its label and icon', async () => {
    const { html } = await list();
    const expected = {
      release: ['Release', 'tag'],
      deprecation: ['Deprecation', 'archive'],
      'end-of-life': ['End of life', 'calendar-x'],
      ai: ['AI', 'sparkles'],
      tooling: ['Tooling', 'wrench'],
      industry: ['Industry', 'newspaper'],
    };
    for (const [category, [label, icon]] of Object.entries(expected)) {
      const chip = element(html, `data-category-chip="${category}"`) ?? '';
      expect(text(chip), category).toBe(label);
      expect(icons(chip), category).toEqual([icon]);
    }
  });

  it('puts a what to do box with the CVE ids, affected versions and fixed-in version on security items', async () => {
    const { html } = await list();
    const item = BY_SEVERITY.critical;
    const box = element(card(html, item.slug), 'data-security-box', 'section') ?? '';
    const words = text(box);
    expect(words).toContain('What to do');
    expect(words).toContain('CVE-2026-50101');
    expect(words).toContain('CVE-2026-50102');
    expect(words).toContain('>=22.0.0 <22.21.1');
    expect(words).toContain('>=24.0.0 <24.11.1');
    expect(words).toContain('Update Node.js to 22.21.1 or later');
    expect(words).toContain('Update Node.js to 24.11.1 or later');
  });

  it('says when a security item has no fixed version yet', async () => {
    const { html } = await list();
    const box = element(card(html, BY_SEVERITY.low.slug), 'data-security-box', 'section') ?? '';
    expect(text(box)).toContain('No fixed version of nginx is out yet');
  });

  it('puts no what to do box on items that are not security', async () => {
    const { html } = await list();
    expect(card(html, BY_SEVERITY.info.slug)).not.toContain('data-security-box');
  });

  it('filters by category and severity from the query string and keeps them in the form', async () => {
    const { response, html } = await list('?category=security&severity=high&severity=critical');
    expect(response.status).toBe(200);
    expect(api.requests).toContain(
      '/api/v1/news?category=security&severity=high&severity=critical&page=1&pageSize=20',
    );
    expect(cardSlugs(html)).toEqual(
      FIXTURE_NEWS.filter(
        (item) => item.category === 'security' && ['high', 'critical'].includes(item.severity),
      ).map((item) => item.slug),
    );
    expect(isChecked(checkbox(html, 'category', 'security'))).toBe(true);
    expect(isChecked(checkbox(html, 'severity', 'high'))).toBe(true);
    expect(isChecked(checkbox(html, 'severity', 'critical'))).toBe(true);
    expect(isChecked(checkbox(html, 'category', 'release'))).toBe(false);
    expect(isChecked(checkbox(html, 'severity', 'info'))).toBe(false);
    expect(canonical(html)).toBe(`${SITE}/news`);
  });

  it('offers a chip for every category and severity, with a submit button for browsers without scripts', async () => {
    const { html } = await list();
    const form = element(html, 'data-news-filters', 'form') ?? '';
    expect(form).toMatch(/method="get"/);
    expect(form).toMatch(/action="\/news"/);
    for (const category of [
      'security',
      'release',
      'deprecation',
      'end-of-life',
      'ai',
      'tooling',
      'industry',
    ]) {
      expect(checkbox(html, 'category', category), category).toBeDefined();
    }
    for (const level of LEVELS) {
      const input = checkbox(html, 'severity', level);
      expect(input, level).toBeDefined();
      const label =
        new RegExp(
          `<label\\b[^>]*>(?:(?!</label>)[\\s\\S])*value="${level}"[\\s\\S]*?</label>`,
        ).exec(form)?.[0] ?? '';
      expect(icons(label), level).toEqual([ICONS[level]]);
    }
    expect(form).toMatch(/<button\b[^>]*type="submit"/);
  });

  it('ignores filter values the API does not know', async () => {
    const before = api.requests.length;
    const { response, html } = await list('?category=gossip&severity=urgent&severity=low');
    expect(response.status).toBe(200);
    expect(api.requests.slice(before)).toEqual(['/api/v1/news?severity=low&page=1&pageSize=20']);
    expect(cardSlugs(html)).toEqual([BY_SEVERITY.low.slug]);
  });

  it('pages with ?page and keeps the filters in the pager links', async () => {
    const { response, html } = await list('?category=release&page=2');
    expect(response.status).toBe(200);
    const releases = FIXTURE_NEWS.filter((item) => item.category === 'release');
    expect(cardSlugs(html)).toEqual(releases.slice(20).map((item) => item.slug));
    expect(html).toContain('href="/news?category=release" rel="prev"');
    expect(canonical(html)).toBe(`${SITE}/news`);
    const first = await list('?category=release');
    expect(first.html).toContain('href="/news?category=release&amp;page=2" rel="next"');
  });

  it('keeps the page number in the canonical of an unfiltered later page', async () => {
    const { html } = await list('?page=2');
    expect(cardSlugs(html)).toEqual(FIXTURE_NEWS.slice(20).map((item) => item.slug));
    expect(canonical(html)).toBe(`${SITE}/news?page=2`);
    expect(meta(html, 'og:url')).toBe(`${SITE}/news?page=2`);
  });

  it('answers 404 for a page past the end or a page that is not a number', async () => {
    for (const query of ['?page=3', '?page=0', '?page=two']) {
      const { response } = await list(query);
      expect(response.status, query).toBe(404);
      expect(response.headers.get('cache-control'), query).toBe('no-store');
    }
  });

  it('says so when nothing matches the filters, with a way back to all news', async () => {
    const { response, html } = await list('?category=ai&severity=critical');
    expect(response.status).toBe(200);
    expect(cardSlugs(html)).toEqual([]);
    expect(text(main(html))).toContain('No news matches these filters');
    expect(main(html)).toContain('href="/news"');
  });

  it('answers 503 with Retry-After and a short notice when the API is down', async () => {
    const { response, html } = await render(NewsIndex, '/news', {}, unavailable.url);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(heading(html)).toBe('The news could not be loaded');
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
  });

  it('answers 503 when nothing listens at the API URL', async () => {
    const { response } = await render(NewsIndex, '/news', {}, await deadApiUrl());
    expect(response.status).toBe(503);
  });

  it('links its RSS feed and passes the site text scan', async () => {
    const { html } = await list();
    const alternate = /<link rel="alternate"[^>]*>/.exec(html)?.[0] ?? '';
    expect(alternate).toContain('type="application/rss+xml"');
    expect(alternate).toContain('href="/news/rss.xml"');
    expect(scanHtml(html)).toEqual([]);
  });
});

describe('/news/<slug>', () => {
  it('shows the item with its severity, category, body and sources', async () => {
    const item = BY_SEVERITY.high;
    const { response, html } = await itemPage(item.slug);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(ITEM_CACHE);
    expect(heading(html)).toBe(item.title);
    expect(canonical(html)).toBe(`${SITE}/news/${item.slug}`);
    expect(meta(html, 'og:type')).toBe('article');
    const body = main(html);
    expect(text(element(body, 'data-severity-badge="high"') ?? '')).toBe('High');
    expect(text(element(body, 'data-category-chip="security"') ?? '')).toBe('Security');
    expect(body).toContain('<h2>Who is affected</h2>');
    expect(body).toContain('href="https://www.openssh.com/releasenotes.html"');
    expect(text(body)).toContain('CVSS 7.5');
  });

  it('shows the CVE ids, affected versions and fixed-in version of a security item', async () => {
    const { html } = await itemPage(BY_SEVERITY.high.slug);
    const box = element(main(html), 'data-security-box', 'section') ?? '';
    const words = text(box);
    expect(words).toContain('CVE-2026-41234');
    expect(box).toContain('href="https://www.cve.org/CVERecord?id=CVE-2026-41234"');
    expect(words).toContain('>=9.8.0 <10.3.0');
    expect(words).toContain('Update OpenSSH to 10.3.0 or later');
  });

  it('has NewsArticle JSON-LD with the headline and both dates', async () => {
    const item = BY_SEVERITY.high;
    const { html } = await itemPage(item.slug);
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const graph = (JSON.parse(json ?? '{}')['@graph'] ?? []) as Array<Record<string, unknown>>;
    const article = graph.find((node) => node['@type'] === 'NewsArticle');
    expect(article).toMatchObject({
      '@type': 'NewsArticle',
      headline: item.title,
      description: item.summary,
      datePublished: item.publishedAt,
      dateModified: item.updatedAt,
      url: `${SITE}/news/${item.slug}`,
      mainEntityOfPage: `${SITE}/news/${item.slug}`,
      author: { '@id': `${SITE}/#organization` },
      publisher: { '@id': `${SITE}/#organization` },
      articleSection: 'Security',
      keywords: 'ssh, servers',
      inLanguage: 'en',
    });
    expect(article?.image).toEqual([`${SITE}/og/default.png`]);
  });

  it('answers 404 with the site 404 page for an unknown slug', async () => {
    const { response, html } = await itemPage('no-such-item');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const notFound = await container.renderToString(NotFoundPage);
    expect(main(html)).toBe(main(notFound));
  });

  it('answers 404 without asking the API for a slug it would refuse', async () => {
    const before = api.requests.length;
    const { response } = await itemPage('12345');
    expect(response.status).toBe(404);
    expect(api.requests.length).toBe(before);
  });

  it('answers 503 when the API is down', async () => {
    const { response, html } = await render(
      NewsItemPage,
      `/news/${FIXTURE_NEWS[0].slug}`,
      { slug: FIXTURE_NEWS[0].slug },
      unavailable.url,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(heading(html)).toBe('The news could not be loaded');
  });

  it('passes the site text scan', async () => {
    for (const level of LEVELS) {
      const { html } = await itemPage(BY_SEVERITY[level].slug);
      expect(scanHtml(html), level).toEqual([]);
    }
  });
});
