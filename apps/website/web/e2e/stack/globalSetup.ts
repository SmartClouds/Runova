// Before the stack specs: waits until the compose stack answers through the proxy, then makes the
// owner account the specs sign in with. The stack itself is started by `docker compose up`.
import { request } from '@playwright/test';
import { ensureOwner } from './compose.ts';
import { STACK_URL } from './stackConfig.ts';

export default async function globalSetup() {
  const context = await request.newContext({ baseURL: STACK_URL, ignoreHTTPSErrors: true });
  try {
    const until = Date.now() + 180_000;
    for (;;) {
      const ready = await Promise.all(
        ['/', '/api/v1/news'].map((path) =>
          context.get(path, { timeout: 5_000 }).then(
            (response) => response.ok(),
            () => false,
          ),
        ),
      );
      if (ready.every(Boolean)) break;
      if (Date.now() > until) {
        throw new Error(
          `The stack did not answer at ${STACK_URL}. Start it with docker compose up.`,
        );
      }
      await new Promise((wake) => setTimeout(wake, 1_000));
    }
  } finally {
    await context.dispose();
  }
  ensureOwner();
}
