import type {
  CertificateInfo,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { siteNames } from '@shared/deploy/siteNames';
import { describe, expect, it } from 'vitest';
import { siteChips, upstreamLabel } from '@/components/deploy/sites/RouteMap';
import { uncoveredNames } from './certificates';
import { blankDraft, draftFromSite, type SiteDraft } from './draft';
import { tabOf } from './problems';
import { applyRedirectSuggestion, redirectExample, suggestRedirect } from './redirects';
import { settingsFromDraft } from './settings';

/** Redirect sites, names redirected to a site, and the www suggestion. */

const MOVED: SiteInfo = {
  applied: true,
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
  settings: {
    id: 'moved',
    domains: ['old.example.com'],
    upstream: {
      kind: 'redirect',
      address: 'https://runovahq.com',
      permanent: false,
      keepPath: false,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: false,
    gzip: false,
    http2: true,
    redirectToHttps: true,
  },
};

const APEX: SiteInfo = {
  applied: true,
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
  settings: {
    id: 'apex',
    domains: ['runovahq.com'],
    upstream: {
      kind: 'servicePort',
      port: 3000,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: false,
    gzip: false,
    http2: true,
    redirectToHttps: true,
    redirectDomains: ['www.runovahq.com'],
  },
};

function draft(overrides: Partial<SiteDraft> = {}): SiteDraft {
  return {
    ...blankDraft(),
    id: 'apex',
    domains: ['runovahq.com'],
    port: '3000',
    ...overrides,
  };
}

function redirectDraft(overrides: Partial<SiteDraft> = {}): SiteDraft {
  return draft({
    id: 'moved',
    domains: ['old.example.com'],
    upstreamKind: 'redirect',
    redirectTo: 'https://runovahq.com',
    ...overrides,
  });
}

describe('redirect sites', () => {
  it('round-trips through the draft', () => {
    const read = draftFromSite(MOVED);
    expect(read).toMatchObject({
      upstreamKind: 'redirect',
      redirectTo: 'https://runovahq.com',
      redirectPermanent: false,
      redirectKeepPath: false,
    });
    const { settings, errors } = settingsFromDraft(read);
    expect(errors).toEqual({});
    expect(settings).toEqual(MOVED.settings);
  });

  it('reads a redirect saved without its options as permanent and keeping the path', () => {
    const { permanent: _p, keepPath: _k, ...upstream } = MOVED.settings.upstream;
    const read = draftFromSite({
      ...MOVED,
      settings: { ...MOVED.settings, upstream },
    });
    expect(read).toMatchObject({
      redirectPermanent: true,
      redirectKeepPath: true,
    });
  });

  it('leaves out what only a proxy uses', () => {
    const { settings } = settingsFromDraft(
      redirectDraft({
        websocket: true,
        cache: true,
        redirectDomains: ['www.old.example.com'],
      }),
    );
    expect(settings.websocket).toBe(false);
    expect(settings).not.toHaveProperty('proxyCache');
    expect(settings).not.toHaveProperty('redirectDomains');
    expect(settings.upstream).toEqual({
      kind: 'redirect',
      address: 'https://runovahq.com',
      permanent: true,
      keepPath: true,
      verifyCertificate: true,
      sendUpstreamHost: false,
    });
  });

  it.each([
    ['', /Enter the address/],
    ['runovahq.com', /https:\/\//],
    ['ftp://runovahq.com', /https:\/\//],
    ['https://runovahq.com/a b', /spaces/],
    ['https://runovahq.com/$x', /\$/],
    ['https://user:pw@runovahq.com', /user name/],
    ['https://runovahq.com/#top', /#/],
    ['https://old.example.com/new', /loop/],
    ['https://OLD.example.com', /loop/],
  ])('refuses %s as a destination', (to, message) => {
    expect(settingsFromDraft(redirectDraft({ redirectTo: to })).errors.upstream).toMatch(message);
  });

  it('allows a query only when the visitor’s path is not added', () => {
    const to = 'https://runovahq.com/landing?from=old';
    expect(settingsFromDraft(redirectDraft({ redirectTo: to })).errors.upstream).toMatch(/query/);
    expect(
      settingsFromDraft(redirectDraft({ redirectTo: to, redirectKeepPath: false })).errors,
    ).toEqual({});
  });

  it('accepts addresses with a port, a path or an IP address', () => {
    for (const to of [
      'http://10.0.0.5:8080/app/',
      'https://[2001:db8::1]/',
      'https://runovahq.com/blog/',
    ]) {
      expect(settingsFromDraft(redirectDraft({ redirectTo: ` ${to} ` })).errors).toEqual({});
    }
    expect(
      settingsFromDraft(redirectDraft({ redirectTo: ' https://runovahq.com ' })).settings.upstream
        .address,
    ).toBe('https://runovahq.com');
  });

  it('shows where an example request ends up', () => {
    expect(redirectExample('www.runovahq.com', 'https://runovahq.com', true)).toEqual({
      from: 'www.runovahq.com/pricing?plan=pro',
      to: 'https://runovahq.com/pricing?plan=pro',
    });
    expect(redirectExample('old.example.com', 'https://runovahq.com/blog/', true).to).toBe(
      'https://runovahq.com/blog/pricing?plan=pro',
    );
    expect(redirectExample('old.example.com', 'https://runovahq.com/landing', false).to).toBe(
      'https://runovahq.com/landing',
    );
    expect(redirectExample('', '', true)).toEqual({
      from: 'example.com/pricing?plan=pro',
      to: 'https://…/pricing?plan=pro',
    });
  });
});

describe('names redirected to a site', () => {
  it('round-trip through the draft and drop empty rows', () => {
    const read = draftFromSite(APEX);
    expect(read.redirectDomains).toEqual(['www.runovahq.com']);
    expect(settingsFromDraft(read).settings).toEqual(APEX.settings);
    expect(settingsFromDraft({ ...read, redirectDomains: [' ', ''] }).settings).not.toHaveProperty(
      'redirectDomains',
    );
    expect(draftFromSite(MOVED).redirectDomains).toEqual([]);
  });

  it('are checked like domains, and only one site may hold a name', () => {
    const { errors, settings } = settingsFromDraft(
      draft({
        domains: ['runovahq.com', 'shop.runovahq.com'],
        redirectDomains: [
          'WWW.runovahq.com',
          'not a domain',
          'shop.runovahq.com',
          'www.runovahq.com',
        ],
      }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      'redirectDomains[1]',
      'redirectDomains[2]',
      'redirectDomains[3]',
    ]);
    expect(errors['redirectDomains[2]']).toMatch(/already one of this site/);
    expect(settings.redirectDomains?.[0]).toBe('www.runovahq.com');
  });

  it('need a plain first domain to send visitors to', () => {
    expect(
      settingsFromDraft(
        draft({
          domains: ['*.runovahq.com'],
          redirectDomains: ['runovahq.com'],
        }),
      ).errors.redirectDomains,
    ).toMatch(/wildcard/);
  });

  it('belong on the Domains tab', () => {
    expect(tabOf('redirectDomains[0]')).toBe('domains');
    expect(tabOf('redirectDomains')).toBe('domains');
  });

  it('count among the names a certificate has to cover', () => {
    expect(siteNames(APEX.settings)).toEqual(['runovahq.com', 'www.runovahq.com']);
    expect(siteNames(MOVED.settings)).toEqual(['old.example.com']);
    const certificate = { domains: ['runovahq.com'] } as CertificateInfo;
    expect(uncoveredNames({ ...APEX, certificate })).toEqual(['www.runovahq.com']);
    expect(
      uncoveredNames({
        ...APEX,
        certificate: {
          ...certificate,
          domains: ['*.runovahq.com', 'runovahq.com'],
        },
      }),
    ).toEqual([]);
    expect(uncoveredNames(APEX)).toEqual([]);
  });
});

describe('the www suggestion', () => {
  it.each([
    [['runovahq.com'], [], { name: 'www.runovahq.com', move: false }],
    [['www.runovahq.com'], [], { name: 'runovahq.com', move: false }],
    [['runovahq.co.uk'], [], { name: 'www.runovahq.co.uk', move: false }],
    [['Runovahq.com '], [], { name: 'www.runovahq.com', move: false }],
    [['runovahq.com', 'www.runovahq.com'], [], { name: 'www.runovahq.com', move: true }],
    [['runovahq.com'], ['www.runovahq.com'], null],
    [['app.runovahq.com'], [], null],
    [['*.runovahq.com'], [], null],
    [[''], [], null],
  ])('for %j with %j redirected is %j', (domains, redirected, expected) => {
    expect(suggestRedirect(domains, redirected)).toEqual(expected);
  });

  it('adds the name, or moves it from the served domains', () => {
    expect(
      applyRedirectSuggestion(draft({ redirectDomains: [''] }), {
        name: 'www.runovahq.com',
        move: false,
      }),
    ).toMatchObject({
      domains: ['runovahq.com'],
      redirectDomains: ['www.runovahq.com'],
    });
    expect(
      applyRedirectSuggestion(
        draft({
          domains: ['runovahq.com', 'www.runovahq.com'],
          redirectDomains: ['old.runovahq.com'],
        }),
        { name: 'www.runovahq.com', move: true },
      ),
    ).toMatchObject({
      domains: ['runovahq.com'],
      redirectDomains: ['old.runovahq.com', 'www.runovahq.com'],
    });
  });
});

describe('the route map', () => {
  it('shows where a redirect sends visitors and the names redirected to a site', () => {
    expect(upstreamLabel(MOVED)).toBe('https://runovahq.com');
    expect(siteChips(MOVED)).toEqual(['redirect 302']);
    expect(
      siteChips({
        ...MOVED,
        settings: {
          ...MOVED.settings,
          upstream: { ...MOVED.settings.upstream, permanent: undefined },
        },
      }),
    ).toEqual(['redirect 301']);
    expect(siteChips(APEX)).toEqual(['https only', '1 redirected']);
  });
});
