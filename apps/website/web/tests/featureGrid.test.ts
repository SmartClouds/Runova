import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import FeatureGrid from '../src/components/features/FeatureGrid.astro';
import { FEATURE_GROUPS, type FeatureCard, groupLabel, matchesFilter } from '../src/lib/features';
import { featureEntryFiles } from './helpers/featureEntries';

const cards: FeatureCard[] = featureEntryFiles()
  .map(({ slug, module }) => ({ slug, ...module.frontmatter }) as FeatureCard)
  .sort((a, b) => a.order - b.order);

let html: string;

beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(FeatureGrid, { props: { features: cards } });
});

function decode(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

describe('matchesFilter', () => {
  const card = { group: 'ship', text: 'Ship. Pipelines, Deploy, Monitoring, Docker, Android' };

  it('keeps every card for all groups and an empty search', () => {
    expect(matchesFilter(card, 'all', '')).toBe(true);
    expect(matchesFilter(card, 'all', '   ')).toBe(true);
  });

  it('keeps only the chosen group', () => {
    expect(matchesFilter(card, 'ship', '')).toBe(true);
    expect(matchesFilter(card, 'connect', '')).toBe(false);
  });

  it('needs every word of the search, in any case and order', () => {
    expect(matchesFilter(card, 'all', 'docker')).toBe(true);
    expect(matchesFilter(card, 'all', 'DOCKER deploy')).toBe(true);
    expect(matchesFilter(card, 'all', 'docker vault')).toBe(false);
    expect(matchesFilter(card, 'connect', 'docker')).toBe(false);
  });
});

describe('FeatureGrid', () => {
  it('renders a card per feature in the server HTML, linking its page', () => {
    const items = html.match(/<li[^>]* data-feature-card[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(cards.length);
    items.forEach((item, index) => {
      const card = cards[index];
      expect(item).toContain(`data-group="${card.group}"`);
      expect(item).toMatch(new RegExp(`<a[^>]* href="/features/${card.slug}"`));
      expect(decode(item)).toContain(card.title);
    });
  });

  it('lets a search find a card by the README features it covers', () => {
    const ship = /<li[^>]* data-feature-card[^>]*data-group="ship"[^>]*>/.exec(html)?.[0] ?? '';
    const text = decode(/ data-search="([^"]*)"/.exec(ship)?.[1] ?? '');
    expect(matchesFilter({ group: 'ship', text }, 'all', 'docker')).toBe(true);
  });

  it('shows a screenshot with alt text on every card', () => {
    const items = html.match(/<li[^>]* data-feature-card[\s\S]*?<\/li>/g) ?? [];
    for (const item of items) expect(item).toMatch(/<img[^>]* alt="[^"]{20,}"/);
  });

  it('offers All plus one toggle per group that has a feature', () => {
    const buttons = [...html.matchAll(/<button[^>]*data-filter-group="([\w-]+)"[^>]*>([^<]*)</g)];
    const used = FEATURE_GROUPS.filter((group) => cards.some((card) => card.group === group.id));
    expect(buttons.map((button) => button[1])).toEqual(['all', ...used.map((group) => group.id)]);
    expect(buttons.map((button) => button[2].trim())).toEqual([
      'All',
      ...used.map((group) => groupLabel(group.id)),
    ]);
    const all = /<button[^>]*data-filter-group="all"[^>]*>/.exec(html)?.[0] ?? '';
    expect(all).toContain('aria-pressed="true"');
    for (const group of used) {
      const button =
        new RegExp(`<button[^>]*data-filter-group="${group.id}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(button).toContain('aria-pressed="false"');
      expect(button).toContain('type="button"');
    }
  });

  it('labels the search box and the group toggles', () => {
    const input = /<input[^>]* data-filter-search[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('type="search"');
    const id = / id="([^"]+)"/.exec(input)?.[1];
    expect(id).toBeTruthy();
    expect(html).toMatch(new RegExp(`<label[^>]* for="${id}"`));
    expect(html).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Filter by group<\/legend>/);
  });

  it('keeps the controls hidden until the script binds them, so the grid works without it', () => {
    expect(html).toMatch(/<div[^>]* data-filter-controls[^>]* hidden/);
  });

  it('announces the number of matching features in a live region', () => {
    expect(html).toMatch(
      new RegExp(`<p[^>]* aria-live="polite"[^>]*>[^<]*${cards.length} of ${cards.length}`),
    );
  });
});
