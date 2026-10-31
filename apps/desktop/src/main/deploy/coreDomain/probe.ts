import type { Duplex } from 'node:stream';
import type { DeployCoreDomainCheck } from '../../../shared/deployCoreDomainTypes';
import type { CoreTransport } from '../connection/transport';
import { CoreDomainUnreachableError } from './transport';

/**
 * Checks the core domain from this computer the way the link would use it: TLS to the domain with
 * the device certificate, then the core's health. The answer's headers tell the usual mistakes
 * apart: Cloudflare's proxy answers with a cf-ray header (it ends TLS itself, so the device
 * certificate never reaches nginx), and nginx turns a request without a certificate down with 403.
 */

const HEALTH_PATH = '/api/v1/health';
const READ_TIMEOUT_MS = 15_000;
const MAX_HEAD_BYTES = 32 * 1024;

export interface ProbeAnswer {
  status: number;
  headers: Record<string, string>;
}

/** Sends one GET and reads the status line and headers; the body is not needed. */
export async function readHead(stream: Duplex, host: string, path: string): Promise<ProbeAnswer> {
  return new Promise<ProbeAnswer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(
      () => finish(new Error(`${host} sent no answer in time.`)),
      READ_TIMEOUT_MS,
    );
    const finish = (error: Error | null, answer?: ProbeAnswer) => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.destroy();
      if (error) reject(error);
      else resolve(answer as ProbeAnswer);
    };
    stream.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.length > MAX_HEAD_BYTES)
          finish(new Error(`${host} sent an answer too large to read.`));
        return;
      }
      const lines = buffered.subarray(0, end).toString('latin1').split('\r\n');
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '');
      if (!status) {
        finish(new Error(`${host} did not answer in HTTP.`));
        return;
      }
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0)
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      finish(null, { status: Number(status[1]), headers });
    });
    stream.once('error', (error: Error) => finish(error));
    stream.once('end', () => finish(new Error(`${host} closed the connection without an answer.`)));
    stream.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
    );
  });
}

/** What an answer means for the core domain. */
export function judge(answer: ProbeAnswer, domain: string, now: number): DeployCoreDomainCheck {
  if (
    answer.headers['cf-ray'] !== undefined ||
    answer.headers.server?.toLowerCase() === 'cloudflare'
  ) {
    return {
      ok: false,
      checkedAt: now,
      problem: 'cloudflare-proxy',
      message: `Cloudflare answers for ${domain}, so this computer's device certificate never reaches the server. Turn the proxy off for this record in Cloudflare (DNS only, the grey cloud).`,
    };
  }
  if (answer.status === 200) return { ok: true, checkedAt: now };
  if (answer.status === 403) {
    return {
      ok: false,
      checkedAt: now,
      problem: 'no-certificate',
      message: `${domain} turned this computer's device certificate down. Something between this computer and nginx may end TLS itself (a proxy or a load balancer), or this device was revoked on the core.`,
    };
  }
  return {
    ok: false,
    checkedAt: now,
    problem: 'unreachable',
    message: `${domain} answered ${answer.status} instead of the server core. Check that its DNS record points at this server.`,
  };
}

export async function checkCoreDomain(
  transport: CoreTransport,
  domain: string,
  now: () => number,
): Promise<DeployCoreDomainCheck> {
  try {
    const stream = await transport.openStream();
    return judge(await readHead(stream, domain, HEALTH_PATH), domain, now());
  } catch (error) {
    const certificate = error instanceof CoreDomainUnreachableError && error.certificate;
    return {
      ok: false,
      checkedAt: now(),
      problem: certificate ? 'certificate' : 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
