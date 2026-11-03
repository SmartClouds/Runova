import { z } from 'zod';
import { defineCatalogTemplate, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import type { CatalogServiceSpec } from '../types.js';
import { appUrl, curlCheck, fact } from './shared.js';

export const ollama = defineCatalogTemplate({
  id: 'ollama',
  name: 'Ollama',
  description: 'Runs open language models on your server, with Open WebUI as a chat front end.',
  category: 'ai',
  homepage: 'https://ollama.com',
  versions: [
    {
      id: '0.35',
      label: 'Ollama {ollama} with Open WebUI {webui}',
      images: { ollama: CATALOG_IMAGES.ollama, webui: CATALOG_IMAGES.openWebUi },
    },
  ],
  defaultVersion: '0.35',
  parameters: z.object({
    port: portParam(11434),
    webUi: z.boolean().default(true),
    webUiPort: portParam(3003),
    gpu: z.boolean().default(false),
  }),
  fields: {
    port: {
      label: 'API port',
      help: 'The port of the Ollama API on the server. It has no login, so it stays on 127.0.0.1.',
      input: 'port',
    },
    webUi: {
      label: 'Open WebUI',
      help: 'Adds a chat interface in the browser, with accounts of its own.',
      input: 'toggle',
    },
    webUiPort: {
      label: 'Open WebUI port',
      help: 'The port on the server that the proxy forwards the domain to.',
      input: 'port',
    },
    gpu: {
      label: 'Use NVIDIA GPUs',
      help: 'Gives Ollama every NVIDIA GPU. The server needs the NVIDIA Container Toolkit.',
      input: 'toggle',
    },
  },
  secrets: [{ key: 'WEBUI_SECRET_KEY', label: 'Open WebUI session key', kind: 'hex', length: 32 }],
  secretInUse: (key, params) => key !== 'WEBUI_SECRET_KEY' || params.webUi,
  minMemoryMb: 8192,
  firstVisitorSetup: true,
  exposureNote:
    'The first account created in Open WebUI becomes its admin, so create yours before putting it on a domain. The Ollama API has no login and should never go on a domain without one in front of it.',
  acknowledgments: [],
  build: ({ version, params, publicUrl }) => {
    const services: Record<string, CatalogServiceSpec> = {
      ollama: {
        image: 'ollama',
        ports: [{ label: 'Ollama API', target: 11434, published: params.port }],
        volumes: [{ volume: 'models', target: '/root/.ollama' }],
        healthcheck: { test: ['CMD', 'ollama', 'list'], startPeriod: '30s' },
        gpu: params.gpu,
      },
    };
    if (params.webUi) {
      services['open-webui'] = {
        image: 'webui',
        environment: {
          OLLAMA_BASE_URL: 'http://ollama:11434',
          WEBUI_SECRET_KEY: { secret: 'WEBUI_SECRET_KEY' },
          WEBUI_URL: appUrl(publicUrl, params.webUiPort),
          ANONYMIZED_TELEMETRY: 'false',
        },
        ports: [{ label: 'Open WebUI', target: 8080, published: params.webUiPort }],
        volumes: [{ volume: 'webui', target: '/app/backend/data' }],
        // The first start downloads the embedding models, which takes a while.
        healthcheck: curlCheck('http://localhost:8080/health', '10m'),
        dependsOn: ['ollama'],
      };
    }
    return {
      services,
      web: params.webUi ? { service: 'open-webui', port: 8080 } : null,
      facts: [
        fact('version', 'Version', version.label),
        fact('api', 'Ollama API', `http://127.0.0.1:${params.port}`),
        ...(params.webUi ? [fact('webui', 'Open WebUI', appUrl(publicUrl, params.webUiPort))] : []),
        fact('gpu', 'GPU', params.gpu ? 'Every NVIDIA GPU' : 'None, models run on the CPU'),
      ],
    };
  },
});
