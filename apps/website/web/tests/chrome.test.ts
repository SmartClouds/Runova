import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import Footer from '../src/components/Footer.astro';
import Header from '../src/components/Header.astro';

let container: AstroContainer;

beforeAll(async () => {
  // The header's icons (effects/Icon.astro) render lucide-react on the server.
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

  describe('menu', () => {
    let html: string;
    let main: string;

    beforeAll(async () => {
      html = await render(Header, '/');
      main = html.slice(html.search(/<nav[^>]* aria-label="Main"/), html.indexOf('</nav>'));
    });

    it('has Features, News, Blog and Resources menus and a Help link, in that order', () => {
      const labels = [...main.matchAll(/data-mega-trigger[^>]*>\s*([A-Za-z]+)/g)].map((m) => m[1]);
      expect(labels).toEqual(['Features', 'News', 'Blog', 'Resources', 'Help']);
      expect(main).toMatch(/<button[^>]* aria-controls="mega-resources"/);
      expect(main).toMatch(/<a[^>]* href="\/help"[^>]* class="mega-trigger mega-link"/);
    });

    it('starts with every panel closed and out of the tab order, each owned by its label', () => {
      for (const id of ['features', 'news', 'blog', 'resources']) {
        expect(main).toMatch(new RegExp(`aria-expanded="false" aria-controls="mega-${id}"`));
        expect(main).toMatch(
          new RegExp(`<div id="mega-${id}" class="mega-panel" data-state="closed" inert`),
        );
      }
    });

    it('holds a place for the newest news and posts until the script fills it', () => {
      expect(main).toMatch(/data-latest="news" aria-busy="true"/);
      expect(main).toMatch(/data-latest="blog" aria-busy="true"/);
      expect(main).toContain('href="/news"');
      expect(main).toContain('href="/blog"');
    });

    it('has a closed phone menu that the menu button controls', () => {
      expect(html).toMatch(
        /aria-label="Open menu" aria-expanded="false" aria-controls="site-sheet"/,
      );
      expect(html).toMatch(
        /<div id="site-sheet" class="sheet" data-state="closed" data-sheet inert/,
      );
      expect(html).toMatch(/<nav aria-label="Site menu"/);
    });

    it('keeps the Download button the home page light falls from', () => {
      expect(html).toMatch(/<a href="\/download"[^>]* data-beam-source/);
    });

    it('gives the Download button a closed panel with a link per system', () => {
      expect(html).toMatch(
        /<a href="\/download"[^>]* aria-expanded="false" aria-controls="mega-download"/,
      );
      const start = html.indexOf('<div id="mega-download"');
      expect(start).toBeGreaterThan(-1);
      const panel = html.slice(start, html.indexOf('</ul>', start));
      expect(panel).toMatch(
        /^<div id="mega-download" class="mega-panel" data-state="closed" inert/,
      );
      for (const href of [
        '/download/windows/latest',
        '/download/macos/latest?arch=arm64',
        '/download/macos/latest?arch=x64',
        '/download/linux/latest',
      ]) {
        expect(panel).toContain(`href="${href}"`);
      }
    });
  });
});
