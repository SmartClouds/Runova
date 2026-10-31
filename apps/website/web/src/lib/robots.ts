/** The paths crawlers stay out of: the admin pages, the API and the jobs dashboard. */
export const DISALLOWED = ['/admin', '/api/', '/hangfire'];

/** robots.txt for `site`: everything is open except DISALLOWED, with the sitemaps listed. */
export function robotsTxt(site: string | URL): string {
  return [
    'User-agent: *',
    ...DISALLOWED.map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${new URL('/sitemap-index.xml', site).href}`,
    `Sitemap: ${new URL('/news-sitemap.xml', site).href}`,
    '',
  ].join('\n');
}
