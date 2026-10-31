import { describe, expect, it } from 'vitest';
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

describe('jsonLdProblems', () => {
  it('passes a graph of real schema.org types', () => {
    const block = graph(organization, {
      '@type': 'BlogPosting',
      headline: 'Hello',
      datePublished: '2026-10-01T00:00:00Z',
      author: { '@id': 'https://runovahq.com/#organization' },
      image: ['https://runovahq.com/og.png'],
    });
    expect(jsonLdProblems([{ path: '/blog/hello', json: block }])).toEqual([]);
  });

  it('passes a single node with a context', () => {
    const block = JSON.stringify({ '@context': 'https://schema.org', ...organization });
    expect(jsonLdProblems([{ path: '/', json: block }])).toEqual([]);
  });

  it('fails a type schema.org does not have', () => {
    const problems = jsonLdProblems([
      { path: '/news/x', json: graph({ '@type': 'NewsArticel', headline: 'x' }) },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^\/news\/x: /);
  });

  it('fails a property the type does not have', () => {
    const problems = jsonLdProblems([
      { path: '/help/relay', json: graph({ '@type': 'TechArticle', headlien: 'Relay' }) },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('headlien');
  });

  it('fails a value of the wrong kind', () => {
    const problems = jsonLdProblems([
      {
        path: '/',
        json: graph({
          '@type': 'BreadcrumbList',
          itemListElement: [{ '@type': 'ListItem', position: {} }],
        }),
      },
    ]);
    expect(problems).toHaveLength(1);
  });

  it('fails a block without the schema.org context', () => {
    const block = JSON.stringify({ '@context': 'https://example.com', ...organization });
    expect(jsonLdProblems([{ path: '/', json: block }])).toHaveLength(1);
  });

  it('names the page of each bad block, and only those', () => {
    const problems = jsonLdProblems([
      { path: '/a', json: graph(organization) },
      { path: '/b', json: graph({ '@type': 'Organisation' }) },
      { path: '/c', json: graph(organization) },
      { path: '/d', json: graph({ '@type': 'WebSite', nmae: 'x' }) },
    ]);
    expect(problems.map((problem) => problem.split(':')[0])).toEqual(['/b', '/d']);
  });

  it('reports a block that does not parse', () => {
    expect(jsonLdProblems([{ path: '/x', json: '{"@type":' }])[0]).toMatch(/^\/x: .*parse/);
  });
});
