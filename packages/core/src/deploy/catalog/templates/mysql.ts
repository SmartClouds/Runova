import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { fact, MYSQL_HEALTHCHECK, NOT_ROOT_MESSAGE, notRootUser } from './shared.js';

export const mysql = defineCatalogTemplate({
  id: 'mysql',
  name: 'MySQL',
  description: 'The relational database most web apps already know how to talk to.',
  category: 'database',
  homepage: 'https://www.mysql.com',
  versions: [
    { id: '9.7', label: 'MySQL {db} LTS', images: { db: CATALOG_IMAGES.mysql97 } },
    { id: '8.4', label: 'MySQL {db} LTS', images: { db: CATALOG_IMAGES.mysql84 } },
  ],
  defaultVersion: '9.7',
  parameters: z.object({
    port: portParam(3306),
    database: identifierParam('app'),
    user: identifierParam('app').refine(notRootUser, NOT_ROOT_MESSAGE),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server, reachable from the server itself or an SSH tunnel.',
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
    { key: 'MYSQL_ROOT_PASSWORD', label: 'Root password', kind: 'password', length: 32 },
    { key: 'MYSQL_PASSWORD', label: 'User password', kind: 'password', length: 32 },
  ],
  minMemoryMb: 512,
  firstVisitorSetup: false,
  exposureNote:
    'MySQL speaks its own protocol, not HTTP, so it is not put on a domain. Reach it through an SSH tunnel.',
  acknowledgments: [],
  build: ({ version, params, secret }) => ({
    services: {
      mysql: {
        image: 'db',
        environment: {
          MYSQL_ROOT_PASSWORD: { secret: 'MYSQL_ROOT_PASSWORD' },
          MYSQL_DATABASE: params.database,
          MYSQL_USER: params.user,
          MYSQL_PASSWORD: { secret: 'MYSQL_PASSWORD' },
        },
        ports: [{ label: 'MySQL', target: 3306, published: params.port }],
        volumes: [{ volume: 'data', target: '/var/lib/mysql' }],
        healthcheck: MYSQL_HEALTHCHECK,
      },
    },
    web: null,
    facts: [
      fact('version', 'Version', version.label),
      fact('host', 'Host', `127.0.0.1:${params.port}`),
      fact('database', 'Database', params.database),
      fact('user', 'User', params.user),
      fact('password', 'Password', secret('MYSQL_PASSWORD'), true),
      fact(
        'url',
        'Connection string',
        `mysql://${params.user}:${secret('MYSQL_PASSWORD')}@127.0.0.1:${params.port}/${params.database}`,
        true,
      ),
      fact('root-password', 'Root password', secret('MYSQL_ROOT_PASSWORD'), true),
    ],
  }),
});
