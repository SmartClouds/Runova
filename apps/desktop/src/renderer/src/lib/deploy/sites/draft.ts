import type {
  SiteFrameOptions,
  SiteInfo,
  SiteRatePeriod,
  SiteReferrerPolicy,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * A site as its editor holds it: text for every number (so a half-typed value stays as typed),
 * a switch for each optional block, and lists as rows. `settingsFromDraft` turns it back into
 * the core's `SiteSettings`, checking what can be checked here first.
 */

export interface HeaderRow {
  name: string;
  value: string;
}

export interface AuthUserRow {
  name: string;
  /** Empty for a user already saved: the core keeps the password it has. */
  password: string;
  saved: boolean;
}

export interface SiteDraft {
  /** True until the site was saved once; the id can change only then. */
  isNew: boolean;
  id: string;
  domains: string[];
  /** Names that send visitors on to the first domain, as rows. */
  redirectDomains: string[];
  /** A redirect sends every visitor to `redirectTo` instead of passing requests to an app. */
  upstreamKind: 'servicePort' | 'url' | 'redirect';
  service: string;
  port: string;
  url: string;
  redirectTo: string;
  redirectPermanent: boolean;
  redirectKeepPath: boolean;
  verifyCertificate: boolean;
  sendUpstreamHost: boolean;
  websocket: boolean;
  gzip: boolean;
  http2: boolean;
  redirectToHttps: boolean;
  hsts: boolean;
  hstsMaxAge: string;
  hstsSubdomains: boolean;
  hstsPreload: boolean;
  cache: boolean;
  cacheTtl: string;
  cacheSize: string;
  cacheBypass: string;
  bodySize: string;
  connectTimeout: string;
  readTimeout: string;
  sendTimeout: string;
  securityHeaders: boolean;
  noSniff: boolean;
  frameOptions: SiteFrameOptions;
  referrerPolicy: SiteReferrerPolicy;
  headers: HeaderRow[];
  allow: string;
  deny: string;
  basicAuth: boolean;
  realm: string;
  users: AuthUserRow[];
  rateLimit: boolean;
  rateRequests: string;
  ratePer: SiteRatePeriod;
  rateBurst: string;
  rateNoDelay: boolean;
}

export const ONE_YEAR_SECONDS = 31_536_000;

export function blankDraft(): SiteDraft {
  return {
    isNew: true,
    id: '',
    domains: [''],
    redirectDomains: [],
    upstreamKind: 'servicePort',
    service: '',
    port: '',
    url: '',
    redirectTo: '',
    redirectPermanent: true,
    redirectKeepPath: true,
    verifyCertificate: true,
    sendUpstreamHost: false,
    websocket: false,
    gzip: true,
    http2: true,
    redirectToHttps: false,
    hsts: false,
    hstsMaxAge: String(ONE_YEAR_SECONDS),
    hstsSubdomains: false,
    hstsPreload: false,
    cache: false,
    cacheTtl: '600',
    cacheSize: '256',
    cacheBypass: '',
    bodySize: '',
    connectTimeout: '',
    readTimeout: '',
    sendTimeout: '',
    securityHeaders: true,
    noSniff: true,
    frameOptions: 'sameOrigin',
    referrerPolicy: 'strictOriginWhenCrossOrigin',
    headers: [],
    allow: '',
    deny: '',
    basicAuth: false,
    realm: 'Restricted',
    users: [],
    rateLimit: false,
    rateRequests: '10',
    ratePer: 'second',
    rateBurst: '20',
    rateNoDelay: true,
  };
}

const text = (value: number | undefined): string => (value === undefined ? '' : String(value));

export function draftFromSite(site: SiteInfo): SiteDraft {
  const s = site.settings;
  const blank = blankDraft();
  const redirect = s.upstream.kind === 'redirect';
  return {
    ...blank,
    isNew: false,
    id: s.id,
    domains: s.domains.length > 0 ? [...s.domains] : [''],
    redirectDomains: [...(s.redirectDomains ?? [])],
    upstreamKind: redirect ? 'redirect' : s.upstream.kind === 'url' ? 'url' : 'servicePort',
    service: s.upstream.kind === 'url' || redirect ? '' : (s.upstream.service ?? ''),
    port: s.upstream.kind === 'url' || redirect ? '' : text(s.upstream.port),
    url: s.upstream.kind === 'url' ? (s.upstream.address ?? '') : '',
    redirectTo: redirect ? (s.upstream.address ?? '') : '',
    redirectPermanent: redirect ? (s.upstream.permanent ?? true) : true,
    redirectKeepPath: redirect ? (s.upstream.keepPath ?? true) : true,
    verifyCertificate: s.upstream.verifyCertificate,
    sendUpstreamHost: s.upstream.sendUpstreamHost,
    websocket: s.websocket,
    gzip: s.gzip,
    http2: s.http2,
    redirectToHttps: s.redirectToHttps,
    hsts: s.hsts !== undefined,
    hstsMaxAge: s.hsts ? String(s.hsts.maxAgeSeconds) : blank.hstsMaxAge,
    hstsSubdomains: s.hsts?.includeSubdomains ?? false,
    hstsPreload: s.hsts?.preload ?? false,
    cache: s.proxyCache !== undefined,
    cacheTtl: s.proxyCache ? String(s.proxyCache.ttlSeconds) : blank.cacheTtl,
    cacheSize: s.proxyCache ? String(s.proxyCache.maxSizeMegabytes) : blank.cacheSize,
    cacheBypass: (s.proxyCache?.bypassCookies ?? []).join(', '),
    bodySize: text(s.clientMaxBodySizeMegabytes),
    connectTimeout: text(s.timeouts?.connectSeconds),
    readTimeout: text(s.timeouts?.readSeconds),
    sendTimeout: text(s.timeouts?.sendSeconds),
    securityHeaders: s.securityHeaders !== undefined,
    noSniff: s.securityHeaders?.noSniff ?? blank.noSniff,
    frameOptions: s.securityHeaders?.frameOptions ?? blank.frameOptions,
    referrerPolicy: s.securityHeaders?.referrerPolicy ?? blank.referrerPolicy,
    headers: (s.responseHeaders ?? []).map((header) => ({ ...header })),
    allow: (s.ipRules?.allow ?? []).join('\n'),
    deny: (s.ipRules?.deny ?? []).join('\n'),
    basicAuth: s.basicAuth !== undefined,
    realm: s.basicAuth?.realm ?? blank.realm,
    users: (s.basicAuth?.users ?? []).map((user) => ({
      name: user.name,
      password: '',
      saved: true,
    })),
    rateLimit: s.rateLimit !== undefined,
    rateRequests: s.rateLimit ? String(s.rateLimit.requests) : blank.rateRequests,
    ratePer: s.rateLimit?.per ?? blank.ratePer,
    rateBurst: s.rateLimit ? String(s.rateLimit.burst) : blank.rateBurst,
    rateNoDelay: s.rateLimit?.noDelay ?? blank.rateNoDelay,
  };
}

/** A site id from its first domain: `www.shop.example.com` becomes `www-shop-example-com`. */
export function suggestId(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^\*\./, 'wildcard-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}
