import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, curlCheck, fact } from './shared.js';

export const grafana = defineCatalogTemplate({
  id: 'grafana',
  name: 'Grafana',
  description: 'Dashboards and alerts over Prometheus, databases and many other data sources.',
  category: 'monitoring',
  homepage: 'https://grafana.com',
  versions: [{ id: '13.2', label: 'Grafana {app}', images: { app: CATALOG_IMAGES.grafana } }],
  defaultVersion: '13.2',
  parameters: z.object({
    port: portParam(3000),
    admin: identifierParam('admin'),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
    admin: {
      label: 'Admin user',
      help: 'The administrator account, created on first start.',
      input: 'text',
    },
  },
  secrets: [
    { key: 'GF_SECURITY_ADMIN_PASSWORD', label: 'Admin password', kind: 'password', length: 32 },
    { key: 'GF_SECURITY_SECRET_KEY', label: 'Secret key', kind: 'hex', length: 32 },
  ],
  minMemoryMb: 256,
  firstVisitorSetup: false,
  exposureNote: null,
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => ({
    services: {
      grafana: {
        image: 'app',
        environment: {
          GF_SECURITY_ADMIN_USER: params.admin,
          GF_SECURITY_ADMIN_PASSWORD: { secret: 'GF_SECURITY_ADMIN_PASSWORD' },
          GF_SECURITY_SECRET_KEY: { secret: 'GF_SECURITY_SECRET_KEY' },
          GF_SERVER_ROOT_URL: appUrl(publicUrl, params.port),
          GF_USERS_ALLOW_SIGN_UP: 'false',
          GF_ANALYTICS_REPORTING_ENABLED: 'false',
        },
        ports: [{ label: 'Web interface', target: 3000, published: params.port }],
        volumes: [{ volume: 'data', target: '/var/lib/grafana' }],
        healthcheck: curlCheck('http://localhost:3000/api/health'),
      },
    },
    web: { service: 'grafana', port: 3000 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'Web interface', appUrl(publicUrl, params.port)),
      fact('admin', 'Admin user', params.admin),
      fact('admin-password', 'Admin password', secret('GF_SECURITY_ADMIN_PASSWORD'), true),
    ],
  }),
});
