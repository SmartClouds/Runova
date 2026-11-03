import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, curlCheck, fact, urlHost } from './shared.js';

export const gitea = defineCatalogTemplate({
  id: 'gitea',
  name: 'Gitea',
  description: 'Lightweight self-hosted Git with issues, pull requests and package registries.',
  category: 'developer',
  homepage: 'https://about.gitea.com',
  versions: [{ id: '28', label: 'Gitea {app} (rootless)', images: { app: CATALOG_IMAGES.gitea } }],
  defaultVersion: '28',
  parameters: z.object({
    port: portParam(3002),
    sshPort: portParam(2222),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
    sshPort: {
      label: 'SSH port',
      help: 'For cloning over SSH. It is bound to 127.0.0.1 like every other port.',
      input: 'port',
    },
  },
  secrets: [
    { key: 'GITEA_SECRET_KEY', label: 'Secret key', kind: 'hex', length: 32 },
    { key: 'GITEA_INTERNAL_TOKEN', label: 'Internal token', kind: 'hex', length: 32 },
  ],
  minMemoryMb: 512,
  firstVisitorSetup: true,
  exposureNote:
    'The first visit opens the setup page, and the first account registered becomes the admin. Finish both before putting Gitea on a domain.',
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => {
    const url = appUrl(publicUrl, params.port);
    return {
      services: {
        gitea: {
          image: 'app',
          environment: {
            GITEA__database__DB_TYPE: 'sqlite3',
            GITEA__server__ROOT_URL: `${url}/`,
            GITEA__server__DOMAIN: urlHost(url),
            GITEA__server__SSH_DOMAIN: urlHost(url),
            GITEA__server__SSH_PORT: String(params.sshPort),
            GITEA__server__SSH_LISTEN_PORT: '2222',
            GITEA__security__SECRET_KEY: { secret: 'GITEA_SECRET_KEY' },
            GITEA__security__INTERNAL_TOKEN: { secret: 'GITEA_INTERNAL_TOKEN' },
          },
          ports: [
            { label: 'Web interface', target: 3000, published: params.port },
            { label: 'Git over SSH', target: 2222, published: params.sshPort },
          ],
          volumes: [
            { volume: 'data', target: '/var/lib/gitea' },
            { volume: 'config', target: '/etc/gitea' },
          ],
          healthcheck: curlCheck('http://localhost:3000/api/healthz'),
        },
      },
      web: { service: 'gitea', port: 3000 },
      facts: [
        fact('version', 'Version', version.label),
        fact('url', 'Web interface', url),
        fact('ssh', 'Clone over SSH', `ssh://git@${urlHost(url)}:${params.sshPort}/owner/repo.git`),
        fact('secret-key', 'Secret key', secret('GITEA_SECRET_KEY'), true),
      ],
    };
  },
});
