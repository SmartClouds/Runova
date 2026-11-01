import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import Footer from '../src/components/Footer.astro';
import Header from '../src/components/Header.astro';

let container: AstroContainer;

beforeAll(async () => {
  // The theme toggle in the header renders lucide-react icons on the server.
  const renderers = await loadRenderers([reactRenderer()]);
  container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
});

const render = (component: typeof Footer, path: string) =>
  container.renderToString(component, { request: new Request(`https://runovahq.com${path}`) });

describe('Footer', () => {
  let html: string;

  beforeAll(async () => {
    html = await render(Footer, '/');
  });

  it('has a Footer navigation with the product, resource and project links', () => {
    const nav = html.slice(html.search(/<nav[^>]* aria-label="Footer"/), html.indexOf('</nav>'));
    for (const href of [
      '/features',
      '/download',
      '/help',
      '/blog',
      '/news',
      '/blog/rss.xml',
      '/news/rss.xml',
      'https://github.com/SmartClouds/Runova',
    ]) {
      expect(nav).toContain(`href="${href}"`);
    }
    expect(nav).toMatch(/>\s*Blog\s*</);
    expect(nav).toMatch(/>\s*News\s*</);
  });

  it('ends with a status bar that names the license, the systems and the year', () => {
    expect(html).toContain('Open source, MIT');
    expect(html).toContain('Windows · macOS · Linux');
    expect(html).toMatch(new RegExp(`(©|&copy;) ${new Date().getFullYear()} SmartClouds`));
  });

  it('opens external links with rel="noopener"', () => {
    for (const link of html.match(/<a [^>]*href="https:[^>]*>/g) ?? []) {
      expect(link).toContain('rel="noopener"');
    }
  });
});

describe('Header', () => {
  it('marks the section the visitor is in as the current page', async () => {
    const html = await render(Header, '/features/relay');
    expect(html).toMatch(/<a[^>]* href="\/features"[^>]* aria-current="page"/);
    expect(html).not.toMatch(/<a[^>]* href="\/help"[^>]* aria-current/);
  });

  it('marks nothing on the home page', async () => {
    const html = await render(Header, '/');
    expect(html).not.toContain('aria-current');
  });
});
