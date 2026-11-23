import { isIP } from 'node:net';
import { type ConnectionOptions, checkServerIdentity } from 'node:tls';
import type { DbTlsMode } from '@runova/core';
import type { DriverConnectOptions } from './types';

/** Helpers every driver shares. */

/** The mode a TLS connection runs in. Missing means the strictest, as for a new connection. */
export function tlsModeOf(options: DriverConnectOptions): DbTlsMode {
  return options.tlsMode ?? 'verify-full';
}

/** The name the certificate has to carry: the original host for a forward, else the host. */
export function tlsIdentityHost(options: DriverConnectOptions): string {
  return options.tlsServername || options.host;
}

/**
 * Node TLS options for a driver that hands them to `tls.connect` (pg, ioredis, cassandra-driver).
 * Undefined when TLS is off. Through a forward the socket goes to 127.0.0.1, so the host name is
 * checked against the original host (`tlsServername`) instead, which is also sent as SNI unless
 * it is an IP address.
 */
export function nodeTlsOptions(options: DriverConnectOptions): ConnectionOptions | undefined {
  if (!options.tls) return undefined;
  const mode = tlsModeOf(options);
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-ca')
    return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
  const name = tlsIdentityHost(options);
  return {
    rejectUnauthorized: true,
    ...(isIP(name) ? {} : { servername: name }),
    checkServerIdentity: (_host, certificate) => checkServerIdentity(name, certificate),
  };
}

/** Up to this many rows the grid shows an exact total; past it, the estimate is enough. */
export const EXACT_COUNT_LIMIT = 100_000;

/** Counting is cheap when the table is small, or its size is unknown and no filter makes it slow. */
export function countIsCheap(rowEstimate: number | null, filter: string | undefined): boolean {
  if (rowEstimate === null || rowEstimate < 0) return !filter?.trim();
  return rowEstimate <= EXACT_COUNT_LIMIT;
}

/** The words Node uses when a certificate check fails. */
const CERTIFICATE_FAILURE =
  /self[- ]signed certificate|unable to (verify the first|get local issuer) certificate|certificate has expired|does not match certificate's altnames|certificate is not yet valid|unable to verify leaf signature/i;

/**
 * Adds what to do when a TLS connection failed its certificate check. TLS connections used to
 * accept any certificate, so a saved connection to a server with a self-signed one starts
 * failing here, and the person needs to know how to choose that on purpose.
 */
export function withCertificateHint(message: string): string {
  if (!CERTIFICATE_FAILURE.test(message)) return message;
  return `${message.replace(/\.?\s*$/, '.')} The server's certificate could not be verified. If you trust this server and it uses a self-signed certificate, add the connection again with sslmode=require in the URL to encrypt without checking the certificate.`;
}

/** A driver's error as one readable sentence, without the stack. */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return describeError(error.errors[0]);
  }
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    const message = error.message || error.name;
    return typeof detail === 'string' && detail ? `${message} (${detail})` : message;
  }
  return String(error);
}
