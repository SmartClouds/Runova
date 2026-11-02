import { createPublicKey, verify } from 'node:crypto';
import { createServer as httpServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeviceKey } from '../auth/deviceKey';
import {
  coreDomainProof,
  coreDomainProofMessage,
  decodedTarget,
  PROOF_HEADER,
  signFirstRequest,
} from './proof';

/**
 * The device proof for the core domain behind Cloudflare: the exact text the core verifies (the
 * same vector its DeviceProofTests checks), a signature the device's public key verifies, and the
 * header added to the one request a stream carries without touching anything after it.
 */

const DEVICE = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('coreDomainProofMessage', () => {
  it('builds the text the core verifies, the target decoded and the names normalized', () => {
    const message = coreDomainProofMessage(
      DEVICE.toUpperCase(),
      'get',
      '/api/v1/files?path=%2Fsrv%2Fmy%20app',
      'Core.Example.com',
      1_767_225_600_000,
      'AAAAAAAAAAAAAAAAAAAAAA',
    );

    // The same vector as the core's DeviceProofTests.The_message_matches_the_apps.
    expect(message).toBe(
      [
        'runova-core/core-domain-request',
        'v1',
        DEVICE,
        'GET',
        '/api/v1/files?path=/srv/my app',
        'core.example.com',
        '1767225600000',
        'AAAAAAAAAAAAAAAAAAAAAA',
      ].join('\n'),
    );
  });

  it('keeps a target that does not decode as it was sent', () => {
    expect(decodedTarget('/bad%E0%A4%A')).toBe('/bad%E0%A4%A');
  });
});

describe('coreDomainProof', () => {
  it('signs the request with the device key, with a fresh nonce each time', () => {
    const device = createDeviceKey();
    const key = { deviceId: DEVICE, privateKeyPem: device.privateKeyPem };

    const first = coreDomainProof(key, 'GET', '/api/v1/health', 'core.example.com', 1_000);
    const second = coreDomainProof(key, 'GET', '/api/v1/health', 'core.example.com', 1_000);
    const [version, id, time, nonce, signature] = first.split('.');

    expect([version, id, time]).toEqual(['v1', DEVICE, '1000']);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.split('.')[3]).not.toBe(nonce);
    const message = coreDomainProofMessage(
      DEVICE,
      'GET',
      '/api/v1/health',
      'core.example.com',
      1_000,
      nonce ?? '',
    );
    const publicKey = createPublicKey({
      key: Buffer.from(device.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(message),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature ?? '', 'base64'),
      ),
    ).toBe(true);
  });
});

describe('signFirstRequest', () => {
  it('adds the proof as the last header of the first head, and passes the body and later writes through', () => {
    const stream = new PassThrough();
    const written: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => written.push(chunk));
    const signed = signFirstRequest(stream, (method, target) => `${method} ${target}`);

    signed.write('PUT /api/v1/files?x=1 HTTP/1.1\r\nHost: core.example.com\r\n');
    signed.write('Content-Length: 4\r\n\r\nbo');
    signed.write('dy');
    signed.end();

    expect(Buffer.concat(written).toString('latin1')).toBe(
      'PUT /api/v1/files?x=1 HTTP/1.1\r\nHost: core.example.com\r\nContent-Length: 4\r\n' +
        `${PROOF_HEADER}: PUT /api/v1/files?x=1\r\n\r\nbody`,
    );
  });

  it('signs a head that arrives through end()', () => {
    const stream = new PassThrough();
    const written: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => written.push(chunk));

    signFirstRequest(stream, () => 'proof').end('GET / HTTP/1.1\r\nHost: a\r\n\r\n');

    expect(Buffer.concat(written).toString('latin1')).toBe(
      `GET / HTTP/1.1\r\nHost: a\r\n${PROOF_HEADER}: proof\r\n\r\n`,
    );
  });

  const servers: ReturnType<typeof httpServer>[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('reaches a real HTTP server as a header on the request node:http sends', async () => {
    const seen: { proof: string | undefined; body: string }[] = [];
    const server = httpServer((incoming, answer) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        seen.push({
          proof: incoming.headers[PROOF_HEADER.toLowerCase()] as string | undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        answer.end('ok');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/auth/challenge?a=%20b',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          createConnection: (_options, callback) => {
            const socket = connect(port, '127.0.0.1');
            socket.once('connect', () =>
              callback?.(
                null,
                signFirstRequest(socket, (method, target) => `${method} ${target}`),
              ),
            );
            socket.once('error', (error) => callback?.(error, socket));
            return undefined;
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      outgoing.on('error', reject);
      outgoing.end('{"deviceId":"x"}');
    });

    expect(status).toBe(200);
    expect(seen).toEqual([
      { proof: 'POST /api/v1/auth/challenge?a=%20b', body: '{"deviceId":"x"}' },
    ]);
  });
});
