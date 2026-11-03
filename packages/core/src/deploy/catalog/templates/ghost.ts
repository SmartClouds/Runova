import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, bundledMysql, fact, nodeHttpCheck } from './shared.js';

export const ghost = defineCatalogTemplate({
  id: 'ghost',
  name: 'Ghost',
  description: 'A publishing platform for blogs and newsletters, with a MySQL database of its own.',
  category: 'website',
  homepage: 'https://ghost.org',
  versions: [
    {
      id: '6',
      label: 'Ghost {app} with MySQL {db}',
      images: { app: CATALOG_IMAGES.ghost6, db: CATALOG_IMAGES.mysql84 },
    },
  ],
  defaultVersion: '6',
  parameters: z.object({ port: portParam(2368) }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
  },
  secrets: [
    { key: 'GHOST_DB_PASSWORD', label: 'Database password', kind: 'password', length: 32 },
    { key: 'MYSQL_ROOT_PASSWORD', label: 'MySQL root password', kind: 'password', length: 32 },
  ],
  minMemoryMb: 1024,
  firstVisitorSetup: true,
  exposureNote:
    'Whoever opens /ghost first creates the owner account, so do that before putting the site on a domain. Staff invites and newsletters need mail settings, which this install leaves out.',
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => ({
    services: {
      ghost: {
        image: 'app',
        environment: {
          url: appUrl(publicUrl, params.port),
          database__client: 'mysql',
          database__connection__host: 'db',
          database__connection__user: 'ghost',
          database__connection__password: { secret: 'GHOST_DB_PASSWORD' },
          database__connection__database: 'ghost',
        },
        ports: [{ label: 'Website', target: 2368, published: params.port }],
        volumes: [{ volume: 'content', target: '/var/lib/ghost/content' }],
        healthcheck: nodeHttpCheck('http://127.0.0.1:2368/ghost/api/admin/site/', '2m'),
        dependsOn: ['db'],
      },
      db: bundledMysql({
        database: 'ghost',
        user: 'ghost',
        passwordSecret: 'GHOST_DB_PASSWORD',
        rootSecret: 'MYSQL_ROOT_PASSWORD',
      }),
    },
    web: { service: 'ghost', port: 2368 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'Site', appUrl(publicUrl, params.port)),
      fact('admin', 'Admin', `${appUrl(publicUrl, params.port)}/ghost/`),
      fact('db-password', 'Database password', secret('GHOST_DB_PASSWORD'), true),
    ],
  }),
});
