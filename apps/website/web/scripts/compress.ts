import { gzipSync } from 'node:zlib';

const COMPRESSIBLE =
  /^(text\/|application\/(javascript|json|xml|ld\+json|manifest\+json)|image\/svg\+xml)/;

/**
 * Gzips a text response when the client accepts it, the way Caddy's `encode` does in front of the
 * site in production. Anything else, and responses without a body, pass through untouched.
 */
export async function compressResponse(
  response: Response,
  acceptEncoding: string | null,
): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (
    !response.body ||
    response.headers.has('content-encoding') ||
    !COMPRESSIBLE.test(type) ||
    !/\bgzip\b/.test(acceptEncoding ?? '')
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  headers.delete('content-length');
  headers.append('vary', 'Accept-Encoding');
  const body = gzipSync(new Uint8Array(await response.arrayBuffer()));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
