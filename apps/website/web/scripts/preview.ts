// Serves the build the way production does: the site server (scripts/server.ts) behind a proxy
// that compresses text, as Caddy does in front of it. Lighthouse audits this, so an uncompressed preview would count
// hundreds of kilobytes the real site never sends. HOST and PORT pick the public address.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { compressResponse } from './compress';
import { startSite } from './server';

const host = process.env.HOST || 'localhost';
const port = Number(process.env.PORT || 4321);
const upstream = { host: '127.0.0.1', port: port + 1 };

// The site server prints nothing, so the line below (which lighthouserc waits for) only shows once
// both servers are up.
await startSite(upstream.host, upstream.port);

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
