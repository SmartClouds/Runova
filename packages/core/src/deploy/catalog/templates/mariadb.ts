import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { fact, MARIADB_HEALTHCHECK, NOT_ROOT_MESSAGE, notRootUser } from './shared.js';

export const mariadb = defineCatalogTemplate({
  id: 'mariadb',
  name: 'MariaDB',
  description: 'The community fork of MySQL, a drop-in for apps written against it.',
  category: 'database',
  homepage: 'https://mariadb.org',
  versions: [
    { id: '12.3', label: 'MariaDB {db} LTS', images: { db: CATALOG_IMAGES.mariadb123 } },
    { id: '11.4', label: 'MariaDB {db} LTS', images: { db: CATALOG_IMAGES.mariadb114 } },
  ],
  defaultVersion: '12.3',
  parameters: z.object({
    port: portParam(3307),
    database: identifierParam('app'),
    user: identifierParam('app').refine(notRootUser, NOT_ROOT_MESSAGE),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server. It defaults to 3307 so MySQL can keep 3306.',
      input: 'port',
    },
    database: { label: 'Database', help: 'Created on first start.', input: 'text' },
    user: {
      label: 'User',
      help: 'An account with full rights on that database, created on first start.',
      input: 'text',
    },
  },
  secrets: [
    { key: 'MARIADB_ROOT_PASSWORD', label: 'Root password', kind: 'password', length: 32 },
    { key: 'MARIADB_PASSWORD', label: 'User password', kind: 'password', length: 32 },
  ],
  minMemoryMb: 512,
  firstVisitorSetup: false,
  exposureNote:
    'MariaDB speaks its own protocol, not HTTP, so it is not put on a domain. Reach it through an SSH tunnel.',
  acknowledgments: [],
  build: ({ version, params, secret }) => ({
    services: {
      mariadb: {
        image: 'db',
        environment: {
          MARIADB_ROOT_PASSWORD: { secret: 'MARIADB_ROOT_PASSWORD' },
          MARIADB_DATABASE: params.database,
          MARIADB_USER: params.user,
          MARIADB_PASSWORD: { secret: 'MARIADB_PASSWORD' },
          MARIADB_AUTO_UPGRADE: '1',
        },
        ports: [{ label: 'MariaDB', target: 3306, published: params.port }],
        volumes: [{ volume: 'data', target: '/var/lib/mysql' }],
        healthcheck: MARIADB_HEALTHCHECK,
      },
    },
    web: null,
    facts: [
      fact('version', 'Version', version.label),
      fact('host', 'Host', `127.0.0.1:${params.port}`),
      fact('database', 'Database', params.database),
      fact('user', 'User', params.user),
      fact('password', 'Password', secret('MARIADB_PASSWORD'), true),
      fact(
        'url',
        'Connection string',
        `mariadb://${params.user}:${secret('MARIADB_PASSWORD')}@127.0.0.1:${params.port}/${params.database}`,
        true,
      ),
      fact('root-password', 'Root password', secret('MARIADB_ROOT_PASSWORD'), true),
    ],
  }),
});
