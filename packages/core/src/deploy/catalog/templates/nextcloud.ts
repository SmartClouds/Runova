import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, bundledMariadb, curlCheck, fact, urlHost } from './shared.js';

export const nextcloud = defineCatalogTemplate({
  id: 'nextcloud',
  name: 'Nextcloud',
  description:
    'Your own file sync and sharing, with calendars and contacts, on a MariaDB database.',
  category: 'storage',
  homepage: 'https://nextcloud.com',
  versions: [
    {
      id: '35',
      label: 'Nextcloud {app} with MariaDB {db}',
      images: { app: CATALOG_IMAGES.nextcloud35, db: CATALOG_IMAGES.mariadb114 },
    },
    {
      id: '34',
      label: 'Nextcloud {app} (production channel) with MariaDB {db}',
      images: { app: CATALOG_IMAGES.nextcloud34, db: CATALOG_IMAGES.mariadb114 },
    },
  ],
  // Nextcloud's production channel trails the newest release by one major version.
  defaultVersion: '34',
  parameters: z.object({
    port: portParam(8083),
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
      help: 'The administrator account, set up on first start.',
      input: 'text',
    },
  },
  secrets: [
    { key: 'NEXTCLOUD_ADMIN_PASSWORD', label: 'Admin password', kind: 'password', length: 32 },
    { key: 'NEXTCLOUD_DB_PASSWORD', label: 'Database password', kind: 'password', length: 32 },
    { key: 'MARIADB_ROOT_PASSWORD', label: 'MariaDB root password', kind: 'password', length: 32 },
  ],
  minMemoryMb: 2048,
  firstVisitorSetup: false,
  exposureNote:
    'The first start installs Nextcloud and can take a few minutes. Give it a domain with SSL before anyone syncs over the internet.',
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => {
    const domains = ['127.0.0.1', 'localhost'];
    if (publicUrl) domains.unshift(urlHost(publicUrl));
    return {
      services: {
        nextcloud: {
          image: 'app',
          environment: {
            MYSQL_HOST: 'db',
            MYSQL_DATABASE: 'nextcloud',
            MYSQL_USER: 'nextcloud',
            MYSQL_PASSWORD: { secret: 'NEXTCLOUD_DB_PASSWORD' },
            NEXTCLOUD_ADMIN_USER: params.admin,
            NEXTCLOUD_ADMIN_PASSWORD: { secret: 'NEXTCLOUD_ADMIN_PASSWORD' },
            NEXTCLOUD_TRUSTED_DOMAINS: domains.join(' '),
            ...(publicUrl
              ? {
                  OVERWRITEPROTOCOL: 'https',
                  OVERWRITECLIURL: publicUrl,
                  // The proxy reaches the container through Docker's bridge.
                  TRUSTED_PROXIES: '172.16.0.0/12 192.168.0.0/16 10.0.0.0/8',
                }
              : {}),
          },
          ports: [{ label: 'Website', target: 80, published: params.port }],
          volumes: [{ volume: 'nextcloud', target: '/var/www/html' }],
          healthcheck: curlCheck('http://localhost/status.php', '10m'),
          dependsOn: ['db'],
        },
        db: bundledMariadb({
          database: 'nextcloud',
          user: 'nextcloud',
          passwordSecret: 'NEXTCLOUD_DB_PASSWORD',
          rootSecret: 'MARIADB_ROOT_PASSWORD',
          command: [
            '--transaction-isolation=READ-COMMITTED',
            '--log-bin=binlog',
            '--binlog-format=ROW',
          ],
        }),
      },
      web: { service: 'nextcloud', port: 80 },
      facts: [
        fact('version', 'Version', version.label),
        fact('url', 'Web interface', appUrl(publicUrl, params.port)),
        fact('admin', 'Admin user', params.admin),
        fact('admin-password', 'Admin password', secret('NEXTCLOUD_ADMIN_PASSWORD'), true),
        fact(
          'webdav',
          'WebDAV',
          `${appUrl(publicUrl, params.port)}/remote.php/dav/files/${params.admin}/`,
        ),
      ],
    };
  },
});
