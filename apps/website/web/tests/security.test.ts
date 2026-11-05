import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import config from '../astro.config.mjs';
import {
  contentSecurityPolicy,
  isDevServer,
  SECURITY_HEADERS,
  withSecurityHeaders,
} from '../src/lib/security';

const site = 'https://runovahq.com';

function header(name: string): string | undefined {
  return SECURITY_HEADERS.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

describe('SECURITY_HEADERS', () => {
  it('asks browsers to use HTTPS for two years, subdomains too', () => {
    const hsts = header('Strict-Transport-Security') ?? '';
    expect(Number(/max-age=(\d+)/.exec(hsts)?.[1])).toBeGreaterThanOrEqual(31_536_000);
    expect(hsts).toContain('includeSubDomains');
  });

  it('keeps paths out of the Referer to other sites, and stops type sniffing', () => {
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('turns off the device features the site never uses', () => {
    const policy = header('Permissions-Policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(policy).toContain(`${feature}=()`);
    }
  });
});

describe('contentSecurityPolicy', () => {
  const csp = contentSecurityPolicy({ site, sentryDsn: '' });
  const directive = (name: string, policy = csp) =>
    policy.directives.find((entry) => entry.startsWith(`${name} `));

  it('loads everything from the site itself by default and never from plugins', () => {
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('allows images from the site origin, where post and news covers live', () => {
    expect(directive('img-src')).toBe(`img-src 'self' data: ${site}`);
  });

  it('allows the small font files Vite inlines as data URLs', () => {
    expect(directive('font-src')).toBe("font-src 'self' data:");
  });

  it("allows Pagefind's WebAssembly and the Turnstile script, but no other eval", () => {
    expect(csp.scriptDirective.resources).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
      'https://challenges.cloudflare.com',
    ]);
  });

  it('frames only the Turnstile captcha, which renders in an iframe', () => {
    expect(directive('frame-src')).toBe("frame-src 'self' https://challenges.cloudflare.com");
  });

  it('lets inline style attributes through, which React and Radix render', () => {
    expect(csp.styleDirective.resources).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('only connects to the Sentry ingest origin when a DSN is set', () => {
    expect(directive('connect-src')).toBe("connect-src 'self'");
    const withSentry = contentSecurityPolicy({
      site,
      sentryDsn: 'https://abc123@o42.ingest.sentry.io/7',
    });
    expect(directive('connect-src', withSentry)).toBe(
      "connect-src 'self' https://o42.ingest.sentry.io",
    );
  });
});

describe('isDevServer', () => {
  it('is true for `astro dev`, whose CSP would leave out the island scripts', () => {
    expect(isDevServer(['node', 'astro', 'dev'])).toBe(true);
    expect(isDevServer(['node', 'astro', 'dev', '--port', '4391'])).toBe(true);
  });

  it('is false for a build, a preview and the tests', () => {
    expect(isDevServer(['node', 'astro', 'build'])).toBe(false);
    expect(isDevServer(['node', 'astro', 'preview'])).toBe(false);
    expect(isDevServer(['node', 'vitest', 'run'])).toBe(false);
  });
});

describe('astro.config.mjs', () => {
  it('turns on the CSP and has the adapter send it as a header on every page', () => {
    const csp = config.security?.csp;
    expect(csp).toMatchObject(
      contentSecurityPolicy({
        site: config.site ?? site,
        sentryDsn: process.env.PUBLIC_SENTRY_DSN || '',
      }),
    );
  });
});

describe('withSecurityHeaders', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.close();
    if (server) await once(server, 'close');
    server = undefined;
  });

  async function serve(listener: Parameters<typeof withSecurityHeaders>[0]): Promise<string> {
    server = createServer(withSecurityHeaders(listener));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('adds every header to what the handler answers, whatever the status', async () => {
    const url = await serve((request, reply) => {
      reply.writeHead(request.url === '/missing' ? 404 : 200, { 'content-type': 'text/plain' });
      reply.end('ok');
    });
    for (const path of ['/', '/missing', '/_astro/app.js']) {
      const response = await fetch(`${url}${path}`);
      for (const [name, value] of SECURITY_HEADERS) {
        expect(response.headers.get(name), `${path} ${name}`).toBe(value);
      }
      expect(response.headers.get('content-type')).toBe('text/plain');
    }
  });

  it('lets the handler set a header of its own over a default', async () => {
    const url = await serve((_request, reply) => {
      reply.setHeader('Referrer-Policy', 'no-referrer');
      reply.end();
    });
    expect((await fetch(url)).headers.get('referrer-policy')).toBe('no-referrer');
  });
});
