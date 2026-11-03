import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { fact } from './shared.js';

export const redis = defineCatalogTemplate({
  id: 'redis',
  name: 'Redis',
  description: 'An in-memory store for caches, queues and sessions, saved to disk as it goes.',
  category: 'database',
  homepage: 'https://redis.io',
  versions: [{ id: '8.10', label: 'Redis {db}', images: { db: CATALOG_IMAGES.redis810 } }],
  defaultVersion: '8.10',
  parameters: z.object({ port: portParam(6379) }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server, reachable from the server itself or an SSH tunnel.',
      input: 'port',
    },
  },
  secrets: [{ key: 'REDIS_PASSWORD', label: 'Password', kind: 'password', length: 32 }],
  minMemoryMb: 128,
  firstVisitorSetup: false,
  exposureNote:
    'Redis speaks its own protocol, not HTTP, so it is not put on a domain. Reach it through an SSH tunnel.',
  acknowledgments: [],
  build: ({ version, params, secret }) => ({
    services: {
      redis: {
        image: 'db',
        // The image's own redis user (999), which owns /data. The password comes from the
        // environment at start, so it is not in the container's command line.
        user: '999:999',
        command: [
          'sh',
          '-c',
          'exec redis-server --requirepass "$$REDIS_PASSWORD" --appendonly yes --save 60 1000',
        ],
        environment: {
          REDIS_PASSWORD: { secret: 'REDIS_PASSWORD' },
          REDISCLI_AUTH: { secret: 'REDIS_PASSWORD' },
        },
        ports: [{ label: 'Redis', target: 6379, published: params.port }],
        volumes: [{ volume: 'data', target: '/data' }],
        healthcheck: { test: ['CMD-SHELL', 'redis-cli ping | grep -q PONG'], startPeriod: '20s' },
      },
    },
    web: null,
    facts: [
      fact('version', 'Version', version.label),
      fact('host', 'Host', `127.0.0.1:${params.port}`),
      fact('password', 'Password', secret('REDIS_PASSWORD'), true),
      fact(
        'url',
        'Connection string',
        `redis://:${secret('REDIS_PASSWORD')}@127.0.0.1:${params.port}/0`,
        true,
      ),
    ],
  }),
});
