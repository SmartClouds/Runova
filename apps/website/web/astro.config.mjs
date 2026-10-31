// @ts-check
import mdx from '@astrojs/mdx';
import node from '@astrojs/node';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import sentry from '@sentry/astro';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { contentSecurityPolicy } from './src/lib/security';

const env = process.env;
const apiUrl = env.WEBSITE_API_URL || 'http://localhost:5180';
const sentryDsn = env.PUBLIC_SENTRY_DSN || '';
const site = env.SITE_URL || 'https://runovahq.com';

/** @type {NonNullable<import('@astrojs/sitemap').SitemapOptions>} */
export const sitemapOptions = {
  // The admin pages are private, so they stay out of the sitemap even when Astro lists them.
  filter: (page) => !/^\/admin(?:\/|$)/.test(new URL(page).pathname),
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
  security: { csp: contentSecurityPolicy({ site, sentryDsn }) },
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
    // The hero worker fetches three.js only after it has checked WebGL, which needs code splitting.
    worker: { format: 'es' },
    define: {
      'import.meta.env.SENTRY_ENVIRONMENT': JSON.stringify(env.SENTRY_ENVIRONMENT || ''),
      'import.meta.env.SENTRY_RELEASE': JSON.stringify(env.SENTRY_RELEASE || ''),
    },
    server: {
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true },
        '/media': { target: apiUrl, changeOrigin: true },
      },
    },
  },
});
