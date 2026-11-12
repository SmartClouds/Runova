import { loadRenderers } from 'astro:container';
import { existsSync, readFileSync } from 'node:fs';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import { sitemapOptions } from '../astro.config.mjs';
import {
  PRIVACY_EFFECTIVE,
  PRIVACY_EMAIL,
  PRIVACY_PATH,
  PRIVACY_SECTIONS,
  privacyDate,
} from '../src/lib/privacy';
import Privacy from '../src/pages/privacy.astro';
import { scanHtml } from './helpers/textScan';

/**
 * The privacy policy page (/privacy). The App Store and Google Play link to it, so the tests hold
 * what a reviewer looks for (a title, contact, how to delete an account, the phone permissions)
 * and keep the numbers in the text equal to the ones the API enforces.
 */

let html: string;

beforeAll(async () => {
  const renderers = await loadRenderers([reactRenderer()]);
  const container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
  html = await container.renderToString(Privacy, {
    request: new Request('https://runovahq.com/privacy'),
  });
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The ids of every heading of one level, in page order. */
const headingIds = (level: 2 | 3) =>
  [...html.matchAll(new RegExp(`<h${level}[^>]* id="([^"]+)"`, 'g'))].map((match) => match[1]);

const text = () => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');

describe('privacy page head', () => {
  it('has its own title, a description of 70 to 160 characters and a canonical on the site', () => {
    expect(html).toContain('<title>Privacy policy | Runova</title>');
    const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(html).toContain(`<link rel="canonical" href="https://runovahq.com${PRIVACY_PATH}"`);
  });

  it('is open to search engines, which the stores and visitors both rely on', () => {
    expect(html).not.toContain('noindex');
  });

  it('describes its place in the site as a breadcrumb trail', () => {
    const script = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    const graph = JSON.parse(script?.[1] ?? '{}')['@graph'] as Array<Record<string, unknown>>;
    const trail = graph.find((node) => node['@type'] === 'BreadcrumbList');
    expect(trail).toMatchObject({
      itemListElement: [
        { position: 1, name: 'Home', item: 'https://runovahq.com/' },
        { position: 2, name: 'Privacy policy', item: `https://runovahq.com${PRIVACY_PATH}` },
      ],
    });
  });

  it('is in the sitemap', () => {
    expect(sitemapOptions.filter?.(`https://runovahq.com${PRIVACY_PATH}`)).toBe(true);
  });
});

describe('privacy page structure', () => {
  it('has one h1, and the headings never skip a level', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html.match(/<h2[\s>]/g)?.length).toBeGreaterThan(5);
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
    levels.forEach((level, index) => {
      if (index > 0) expect(level - levels[index - 1]).toBeLessThanOrEqual(1);
    });
  });

  it('has a heading for each section in the list, in order, after the summary', () => {
    expect(headingIds(2)).toEqual(['glance-title', ...PRIVACY_SECTIONS.map((item) => item.id)]);
  });

  it('lists every section in "On this page" and in the list for small screens', () => {
    const toc = html.slice(html.search(/<nav[^>]* aria-label="On this page"/));
    const jump = html.slice(html.search(/<details[^>]* class="[^"]*jump/));
    for (const section of PRIVACY_SECTIONS) {
      expect(toc).toMatch(new RegExp(`href="#${section.id}"[^>]*>\\s*${section.heading}\\s*<`));
      expect(jump).toMatch(new RegExp(`href="#${section.id}"[^>]*>\\s*${section.heading}\\s*<`));
    }
  });

  it('shows the day it took effect, in a time element', () => {
    expect(privacyDate('2026-11-12')).toBe('November 12, 2026');
    expect(html).toMatch(
      new RegExp(`<time datetime="${PRIVACY_EFFECTIVE}"[^>]*>${privacyDate()}</time>`),
    );
  });

  it('has one address for questions, as a mail link', () => {
    expect(html).toContain(`href="mailto:${PRIVACY_EMAIL}"`);
    expect(PRIVACY_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
  });

  it('links only to pages that exist', () => {
    for (const [, path] of html.matchAll(/ href="(\/account\/[a-z-]+)"/g)) {
      expect(existsSync(new URL(`../src/pages${path}.astro`, import.meta.url)), path).toBe(true);
    }
    // The layout's skip link points at #main.
    const anchors = new Set([...headingIds(2), 'main']);
    for (const [, id] of html.matchAll(/ href="#([a-z-]+)"/g))
      expect(anchors.has(id), id).toBe(true);
  });

  it('opens outside links with rel="noopener"', () => {
    for (const tag of html.match(/<a [^>]*href="https:[^>]*>/g) ?? []) {
      expect(tag).toContain('rel="noopener"');
    }
  });
});

describe('privacy page content', () => {
  it('tells a reviewer what the phone apps ask for and what they leave out', () => {
    const words = text();
    for (const permission of [
      'Camera',
      'Notifications',
      'Face ID, fingerprint or screen lock',
      'Network',
    ]) {
      expect(words).toContain(permission);
    }
    expect(words).toContain('no ads, no analytics and no crash reporting');
    expect(words).toContain('Firebase Cloud Messaging');
    expect(words).toContain('Apple Push Notification service');
  });

  it('says how to delete an account, with the page where it is done', () => {
    const section = html.slice(
      html.indexOf('id="delete-account"'),
      html.indexOf('id="children-and-changes"'),
    );
    expect(section).toContain('href="/account/security"');
    expect(section).toContain('Delete account');
    expect(section).toContain('What is deleted:');
    expect(section).toContain('What stays:');
  });

  it('names every outside service that receives data', () => {
    const words = text();
    for (const name of [
      'Twilio SendGrid',
      'Stripe',
      'NOWPayments',
      'Cloudflare Turnstile',
      'Sentry',
      'GitHub',
    ]) {
      expect(words, name).toContain(name);
    }
  });

  it('passes the site text scan: no em dash and none of the forbidden phrases', () => {
    expect(scanHtml(html)).toEqual([]);
  });

  it('keeps the retention periods equal to the ones the API enforces', () => {
    const source = (file: string) => read(`../../api/src/Runova.Website.Api/${file}`);
    const daysOf = (file: string) =>
      [...source(file).matchAll(/TimeSpan\.FromDays\((\d+)\)/g)].map((match) => Number(match[1]));
    const kept = text().replace(/\s+/g, ' ');
    const row = (what: string, days: number) => expect(kept).toContain(`${what} ${days} days`);

    // AccountsSetup.cs: the sync markers first, then accounts that never confirmed their email.
    const [markers, unconfirmed] = daysOf('Accounts/AccountsSetup.cs');
    row('A synced item you deleted (only a marker is left)', markers);
    row('Accounts whose email address was never confirmed', unconfirmed);
    row('Records of remote access connections', daysOf('Remote/RemoteEndpoints.cs')[0]);
    row(
      'Notifications forwarded from your computers',
      daysOf('Notifications/NotificationSettingsEndpoints.cs')[0],
    );
  });
});
