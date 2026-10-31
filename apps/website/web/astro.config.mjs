// @ts-check
import mdx from '@astrojs/mdx';
import node from '@astrojs/node';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import sentry from '@sentry/astro';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

const env = process.env;
const apiUrl = env.WEBSITE_API_URL || 'http://localhost:5180';
const sentryDsn = env.PUBLIC_SENTRY_DSN || '';

export default defineConfig({
  site: env.SITE_URL || 'https://runovahq.com',
  trailingSlash: 'never',
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    react(),
    mdx(),
    // The admin pages are private, so they stay out of the sitemap even when Astro lists them.
    sitemap({ filter: (page) => !/^\/admin(?:\/|$)/.test(new URL(page).pathname) }),
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
