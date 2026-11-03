import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { fact } from './shared.js';

export const postgres = defineCatalogTemplate({
  id: 'postgres',
  name: 'PostgreSQL',
  description: 'A dependable SQL database that handles JSON, full-text search and big tables well.',
  category: 'database',
  homepage: 'https://www.postgresql.org',
  versions: [
    { id: '18', label: 'PostgreSQL {db}', images: { db: CATALOG_IMAGES.postgres18 } },
    { id: '17', label: 'PostgreSQL {db}', images: { db: CATALOG_IMAGES.postgres17 } },
  ],
  defaultVersion: '18',
  parameters: z.object({
    port: portParam(5432),
    database: identifierParam('app'),
    user: identifierParam('app'),
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
      help: 'The superuser created on first start. It owns the database.',
      input: 'text',
    },
  },
  secrets: [{ key: 'POSTGRES_PASSWORD', label: 'Password', kind: 'password', length: 32 }],
  minMemoryMb: 256,
  firstVisitorSetup: false,
  exposureNote:
    'PostgreSQL speaks its own protocol, not HTTP, so it is not put on a domain. Reach it through an SSH tunnel.',
  acknowledgments: [],
  build: ({ version, params, secret }) => ({
    services: {
      postgres: {
        image: 'db',
        environment: {
          POSTGRES_DB: params.database,
          POSTGRES_USER: params.user,
          POSTGRES_PASSWORD: { secret: 'POSTGRES_PASSWORD' },
        },
        ports: [{ label: 'PostgreSQL', target: 5432, published: params.port }],
        // From 18 on, the image keeps a folder per major version under /var/lib/postgresql.
        volumes: [
          {
            volume: 'data',
            target: version.id === '17' ? '/var/lib/postgresql/data' : '/var/lib/postgresql',
          },
        ],
        healthcheck: {
          test: [
            'CMD-SHELL',
            'pg_isready -h 127.0.0.1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" --quiet',
          ],
          startPeriod: '1m',
        },
        stopGracePeriod: '1m',
      },
    },
    web: null,
    facts: [
      fact('version', 'Version', version.label),
      fact('host', 'Host', `127.0.0.1:${params.port}`),
      fact('database', 'Database', params.database),
      fact('user', 'User', params.user),
      fact('password', 'Password', secret('POSTGRES_PASSWORD'), true),
      fact(
        'url',
        'Connection string',
        `postgresql://${params.user}:${secret('POSTGRES_PASSWORD')}@127.0.0.1:${params.port}/${params.database}`,
        true,
      ),
    ],
  }),
});
