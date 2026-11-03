import { z } from 'zod';
import { defineCatalogTemplate, hostParam, networkParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, fact } from './shared.js';

export const adminer = defineCatalogTemplate({
  id: 'adminer',
  name: 'Adminer',
  description: 'A one-page database manager for MySQL, MariaDB, PostgreSQL and SQLite.',
  category: 'database',
  homepage: 'https://www.adminer.org',
  versions: [{ id: '6', label: 'Adminer {app}', images: { app: CATALOG_IMAGES.adminer6 } }],
  defaultVersion: '6',
  parameters: z.object({
    port: portParam(8081),
    server: hostParam('db'),
    network: networkParam(),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server, best opened through an SSH tunnel.',
      input: 'port',
    },
    server: {
      label: 'Default server',
      help: 'The database host filled in on the login page, such as the service name of another app.',
      input: 'text',
    },
    network: {
      label: 'Network',
      help: "Another app's Docker network to join, such as mysql_default, so Adminer can reach its database.",
      input: 'text',
    },
  },
  secrets: [],
  minMemoryMb: 64,
  firstVisitorSetup: false,
  exposureNote:
    'Adminer is a login page for your databases. Keep it on 127.0.0.1, or put it on a domain only behind basic auth or an IP allowlist.',
  acknowledgments: [],
  build: ({ version, params, publicUrl }) => ({
    services: {
      adminer: {
        image: 'app',
        environment: { ADMINER_DEFAULT_SERVER: params.server },
        ports: [{ label: 'Web interface', target: 8080, published: params.port }],
        healthcheck: {
          test: ['CMD', 'php', '-r', "exit(@fsockopen('127.0.0.1', 8080) ? 0 : 1);"],
          startPeriod: '10s',
        },
        externalNetworks: params.network ? [params.network] : undefined,
      },
    },
    web: { service: 'adminer', port: 8080 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'Web interface', appUrl(publicUrl, params.port)),
      fact('server', 'Default server', params.server),
      fact('network', 'Joined network', params.network ?? 'None, only its own'),
    ],
  }),
});
