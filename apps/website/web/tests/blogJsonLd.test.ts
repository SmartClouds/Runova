import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blogPosting } from '../src/lib/blog/page';
import Post from '../src/pages/blog/[slug].astro';
import { FIXTURE_POSTS } from './fixtures/blog/posts';
import { type FakeBlogApi, startFakeBlogApi } from './helpers/fakeBlogApi';

const SITE = 'https://runovahq.com';

let container: AstroContainer;
let api: FakeBlogApi;

beforeAll(async () => {
  container = await AstroContainer.create({
    renderers: await loadRenderers([reactRenderer()]),
    astroConfig: { site: SITE },
  });
  api = await startFakeBlogApi();
});

afterAll(async () => {
  await api?.close();
});

type Node = Record<string, unknown>;

async function postingOnPage(slug: string): Promise<Node | undefined> {
  process.env.WEBSITE_API_INTERNAL_URL = api.url;
  const html = await container.renderToString(Post, {
    request: new Request(`${SITE}/blog/${slug}`),
    params: { slug },
  });
  const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  const graph = (JSON.parse(json ?? '{}')['@graph'] ?? []) as Node[];
  return graph.find((node) => node['@type'] === 'BlogPosting');
}

describe('BlogPosting JSON-LD', () => {
  it('has the headline, dates, author and cover image of a post', async () => {
    const post = FIXTURE_POSTS[0];
    const posting = await postingOnPage(post.slug);
    expect(posting).toMatchObject({
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.excerpt,
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      author: { '@type': 'Person', name: post.author.displayName },
      image: [post.coverImage?.url],
      url: `${SITE}/blog/${post.slug}`,
      mainEntityOfPage: `${SITE}/blog/${post.slug}`,
      publisher: { '@id': `${SITE}/#organization` },
      keywords: 'Agents, Relay',
      inLanguage: 'en',
    });
  });

  it('points at the generated image when the post has no cover', async () => {
    const post = FIXTURE_POSTS[1];
    const posting = await postingOnPage(post.slug);
    expect(posting?.image).toEqual([`${SITE}/blog/${post.slug}/og.png`]);
    expect(posting?.dateModified).toBe(post.publishedAt);
  });

  it('keeps a long headline within the 110 characters search engines read', () => {
    const post = { ...FIXTURE_POSTS[1], title: `${'A long title about agents '.repeat(6)}end` };
    const headline = blogPosting(SITE, post, `${SITE}/og.png`).headline as string;
    expect(headline.length).toBeLessThanOrEqual(110);
    expect(headline.endsWith('…')).toBe(true);
  });
});
