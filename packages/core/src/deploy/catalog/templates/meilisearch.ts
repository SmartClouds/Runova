import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, curlCheck, fact } from './shared.js';

export const meilisearch = defineCatalogTemplate({
  id: 'meilisearch',
  name: 'Meilisearch',
  description: 'A fast, typo-tolerant search engine for adding search to your own apps.',
  category: 'search',
  homepage: 'https://www.meilisearch.com',
  versions: [
    { id: '1.54', label: 'Meilisearch {app}', images: { app: CATALOG_IMAGES.meilisearch } },
  ],
  defaultVersion: '1.54',
  parameters: z.object({ port: portParam(7700) }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
  },
  secrets: [{ key: 'MEILI_MASTER_KEY', label: 'Master key', kind: 'hex', length: 32 }],
  minMemoryMb: 512,
  firstVisitorSetup: false,
  exposureNote:
    'Hand out scoped API keys made with the master key, never the master key itself, to apps that search from the browser.',
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => ({
    services: {
      meilisearch: {
        image: 'app',
        environment: {
          MEILI_MASTER_KEY: { secret: 'MEILI_MASTER_KEY' },
          MEILI_ENV: 'production',
          MEILI_NO_ANALYTICS: 'true',
        },
        ports: [{ label: 'API', target: 7700, published: params.port }],
        volumes: [{ volume: 'data', target: '/meili_data' }],
        healthcheck: curlCheck('http://localhost:7700/health', '30s'),
      },
    },
    web: { service: 'meilisearch', port: 7700 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'API', appUrl(publicUrl, params.port)),
      fact('master-key', 'Master key', secret('MEILI_MASTER_KEY'), true),
    ],
  }),
});
