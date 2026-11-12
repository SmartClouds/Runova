import type { LucideIcon } from 'lucide-react';
import type { HelpTocItem } from './help/articles';

/**
 * The privacy policy page (/privacy). The Apple App Store and Google Play ask for a public address
 * for it, so this one page covers the website, the desktop app and the phone apps.
 */

/** The day this text took effect, as ISO. Change it whenever the policy changes. */
export const PRIVACY_EFFECTIVE = '2026-11-12';

/** Where privacy questions and requests go. */
export const PRIVACY_EMAIL = 'info@smartclouds.co';

export const PRIVACY_PATH = '/privacy';

/** The sections in page order. Each id is the id of the section's heading. */
export const PRIVACY_SECTIONS: HelpTocItem[] = [
  { id: 'who-we-are', heading: 'Who we are', level: 2 },
  { id: 'what-we-collect', heading: 'What we collect', level: 2 },
  { id: 'desktop-app', heading: 'The desktop app', level: 2 },
  { id: 'phone-apps', heading: 'The apps for Android and iOS', level: 2 },
  { id: 'cookies', heading: 'Cookies and analytics', level: 2 },
  { id: 'who-receives-it', heading: 'Who receives your data', level: 2 },
  { id: 'how-long', heading: 'How long we keep it', level: 2 },
  { id: 'how-we-protect-it', heading: 'How we protect it', level: 2 },
  { id: 'your-rights', heading: 'Your choices and rights', level: 2 },
  { id: 'delete-account', heading: 'Delete your account', level: 2 },
  { id: 'children-and-changes', heading: 'Children and changes', level: 2 },
  { id: 'contact', heading: 'Contact', level: 2 },
];

/** "November 12, 2026", the way the download page writes release dates. */
export function privacyDate(iso: string = PRIVACY_EFFECTIVE): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

/**
 * One row of a card in the policy (a kind of data, a permission, a provider). The text may hold
 * links and bold words, and is written in this repo, never taken from a visitor.
 */
export interface Fact {
  icon: LucideIcon;
  title: string;
  text: string;
  /** A short note beside the row: `label` in small caps, then the `value`. */
  note?: { label: string; value: string };
}
