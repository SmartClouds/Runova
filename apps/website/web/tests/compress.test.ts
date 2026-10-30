import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compressResponse } from '../scripts/compress';

const html = '<!doctype html><title>Runova</title>'.repeat(50);

function page(type: string, body: BodyInit | null = html, init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: { 'content-type': type, 'content-length': '1800', ...init.headers },
  });
}

describe('compressResponse', () => {
  it('gzips text when the client accepts it, like Caddy encode in production', async () => {
    const response = await compressResponse(page('text/html; charset=utf-8'), 'gzip, deflate, br');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('vary')).toMatch(/Accept-Encoding/i);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBeLessThan(html.length);
    expect(gunzipSync(body).toString()).toBe(html);
  });

  it.each([
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/json',
    'application/xml',
    'image/svg+xml',
  ])('compresses %s', async (type) => {
    const response = await compressResponse(page(type), 'gzip');
    expect(response.headers.get('content-encoding')).toBe('gzip');
  });

  it.each(['image/avif', 'image/png', 'font/woff2'])('leaves %s alone', async (type) => {
    const response = await compressResponse(page(type), 'gzip');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('leaves the body alone when the client does not accept gzip', async () => {
    const response = await compressResponse(page('text/html'), 'identity');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe(html);
  });

  it('leaves responses without a body alone', async () => {
    const response = await compressResponse(page('text/html', null, { status: 304 }), 'gzip');
    expect(response.status).toBe(304);
    expect(response.headers.get('content-encoding')).toBeNull();
  });
});
