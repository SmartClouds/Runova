import { type ConnectionOptions, type TLSSocket, connect as tlsConnect } from 'node:tls';
import type { CoreTransport } from '../connection/transport';
import type { ClientCertificate } from '../directTls/clientCertificate';

/**
 * The core domain (E44): the server core behind a domain in nginx. The domain has a certificate
 * from a public CA, so it is checked the usual way (name and chain) rather than pinned: Let's
 * Encrypt renews it with new keys. This computer's device key goes along as the client
 * certificate, as for direct TLS; nginx passes it to the core, which checks it on every request.
 * HTTP and the hub then run over the socket exactly as they do over SSH, with the domain as Host
 * so nginx picks the right site.
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The domain did not answer, or its certificate is not one this computer trusts: SSH may still get in. */
export class CoreDomainUnreachableError extends Error {
  constructor(
    message: string,
    /** True when TLS failed on the domain's own certificate, not on the network. */
    readonly certificate = false,
  ) {
    super(message);
    this.name = 'CoreDomainUnreachableError';
  }
}

export type TlsConnect = (options: ConnectionOptions) => TLSSocket;

/**
 * Whether a TLS error is about the certificate the domain presents (OpenSSL's verify codes and
 * Node's name check), as opposed to a network that did not answer.
 */
export function isCertificateError(error: { code?: string }): boolean {
  return (
    error.code !== undefined &&
    /CERT|SIGNATURE|ISSUER|PURPOSE|HOSTNAME|ALTNAME|LEAF/.test(error.code)
  );
}

export function coreDomainTransport(
  domain: string,
  credentials: () => Promise<ClientCertificate>,
  connect: TlsConnect = tlsConnect,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): CoreTransport {
  return {
    kind: 'core-domain',
    host: () => domain,
    openStream: async () => {
      const { certificate, key } = await credentials();
      return new Promise<TLSSocket>((resolve, reject) => {
        const socket = connect({
          host: domain,
          port: 443,
          servername: domain,
          cert: certificate,
          key,
          minVersion: 'TLSv1.2',
          ALPNProtocols: ['http/1.1'],
          // A public CA vouches for the domain; Node checks the chain and the name.
          rejectUnauthorized: true,
        });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new CoreDomainUnreachableError(`${domain} did not answer in time.`));
        }, timeoutMs);
        socket.once('secureConnect', () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once('error', (error: Error & { code?: string }) => {
          clearTimeout(timer);
          const certificateProblem = isCertificateError(error);
          reject(
            new CoreDomainUnreachableError(
              certificateProblem
                ? `The certificate ${domain} presents is not trusted here: ${error.message}`
                : `Could not reach ${domain}: ${error.message}`,
              certificateProblem,
            ),
          );
        });
      });
    },
  };
}
