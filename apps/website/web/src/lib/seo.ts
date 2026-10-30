import type { BreadcrumbList, Organization, SoftwareApplication, Thing, WebSite } from 'schema-dts';

export const SITE_NAME = 'Runova';
export const HOME_TITLE = 'Runova: the Agentic Development Environment';

/** The default Open Graph image, 1200x630, under public/. */
export const DEFAULT_OG_IMAGE = {
  path: '/og/default.png',
  width: 1200,
  height: 630,
  alt: 'Runova, the Agentic Development Environment',
};

const MAX_HEADLINE = 110;

/** A title cut at a word to the 110 characters search engines read from an article headline. */
export function headline(title: string): string {
  if (title.length <= MAX_HEADLINE) return title;
  const cut = title.slice(0, MAX_HEADLINE - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:.]+$/, '')}…`;
}

const MIN_DESCRIPTION = 70;
const MAX_DESCRIPTION = 160;

/**
 * Text as a meta description of 70 to 160 characters: whole sentences while they fit, else the
 * first sentence cut at a word with an ellipsis. A short one gets `closing` after it.
 */
export function fitMetaDescription(text: string, closing: string): string {
  let description = text.trim();
  if (description.length > MAX_DESCRIPTION) {
    const sentences = description.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
    let fitting = '';
    for (const sentence of sentences) {
      const next = `${fitting}${sentence}`.trim();
      if (next.length > MAX_DESCRIPTION) break;
      fitting = next;
    }
    if (fitting.length >= MIN_DESCRIPTION) {
      description = fitting;
    } else {
      const cut = description.slice(0, MAX_DESCRIPTION);
      description = `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:]+$/, '')}…`;
    }
  }
  if (description.length < MIN_DESCRIPTION) description = `${description} ${closing}`;
  return description;
}

/** Pages use the `%s | Runova` template; the home page passes no title and gets its own. */
export function pageTitle(title?: string): string {
  return title ? `${title} | ${SITE_NAME}` : HOME_TITLE;
}

/**
 * The canonical URL is the site plus the lowercased path, with no trailing slash and no query
 * string except `page` on paged lists.
 */
export function canonicalUrl(site: string | URL, url: URL): string {
  let path = url.pathname.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const canonical = new URL(path, site);
  const page = url.searchParams.get('page');
  if (page) canonical.searchParams.set('page', page);
  return canonical.href;
}

/** The Organization node's id, for pages that point at it (a publisher, an author). */
export function organizationId(site: string | URL): string {
  return new URL('/#organization', site).href;
}

export function organization(site: string | URL): Organization {
  return {
    '@type': 'Organization',
    '@id': organizationId(site),
    name: SITE_NAME,
    url: new URL('/', site).href,
    logo: new URL('/icon-512.png', site).href,
    sameAs: ['https://github.com/SmartClouds/Runova'],
  };
}

export function webSite(site: string | URL): WebSite {
  return {
    '@type': 'WebSite',
    '@id': new URL('/#website', site).href,
    name: SITE_NAME,
    url: new URL('/', site).href,
    inLanguage: 'en',
    publisher: { '@id': organizationId(site) },
  };
}

/** What the download page adds to the SoftwareApplication node. */
export interface AppReleaseDetails {
  softwareVersion?: string;
  /** The page or files a visitor downloads from. Defaults to the download page. */
  downloadUrl?: string | string[];
  releaseNotes?: string;
}

/** Runova as a free SoftwareApplication, for the home and download pages. */
export function softwareApplication(
  site: string | URL,
  details: AppReleaseDetails = {},
): SoftwareApplication {
  const { softwareVersion, downloadUrl = new URL('/download', site).href, releaseNotes } = details;
  return {
    '@type': 'SoftwareApplication',
    '@id': new URL('/#app', site).href,
    name: SITE_NAME,
    description:
      'An Agentic Development Environment: run Claude Code, Codex, Gemini and other AI coding CLIs in panes, with the git panel, diffs, tests and pipelines next to them.',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows, macOS, Linux',
    url: new URL('/', site).href,
    downloadUrl,
    ...(softwareVersion ? { softwareVersion } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    image: new URL('/icon-512.png', site).href,
    license: 'https://opensource.org/licenses/MIT',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@id': organizationId(site) },
  };
}

/** One JSON-LD graph: Organization and WebSite on every page, then the page's own nodes. */
export function jsonLdGraph(site: string | URL, nodes: Thing[] = []) {
  return {
    '@context': 'https://schema.org',
    '@graph': [organization(site), webSite(site), ...nodes],
  };
}

/** JSON for a <script type="application/ld+json">, with `<` escaped so it cannot end the element. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** One step in a breadcrumb trail: the page name and its path on the site. */
export interface Crumb {
  name: string;
  path: string;
}

/** The trail as a BreadcrumbList, numbered from 1, with absolute URLs. */
export function breadcrumbList(site: string | URL, crumbs: Crumb[]): BreadcrumbList {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: new URL(crumb.path, site).href,
    })),
  };
}
