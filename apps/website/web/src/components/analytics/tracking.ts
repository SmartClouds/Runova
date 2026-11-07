/**
 * Loads the tracking tags an Admin set (src/lib/analytics.ts) on a public page. It runs as a
 * module script, so it asks `/nav/analytics.json` once the page is parsed and never holds up the
 * first paint, and it does nothing when the answer has no tag or does not come.
 *
 * With the consent banner on, nothing loads until the visitor allows it. The choice is kept in
 * this browser, and the footer's "Cookie settings" button opens the banner again. Each vendor's
 * snippet is rebuilt here with DOM calls, since the CSP blocks inline scripts.
 */

import { ANALYTICS_URL, hasTags, parseTrackingTags, type TrackingTags } from '../../lib/analytics';

export const CONSENT_KEY = 'runova-consent';

export type Choice = 'granted' | 'denied';

/** What happened on this page: tags loaded, the visitor asked, the visitor said no, or nothing to do. */
export type Outcome = 'loaded' | 'asked' | 'declined' | null;

type Queue = ((...args: unknown[]) => void) & { q?: unknown[] };

interface TrackingWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  clarity?: Queue;
  uetq?: unknown[] | { push: (...args: unknown[]) => void };
  UET?: new (options: Record<string, unknown>) => { push: (...args: unknown[]) => void };
}

type Win = Window & TrackingWindow;

/** The visitor's saved choice. Storage can be off or throw (a private window), which counts as none. */
export function readChoice(win: Window = window): Choice | null {
  try {
    const value = win.localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

function saveChoice(choice: Choice, win: Window) {
  try {
    win.localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Not kept: the banner asks again on the next page.
  }
}

function addScript(doc: Document, src: string, onload?: () => void) {
  const script = doc.createElement('script');
  script.async = true;
  script.src = src;
  if (onload) script.addEventListener('load', onload, { once: true });
  doc.head.append(script);
}

/** The data layer and `gtag()` that Google's tags and Tag Manager share. */
function gtagOf(win: Win) {
  win.dataLayer ??= [];
  const dataLayer = win.dataLayer;
  win.gtag ??= function gtag() {
    // biome-ignore lint/complexity/noArguments: gtag.js reads the arguments object itself, not an array.
    dataLayer.push(arguments);
  };
  return win.gtag;
}

const GRANTED = {
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  analytics_storage: 'granted',
};

/** Puts every tag on the page. `consented` says the visitor allowed them through the banner. */
export function loadTags(
  tags: TrackingTags,
  consented: boolean,
  win: Window = window,
  doc: Document = document,
) {
  const target = win as Win;
  const google = [...tags.googleAnalyticsIds, ...tags.googleAdsIds];

  if (google.length > 0 || tags.googleTagManagerId) {
    const gtag = gtagOf(target);
    // Consent Mode: tell Google's tags (and Tag Manager's) the visitor said yes.
    if (consented) gtag('consent', 'default', GRANTED);
    if (google.length > 0) {
      gtag('js', new Date());
      for (const id of google) gtag('config', id);
      addScript(
        doc,
        `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(google[0] as string)}`,
      );
    }
    if (tags.googleTagManagerId) {
      target.dataLayer?.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
      addScript(
        doc,
        `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(tags.googleTagManagerId)}`,
      );
    }
  }

  if (tags.clarityProjectId) {
    const clarity: Queue =
      target.clarity ??
      function clarityQueue() {
        clarity.q ??= [];
        // biome-ignore lint/complexity/noArguments: Clarity reads the arguments object itself, like gtag.js.
        clarity.q.push(arguments);
      };
    target.clarity = clarity;
    if (consented) clarity('consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' });
    addScript(doc, `https://www.clarity.ms/tag/${encodeURIComponent(tags.clarityProjectId)}`);
  }

  if (tags.bingUetTagId) {
    const queue = Array.isArray(target.uetq) ? target.uetq : [];
    target.uetq = queue;
    if (consented) queue.push('consent', 'default', { ad_storage: 'granted' });
    const ti = tags.bingUetTagId;
    addScript(doc, 'https://bat.bing.com/bat.js', () => {
      if (!target.UET) return;
      const uet = new target.UET({ ti, enableAutoSpaTracking: true, q: queue });
      target.uetq = uet;
      uet.push('pageLoad');
    });
  }
}

/** Cookie names the tags above set, so saying no afterwards takes them away too. */
const TRACKING_COOKIE =
  /^(_ga|_gid|_gat|_gcl|_gac|_clck|_clsk|_uetsid|_uetvid|_uetmsclkid|MUID|CLID|ANONCHK|SM)(_|$)/;

export function clearTrackingCookies(
  doc: Document = document,
  host = doc.location?.hostname ?? '',
) {
  const parts = host.split('.');
  const domains = ['', host, ...parts.slice(1).map((_, i) => `.${parts.slice(i + 1).join('.')}`)];
  for (const pair of doc.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim() ?? '';
    if (!TRACKING_COOKIE.test(name)) continue;
    for (const domain of domains) {
      doc.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}`;
    }
  }
}

/** Reads the tags and loads them, asking first when the banner is on. */
export async function startTracking(
  fetchFn: typeof fetch = globalThis.fetch,
  win: Window = window,
  doc: Document = document,
): Promise<Outcome> {
  let tags: TrackingTags | null = null;
  try {
    const response = await fetchFn(ANALYTICS_URL, { headers: { accept: 'application/json' } });
    if (response.ok) tags = parseTrackingTags(await response.json());
  } catch {
    // Offline or a bad body: the page simply goes without the tags.
  }
  if (!tags || !hasTags(tags)) return null;
  if (!tags.consentRequired) {
    loadTags(tags, false, win, doc);
    return 'loaded';
  }

  const banner = doc.querySelector<HTMLElement>('[data-consent-banner]');
  let loaded = false;
  const load = () => {
    if (loaded || !tags) return;
    loaded = true;
    loadTags(tags, true, win, doc);
  };

  banner?.querySelectorAll<HTMLButtonElement>('[data-consent-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      const choice: Choice = button.dataset.consentChoice === 'granted' ? 'granted' : 'denied';
      saveChoice(choice, win);
      banner.hidden = true;
      if (choice === 'granted') load();
      else if (loaded) {
        // A tag that already ran can not be unloaded: take its cookies and start the page again without it.
        clearTrackingCookies(doc);
        win.location.reload();
      } else clearTrackingCookies(doc);
    });
  });
  for (const opener of doc.querySelectorAll<HTMLButtonElement>('[data-consent-open]')) {
    opener.hidden = false;
    opener.addEventListener('click', () => {
      if (banner) banner.hidden = false;
    });
  }

  const choice = readChoice(win);
  if (choice === 'granted') {
    load();
    return 'loaded';
  }
  if (choice === 'denied') return 'declined';
  if (banner) banner.hidden = false;
  return 'asked';
}
