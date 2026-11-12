// @ts-check
import { readFileSync } from 'node:fs';
import mdx from '@astrojs/mdx';
import node from '@astrojs/node';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import sentry from '@sentry/astro/integration';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { contentSecurityPolicy, isDevServer } from './src/lib/security';

const env = process.env;
const apiUrl = env.WEBSITE_API_URL || 'http://localhost:5180';
// run-website.bat sets these to the .NET dev certificate, so `astro dev` serves https. The API's
// session and antiforgery cookies are Secure and it refuses them on a plain http request.
const devHttps =
  env.WEBSITE_DEV_CERT && env.WEBSITE_DEV_KEY
    ? { cert: readFileSync(env.WEBSITE_DEV_CERT), key: readFileSync(env.WEBSITE_DEV_KEY) }
    : undefined;
const sentryDsn = env.PUBLIC_SENTRY_DSN || '';
const site = env.SITE_URL || 'https://runovahq.com';

/** @type {NonNullable<import('@astrojs/sitemap').SitemapOptions>} */
export const sitemapOptions = {
  // The admin pages and the account panel are private, so they stay out of the sitemap even
  // when Astro lists them.
  filter: (page) => !/^\/(?:admin|account)(?:\/|$)/.test(new URL(page).pathname),
  // The blog and news pages come from the API, so their sitemaps are rendered on demand.
  customSitemaps: [
    new URL('/sitemap-dynamic.xml', site).href,
    new URL('/news-sitemap.xml', site).href,
  ],
};

export default defineConfig({
  site,
  trailingSlash: 'never',
  output: 'static',
  // staticHeaders: the adapter sends the CSP of prerendered pages as a header too, not a <meta>.
  adapter: node({ mode: 'standalone', staticHeaders: true }),
  // Left out under `astro dev`, which would block the islands' inline scripts (see isDevServer).
  security: isDevServer(process.argv) ? {} : { csp: contentSecurityPolicy({ site, sentryDsn }) },
  // Shiki colors code with inline styles, which a CSP does not get along with. The only code
  // blocks on the site are plain text in the help articles, and Prose.astro already styles them.
  markdown: { syntaxHighlight: false },
  integrations: [
    react(),
    mdx(),
    sitemap(sitemapOptions),
    // An empty DSN leaves Sentry out of both bundles. Source maps upload only with an auth token.
    sentry({
      enabled: Boolean(sentryDsn),
      telemetry: false,
      sourcemaps: { disable: !env.SENTRY_AUTH_TOKEN },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    define: {
      'import.meta.env.SENTRY_ENVIRONMENT': JSON.stringify(env.SENTRY_ENVIRONMENT || ''),
      'import.meta.env.SENTRY_RELEASE': JSON.stringify(env.SENTRY_RELEASE || ''),
    },
    server: {
      https: devHttps,
      // xfwd sends X-Forwarded-Proto, which the API trusts from loopback, so behind an https dev
      // server it sees an https request even though the proxy reaches it over http.
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true, xfwd: true },
        // The notifications hub (E51): SignalR, over a WebSocket when it can.
        '/hubs': { target: apiUrl, changeOrigin: true, xfwd: true, ws: true },
        '/media': { target: apiUrl, changeOrigin: true, xfwd: true },
      },
    },
  },
});
