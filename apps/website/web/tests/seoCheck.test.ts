import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtPages, pageMeta, seoProblems } from '../scripts/seoCheck';

const pkg = await import('../package.json', { with: { type: 'json' } });

const DESCRIPTION =
  'A description long enough for a search result, between seventy and 160 characters.';

function html({
  title = 'Page | Runova',
  description = DESCRIPTION,
  canonical = 'https://runovahq.com/page',
  jsonLd = ['{"@context":"https://schema.org","@graph":[]}'],
}: {
  title?: string;
  description?: string;
  canonical?: string;
  jsonLd?: string[];
} = {}) {
  return [
    '<!doctype html><html lang="en"><head>',
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${canonical}">`,
    ...jsonLd.map((block) => `<script type="application/ld+json">${block}</script>`),
    '</head><body></body></html>',
  ].join('');
}

describe('pageMeta', () => {
  it('reads the title, description and canonical with entities decoded', () => {
    const meta = pageMeta(
      html({ title: 'Git &amp; review | Runova', description: `It&#39;s ${DESCRIPTION}` }),
    );
    expect(meta.titles).toEqual(['Git & review | Runova']);
    expect(meta.descriptions).toEqual([`It's ${DESCRIPTION}`]);
    expect(meta.canonicals).toEqual(['https://runovahq.com/page']);
    expect(meta.jsonLd).toHaveLength(1);
  });
});

describe('seoProblems', () => {
  it('passes pages with their own title and description', () => {
    expect(
      seoProblems([
        { path: '/a', html: html({ title: 'A | Runova', description: `A. ${DESCRIPTION}` }) },
        { path: '/b', html: html({ title: 'B | Runova', description: `B. ${DESCRIPTION}` }) },
      ]),
    ).toEqual([]);
  });

  it('fails two pages that share a title', () => {
    const problems = seoProblems([
      { path: '/a', html: html({ description: `A. ${DESCRIPTION}` }) },
      { path: '/b', html: html({ description: `B. ${DESCRIPTION}` }) },
    ]);
    expect(problems).toEqual(['/a and /b share the title "Page | Runova"']);
  });

  it('fails two pages that share a description', () => {
    const problems = seoProblems([
      { path: '/a', html: html({ title: 'A | Runova' }) },
      { path: '/b', html: html({ title: 'B | Runova' }) },
    ]);
    expect(problems).toEqual([`/a and /b share the description "${DESCRIPTION}"`]);
  });

  it('fails a page without exactly one title, description and canonical', () => {
    const page = html()
      .replace(/<title>.*<\/title>/, '')
      .replace(/<link rel="canonical"[^>]*>/, '');
    expect(seoProblems([{ path: '/a', html: page }])).toEqual([
      '/a has 0 titles',
      '/a has 0 canonical links',
    ]);
    const twice = html().replace(
      '</head>',
      `<meta name="description" content="${DESCRIPTION}"></head>`,
    );
    expect(seoProblems([{ path: '/a', html: twice }])).toEqual(['/a has 2 meta descriptions']);
  });

  it('fails a description outside 70 to 160 characters', () => {
    expect(seoProblems([{ path: '/a', html: html({ description: 'Too short.' }) }])).toEqual([
      '/a has a description of 10 characters, not 70 to 160',
    ]);
  });

  it('fails a JSON-LD block that does not parse', () => {
    const problems = seoProblems([{ path: '/a', html: html({ jsonLd: ['{"@type": }'] }) }]);
    expect(problems).toEqual([expect.stringMatching(/^\/a: the JSON-LD does not parse: /)]);
  });

  it('fails a JSON-LD block that does not match its schema.org type', () => {
    const block =
      '{"@context":"https://schema.org","@graph":[{"@type":"WebSite","nmae":"Runova"}]}';
    const problems = seoProblems([{ path: '/a', html: html({ jsonLd: [block] }) }]);
    expect(problems).toEqual([expect.stringMatching(/^\/a: .*nmae/)]);
  });
});

describe('builtPages', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads every HTML page in the build with its path, and skips Pagefind and assets', () => {
    dir = mkdtempSync(join(tmpdir(), 'seo-check-'));
    for (const folder of ['features/ship', 'pagefind', '_astro']) {
      mkdirSync(join(dir, folder), { recursive: true });
    }
    writeFileSync(join(dir, 'index.html'), html());
    writeFileSync(join(dir, '404.html'), html());
    writeFileSync(join(dir, 'features', 'ship', 'index.html'), html());
    writeFileSync(join(dir, 'pagefind', 'x.html'), html());
    writeFileSync(join(dir, '_astro', 'y.html'), html());
    expect(
      builtPages(dir)
        .map((page) => page.path)
        .sort(),
    ).toEqual(['/', '/404', '/features/ship']);
  });
});

describe('the build', () => {
  it('runs the check after the build', () => {
    expect(pkg.default.scripts.build).toMatch(/&& bun scripts\/seoCheck\.ts$/);
  });
});
