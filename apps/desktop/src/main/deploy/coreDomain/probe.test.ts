import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { asSocket } from '../connection/socketShim';
import type { CoreTransport } from '../connection/transport';
import { checkCoreDomain, judge, readHead } from './probe';
import { CoreDomainUnreachableError } from './transport';

/** A stream that answers the first request with `answer`, and records what it was sent. */
function answering(answer: string): { stream: Duplex; sent: string[] } {
  const sent: string[] = [];
  const stream = new Duplex({
    read() {
      // Answers are pushed from write.
    },
    write(chunk, _encoding, done) {
      sent.push(String(chunk));
      this.push(answer);
      done();
    },
  });
  return { stream, sent };
}

function transportOf(answer: string | Error): CoreTransport {
  return {
    kind: 'core-domain',
    host: () => 'core.example.com',
    openStream: async () => {
      if (answer instanceof Error) throw answer;
      return asSocket(answering(answer).stream);
    },
  };
}

describe('readHead', () => {
  it('sends one GET with the domain as Host and reads the status and headers', async () => {
    const { stream, sent } = answering(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Thing: a: b\r\n\r\n{"status":"ok"}',
    );

    const head = await readHead(stream, 'core.example.com', '/api/v1/health');

    expect(sent[0]).toMatch(/^GET \/api\/v1\/health HTTP\/1\.1\r\nHost: core\.example\.com\r\n/);
    expect(head).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-thing': 'a: b' },
    });
  });

  it('refuses an answer that is not HTTP', async () => {
    const { stream } = answering('SSH-2.0-OpenSSH_9.6\r\n\r\n');

    await expect(readHead(stream, 'core.example.com', '/')).rejects.toThrow(/HTTP/);
  });
});

describe('judge', () => {
  it('passes the core answering its health', () => {
    expect(judge({ status: 200, headers: {} }, 'core.example.com', 7)).toEqual({
      ok: true,
      checkedAt: 7,
    });
  });

  it('names the Cloudflare proxy whatever the status', () => {
    const answers: Record<string, string>[] = [{ 'cf-ray': '8a1-FRA' }, { server: 'cloudflare' }];
    for (const headers of answers) {
      const result = judge({ status: 403, headers }, 'core.example.com', 7);
      expect(result).toMatchObject({ ok: false, problem: 'cloudflare-proxy' });
      expect(result.ok ? '' : result.message).toMatch(/DNS only/);
    }
  });

  it('tells a refused device certificate from a domain that points elsewhere', () => {
    expect(judge({ status: 403, headers: {} }, 'core.example.com', 7)).toMatchObject({
      ok: false,
      problem: 'no-certificate',
    });
    expect(judge({ status: 404, headers: {} }, 'core.example.com', 7)).toMatchObject({
      ok: false,
      problem: 'unreachable',
    });
  });
});

describe('judge through Cloudflare', () => {
  const via = { 'cf-ray': '8a1-FRA', server: 'cloudflare' };
  const verdict = (status: number, headers: Record<string, string>) =>
    judge({ status, headers }, 'core.example.com', 7, 'cloudflare');

  it('passes the core answering through Cloudflare, and names an answer without it', () => {
    expect(verdict(200, via)).toEqual({ ok: true, checkedAt: 7 });
    expect(verdict(200, {})).toMatchObject({ ok: false, problem: 'not-proxied' });
  });

  it('names a clock that is off apart from a refused proof', () => {
    expect(verdict(403, { ...via, 'x-runova-refusal': 'deviceProofClockSkew' })).toMatchObject({
      ok: false,
      problem: 'clock',
    });
    expect(verdict(403, { ...via, 'x-runova-refusal': 'deviceProofInvalid' })).toMatchObject({
      ok: false,
      problem: 'device-proof',
    });
  });

  it("explains Cloudflare's own pages for an origin it could not reach or trust", () => {
    const unreachable = verdict(522, via);
    const untrusted = verdict(526, via);

    expect(unreachable).toMatchObject({ ok: false, problem: 'cloudflare-origin' });
    expect(unreachable.ok ? '' : unreachable.message).toMatch(/firewall lets Cloudflare in/);
    expect(untrusted).toMatchObject({ ok: false, problem: 'cloudflare-origin' });
    expect(untrusted.ok ? '' : untrusted.message).toMatch(/Full \(strict\)/);
  });

  it('says a 403 Cloudflare sent itself may be one of its rules', () => {
    const blocked = verdict(403, via);

    expect(blocked).toMatchObject({ ok: false, problem: 'device-proof' });
    expect(blocked.ok ? '' : blocked.message).toMatch(/Cloudflare rule/);
  });
});

describe('checkCoreDomain', () => {
  it('reports a certificate this computer does not trust apart from a network failure', async () => {
    const untrusted = await checkCoreDomain(
      transportOf(new CoreDomainUnreachableError('not trusted', true)),
      'core.example.com',
      () => 9,
    );
    const refused = await checkCoreDomain(
      transportOf(new CoreDomainUnreachableError('ECONNREFUSED')),
      'core.example.com',
      () => 9,
    );

    expect(untrusted).toMatchObject({ ok: false, problem: 'certificate', checkedAt: 9 });
    expect(refused).toMatchObject({ ok: false, problem: 'unreachable', checkedAt: 9 });
  });

  it('passes when the core answers through the domain', async () => {
    const result = await checkCoreDomain(
      transportOf('HTTP/1.1 200 OK\r\n\r\n'),
      'core.example.com',
      () => 9,
    );

    expect(result).toEqual({ ok: true, checkedAt: 9 });
  });
});
