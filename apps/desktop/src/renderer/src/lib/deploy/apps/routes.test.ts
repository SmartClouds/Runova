import type {
  CertificateInfo,
  SiteInfo,
  StackPortBinding,
  UpstreamTarget,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { describe, expect, it } from 'vitest';
import { appHealthUrl, domainsForPort, proxyBlockReason, publishedPort } from './routes';

/** Which domains lead to a published port, and whether nginx can put one on a domain. */

function binding(extra: Partial<StackPortBinding> = {}): StackPortBinding {
  return {
    service: 'api',
    target: 3000,
    protocol: 'tcp',
    hostIp: '127.0.0.1',
    published: '8091',
    ...extra,
  };
}

function siteTo(domains: string[], upstream: Partial<UpstreamTarget>): SiteInfo {
  return {
    settings: {
      id: domains[0].replaceAll('.', '-'),
      domains,
      upstream: {
        kind: 'servicePort',
        verifyCertificate: true,
        sendUpstreamHost: false,
        ...upstream,
      },
      websocket: true,
      gzip: true,
      http2: true,
      redirectToHttps: false,
    },
    applied: true,
    createdAtUnixMs: 0,
    updatedAtUnixMs: 0,
  };
}

describe('publishedPort', () => {
  it('reads the port on the server as a number', () => {
    expect(publishedPort(binding())).toBe(8091);
    expect(publishedPort(binding({ published: undefined }))).toBeNull();
    expect(publishedPort(binding({ published: '8000-8010' }))).toBeNull();
  });
});

describe('domainsForPort', () => {
  it('collects the domains of every site that forwards to the port', () => {
    const sites = [
      siteTo(['api.example.com', 'www.api.example.com'], { port: 8091 }),
      siteTo(['blog.example.com'], { port: 3000 }),
      siteTo(['old.example.com'], { kind: 'url', address: 'http://127.0.0.1:8091/' }),
      siteTo(['local.example.com'], { kind: 'url', address: 'https://localhost:8091' }),
      siteTo(['far.example.com'], { kind: 'url', address: 'http://10.0.0.5:8091' }),
      siteTo(['bad.example.com'], { kind: 'url', address: 'not a url' }),
    ];
    expect(domainsForPort(sites, 8091)).toEqual([
      'api.example.com',
      'www.api.example.com',
      'old.example.com',
      'local.example.com',
    ]);
  });

  it('has nothing for a port no site forwards to', () => {
    expect(domainsForPort([], 8091)).toEqual([]);
  });
});

describe('proxyBlockReason', () => {
  it('lets a TCP port on this server or every address through', () => {
    expect(proxyBlockReason(binding())).toBeNull();
    expect(proxyBlockReason(binding({ hostIp: '0.0.0.0' }))).toBeNull();
    expect(proxyBlockReason(binding({ hostIp: undefined }))).toBeNull();
    expect(proxyBlockReason(binding({ hostIp: '::1' }))).toBeNull();
  });

  it('says why nginx cannot reach the rest', () => {
    expect(proxyBlockReason(binding({ protocol: 'udp' }))).toMatch(/UDP/);
    expect(proxyBlockReason(binding({ published: undefined }))).toMatch(/fixed port/);
    expect(proxyBlockReason(binding({ hostIp: '10.0.0.5' }))).toMatch(/10\.0\.0\.5/);
  });
});

describe('appHealthUrl', () => {
  const app = (...ports: StackPortBinding[]) => ({
    services: [{ name: 'api', containers: [], ports }],
  });
  const certified = (site: SiteInfo): SiteInfo => ({
    ...site,
    certificate: { siteId: site.settings.id, state: 'valid' } as CertificateInfo,
  });

  it('uses the domain of a site with a certificate over https', () => {
    const sites = [
      siteTo(['plain.example.com'], { port: 8091 }),
      certified(siteTo(['api.example.com'], { port: 8091 })),
    ];
    expect(appHealthUrl(app(binding()), sites, '203.0.113.7')).toEqual({
      url: 'https://api.example.com/_runova/health',
      insecure: false,
    });
  });

  it('falls back to plain http on a domain with no certificate', () => {
    const sites = [siteTo(['*.example.com', 'api.example.com'], { port: 8091 })];
    expect(appHealthUrl(app(binding()), sites, '203.0.113.7')).toEqual({
      url: 'http://api.example.com/_runova/health',
      insecure: true,
    });
  });

  it('uses the server address for a port open to every address', () => {
    expect(appHealthUrl(app(binding({ hostIp: '0.0.0.0' })), [], '203.0.113.7')).toEqual({
      url: 'http://203.0.113.7:8091/_runova/health',
      insecure: true,
    });
    expect(appHealthUrl(app(binding({ hostIp: '2001:db8::1' })), undefined, 'web-1')).toEqual({
      url: 'http://[2001:db8::1]:8091/_runova/health',
      insecure: true,
    });
  });

  it('needs no insecure switch for a server on this computer', () => {
    expect(appHealthUrl(app(binding({ hostIp: undefined })), [], 'localhost')).toEqual({
      url: 'http://localhost:8091/_runova/health',
      insecure: false,
    });
  });

  it('has nothing to call when every port stays on the server', () => {
    expect(appHealthUrl(app(binding()), [], '203.0.113.7')).toBeNull();
    expect(appHealthUrl(app(binding({ hostIp: '0.0.0.0', protocol: 'udp' })), [], 'h')).toBeNull();
    expect(appHealthUrl(app(), [], '203.0.113.7')).toBeNull();
  });
});
