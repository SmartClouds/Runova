import { describe, expect, it } from 'vitest';
import { settings, site } from '@/components/deploy/sites/testing/fixtures';
import { carriesWebsockets, withWebsockets } from './websocket';

/** The quick WebSockets switch on a site's row: which sites have it, and what it saves. */

describe('carriesWebsockets', () => {
  it('is true for a site that passes requests to a port or an address', () => {
    expect(carriesWebsockets(site())).toBe(true);
    expect(
      carriesWebsockets(
        site(
          {},
          {
            upstream: {
              kind: 'url',
              address: 'http://10.0.0.5:8080',
              verifyCertificate: true,
              sendUpstreamHost: false,
            },
          },
        ),
      ),
    ).toBe(true);
  });

  it('is false for a site that only redirects, since nothing reaches an app', () => {
    const moved = site(
      {},
      {
        websocket: false,
        upstream: {
          kind: 'redirect',
          address: 'https://new.example.com',
          permanent: true,
          keepPath: true,
          verifyCertificate: true,
          sendUpstreamHost: false,
        },
      },
    );
    expect(carriesWebsockets(moved)).toBe(false);
  });
});

describe('withWebsockets', () => {
  it('turns WebSockets on and keeps every other setting as saved', () => {
    const saved = site(
      {},
      {
        websocket: false,
        basicAuth: { realm: 'Team', users: [{ name: 'maria' }] },
        rateLimit: { requests: 10, per: 'second', burst: 20, noDelay: true },
        timeouts: { readSeconds: 120 },
        redirectDomains: ['old.example.com'],
      },
    );
    expect(withWebsockets(saved, true)).toEqual({
      ...saved.settings,
      websocket: true,
    });
  });

  it('turns WebSockets off', () => {
    expect(withWebsockets(site(), false)).toEqual({
      ...settings(),
      websocket: false,
    });
  });

  it('leaves the site it was given alone', () => {
    const saved = site();
    withWebsockets(saved, false);
    expect(saved.settings.websocket).toBe(true);
  });

  it('sends no password back for a basic auth user, so the core keeps the one it has', () => {
    const saved = site(
      {},
      {
        basicAuth: {
          realm: 'Team',
          users: [{ name: 'maria', password: null as never }],
        },
      },
    );
    expect(withWebsockets(saved, false).basicAuth?.users).toEqual([{ name: 'maria' }]);
  });
});
