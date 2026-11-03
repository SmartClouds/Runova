import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, fact } from './shared.js';

export const rabbitmq = defineCatalogTemplate({
  id: 'rabbitmq',
  name: 'RabbitMQ',
  description: 'A message broker for queues between services, with its management UI included.',
  category: 'messaging',
  homepage: 'https://www.rabbitmq.com',
  versions: [
    {
      id: '4.3',
      label: 'RabbitMQ {app} with management',
      images: { app: CATALOG_IMAGES.rabbitmq43 },
    },
  ],
  defaultVersion: '4.3',
  parameters: z.object({
    port: portParam(5672),
    managementPort: portParam(15672),
    user: identifierParam('admin').refine(
      (name) => name !== 'guest',
      'guest can only sign in from inside the container. Pick another name.',
    ),
  }),
  fields: {
    port: {
      label: 'AMQP port',
      help: 'The port clients connect to, on the server or through an SSH tunnel.',
      input: 'port',
    },
    managementPort: {
      label: 'Management port',
      help: 'The port of the management UI, which the proxy forwards the domain to.',
      input: 'port',
    },
    user: {
      label: 'User',
      help: 'The administrator account, created on first start.',
      input: 'text',
    },
  },
  secrets: [{ key: 'RABBITMQ_DEFAULT_PASS', label: 'Password', kind: 'password', length: 32 }],
  minMemoryMb: 512,
  firstVisitorSetup: false,
  exposureNote: 'Only the management UI goes on a domain. Clients keep using the AMQP port.',
  acknowledgments: [],
  build: ({ version, params, secret, publicUrl }) => ({
    services: {
      rabbitmq: {
        image: 'app',
        // RabbitMQ names its data after the host name, so it has to stay the same.
        hostname: 'rabbitmq',
        environment: {
          RABBITMQ_DEFAULT_USER: params.user,
          RABBITMQ_DEFAULT_PASS: { secret: 'RABBITMQ_DEFAULT_PASS' },
        },
        ports: [
          { label: 'AMQP', target: 5672, published: params.port },
          { label: 'Management UI', target: 15672, published: params.managementPort },
        ],
        volumes: [{ volume: 'data', target: '/var/lib/rabbitmq' }],
        healthcheck: {
          test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping'],
          startPeriod: '1m',
        },
      },
    },
    web: { service: 'rabbitmq', port: 15672 },
    facts: [
      fact('version', 'Version', version.label),
      fact('management', 'Management UI', appUrl(publicUrl, params.managementPort)),
      fact('user', 'User', params.user),
      fact('password', 'Password', secret('RABBITMQ_DEFAULT_PASS'), true),
      fact(
        'url',
        'Connection string',
        `amqp://${params.user}:${secret('RABBITMQ_DEFAULT_PASS')}@127.0.0.1:${params.port}/`,
        true,
      ),
    ],
  }),
});
