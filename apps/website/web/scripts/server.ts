// Serves the build in production (`bun run start`): the Node adapter's handler with the security
// headers from src/lib/security.ts on every response. The adapter's own server can't add them to
// prerendered files, which it serves without running Astro middleware. HOST and PORT pick the address.
import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { withSecurityHeaders } from '../src/lib/security';

/** Starts the site on `host` and `port` (0 for any free port) and resolves once it listens. */
export async function startSite(host: string, port: number): Promise<Server> {
  // The entry starts its own server on import unless this is set.
  process.env.ASTRO_NODE_AUTOSTART = 'disabled';
  const entry = '../dist/server/entry.mjs';
  const { handler } = (await import(entry)) as { handler: RequestListener };
  const server = createServer(withSecurityHeaders(handler));
  server.listen(port, host);
  await once(server, 'listening');
  return server;
}

if (import.meta.main) {
  const server = await startSite(process.env.HOST || 'localhost', Number(process.env.PORT || 4321));
  const { address, port } = server.address() as AddressInfo;
  console.log(`Server listening on http://${address}:${port}`);
}
