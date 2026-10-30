import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
import Breadcrumbs from '../src/components/Breadcrumbs.astro';
import { featureCrumbs } from '../src/lib/features';
import { breadcrumbList } from '../src/lib/seo';

const site = 'https://runovahq.com';

describe('featureCrumbs', () => {
  it('leads from home to the features index', () => {
    expect(featureCrumbs()).toEqual([
      { name: 'Home', path: '/' },
      { name: 'Features', path: '/features' },
    ]);
  });

  it('ends on the feature page', () => {
    expect(featureCrumbs({ slug: 'relay', title: 'Relay' })).toEqual([
      { name: 'Home', path: '/' },
      { name: 'Features', path: '/features' },
      { name: 'Relay', path: '/features/relay' },
    ]);
  });
});

describe('breadcrumbList', () => {
  it('numbers the crumbs from 1 with absolute URLs', () => {
    expect(breadcrumbList(site, featureCrumbs({ slug: 'ship', title: 'Ship' }))).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://runovahq.com/' },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Features',
          item: 'https://runovahq.com/features',
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: 'Ship',
          item: 'https://runovahq.com/features/ship',
        },
      ],
    });
  });
});

describe('Breadcrumbs', () => {
  it('is a labelled navigation list with links up to the current page', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Breadcrumbs, {
      props: { crumbs: featureCrumbs({ slug: 'git-and-review', title: 'Git, diffs and review' }) },
    });
    expect(html).toMatch(/<nav[^>]* aria-label="Breadcrumb"/);
    const items = html.match(/<li[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/<a[^>]* href="\/"[^>]*>Home<\/a>/);
    expect(items[1]).toMatch(/<a[^>]* href="\/features"[^>]*>Features<\/a>/);
    // The current page is text, not a link, and says so to screen readers.
    expect(items[2]).not.toContain('<a');
    expect(items[2]).toMatch(/aria-current="page"[^>]*>Git, diffs and review</);
  });
});
