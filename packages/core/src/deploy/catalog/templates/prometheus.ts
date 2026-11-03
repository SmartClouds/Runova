import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { appUrl, fact } from './shared.js';

export const prometheus = defineCatalogTemplate({
  id: 'prometheus',
  name: 'Prometheus',
  description: 'Collects metrics from your services and keeps them as time series for querying.',
  category: 'monitoring',
  homepage: 'https://prometheus.io',
  versions: [{ id: '3', label: 'Prometheus {app}', images: { app: CATALOG_IMAGES.prometheus } }],
  defaultVersion: '3',
  parameters: z.object({
    port: portParam(9090),
    retention: z
      .string({ error: 'Enter how long to keep data.' })
      .regex(/^[1-9][0-9]{0,3}[hdwy]$/, 'Use a number and a unit, such as 15d, 12w or 1y.')
      .default('15d'),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port on the server, best opened through an SSH tunnel.',
      input: 'port',
    },
    retention: {
      label: 'Keep data for',
      help: 'How long samples are kept, such as 15d, 12w or 1y.',
      input: 'text',
    },
  },
  secrets: [],
  minMemoryMb: 512,
  firstVisitorSetup: false,
  exposureNote:
    'Prometheus has no login of its own. Keep it on 127.0.0.1 for Grafana and SSH tunnels, or put basic auth in front of it before it goes on a domain.',
  acknowledgments: [],
  build: ({ version, params, publicUrl }) => ({
    services: {
      prometheus: {
        image: 'app',
        // The image's own arguments, plus the retention and the public URL.
        command: [
          '--config.file=/etc/prometheus/prometheus.yml',
          '--storage.tsdb.path=/prometheus',
          `--storage.tsdb.retention.time=${params.retention}`,
          ...(publicUrl ? [`--web.external-url=${publicUrl}/`] : []),
        ],
        ports: [{ label: 'Web interface and API', target: 9090, published: params.port }],
        volumes: [{ volume: 'data', target: '/prometheus' }],
        healthcheck: {
          test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:9090/-/healthy'],
          startPeriod: '30s',
        },
      },
    },
    web: { service: 'prometheus', port: 9090 },
    facts: [
      fact('version', 'Version', version.label),
      fact('url', 'Web interface', appUrl(publicUrl, params.port)),
      fact('retention', 'Keeps data for', params.retention),
    ],
  }),
});
