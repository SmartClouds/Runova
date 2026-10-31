// Where the compose stack (apps/website/compose.yaml, with compose.test.yaml on top) answers and
// the owner account the stack specs make in it. Shared by playwright.stack.config.ts, the global
// setup and the specs.
import { resolve } from 'node:path';

/** The one origin Caddy serves: the site, `/api`, `/media` and `/hangfire`. */
export const STACK_URL = (process.env.STACK_URL || 'https://localhost:8443').replace(/\/+$/, '');

/** The same proxy on plain HTTP, which only redirects to STACK_URL. */
export const STACK_HTTP_URL = (process.env.STACK_HTTP_URL || 'http://localhost:8080').replace(
  /\/+$/,
  '',
);

/** The stack as production runs it, then the test-only telemetry sink (see compose.test.yaml). */
export const COMPOSE_FILES = ['compose.yaml', 'compose.test.yaml'].map((name) =>
  resolve(import.meta.dirname, '../../..', name),
);

/** The first Admin, made with `admin create-owner` in the API container on the first run. */
export const OWNER = {
  email: 'owner@stack.runovahq.test',
  displayName: 'Stack Owner',
  password: process.env.STACK_OWNER_PASSWORD || 'owner-password-for-the-stack-only',
};
