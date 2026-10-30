// Serves the build the way production does: the Astro server behind a proxy that compresses text,
// as Caddy does in front of it. Lighthouse audits this, so an uncompressed preview would count
// hundreds of kilobytes the real site never sends. HOST and PORT pick the public address.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { compressResponse } from './compress';

const host = process.env.HOST || 'localhost';
const port = Number(process.env.PORT || 4321);
const upstream = { host: '127.0.0.1', port: port + 1 };

// The entry reads these when startServer runs. Its own "Server listening" line is turned off, so
// the line below (which lighthouserc waits for) only shows once both servers are up.
Object.assign(process.env, {
  ASTRO_NODE_AUTOSTART: 'disabled',
  ASTRO_NODE_LOGGING: 'disabled',
  HOST: upstream.host,
  PORT: String(upstream.port),
});
const entry = '../dist/server/entry.mjs';
const { startServer } = (await import(entry)) as {
  startServer: () => { server: { server: Server } };
};
const astro = startServer().server.server;
if (!astro.listening) await once(astro, 'listening');

// Hop-by-hop headers belong to the connection to this proxy, and fetch refuses some of them.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

// The site is static, so the proxy forwards the method and headers but no request body.
const proxy = createServer(async (request, reply) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) headers.set(name, String(value));
  }
  const response = await compressResponse(
    await fetch(`http://${upstream.host}:${upstream.port}${request.url}`, {
      method: request.method,
      headers,
      redirect: 'manual',
    }),
    request.headers['accept-encoding'] ?? null,
  );
  reply.writeHead(response.status, Object.fromEntries(response.headers));
  reply.end(Buffer.from(await response.arrayBuffer()));
});
proxy.listen(port, host);
await once(proxy, 'listening');
console.log(`Server listening on http://${host}:${port}`);
