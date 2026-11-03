import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, fact, nodeHttpCheck, urlHost } from './shared.js';

export const n8n = defineCatalogTemplate({
  id: 'n8n',
  name: 'n8n',
  description: 'Workflow automation that connects your apps and APIs with a visual editor.',
  category: 'automation',
  homepage: 'https://n8n.io',
  versions: [{ id: '2.41', label: 'n8n {app}', images: { app: CATALOG_IMAGES.n8n } }],
  defaultVersion: '2.41',
  parameters: z.object({ port: portParam(5678) }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
  },
  secrets: [{ key: 'N8N_ENCRYPTION_KEY', label: 'Credentials key', kind: 'hex', length: 32 }],
  minMemoryMb: 1024,
  firstVisitorSetup: true,
  exposureNote:
    'Whoever opens n8n first sets up the owner account, so do that before putting it on a domain. Webhooks need the domain to be reachable from the services that call them.',
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => {
    const url = appUrl(publicUrl, params.port);
    return {
      services: {
        n8n: {
          image: 'app',
          environment: {
            N8N_ENCRYPTION_KEY: { secret: 'N8N_ENCRYPTION_KEY' },
            N8N_HOST: urlHost(url),
            N8N_PORT: '5678',
            N8N_PROTOCOL: publicUrl ? 'https' : 'http',
            WEBHOOK_URL: `${url}/`,
            // Over plain HTTP on 127.0.0.1 the browser would drop a secure cookie.
            N8N_SECURE_COOKIE: publicUrl ? 'true' : 'false',
            N8N_PROXY_HOPS: publicUrl ? '1' : '0',
            N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
            N8N_DIAGNOSTICS_ENABLED: 'false',
          },
          ports: [{ label: 'Editor', target: 5678, published: params.port }],
          volumes: [{ volume: 'data', target: '/home/node/.n8n' }],
          healthcheck: nodeHttpCheck('http://127.0.0.1:5678/healthz'),
        },
      },
      web: { service: 'n8n', port: 5678 },
      facts: [
        fact('version', 'Version', version.label),
        fact('url', 'Editor', url),
        fact('webhooks', 'Webhook base URL', `${url}/webhook/`),
        fact('key', 'Credentials key', secret('N8N_ENCRYPTION_KEY'), true),
      ],
    };
  },
});
