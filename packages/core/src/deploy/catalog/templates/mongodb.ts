import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { fact } from './shared.js';

export const mongodb = defineCatalogTemplate({
  id: 'mongodb',
  name: 'MongoDB',
  description: 'A document database that stores JSON-like records without a fixed schema.',
  category: 'database',
  homepage: 'https://www.mongodb.com',
  versions: [
    { id: '9.0', label: 'MongoDB {db}', images: { db: CATALOG_IMAGES.mongo90 } },
    { id: '8.0', label: 'MongoDB {db}', images: { db: CATALOG_IMAGES.mongo80 } },
  ],
  defaultVersion: '9.0',
  parameters: z.object({
    port: portParam(27017),
    user: identifierParam('admin'),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server, reachable from the server itself or an SSH tunnel.',
      input: 'port',
    },
    user: {
      label: 'Admin user',
      help: 'The root account, created in the admin database on first start.',
      input: 'text',
    },
  },
  secrets: [
    { key: 'MONGO_INITDB_ROOT_PASSWORD', label: 'Admin password', kind: 'password', length: 32 },
  ],
  minMemoryMb: 1024,
  firstVisitorSetup: false,
  exposureNote:
    'MongoDB speaks its own protocol, not HTTP, so it is not put on a domain. On x86 servers it needs a CPU with AVX.',
  acknowledgments: [],
  build: ({ version, params, secret }) => ({
    services: {
      mongodb: {
        image: 'db',
        environment: {
          MONGO_INITDB_ROOT_USERNAME: params.user,
          MONGO_INITDB_ROOT_PASSWORD: { secret: 'MONGO_INITDB_ROOT_PASSWORD' },
        },
        ports: [{ label: 'MongoDB', target: 27017, published: params.port }],
        volumes: [
          { volume: 'data', target: '/data/db' },
          { volume: 'config', target: '/data/configdb' },
        ],
        healthcheck: {
          test: ['CMD', 'mongosh', '--quiet', '--eval', 'db.adminCommand({ ping: 1 }).ok'],
          startPeriod: '1m',
        },
      },
    },
    web: null,
    facts: [
      fact('version', 'Version', version.label),
      fact('host', 'Host', `127.0.0.1:${params.port}`),
      fact('user', 'Admin user', params.user),
      fact('password', 'Admin password', secret('MONGO_INITDB_ROOT_PASSWORD'), true),
      fact(
        'url',
        'Connection string',
        `mongodb://${params.user}:${secret('MONGO_INITDB_ROOT_PASSWORD')}@127.0.0.1:${params.port}/?authSource=admin`,
        true,
      ),
    ],
  }),
});
