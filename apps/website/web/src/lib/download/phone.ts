/**
 * The phone apps' store pages. Both apps are still on their way to the stores, so `url` is null
 * and every badge says "Coming soon" without a link. Put the real address here once a store
 * publishes the app, and drop the matching store lines from the forbidden block in
 * docs/epics/40-website.md in the same change.
 */
export interface PhoneStore {
  id: 'google-play' | 'app-store';
  system: 'Android' | 'iOS';
  store: 'Google Play' | 'App Store';
  /** A mark name from src/components/effects/Icon.astro. */
  mark: 'android' | 'apple';
  url: string | null;
}

export const PHONE_STORES: PhoneStore[] = [
  { id: 'google-play', system: 'Android', store: 'Google Play', mark: 'android', url: null },
  { id: 'app-store', system: 'iOS', store: 'App Store', mark: 'apple', url: null },
];
