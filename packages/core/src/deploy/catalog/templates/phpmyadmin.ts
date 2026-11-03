import { z } from 'zod';
import { defineCatalogTemplate, hostParam, networkParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, curlCheck, fact } from './shared.js';

export const phpmyadmin = defineCatalogTemplate({
  id: 'phpmyadmin',
  name: 'phpMyAdmin',
  description: 'The classic web interface for MySQL and MariaDB.',
  category: 'database',
  homepage: 'https://www.phpmyadmin.net',
  versions: [
    { id: '5.2', label: 'phpMyAdmin {app}', images: { app: CATALOG_IMAGES.phpmyadmin52 } },
  ],
  defaultVersion: '5.2',
  parameters: z.object({
    port: portParam(8082),
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
      label: 'Database server',
      help: 'The MySQL or MariaDB host to manage, such as the service name of another app.',
      input: 'text',
    },
    network: {
      label: 'Network',
      help: "Another app's Docker network to join, such as mysql_default, so phpMyAdmin can reach its database.",
      input: 'text',
    },
  },
  secrets: [],
  minMemoryMb: 128,
  firstVisitorSetup: false,
  exposureNote:
    'phpMyAdmin is a login page for your databases. Keep it on 127.0.0.1, or put it on a domain only behind basic auth or an IP allowlist.',
  acknowledgments: [],
  build: ({ version, params, publicUrl }) => ({
    services: {
      phpmyadmin: {
        image: 'app',
        environment: {
          PMA_HOST: params.server,
          ...(publicUrl ? { PMA_ABSOLUTE_URI: `${publicUrl}/` } : {}),
        },
        ports: [{ label: 'Web interface', target: 80, published: params.port }],
        healthcheck: curlCheck('http://localhost/', '30s'),
        externalNetworks: params.network ? [params.network] : undefined,
      },
    },
    web: { service: 'phpmyadmin', port: 80 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'Web interface', appUrl(publicUrl, params.port)),
      fact('server', 'Database server', params.server),
      fact('network', 'Joined network', params.network ?? 'None, only its own'),
    ],
  }),
});
