import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DeploySites } from '../deploy/sites/deploySites';
import { registerDeploySitesHandlers } from './deploySites';

/**
 * The Websites channels answer only the main window, check every argument before the core hears
 * of it, pass on known fields only, and tie each site log to the window that opened it.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const SUBSCRIPTION = '5b0e0f3c-8d6e-4c55-9d0e-3f7a1c2b9e10';
const UPSTREAM = {
  kind: 'servicePort',
  service: 'web',
  port: 3000,
  verifyCertificate: true,
  sendUpstreamHost: false,
};
const SITE = {
  id: 'blog',
  domains: ['blog.example.com'],
  upstream: UPSTREAM,
  websocket: true,
  gzip: true,
  http2: true,
  redirectToHttps: false,
};

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const sites = Object.fromEntries(
    [
      'status',
      'sites',
      'streams',
      'certificates',
      'install',
      'saveSite',
      'deleteSite',
      'saveStream',
      'deleteStream',
      'apply',
      'setSnippets',
      'issue',
      'renew',
      'upload',
      'removeCertificate',
    ].map((name) => [name, vi.fn(async () => ({}))]),
  ) as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const logs = { watch: vi.fn(() => 'sub-l'), unwatch: vi.fn(() => true) };
  const owner = { id: 7, send: vi.fn() };
  registerDeploySitesHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    sites: sites as unknown as DeploySites,
    logs,
    guard: () => trusted,
    owner: () => owner,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(handler({} as IpcMainInvokeEvent, ...args));
  };
  return { call, sites, logs, owner, handlers };
}

describe('deploySites channels', () => {
  it('registers every channel of both groups', () => {
    const { handlers } = harness();
    const expected = [
      ...Object.values(IPC.deploySites).filter((channel) => !channel.endsWith(':onLog')),
      ...Object.values(IPC.deployCerts),
    ];
    expect([...handlers.keys()].sort()).toEqual(expected.sort());
  });

  it('turns away every window but the main one', async () => {
    const { call, sites } = harness(false);
    await expect(call(IPC.deploySites.status, 'srv-1')).rejects.toThrow(/main window/);
    expect(sites.status).not.toHaveBeenCalled();
  });

  it('passes reads, installs and applies through for a saved server', async () => {
    const { call, sites } = harness();
    await call(IPC.deploySites.status, 'srv-1');
    await call(IPC.deploySites.list, 'srv-1');
    await call(IPC.deploySites.listStreams, 'srv-1');
    await call(IPC.deploySites.install, 'srv-1');
    await call(IPC.deploySites.apply, 'srv-1');
    await call(IPC.deployCerts.list, 'srv-1');
    await call(IPC.deploySites.remove, 'srv-1', 'blog');
    await call(IPC.deploySites.removeStream, 'srv-1', 'pg');
    await call(IPC.deployCerts.renew, 'srv-1', 'blog');
    for (const name of ['status', 'sites', 'streams', 'install', 'apply', 'certificates']) {
      expect(sites[name]).toHaveBeenCalledWith('srv-1');
    }
    expect(sites.deleteSite).toHaveBeenCalledWith('srv-1', 'blog');
    expect(sites.deleteStream).toHaveBeenCalledWith('srv-1', 'pg');
    expect(sites.renew).toHaveBeenCalledWith('srv-1', 'blog');
    await expect(call(IPC.deploySites.status, '../etc')).rejects.toThrow(/saved server/);
    await expect(call(IPC.deploySites.remove, 'srv-1', 'Blog!')).rejects.toThrow(/not a site/);
  });
});

describe('site settings', () => {
  it('keeps the known fields of a full site and drops the rest', async () => {
    const { call, sites } = harness();
    const full = {
      ...SITE,
      extra: 'dropped',
      upstream: { ...UPSTREAM, extra: true },
      proxyCache: { ttlSeconds: 60, maxSizeMegabytes: 100, bypassCookies: ['session'] },
      hsts: { maxAgeSeconds: 31_536_000, includeSubdomains: true, preload: false },
      securityHeaders: {
        noSniff: true,
        frameOptions: 'sameOrigin',
        referrerPolicy: 'strictOrigin',
      },
      responseHeaders: [{ name: 'X-Robots-Tag', value: 'noindex' }],
      ipRules: { allow: ['10.0.0.0/8'], deny: [] },
      basicAuth: { realm: 'Staff', users: [{ name: 'ana', password: 'secret' }, { name: 'bo' }] },
      rateLimit: { requests: 10, per: 'second', burst: 20, noDelay: true },
      clientMaxBodySizeMegabytes: 50,
      timeouts: { connectSeconds: 5, readSeconds: 60, sendSeconds: null },
    };
    await call(IPC.deploySites.save, 'srv-1', full);
    const [, saved] = sites.saveSite.mock.calls[0];
    expect(saved).not.toHaveProperty('extra');
    expect(saved.upstream).not.toHaveProperty('extra');
    expect(saved.basicAuth.users[1]).toEqual({ name: 'bo' });
    expect(saved.timeouts).toEqual({ connectSeconds: 5, readSeconds: 60 });
    expect(saved.proxyCache.bypassCookies).toEqual(['session']);
  });

  it('keeps a redirect and the names redirected to a site', async () => {
    const { call, sites } = harness();
    await call(IPC.deploySites.save, 'srv-1', {
      ...SITE,
      upstream: {
        kind: 'redirect',
        address: 'https://runovahq.com',
        permanent: false,
        keepPath: true,
        verifyCertificate: true,
        sendUpstreamHost: false,
      },
      redirectDomains: ['www.example.com'],
    });
    const [, saved] = sites.saveSite.mock.calls[0];
    expect(saved.upstream).toMatchObject({
      kind: 'redirect',
      permanent: false,
      keepPath: true,
    });
    expect(saved.redirectDomains).toEqual(['www.example.com']);
  });

  it.each([
    ['no object', null, /Expected site settings/],
    [
      'too many redirected names',
      { ...SITE, redirectDomains: Array(51).fill('a.example') },
      /at most 50 redirected names/,
    ],
    [
      'a redirect flag that is not one',
      {
        ...SITE,
        upstream: { ...UPSTREAM, kind: 'redirect', permanent: 'yes' },
      },
      /yes or no for a permanent redirect/,
    ],
    ['too many domains', { ...SITE, domains: Array(51).fill('a.example') }, /at most 50 domains/],
    ['a domain that is not text', { ...SITE, domains: [7] }, /domain must be text/],
    [
      'a bad upstream kind',
      { ...SITE, upstream: { ...UPSTREAM, kind: 'socket' } },
      /upstream kind/,
    ],
    [
      'a port as text',
      { ...SITE, upstream: { ...UPSTREAM, port: '80' } },
      /whole number from 1 to 65535/,
    ],
    [
      'a port out of range',
      { ...SITE, upstream: { ...UPSTREAM, port: 70_000 } },
      /Ports go from 1/,
    ],
    ['a missing flag', { ...SITE, gzip: 'yes' }, /yes or no for compression/],
    [
      'a bad frame option',
      { ...SITE, securityHeaders: { noSniff: true, frameOptions: 'allow', referrerPolicy: 'off' } },
      /frame option/,
    ],
    [
      'too many headers',
      { ...SITE, responseHeaders: Array(51).fill({ name: 'a', value: 'b' }) },
      /50 headers/,
    ],
    [
      'too many users',
      { ...SITE, basicAuth: { realm: '', users: Array(51).fill({ name: 'a' }) } },
      /50 users/,
    ],
    [
      'a list that is not one',
      { ...SITE, ipRules: { allow: 'all', deny: [] } },
      /at most 200 addresses/,
    ],
    [
      'a negative size',
      { ...SITE, clientMaxBodySizeMegabytes: -1 },
      /body size must be a whole number/,
    ],
    [
      'a bad rate period',
      { ...SITE, rateLimit: { requests: 1, per: 'hour', burst: 0, noDelay: false } },
      /rate period/,
    ],
  ])('refuses %s', async (_name, settings, message) => {
    const { call, sites } = harness();
    await expect(call(IPC.deploySites.save, 'srv-1', settings)).rejects.toThrow(message);
    expect(sites.saveSite).not.toHaveBeenCalled();
  });

  it('checks stream proxies and snippets', async () => {
    const { call, sites } = harness();
    await call(IPC.deploySites.saveStream, 'srv-1', {
      id: 'pg',
      protocol: 'tcp',
      listenPort: 5432,
      upstream: { ...UPSTREAM, kind: 'endpoint', address: '127.0.0.1:5433' },
      allowFrom: ['10.0.0.1'],
      connectTimeoutSeconds: 5,
      idleTimeoutSeconds: 600,
    });
    expect(sites.saveStream.mock.calls[0][1]).toMatchObject({ id: 'pg', allowFrom: ['10.0.0.1'] });
    await expect(
      call(IPC.deploySites.saveStream, 'srv-1', {
        id: 'pg',
        protocol: 'sctp',
        listenPort: 1,
        upstream: UPSTREAM,
      }),
    ).rejects.toThrow(/protocol/);

    await call(IPC.deploySites.setSnippets, 'srv-1', {
      siteId: 'blog',
      serverSnippet: '',
      locationSnippet: 'a;',
    });
    expect(sites.setSnippets).toHaveBeenCalledWith('srv-1', {
      siteId: 'blog',
      serverSnippet: '',
      locationSnippet: 'a;',
    });
    await expect(
      call(IPC.deploySites.setSnippets, 'srv-1', {
        siteId: 'blog',
        serverSnippet: 'x'.repeat(70_000),
      }),
    ).rejects.toThrow(/server snippet/);
  });
});

describe('site logs', () => {
  it('ties a log to the window and checks what it asks for', async () => {
    const { call, logs, owner } = harness();
    await expect(
      call(IPC.deploySites.watchLog, {
        serverId: 'srv-1',
        siteId: 'blog',
        kind: 'access',
        tailLines: 50,
      }),
    ).resolves.toBe('sub-l');
    await call(IPC.deploySites.watchLog, { serverId: 'srv-1', siteId: 'blog', kind: 'error' });
    expect(logs.watch).toHaveBeenNthCalledWith(1, owner, {
      serverId: 'srv-1',
      siteId: 'blog',
      kind: 'access',
      tailLines: 50,
    });
    expect(logs.watch).toHaveBeenNthCalledWith(2, owner, {
      serverId: 'srv-1',
      siteId: 'blog',
      kind: 'error',
    });
    await expect(
      call(IPC.deploySites.watchLog, { serverId: 'srv-1', siteId: 'blog', kind: 'debug' }),
    ).rejects.toThrow(/known log/);
    await expect(
      call(IPC.deploySites.watchLog, {
        serverId: 'srv-1',
        siteId: 'blog',
        kind: 'access',
        tailLines: 0,
      }),
    ).rejects.toThrow(/line count/);

    await call(IPC.deploySites.unwatchLog, SUBSCRIPTION);
    expect(logs.unwatch).toHaveBeenCalledWith(owner, SUBSCRIPTION);
    await expect(call(IPC.deploySites.unwatchLog, 'nope')).rejects.toThrow(/subscription/);
  });
});

describe('certificates', () => {
  it('orders with the terms and an optional contact address', async () => {
    const { call, sites } = harness();
    await call(IPC.deployCerts.issue, {
      serverId: 'srv-1',
      siteId: 'blog',
      acceptTermsOfService: true,
      staging: false,
      contactEmail: '',
    });
    await call(IPC.deployCerts.issue, {
      serverId: 'srv-1',
      siteId: 'blog',
      acceptTermsOfService: true,
      staging: true,
      contactEmail: 'ops@example.com',
    });
    expect(sites.issue.mock.calls[0][0]).toEqual({
      serverId: 'srv-1',
      siteId: 'blog',
      acceptTermsOfService: true,
      staging: false,
    });
    expect(sites.issue.mock.calls[1][0]).toMatchObject({
      contactEmail: 'ops@example.com',
      staging: true,
    });
    await expect(
      call(IPC.deployCerts.issue, {
        serverId: 'srv-1',
        siteId: 'blog',
        acceptTermsOfService: true,
        staging: false,
        contactEmail: 'nope',
      }),
    ).rejects.toThrow(/email address/);
    await expect(
      call(IPC.deployCerts.issue, { serverId: 'srv-1', siteId: 'blog', staging: false }),
    ).rejects.toThrow(/terms of service/);
  });

  it('uploads PEM text and removes with a step-up', async () => {
    const { call, sites } = harness();
    await call(IPC.deployCerts.upload, {
      serverId: 'srv-1',
      siteId: 'blog',
      certificatePem: 'c',
      privateKeyPem: 'k',
    });
    expect(sites.upload).toHaveBeenCalledWith({
      serverId: 'srv-1',
      siteId: 'blog',
      certificatePem: 'c',
      privateKeyPem: 'k',
    });
    await expect(
      call(IPC.deployCerts.upload, {
        serverId: 'srv-1',
        siteId: 'blog',
        certificatePem: '',
        privateKeyPem: 'k',
      }),
    ).rejects.toThrow(/certificate must be text/);

    await call(IPC.deployCerts.remove, {
      serverId: 'srv-1',
      siteId: 'blog',
      revoke: true,
      reason: 'superseded',
      password: 'pw',
    });
    expect(sites.removeCertificate).toHaveBeenCalledWith({
      serverId: 'srv-1',
      siteId: 'blog',
      revoke: true,
      reason: 'superseded',
      password: 'pw',
    });
    await expect(
      call(IPC.deployCerts.remove, {
        serverId: 'srv-1',
        siteId: 'blog',
        revoke: true,
        reason: 'boredom',
      }),
    ).rejects.toThrow(/revocation reason/);
  });
});
