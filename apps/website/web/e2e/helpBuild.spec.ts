import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { readableText, scanHtml } from '../tests/helpers/textScan';

// These read the build that the web server step wrote, so every link on every help page is
// checked against the files without a request each. The build is read inside the tests: when
// Playwright first loads this file, the web server may not have built it yet.
const client = fileURLToPath(new URL('../dist/client/', import.meta.url));
const articlesDir = new URL('../../../desktop/src/shared/help/articles/', import.meta.url);
const pagesDir = new URL('../src/pages/', import.meta.url);

let built: Map<string, string> | undefined;

/** Every built help page by its site path, the index included. */
function helpPages(): Map<string, string> {
  if (built) return built;
  const dir = `${client}help/`;
  const paths = [
    '/help',
    ...readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/help/${entry.name}`),
  ];
  built = new Map(
    paths.map((path) => [path, readFileSync(`${client}${path.slice(1)}/index.html`, 'utf8')]),
  );
  return built;
}

/** The built file a site path is served from, or undefined when there is none. */
function builtFile(path: string): string | undefined {
  const local = `${client}${decodeURIComponent(path).replace(/^\/+/, '')}`;
  for (const candidate of [local, `${local.replace(/\/$/, '')}/index.html`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Site paths of the top-level pages rendered on demand, which have no file in the build. */
function onDemandPages(): Set<string> {
  return new Set(
    readdirSync(pagesDir)
      .filter((name) => name.endsWith('.astro'))
      .filter((name) =>
        /export const prerender = false/.test(readFileSync(new URL(name, pagesDir), 'utf8')),
      )
      .map((name) => `/${name.slice(0, -'.astro'.length)}`),
  );
}

function article(name: string): string {
  return readFileSync(new URL(name, articlesDir), 'utf8');
}

test.describe('built help pages', () => {
  test('the build has a page per article', () => {
    const articles = readdirSync(articlesDir).filter((name) => name.endsWith('.md'));
    const pages = [...helpPages().keys()].filter((path) => path !== '/help');
    expect(pages.sort()).toEqual(articles.map((name) => `/help/${name.slice(0, -3)}`).sort());
  });

  test('every internal link on every help page resolves', () => {
    const broken: string[] = [];
    const onDemand = onDemandPages();
    let checked = 0;
    for (const [path, source] of helpPages()) {
      const base = new URL(path, 'https://runovahq.com');
      for (const match of source.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
        const href = match[1].replace(/&amp;/g, '&');
        const url = new URL(href, base);
        if (url.origin !== base.origin) continue;
        checked++;
        if (onDemand.has(url.pathname) && !url.hash) continue;
        const file = builtFile(url.pathname);
        if (!file) {
          broken.push(`${path} -> ${href}`);
          continue;
        }
        const anchor = decodeURIComponent(url.hash.slice(1));
        if (anchor && !readFileSync(file, 'utf8').includes(`id="${anchor}"`)) {
          broken.push(`${path} -> ${href} (no #${anchor})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(helpPages().size * 5);
    expect(broken).toEqual([]);
  });

  test('every help page passes the forbidden-phrase and em dash scan', () => {
    for (const [path, source] of helpPages()) expect(scanHtml(source), path).toEqual([]);
  });

  test('the Android and App Store articles keep every section', () => {
    for (const slug of ['android', 'deploy-app-store']) {
      const text = readableText(helpPages().get(`/help/${slug}`) ?? '');
      const headings = [...article(`${slug}.md`).matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
        m[1].trim(),
      );
      expect(headings.length, slug).toBeGreaterThan(5);
      for (const heading of headings) expect(text, slug).toContain(heading);
    }
  });

  test('the Android emulator example in the projects article is still there', () => {
    const text = readableText(helpPages().get('/help/projects') ?? '');
    expect(text).toContain('such as running the mobile app on the Android emulator');
  });
});
