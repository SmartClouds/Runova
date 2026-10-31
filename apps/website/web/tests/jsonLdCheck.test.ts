import { beforeAll, describe, expect, it } from 'vitest';
import { jsonLdProblems } from '../scripts/jsonLdCheck';

const organization = {
  '@type': 'Organization',
  '@id': 'https://runovahq.com/#organization',
  name: 'Runova',
  url: 'https://runovahq.com/',
};

function graph(...nodes: object[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes });
}

// Each block is on a page of its own, so one check covers every case. That is how the build check
// calls it too, and each check builds the whole schema.org type graph, which costs far more than
// the blocks in it.
const BLOCKS = [
  {
    path: '/blog/hello',
    json: graph(organization, {
      '@type': 'BlogPosting',
      headline: 'Hello',
      datePublished: '2026-10-01T00:00:00Z',
      author: { '@id': 'https://runovahq.com/#organization' },
      image: ['https://runovahq.com/og.png'],
    }),
  },
  { path: '/', json: JSON.stringify({ '@context': 'https://schema.org', ...organization }) },
  { path: '/news/x', json: graph({ '@type': 'NewsArticel', headline: 'x' }) },
  { path: '/help/relay', json: graph({ '@type': 'TechArticle', headlien: 'Relay' }) },
  {
    path: '/features',
    json: graph({
      '@type': 'BreadcrumbList',
      itemListElement: [{ '@type': 'ListItem', position: {} }],
    }),
  },
  {
    path: '/download',
    json: JSON.stringify({ '@context': 'https://example.com', ...organization }),
  },
  { path: '/a', json: graph(organization) },
  { path: '/b', json: graph({ '@type': 'Organisation' }) },
  { path: '/c', json: graph(organization) },
  { path: '/d', json: graph({ '@type': 'WebSite', nmae: 'x' }) },
];

let problems: string[];
beforeAll(() => {
  problems = jsonLdProblems(BLOCKS);
});

const problemsOf = (path: string) => problems.filter((problem) => problem.startsWith(`${path}: `));

describe('jsonLdProblems', () => {
  it('passes a graph of real schema.org types', () => {
    expect(problemsOf('/blog/hello')).toEqual([]);
  });

  it('passes a single node with a context', () => {
    expect(problemsOf('/')).toEqual([]);
  });

  it('fails a type schema.org does not have', () => {
    expect(problemsOf('/news/x')).toHaveLength(1);
  });

  it('fails a property the type does not have', () => {
    expect(problemsOf('/help/relay')).toHaveLength(1);
    expect(problemsOf('/help/relay')[0]).toContain('headlien');
  });

  it('fails a value of the wrong kind', () => {
    expect(problemsOf('/features')).toHaveLength(1);
  });

  it('fails a block without the schema.org context', () => {
    expect(problemsOf('/download')).toHaveLength(1);
  });

  it('names the page of each bad block, and only those', () => {
    expect(problems.map((problem) => problem.split(':')[0])).toEqual([
      '/news/x',
      '/help/relay',
      '/features',
      '/download',
      '/b',
      '/d',
    ]);
  });

  it('reports a block that does not parse', () => {
    expect(jsonLdProblems([{ path: '/x', json: '{"@type":' }])[0]).toMatch(/^\/x: .*parse/);
  });
});
