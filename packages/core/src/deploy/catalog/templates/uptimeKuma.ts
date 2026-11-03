import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, fact } from './shared.js';

export const uptimeKuma = defineCatalogTemplate({
  id: 'uptime-kuma',
  name: 'Uptime Kuma',
  description: 'Watches your sites and services and tells you when one goes down.',
  category: 'monitoring',
  homepage: 'https://uptime.kuma.pet',
  versions: [
    { id: '2', label: 'Uptime Kuma {app} (rootless)', images: { app: CATALOG_IMAGES.uptimeKuma } },
  ],
  defaultVersion: '2',
  parameters: z.object({ port: portParam(3001) }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
  },
  secrets: [],
  minMemoryMb: 256,
  firstVisitorSetup: true,
  exposureNote:
    'Whoever opens Uptime Kuma first creates the admin account, so do that before putting it on a domain.',
  acknowledgments: [],
  build: ({ version, params, publicUrl }) => ({
    services: {
      'uptime-kuma': {
        image: 'app',
        volumes: [{ volume: 'data', target: '/app/data' }],
        ports: [{ label: 'Dashboard', target: 3001, published: params.port }],
        // The image's own check, with its own timings.
        healthcheck: {
          test: ['CMD-SHELL', 'extra/healthcheck'],
          interval: '1m',
          timeout: '30s',
          startPeriod: '3m',
        },
      },
    },
    web: { service: 'uptime-kuma', port: 3001 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'Dashboard', appUrl(publicUrl, params.port)),
    ],
  }),
});
