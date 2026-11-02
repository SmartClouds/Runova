import type { Duplex } from 'node:stream';
import type { CoreDomainMode } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployCoreDomainCheck } from '../../../shared/deployCoreDomainTypes';
import type { CoreTransport } from '../connection/transport';
import { CoreDomainUnreachableError } from './transport';

/**
 * Checks the core domain from this computer the way the link would use it: TLS to the domain with
 * the device certificate, then the core's health. The answer's headers tell the usual mistakes
 * apart: Cloudflare's proxy answers with a cf-ray header (it ends TLS itself, so the device
 * certificate never reaches nginx), and nginx turns a request without a certificate down with 403.
 * Through Cloudflare it is the other way round: the answer has to come through Cloudflare, the
 * request is signed rather than the handshake, and Cloudflare's own 52x pages name an origin it
 * could not reach or did not trust.
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

/** What the core names a refused proof with (its RefusalHeader), so the head alone tells a clock that is off. */
const REFUSAL_HEADER = 'x-runova-refusal';

function viaCloudflare(answer: ProbeAnswer): boolean {
  return (
    answer.headers['cf-ray'] !== undefined || answer.headers.server?.toLowerCase() === 'cloudflare'
  );
}

/** What an answer means for the core domain. */
export function judge(
  answer: ProbeAnswer,
  domain: string,
  now: number,
  mode: CoreDomainMode = 'direct',
): DeployCoreDomainCheck {
  if (mode === 'cloudflare') return judgeCloudflare(answer, domain, now);
  if (viaCloudflare(answer)) {
    return {
      ok: false,
      checkedAt: now,
      problem: 'cloudflare-proxy',
      message: `Cloudflare answers for ${domain}, so this computer's device certificate never reaches the server. Choose Through Cloudflare for the core domain, or turn the proxy off for this record (DNS only, the grey cloud).`,
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

function judgeCloudflare(answer: ProbeAnswer, domain: string, now: number): DeployCoreDomainCheck {
  const fail = (
    problem: Exclude<DeployCoreDomainCheck, { ok: true }>['problem'],
    message: string,
  ) => ({ ok: false, checkedAt: now, problem, message }) as const;
  const proxied = viaCloudflare(answer);
  if (answer.status === 200) {
    if (proxied) return { ok: true, checkedAt: now };
    return fail(
      'not-proxied',
      `${domain} answered without Cloudflare in front. Turn the proxy on for this record in Cloudflare (Proxied, the orange cloud), or choose Straight to the server.`,
    );
  }
  if (answer.status === 403 && answer.headers[REFUSAL_HEADER] === 'deviceProofClockSkew') {
    return fail(
      'clock',
      "This computer's clock is more than five minutes off the server's, so the server cannot tell a fresh request from an old one. Set the clock to update automatically and check again.",
    );
  }
  if (answer.status === 403 && answer.headers[REFUSAL_HEADER] !== undefined) {
    return fail(
      'device-proof',
      `The server core turned this computer's signed request down. This device may have been revoked on the core.`,
    );
  }
  if (proxied && [521, 522, 523].includes(answer.status)) {
    return fail(
      'cloudflare-origin',
      `Cloudflare could not reach the server behind ${domain} (${answer.status}). Check that the record points at this server and that the firewall lets Cloudflare in on port 443.`,
    );
  }
  if (proxied && [525, 526].includes(answer.status)) {
    return fail(
      'cloudflare-origin',
      `Cloudflare did not accept the server's certificate for ${domain} (${answer.status}). Set the zone's SSL mode to Full (strict) and give the domain a certificate Cloudflare trusts, such as a Cloudflare Origin certificate.`,
    );
  }
  if (answer.status === 403) {
    return fail(
      'device-proof',
      `${domain} refused the request before it reached the server core. A Cloudflare rule (WAF, Access, Bot Fight Mode) may be blocking it, or the server's sources leave this computer out.`,
    );
  }
  return fail(
    'unreachable',
    `${domain} answered ${answer.status} instead of the server core. Check that its DNS record points at this server.`,
  );
}

export async function checkCoreDomain(
  transport: CoreTransport,
  domain: string,
  now: () => number,
  mode: CoreDomainMode = 'direct',
): Promise<DeployCoreDomainCheck> {
  try {
    const stream = await transport.openStream();
    return judge(await readHead(stream, domain, HEALTH_PATH), domain, now(), mode);
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
