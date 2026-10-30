import type { APIContext } from 'astro';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { titleLines } from '../src/lib/blog/ogImage';
import { GET } from '../src/pages/blog/[slug]/og.png';
import { FIXTURE_POSTS } from './fixtures/blog/posts';
import { type FakeBlogApi, startFakeBlogApi } from './helpers/fakeBlogApi';

const SITE = 'https://runovahq.com';

let api: FakeBlogApi;

beforeAll(async () => {
  api = await startFakeBlogApi();
});

afterAll(async () => {
  await api?.close();
});

async function ogImage(slug: string): Promise<Response> {
  process.env.WEBSITE_API_INTERNAL_URL = api.url;
  const url = new URL(`/blog/${slug}/og.png`, SITE);
  return GET({
    site: new URL(SITE),
    url,
    request: new Request(url),
    params: { slug },
  } as unknown as APIContext);
}

describe('/blog/<slug>/og.png', () => {
  it('is a 1200x630 PNG made for the post', async () => {
    const response = await ogImage(FIXTURE_POSTS[1].slug);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=300, stale-while-revalidate=600',
    );
    const image = Buffer.from(await response.arrayBuffer());
    const { width, height, format } = await sharp(image).metadata();
    expect({ width, height, format }).toEqual({ width: 1200, height: 630, format: 'png' });
  });

  it('draws each title differently', async () => {
    const first = Buffer.from(await (await ogImage(FIXTURE_POSTS[1].slug)).arrayBuffer());
    const second = Buffer.from(await (await ogImage(FIXTURE_POSTS[2].slug)).arrayBuffer());
    expect(first.equals(second)).toBe(false);
  });

  it('answers 404 for an unknown post', async () => {
    const response = await ogImage('no-such-post');
    expect(response.status).toBe(404);
  });
});

describe('titleLines', () => {
  const measure = (text: string) => text.length * 10;

  it('breaks a title at spaces to fit the width', () => {
    expect(titleLines('Review what an agent changed, one hunk at a time', 200, measure)).toEqual([
      'Review what an agent',
      'changed, one hunk at',
      'a time',
    ]);
  });

  it('keeps at most three lines and ends a cut title with an ellipsis', () => {
    const lines = titleLines('one two three four five six seven eight nine ten', 100, measure);
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith('…')).toBe(true);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(100);
  });
});
