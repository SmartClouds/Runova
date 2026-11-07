/**
 * The tracking tags and site verifications an Admin sets in the admin panel (E59): Google
 * Analytics, Google Ads, Google Tag Manager, Microsoft Clarity and the Microsoft Advertising (Bing)
 * UET tag. The public pages are prerendered, so they can not carry the IDs: each page reads them
 * from `/nav/analytics.json` (src/pages/nav/analytics.json.ts) and the client script
 * (src/components/analytics/tracking.ts) loads the tags. The verification files are rendered per
 * request by src/pages/[verification].html.ts and src/pages/BingSiteAuth.xml.ts.
 */

import { type ApiResult, apiGetter } from './websiteApi';

/** Where the browser reads the tags. */
export const ANALYTICS_URL = '/nav/analytics.json';

/** The shapes the API takes, checked again here: every one of them ends up in a script URL. */
export const ID_SHAPES = {
  googleAnalytics: /^G-[A-Z0-9]{4,20}$/,
  googleAds: /^AW-[0-9]{6,15}$/,
  googleTagManager: /^GTM-[A-Z0-9]{4,12}$/,
  clarity: /^[a-z0-9]{6,20}$/,
  bingUet: /^[0-9]{4,12}$/,
  googleVerification: /^google[a-z0-9]{8,54}$/,
  bingVerification: /^[A-Za-z0-9]{16,64}$/,
} as const;

/** The tags a public page loads, and whether it asks the visitor first. */
export interface TrackingTags {
  googleAnalyticsIds: string[];
  googleAdsIds: string[];
  googleTagManagerId: string | null;
  clarityProjectId: string | null;
  bingUetTagId: string | null;
  consentRequired: boolean;
}

/** `GET /api/v1/site-analytics`: the tags, and the verifications that are served either way. */
export interface SiteAnalytics extends TrackingTags {
  googleSiteVerification: string | null;
  bingSiteVerification: string | null;
}

export const NO_TAGS: TrackingTags = {
  googleAnalyticsIds: [],
  googleAdsIds: [],
  googleTagManagerId: null,
  clarityProjectId: null,
  bingUetTagId: null,
  consentRequired: false,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A list of IDs of one shape, or undefined when it is not one. */
function ids(value: unknown, shape: RegExp): string[] | undefined {
  if (!Array.isArray(value) || value.length > 5) return undefined;
  return value.every((id) => typeof id === 'string' && shape.test(id)) ? value : undefined;
}

/** An ID of one shape or null, or undefined when it is neither. */
function id(value: unknown, shape: RegExp): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && shape.test(value) ? value : undefined;
}

/** The tags, when every one of them has its shape; anything odd and the page loads nothing. */
export function parseTrackingTags(value: unknown): TrackingTags | null {
  if (!isObject(value)) return null;
  const tags = {
    googleAnalyticsIds: ids(value.googleAnalyticsIds, ID_SHAPES.googleAnalytics),
    googleAdsIds: ids(value.googleAdsIds, ID_SHAPES.googleAds),
    googleTagManagerId: id(value.googleTagManagerId, ID_SHAPES.googleTagManager),
    clarityProjectId: id(value.clarityProjectId, ID_SHAPES.clarity),
    bingUetTagId: id(value.bingUetTagId, ID_SHAPES.bingUet),
    consentRequired: typeof value.consentRequired === 'boolean' ? value.consentRequired : undefined,
  };
  return Object.values(tags).some((each) => each === undefined) ? null : (tags as TrackingTags);
}

export function parseSiteAnalytics(value: unknown): SiteAnalytics | null {
  const tags = parseTrackingTags(value);
  if (!tags || !isObject(value)) return null;
  const google = id(value.googleSiteVerification, ID_SHAPES.googleVerification);
  const bing = id(value.bingSiteVerification, ID_SHAPES.bingVerification);
  if (google === undefined || bing === undefined) return null;
  return { ...tags, googleSiteVerification: google, bingSiteVerification: bing };
}

/** Whether there is anything to load. */
export const hasTags = (tags: TrackingTags) =>
  tags.googleAnalyticsIds.length > 0 ||
  tags.googleAdsIds.length > 0 ||
  tags.googleTagManagerId !== null ||
  tags.clarityProjectId !== null ||
  tags.bingUetTagId !== null;

/** `GET /api/v1/site-analytics` on the API at `baseUrl`. */
export function readSiteAnalytics(baseUrl: string | undefined): Promise<ApiResult<SiteAnalytics>> {
  return apiGetter(baseUrl)('/api/v1/site-analytics', parseSiteAnalytics);
}

/** The tags alone, as `/nav/analytics.json` sends them. */
export const tagsOf = ({
  googleAnalyticsIds,
  googleAdsIds,
  googleTagManagerId,
  clarityProjectId,
  bingUetTagId,
  consentRequired,
}: TrackingTags): TrackingTags => ({
  googleAnalyticsIds,
  googleAdsIds,
  googleTagManagerId,
  clarityProjectId,
  bingUetTagId,
  consentRequired,
});

/**
 * What the CSP of a public page adds so the tags can load and report, from each vendor's own CSP
 * guide. Only BaseLayout adds it: the admin pages and the account panel never load a tag, so they
 * keep the stricter policy. Tag Manager's Custom HTML tags and Custom JavaScript variables need
 * 'unsafe-inline' and 'unsafe-eval', which the site never allows, so only its built-in tags work.
 */
export const TRACKING_CSP = {
  scriptSrc: [
    // Google Analytics, Google Ads and Tag Manager.
    'https://*.googletagmanager.com',
    'https://www.googleadservices.com',
    'https://googleads.g.doubleclick.net',
    'https://www.google.com',
    // Microsoft Clarity and the UET tag.
    'https://*.clarity.ms',
    'https://c.bing.com',
    'https://bat.bing.com',
  ],
  directives: [
    'img-src https://*.google-analytics.com https://*.googletagmanager.com https://*.g.doubleclick.net https://www.google.com https://pagead2.googlesyndication.com https://www.googleadservices.com https://*.clarity.ms https://c.bing.com https://bat.bing.com https://bat.bing.net',
    'connect-src https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.g.doubleclick.net https://www.google.com https://google.com https://pagead2.googlesyndication.com https://www.googleadservices.com https://*.clarity.ms https://c.bing.com https://bat.bing.com https://bat.bing.net',
    'frame-src https://td.doubleclick.net https://www.googletagmanager.com',
  ],
} as const;
