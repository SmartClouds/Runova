import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import * as NotFoundPage from '../src/pages/404.astro';
import * as ServerErrorPage from '../src/pages/500.astro';

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create({
    renderers: await loadRenderers([reactRenderer()]),
    astroConfig: { site: 'https://runovahq.com' },
  });
});

function meta(html: string, name: string): string | undefined {
  return new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`).exec(html)?.[1];
}

describe.each([
  { page: NotFoundPage, path: '/no-such-page', status: 404, heading: 'Page not found' },
  { page: ServerErrorPage, path: '/download', status: 500, heading: 'Something went wrong' },
])('the $status page', ({ page, path, status, heading }) => {
  async function render(props: Record<string, unknown> = {}) {
    const response = await container.renderToResponse(page.default, {
      request: new Request(`https://runovahq.com${path}`),
      props,
    });
    return { response, html: await response.text() };
  }

  it('is rendered on demand', () => {
    expect(page.prerender).toBe(false);
  });

  it(`answers ${status} and is never cached`, async () => {
    const { response } = await render();
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('has a heading, a way home and stays out of the index', async () => {
    const { html } = await render();
    expect(/<h1[^>]*>\s*([^<]*?)\s*<\/h1>/.exec(html)?.[1]).toBe(heading);
    expect(html).toMatch(/<a href="\/"[^>]*>Go to the home page<\/a>/);
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
    expect(meta(html, 'description')?.length).toBeGreaterThanOrEqual(70);
  });
});

describe('the 500 page', () => {
  it('never shows the error itself', async () => {
    const response = await container.renderToResponse(ServerErrorPage.default, {
      request: new Request('https://runovahq.com/download'),
      props: { error: new Error('connect ECONNREFUSED 10.0.0.7:8080') },
    });
    const html = await response.text();
    expect(html).not.toContain('ECONNREFUSED');
    expect(html).not.toContain('10.0.0.7');
  });
});
