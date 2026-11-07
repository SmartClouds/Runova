import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIContext } from 'astro';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  hasTags,
  NO_TAGS,
  parseSiteAnalytics,
  parseTrackingTags,
  TRACKING_CSP,
} from '../src/lib/analytics';
import { CACHE } from '../src/lib/news/page';
import { bingVerificationFile, googleVerificationFile } from '../src/lib/siteVerification';
import { GET } from '../src/pages/nav/analytics.json';

const DEAD = 'http://127.0.0.1:9';

const SITE = {
  googleAnalyticsIds: ['G-ABC123XYZ9', 'G-SECOND1234'],
  googleAdsIds: ['AW-123456789'],
  googleTagManagerId: 'GTM-ABC1234',
  clarityProjectId: 'abcd1234ef',
  bingUetTagId: '187654321',
  consentRequired: true,
  googleSiteVerification: 'google1234567890abcdef',
  bingSiteVerification: '0123456789ABCDEF0123456789ABCDEF',
};

describe('parseTrackingTags', () => {
  it('takes every tag of the right shape', () => {
    const { googleSiteVerification: _, bingSiteVerification: __, ...tags } = SITE;
    expect(parseTrackingTags(SITE)).toEqual(tags);
    expect(parseTrackingTags(NO_TAGS)).toEqual(NO_TAGS);
  });

  it.each([
    ['a Universal Analytics ID', { googleAnalyticsIds: ['UA-12345-1'] }],
    ['a script URL as an ID', { googleAnalyticsIds: ['G-ABC123&callback=x'] }],
    ['more than five IDs', { googleAdsIds: Array(6).fill('AW-123456789') }],
    ['a path in the Clarity ID', { clarityProjectId: '../evil' }],
    ['letters in the UET ID', { bingUetTagId: 'abc123' }],
    ['a GA ID where Tag Manager goes', { googleTagManagerId: 'G-ABC123XYZ9' }],
    ['no consent flag', { consentRequired: undefined }],
  ])('refuses the whole answer for %s, so nothing odd reaches a script URL', (_, change) => {
    expect(parseTrackingTags({ ...SITE, ...change })).toBeNull();
  });

  it('refuses a verification of the wrong shape too', () => {
    expect(parseSiteAnalytics(SITE)).toEqual(SITE);
    expect(parseSiteAnalytics({ ...SITE, bingSiteVerification: '<user>x</user>' })).toBeNull();
  });

  it('says whether there is anything to load', () => {
    expect(hasTags(NO_TAGS)).toBe(false);
    expect(hasTags({ ...NO_TAGS, bingUetTagId: '187654321' })).toBe(true);
  });
});

describe('TRACKING_CSP', () => {
  it('allows the scripts of Google and Microsoft tags and no inline code or eval', () => {
    expect(TRACKING_CSP.scriptSrc).toEqual(
      expect.arrayContaining([
        'https://*.googletagmanager.com',
        'https://*.clarity.ms',
        'https://bat.bing.com',
      ]),
    );
    expect(TRACKING_CSP.scriptSrc.join(' ')).not.toMatch(/unsafe/);
  });

  it('adds to img-src, connect-src and frame-src only', () => {
    expect(TRACKING_CSP.directives.map((each) => each.split(' ')[0])).toEqual([
      'img-src',
      'connect-src',
      'frame-src',
    ]);
    expect(TRACKING_CSP.directives.join(' ')).not.toMatch(/'|\*\s|\bhttp:/);
  });
});

describe('against an API', () => {
  const previous = process.env.WEBSITE_API_INTERNAL_URL;
  let api: Server;
  let answer: unknown = SITE;

  beforeAll(async () => {
    api = createServer((request, reply) => {
      if (request.url !== '/api/v1/site-analytics') return void reply.writeHead(404).end();
      reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
  });

  beforeEach(() => {
    answer = SITE;
  });

  afterAll(async () => {
    process.env.WEBSITE_API_INTERNAL_URL = previous;
    await new Promise((resolve) => api.close(resolve));
  });

  const apiUrl = () => `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  describe('GET /nav/analytics.json', () => {
    const call = () => GET({} as APIContext) as Promise<Response>;

    it('passes the tags on without the verifications, cached for a minute and kept out of search', async () => {
      process.env.WEBSITE_API_INTERNAL_URL = apiUrl();
      const response = await call();
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe(CACHE.list);
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      const body = await response.json();
      expect(body.googleAnalyticsIds).toEqual(SITE.googleAnalyticsIds);
      expect(body.consentRequired).toBe(true);
      expect(body).not.toHaveProperty('googleSiteVerification');
    });

    it('answers with no tags and a short cache when the API is down or says something odd', async () => {
      process.env.WEBSITE_API_INTERNAL_URL = DEAD;
      const down = await call();
      expect(down.status).toBe(200);
      expect(down.headers.get('cache-control')).toBe('public, max-age=15');
      expect(await down.json()).toEqual(NO_TAGS);

      process.env.WEBSITE_API_INTERNAL_URL = apiUrl();
      answer = { ...SITE, clarityProjectId: 'https://evil.example/x' };
      expect(await (await call()).json()).toEqual(NO_TAGS);
    });
  });

  describe('the verification files', () => {
    it("serve Search Console's file with exactly the line Google looks for", async () => {
      const response = await googleVerificationFile('google1234567890abcdef', apiUrl());
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe('google-site-verification: google1234567890abcdef.html');
    });

    it('answer 404 for any other name, a name of the wrong shape, or no answer from the API', async () => {
      expect((await googleVerificationFile('googleffffffffffffffff', apiUrl())).status).toBe(404);
      expect((await googleVerificationFile('index', apiUrl())).status).toBe(404);
      expect((await googleVerificationFile('google1234567890abcdef', DEAD)).status).toBe(404);
      answer = { ...SITE, googleSiteVerification: null };
      expect((await googleVerificationFile('google1234567890abcdef', apiUrl())).status).toBe(404);
    });

    it('serve BingSiteAuth.xml with the saved code, or 404 when there is none', async () => {
      const response = await bingVerificationFile(apiUrl());
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/xml');
      expect(await response.text()).toBe(
        '<?xml version="1.0"?>\n<users>\n\t<user>0123456789ABCDEF0123456789ABCDEF</user>\n</users>\n',
      );

      answer = { ...SITE, bingSiteVerification: null };
      expect((await bingVerificationFile(apiUrl())).status).toBe(404);
      expect((await bingVerificationFile(DEAD)).status).toBe(404);
    });
  });
});
