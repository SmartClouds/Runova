import { loadRenderers } from 'astro:container';
import { fileURLToPath } from 'node:url';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import HelpLayout from '../src/layouts/HelpLayout.astro';
import { readHelpArticles } from '../src/lib/help/articles';
import {
  helpCrumbs,
  helpMetaDescription,
  helpPageTitle,
  helpTechArticle,
} from '../src/lib/help/page';
import { scanHtml } from './helpers/textScan';

const site = 'https://runovahq.com';

describe('helpPageTitle', () => {
  it('sets the article apart from the feature page and the help index of the same name', () => {
    expect(helpPageTitle('Studio')).toBe('Studio guide');
    expect(helpPageTitle('Help center')).toBe('Help center guide');
  });
});

describe('helpMetaDescription', () => {
  it('keeps a summary of 70 to 160 characters', () => {
    const summary = 'A password manager built into Runova that keeps your logins encrypted.';
    expect(helpMetaDescription(summary)).toBe(summary);
  });

  it('cuts a long summary at the last sentence that fits', () => {
    const first = 'Watch your sites and servers, and see the errors your apps report in one place.';
    const summary = `${first} ${'Then it does many other things as well, '.repeat(4)}and more.`;
    expect(helpMetaDescription(summary)).toBe(first);
  });

  it('cuts a long sentence at a word and ends it with an ellipsis', () => {
    const summary = `Studio ${'turns a short brief into a video '.repeat(8)}today.`;
    const description = helpMetaDescription(summary);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description).toMatch(/\w…$/);
    expect(summary.startsWith(description.slice(0, -1))).toBe(true);
  });

  it('lengthens a short summary so it reaches 70 characters', () => {
    const description = helpMetaDescription('Keyboard shortcuts.');
    expect(description).toBe(
      'Keyboard shortcuts. A step-by-step guide from the Runova help center for the desktop app.',
    );
    expect(helpMetaDescription('Short.').length).toBeGreaterThanOrEqual(70);
  });

  it('keeps every app article inside the limits', () => {
    const articles = readHelpArticles(
      fileURLToPath(new URL('../../../desktop/src/shared/help/articles/', import.meta.url)),
    );
    const descriptions = articles.map((article) => helpMetaDescription(article.data.summary));
    for (const description of descriptions) {
      expect(description.length).toBeGreaterThanOrEqual(70);
      expect(description.length).toBeLessThanOrEqual(160);
    }
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe('helpCrumbs', () => {
  it('goes Home, Help, then the article', () => {
    expect(helpCrumbs()).toEqual([
      { name: 'Home', path: '/' },
      { name: 'Help', path: '/help' },
    ]);
    expect(helpCrumbs({ slug: 'vault', title: 'Vault' })).toEqual([
      { name: 'Home', path: '/' },
      { name: 'Help', path: '/help' },
      { name: 'Vault', path: '/help/vault' },
    ]);
  });
});

describe('helpTechArticle', () => {
  it('describes an article for search engines', () => {
    expect(
      helpTechArticle(site, {
        slug: 'vault',
        title: 'Vault',
        description: 'The description.',
        category: 'Connect',
        keywords: ['vault', 'secrets'],
        image: '/_astro/vault.webp',
      }),
    ).toEqual({
      '@type': 'TechArticle',
      '@id': 'https://runovahq.com/help/vault#article',
      headline: 'Vault',
      description: 'The description.',
      url: 'https://runovahq.com/help/vault',
      mainEntityOfPage: 'https://runovahq.com/help/vault',
      articleSection: 'Connect',
      keywords: 'vault, secrets',
      inLanguage: 'en',
      image: 'https://runovahq.com/_astro/vault.webp',
      author: { '@id': 'https://runovahq.com/#organization' },
      publisher: { '@id': 'https://runovahq.com/#organization' },
      isPartOf: { '@id': 'https://runovahq.com/#website' },
      about: { '@type': 'SoftwareApplication', name: 'Runova' },
    });
  });
});

describe('the help article layout', () => {
  const fixtures = fileURLToPath(new URL('./fixtures/help/', import.meta.url));
  const remote = readHelpArticles(fixtures).find((entry) => entry.id === 'remote');
  let html = '';

  beforeAll(async () => {
    if (!remote) throw new Error('no remote fixture');
    const renderers = await loadRenderers([reactRenderer()]);
    const container = await AstroContainer.create({ renderers, astroConfig: { site } });
    html = await container.renderToString(HelpLayout, {
      props: {
        slug: remote.id,
        data: remote.data,
        html: '<h2 id="host-let-another-device-control-this-computer">Host</h2><p>Body text.</p>',
        previous: { slug: 'android', title: 'Android' },
        next: { slug: 'vault', title: 'Vault' },
        feature: { slug: 'connect', title: 'Connect' },
        shot: 'ssh',
      },
      request: new Request(`${site}/help/remote`),
    });
  });

  function jsonLdNodes(): Array<Record<string, unknown>> {
    const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    return JSON.parse(script ?? '{}')['@graph'] ?? [];
  }

  it('has the head of a help page', () => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe('Remote guide | Runova');
    expect(html).toContain('<link rel="canonical" href="https://runovahq.com/help/remote">');
    expect(html).toMatch(/<meta property="og:type" content="article"/);
  });

  it('has one h1, the category and the summary', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(/<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1]).toBe('Remote');
    expect(html).toContain('Connect');
    expect(html).toContain(remote?.data.summary);
  });

  it('describes the page as a TechArticle with a BreadcrumbList', () => {
    const nodes = jsonLdNodes();
    const article = nodes.find((node) => node['@type'] === 'TechArticle');
    expect(article?.headline).toBe('Remote');
    expect(article?.url).toBe('https://runovahq.com/help/remote');
    expect(String(article?.image)).toMatch(/^https:\/\/runovahq\.com\/_(astro|image)/);
    const crumbs = nodes.find((node) => node['@type'] === 'BreadcrumbList');
    expect(crumbs?.itemListElement).toHaveLength(3);
    expect(html).toMatch(/<nav[^>]* aria-label="Breadcrumb"/);
  });

  it('lists every heading in the table of contents', () => {
    const toc = /<nav[^>]* aria-label="On this page"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    for (const item of remote?.data.toc ?? []) expect(toc).toContain(`href="#${item.id}"`);
  });

  it('links to the article before and after it and to its feature page', () => {
    const pager = /<nav[^>]* aria-label="More articles"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect(pager).toMatch(/href="\/help\/android"[\s\S]*Android/);
    expect(pager).toMatch(/href="\/help\/vault"[\s\S]*Vault/);
    expect(html).toMatch(/href="\/features\/connect"/);
  });

  it('shows the screenshot for the route with its alt text', () => {
    expect(html).toMatch(/<img[^>]+alt="[^"]+"/);
  });

  it('marks the article for the search index, with the keywords as an indexed attribute', () => {
    expect(html).toMatch(/data-pagefind-body/);
    expect(html).toMatch(
      /data-pagefind-index-attrs="data-keywords"[^>]*data-keywords="remote, ssh, host, pairing code, qr code, rdp, lan"|data-keywords="remote, ssh, host, pairing code, qr code, rdp, lan"[^>]*data-pagefind-index-attrs="data-keywords"/,
    );
  });

  it('passes the text scan', () => {
    expect(scanHtml(html)).toEqual([]);
  });
});
