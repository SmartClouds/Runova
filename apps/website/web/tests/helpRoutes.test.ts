import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readHelpArticles } from '../src/lib/help/articles';
import { featureForArticle, screenshotForArticle } from '../src/lib/help/routes';
import { featureEntryFiles } from './helpers/featureEntries';

const manifest: Array<{ name: string; route: string; theme: string }> = JSON.parse(
  readFileSync(new URL('../src/assets/screenshots/manifest.json', import.meta.url), 'utf8'),
);
const articles = readHelpArticles(
  fileURLToPath(new URL('../../../desktop/src/shared/help/articles/', import.meta.url)),
);
const features = featureEntryFiles();
const featureSlugs = features.map((feature) => feature.slug);

describe('featureForArticle', () => {
  it('maps a route to its feature page by the path, ignoring the query', () => {
    expect(featureForArticle('deploy', '/deploy')).toBe('ship');
    expect(featureForArticle('cloudflare', '/deploy?cloudflare=1')).toBe('ship');
    expect(featureForArticle('backup-restore', '/settings?tab=data')).toBe('more');
    expect(featureForArticle('dashboard', '/')).toBe('more');
    expect(featureForArticle('token-usage', '/usage')).toBe('token-usage');
  });

  it('picks the narrower feature for workspace articles that have their own page', () => {
    expect(featureForArticle('relay', '/workspace')).toBe('relay');
    expect(featureForArticle('workspace-git', '/workspace')).toBe('git-and-review');
    expect(featureForArticle('workspace-browser-tests', '/workspace')).toBe('tests');
    expect(featureForArticle('worktrees', '/workspace')).toBe('workspace');
  });

  it('gives nothing for an article without a route or with an unknown one', () => {
    expect(featureForArticle('getting-started', undefined)).toBeUndefined();
    expect(featureForArticle('new', '/somewhere-new')).toBeUndefined();
  });

  it.each(articles.filter((article) => article.data.route))(
    'links $id to a feature page that exists and lists it when any page does',
    (article) => {
      const feature = featureForArticle(article.id, article.data.route);
      expect(featureSlugs).toContain(feature);
      const listing = features
        .filter((entry) => entry.module.frontmatter.help.includes(article.id))
        .map((entry) => entry.slug);
      if (listing.length > 0) expect(listing).toContain(feature);
    },
  );
});

describe('screenshotForArticle', () => {
  it('prefers a dark shot named after the article', () => {
    expect(screenshotForArticle('relay', '/workspace', manifest)).toBe('relay');
    expect(screenshotForArticle('deploy-app-store', '/deploy', manifest)).toBe('deploy-app-store');
  });

  it('then matches the route exactly, then by path, then a page under it', () => {
    expect(screenshotForArticle('widgets-desktop-pet', '/settings?tab=companion', manifest)).toBe(
      'ai-pet',
    );
    expect(screenshotForArticle('keyboard-shortcuts', '/settings?tab=shortcuts', manifest)).toBe(
      'settings',
    );
    expect(screenshotForArticle('monitoring', '/monitoring', manifest)).toBe('monitoring-uptime');
    expect(screenshotForArticle('worktrees', '/workspace', manifest)).toBe('workspace');
    expect(screenshotForArticle('help-center', '/help', manifest)).toBe('help');
    expect(screenshotForArticle('dashboard', '/', manifest)).toBe('dashboard');
  });

  it('gives nothing when no shot fits', () => {
    expect(screenshotForArticle('android', '/android', manifest)).toBeUndefined();
    expect(screenshotForArticle('getting-started', undefined, manifest)).toBeUndefined();
  });

  it('never picks a shot in another theme', () => {
    for (const article of articles) {
      const name = screenshotForArticle(article.id, article.data.route, manifest);
      if (name) expect(manifest.find((shot) => shot.name === name)?.theme).toBe('dark');
    }
  });
});
