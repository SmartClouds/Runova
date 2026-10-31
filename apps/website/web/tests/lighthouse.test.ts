import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_POSTS } from './fixtures/blog/posts';
import { FIXTURE_NEWS } from './fixtures/news/items';

// The budgets from docs/epics/40-website.md (SEO rules), T014 and T022, checked by
// `bun run lighthouse`.
const config = JSON.parse(readFileSync(new URL('../lighthouserc.json', import.meta.url), 'utf8'));
const { collect, assert } = config.ci;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

describe('lighthouserc', () => {
  it('runs against the built site served by bun run preview', () => {
    expect(collect.startServerCommand).toBe('bun run preview');
    expect(pkg.scripts.preview).toBe('bun scripts/preview.ts');
    expect(collect.numberOfRuns).toBeGreaterThanOrEqual(3);
  });

  it('audits the home page, a feature, a help article, download, a blog post and a news item', () => {
    const paths = collect.url.map((url: string) => {
      expect(url).toMatch(/^http:\/\/localhost:4321\//);
      return new URL(url).pathname;
    });
    expect(paths).toHaveLength(6);
    expect(paths[0]).toBe('/');
    expect(paths.slice(1, 4)).toEqual([
      expect.stringMatching(/^\/features\/[a-z-]+$/),
      expect.stringMatching(/^\/help\/[a-z-]+$/),
      '/download',
    ]);
    const post = paths[4].replace('/blog/', '');
    const item = paths[5].replace('/news/', '');
    // Fixture covers live on runovahq.com, which the CSP of a localhost build blocks, so the post
    // and the related posts it shows (release notes) have none.
    expect(FIXTURE_POSTS.find((fixture) => fixture.slug === post)?.coverImage).toBeNull();
    expect(FIXTURE_NEWS.map((fixture) => fixture.slug)).toContain(item);
  });

  it('serves the blog post and the news item from the fake API', () => {
    const script = readFileSync(new URL('../scripts/lighthouse.ts', import.meta.url), 'utf8');
    expect(script).toContain('e2e/fakeApiServer.ts');
    expect(script).toContain('WEBSITE_API_INTERNAL_URL');
  });

  it('uses mobile emulation', () => {
    const settings = collect.settings ?? {};
    expect(settings.preset ?? 'mobile').toBe('mobile');
    expect(settings.formFactor ?? 'mobile').toBe('mobile');
    expect(settings.screenEmulation?.mobile ?? true).toBe(true);
  });

  it('asserts the category budgets as errors', () => {
    expect(assert.assertions).toMatchObject({
      'categories:performance': ['error', { minScore: 0.9 }],
      'categories:accessibility': ['error', { minScore: 0.95 }],
      'categories:best-practices': ['error', { minScore: 0.95 }],
      'categories:seo': ['error', { minScore: 1 }],
    });
  });

  it('asserts LCP under 2.5 s and CLS under 0.1', () => {
    expect(assert.assertions).toMatchObject({
      'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
      'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
    });
  });

  it('has a lighthouse script that builds the site and runs lhci', () => {
    expect(pkg.scripts.lighthouse).toBe('bun scripts/lighthouse.ts');
    const script = readFileSync(new URL('../scripts/lighthouse.ts', import.meta.url), 'utf8');
    expect(script).toContain('SITE_URL');
    expect(script).toContain('lhci');
    expect(script).toContain('CHROME_PATH');
  });

  it('keeps the lhci output out of git', () => {
    const lines = gitignore.split('\n').map((line: string) => line.trim());
    expect(lines).toContain('.lighthouseci/');
  });
});
