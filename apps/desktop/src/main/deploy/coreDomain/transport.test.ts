import type { AddressInfo } from 'node:net';
import { createServer, type Server, type TLSSocket, connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceKey } from '../auth/deviceKey';
import { clientCertificate } from '../directTls/clientCertificate';
import { PROOF_HEADER } from './proof';
import {
  CLOUDFLARE_MAX_REQUEST_BYTES,
  CoreDomainUnreachableError,
  cloudflareCoreDomainTransport,
  coreDomainTransport,
  isCertificateError,
} from './transport';

/**
 * A loopback TLS server standing in for nginx. Its certificate is self-signed, so the tests that
 * should connect trust it explicitly; the transport itself only trusts the public CAs.
 */
async function startServer(): Promise<{
  server: Server;
  port: number;
  seen: { servername: string | false | null; peer: boolean }[];
}> {
  const made = clientCertificate(createDeviceKey().privateKeyPem);
  const seen: { servername: string | false | null; peer: boolean }[] = [];
  const server = createServer(
    { key: made.key, cert: made.certificate, requestCert: true, rejectUnauthorized: false },
    (socket: TLSSocket) => {
      seen.push({
        servername: socket.servername,
        peer: socket.getPeerX509Certificate() !== undefined,
      });
      socket.on('error', () => undefined);
      socket.write('hello');
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    seen,
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('isCertificateError', () => {
  it('tells certificate problems from network ones', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'INVALID_PURPOSE',
    ]) {
      expect(isCertificateError({ code })).toBe(true);
    }
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', undefined]) {
      expect(isCertificateError({ code })).toBe(false);
    }
  });
});

describe('coreDomainTransport', () => {
  it('connects to the domain with SNI, the device certificate, and the domain as Host', async () => {
    const nginx = await startServer();
    servers.push(nginx.server);
    const device = createDeviceKey();
    const transport = coreDomainTransport(
      'core.example.com',
      async () => clientCertificate(device.privateKeyPem),
      (options) =>
        tlsConnect({
          ...options,
          host: '127.0.0.1',
          port: nginx.port,
          // The stand-in presents a self-signed client-purpose certificate; trust is tested below.
          rejectUnauthorized: false,
        }),
    );

    const stream = await transport.openStream();
    const greeting = await new Promise<string>((resolve) =>
      stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))),
    );
    stream.destroy();

    expect(transport.kind).toBe('core-domain');
    expect(transport.host?.()).toBe('core.example.com');
    expect(greeting).toBe('hello');
    expect(nginx.seen).toEqual([{ servername: 'core.example.com', peer: true }]);
  });

  it('refuses a certificate no public CA vouches for, and says it is the certificate', async () => {
    const nginx = await startServer();
    servers.push(nginx.server);
    const device = createDeviceKey();
    const transport = coreDomainTransport(
      'core.example.com',
      async () => clientCertificate(device.privateKeyPem),
      (options) => tlsConnect({ ...options, host: '127.0.0.1', port: nginx.port }),
    );

    const error = await transport.openStream().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CoreDomainUnreachableError);
    expect((error as CoreDomainUnreachableError).certificate).toBe(true);
    expect((error as Error).message).toMatch(/not trusted/);
  });

  it('reports a domain that does not answer as unreachable, not as a certificate problem', async () => {
    const closed = await startServer();
    await new Promise<void>((resolve) => closed.server.close(() => resolve()));
    const device = createDeviceKey();
    const transport = coreDomainTransport(
      'core.example.com',
      async () => clientCertificate(device.privateKeyPem),
      (options) => tlsConnect({ ...options, host: '127.0.0.1', port: closed.port }),
    );

    const error = await transport.openStream().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CoreDomainUnreachableError);
    expect((error as CoreDomainUnreachableError).certificate).toBe(false);
    expect((error as Error).message).toMatch(/Could not reach core\.example\.com/);
  });
});

describe('cloudflareCoreDomainTransport', () => {
  it('sends no client certificate and signs the request the stream carries', async () => {
    const nginx = await startServer();
    servers.push(nginx.server);
    const received: string[] = [];
    nginx.server.on('secureConnection', (socket: TLSSocket) =>
      socket.on('data', (chunk: Buffer) => received.push(chunk.toString('latin1'))),
    );
    const device = createDeviceKey();
    const transport = cloudflareCoreDomainTransport(
      'core.example.com',
      async () => ({
        deviceId: '0F8FAD5B-D9CB-469F-A165-70867728950E',
        privateKeyPem: device.privateKeyPem,
      }),
      (options) =>
        tlsConnect({ ...options, host: '127.0.0.1', port: nginx.port, rejectUnauthorized: false }),
      undefined,
      () => 1_767_225_600_000,
    );

    const stream = await transport.openStream();
    stream.write('GET /api/v1/health HTTP/1.1\r\nHost: core.example.com\r\n\r\n');
    await vi.waitFor(() => expect(received.join('')).toContain('\r\n\r\n'));
    stream.destroy();

    const head = received.join('');
    const proof = new RegExp(`${PROOF_HEADER}: (\\S+)\r\n\r\n$`).exec(head)?.[1] ?? '';
    expect(transport.kind).toBe('core-domain');
    expect(transport.host?.()).toBe('core.example.com');
    expect(transport.maxRequestBytes).toBe(CLOUDFLARE_MAX_REQUEST_BYTES);
    expect(nginx.seen).toEqual([{ servername: 'core.example.com', peer: false }]);
    expect(proof.split('.').slice(0, 3)).toEqual([
      'v1',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      '1767225600000',
    ]);
  });
});
