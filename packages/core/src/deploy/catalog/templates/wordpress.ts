import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import type { CatalogSecretSpec } from '../types.js';
import { appUrl, bundledMysql, curlCheck, fact, NOT_ROOT_MESSAGE, notRootUser } from './shared.js';

/** WordPress signs cookies and nonces with these. Set here, they survive a container rebuild. */
const SALTS = [
  'AUTH_KEY',
  'SECURE_AUTH_KEY',
  'LOGGED_IN_KEY',
  'NONCE_KEY',
  'AUTH_SALT',
  'SECURE_AUTH_SALT',
  'LOGGED_IN_SALT',
  'NONCE_SALT',
];

const saltSecrets: CatalogSecretSpec[] = SALTS.map((name) => ({
  key: `WORDPRESS_${name}`,
  label: `WordPress ${name.toLowerCase().replaceAll('_', ' ')}`,
  kind: 'hex',
  length: 32,
}));

/** Behind the proxy the request reaches Apache over plain HTTP; this tells WordPress it was HTTPS. */
const BEHIND_PROXY =
  "if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }";

export const wordpress = defineCatalogTemplate({
  id: 'wordpress',
  name: 'WordPress',
  description: 'The blog and website builder, with a MySQL database of its own.',
  category: 'website',
  homepage: 'https://wordpress.org',
  versions: [
    {
      id: '7.1',
      label: 'WordPress {app} with MySQL {db}',
      images: { app: CATALOG_IMAGES.wordpress71, db: CATALOG_IMAGES.mysql84 },
    },
  ],
  defaultVersion: '7.1',
  parameters: z.object({
    port: portParam(8080),
    database: identifierParam('wordpress'),
    user: identifierParam('wordpress').refine(notRootUser, NOT_ROOT_MESSAGE),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
    database: { label: 'Database', help: 'The MySQL database WordPress uses.', input: 'text' },
    user: { label: 'Database user', help: 'The MySQL account WordPress uses.', input: 'text' },
  },
  secrets: [
    { key: 'WORDPRESS_DB_PASSWORD', label: 'Database password', kind: 'password', length: 32 },
    { key: 'MYSQL_ROOT_PASSWORD', label: 'MySQL root password', kind: 'password', length: 32 },
    ...saltSecrets,
  ],
  minMemoryMb: 1024,
  firstVisitorSetup: true,
  exposureNote:
    'Until the setup page is finished, whoever opens the site first picks the admin account. Finish it before putting the site on a domain.',
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => ({
    services: {
      wordpress: {
        image: 'app',
        environment: {
          WORDPRESS_DB_HOST: 'db',
          WORDPRESS_DB_NAME: params.database,
          WORDPRESS_DB_USER: params.user,
          WORDPRESS_DB_PASSWORD: { secret: 'WORDPRESS_DB_PASSWORD' },
          ...Object.fromEntries(
            SALTS.map((name) => [`WORDPRESS_${name}`, { secret: `WORDPRESS_${name}` }]),
          ),
          WORDPRESS_CONFIG_EXTRA: BEHIND_PROXY,
        },
        ports: [{ label: 'Website', target: 80, published: params.port }],
        volumes: [{ volume: 'wordpress', target: '/var/www/html' }],
        healthcheck: curlCheck('http://localhost/wp-includes/images/blank.gif'),
        dependsOn: ['db'],
      },
      db: bundledMysql({
        database: params.database,
        user: params.user,
        passwordSecret: 'WORDPRESS_DB_PASSWORD',
        rootSecret: 'MYSQL_ROOT_PASSWORD',
      }),
    },
    web: { service: 'wordpress', port: 80 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'Site', appUrl(publicUrl, params.port)),
      fact('admin', 'Dashboard', `${appUrl(publicUrl, params.port)}/wp-admin/`),
      fact('database', 'Database', `${params.database} on the bundled MySQL (host db)`),
      fact('db-password', 'Database password', secret('WORDPRESS_DB_PASSWORD'), true),
    ],
  }),
});
