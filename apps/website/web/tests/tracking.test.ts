// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_KEY,
  clearTrackingCookies,
  loadTags,
  startTracking,
} from '../src/components/analytics/tracking';
import { NO_TAGS, type TrackingTags } from '../src/lib/analytics';

type TestWindow = Window & {
  dataLayer?: unknown[];
  gtag?: unknown;
  clarity?: { q?: unknown[] };
  uetq?: unknown;
  UET?: unknown;
};

const ALL: TrackingTags = {
  googleAnalyticsIds: ['G-ABC123XYZ9', 'G-SECOND1234'],
  googleAdsIds: ['AW-123456789'],
  googleTagManagerId: 'GTM-ABC1234',
  clarityProjectId: 'abcd1234ef',
  bingUetTagId: '187654321',
  consentRequired: false,
};

const scripts = () => [...document.head.querySelectorAll('script')].map((s) => s.src);

/** The calls in a queue of arguments objects, as plain arrays. */
const calls = (queue: unknown[] | undefined) =>
  (queue ?? []).map((entry) =>
    Object.prototype.toString.call(entry) === '[object Arguments]'
      ? Array.from(entry as ArrayLike<unknown>)
      : entry,
  );

const answering = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

/** The banner and the footer button, as Tracking.astro and Footer.astro render them. */
function renderBanner() {
  document.body.innerHTML = `
    <button type="button" data-consent-open hidden>Cookie settings</button>
    <div data-consent-banner hidden>
      <button type="button" data-consent-choice="granted">Allow</button>
      <button type="button" data-consent-choice="denied">Decline</button>
    </div>`;
  const get = (selector: string) => document.querySelector<HTMLElement>(selector) as HTMLElement;
  return {
    banner: get('[data-consent-banner]'),
    opener: get('[data-consent-open]'),
    allow: get('[data-consent-choice="granted"]'),
    decline: get('[data-consent-choice="denied"]'),
  };
}

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  localStorage.clear();
  const win = window as TestWindow;
  for (const key of ['dataLayer', 'gtag', 'clarity', 'uetq', 'UET'] as const) delete win[key];
});

describe('loadTags', () => {
  it("does what each vendor's snippet does, with async scripts and no inline code", () => {
    loadTags(ALL, false);

    expect(scripts()).toEqual([
      'https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9',
      'https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234',
      'https://www.clarity.ms/tag/abcd1234ef',
      'https://bat.bing.com/bat.js',
    ]);
    expect([...document.head.querySelectorAll('script')].every((s) => s.async)).toBe(true);
    const layer = calls((window as TestWindow).dataLayer);
    expect((layer[0] as unknown[])[0]).toBe('js');
    expect(layer.slice(1, 4)).toEqual([
      ['config', 'G-ABC123XYZ9'],
      ['config', 'G-SECOND1234'],
      ['config', 'AW-123456789'],
    ]);
    expect(layer[4]).toMatchObject({ event: 'gtm.js' });
    // Without the banner, no consent command: the tags keep their own defaults.
    expect(layer.some((entry) => Array.isArray(entry) && entry[0] === 'consent')).toBe(false);
  });

  it('starts the UET tag once bat.js has loaded, with the queue it had', () => {
    const made: Record<string, unknown>[] = [];
    (window as TestWindow).UET = class {
      constructor(options: Record<string, unknown>) {
        made.push(options);
      }
      push = vi.fn();
    };
    loadTags({ ...NO_TAGS, bingUetTagId: '187654321' }, true);

    document.head.querySelector('script')?.dispatchEvent(new Event('load'));

    expect(made).toEqual([
      {
        ti: '187654321',
        enableAutoSpaTracking: true,
        q: ['consent', 'default', { ad_storage: 'granted' }],
      },
    ]);
    expect(
      (window as unknown as { uetq: { push: ReturnType<typeof vi.fn> } }).uetq.push,
    ).toHaveBeenCalledWith('pageLoad');
  });

  it('tells Google and Clarity the visitor allowed them, before any tag runs', () => {
    loadTags({ ...ALL, bingUetTagId: null }, true);

    expect(calls((window as TestWindow).dataLayer)[0]).toEqual([
      'consent',
      'default',
      {
        ad_storage: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'granted',
        analytics_storage: 'granted',
      },
    ]);
    expect(calls((window as TestWindow).clarity?.q)).toEqual([
      ['consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }],
    ]);
  });
});

describe('startTracking', () => {
  it('loads the tags at once when no consent is asked for', async () => {
    const fetchFn = answering(ALL);

    expect(await startTracking(fetchFn)).toBe('loaded');
    expect(fetchFn).toHaveBeenCalledWith('/nav/analytics.json', expect.anything());
    expect(scripts()).toHaveLength(4);
  });

  it.each([
    ['no tags', answering(NO_TAGS)],
    ['an error status', answering(ALL, 503)],
    ['an ID of the wrong shape', answering({ ...ALL, googleTagManagerId: 'G-1234' })],
    [
      'no answer',
      vi.fn(async () => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch,
    ],
  ])('loads nothing on %s', async (_, fetchFn) => {
    const { banner } = renderBanner();
    expect(await startTracking(fetchFn)).toBeNull();
    expect(scripts()).toHaveLength(0);
    expect(banner.hidden).toBe(true);
  });

  it('asks first with the banner on, and loads the tags only once the visitor allows them', async () => {
    const { banner, opener, allow } = renderBanner();

    expect(await startTracking(answering({ ...ALL, consentRequired: true }))).toBe('asked');
    expect(banner.hidden).toBe(false);
    expect(opener.hidden).toBe(false);
    expect(scripts()).toHaveLength(0);

    allow.click();

    expect(banner.hidden).toBe(true);
    expect(localStorage.getItem(CONSENT_KEY)).toBe('granted');
    expect(scripts()).toHaveLength(4);
    allow.click();
    expect(scripts()).toHaveLength(4);
  });

  it('remembers a yes on the next page and loads without asking', async () => {
    localStorage.setItem(CONSENT_KEY, 'granted');
    const { banner } = renderBanner();

    expect(await startTracking(answering({ ...ALL, consentRequired: true }))).toBe('loaded');
    expect(banner.hidden).toBe(true);
    expect(scripts()).toHaveLength(4);
  });

  it('loads nothing after a no, and Cookie settings opens the banner again', async () => {
    localStorage.setItem(CONSENT_KEY, 'denied');
    const { banner, opener, allow } = renderBanner();

    expect(await startTracking(answering({ ...ALL, consentRequired: true }))).toBe('declined');
    expect(banner.hidden).toBe(true);
    expect(scripts()).toHaveLength(0);

    opener.click();
    expect(banner.hidden).toBe(false);
    allow.click();
    expect(scripts()).toHaveLength(4);
  });

  it('starts the page again when a visitor takes back a yes, since a tag that ran can not be unloaded', async () => {
    localStorage.setItem(CONSENT_KEY, 'granted');
    const { opener, decline } = renderBanner();
    const reload = vi.fn();
    const win = new Proxy(window, {
      get: (target, key) => (key === 'location' ? { reload } : Reflect.get(target, key, target)),
    });

    await startTracking(answering({ ...ALL, consentRequired: true }), win);
    opener.click();
    decline.click();

    expect(localStorage.getItem(CONSENT_KEY)).toBe('denied');
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('clearTrackingCookies', () => {
  it("takes away the tags' cookies and leaves the site's own", () => {
    document.cookie = '_ga=GA1.1.1; path=/';
    document.cookie = '_ga_ABC123XYZ9=GS1; path=/';
    document.cookie = '_clck=1; path=/';
    document.cookie = 'XSRF-TOKEN=keep; path=/';

    clearTrackingCookies(document, 'localhost');

    expect(document.cookie).toBe('XSRF-TOKEN=keep');
  });
});
