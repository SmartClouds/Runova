/**
 * What the header menu holds. Features and Resources are fixed links; News and Blog fill in with
 * the newest entries from `/nav/latest.json` (src/lib/latest.ts).
 */

import type { IconName } from '../components/effects/Icon.astro';

export const GITHUB_URL = 'https://github.com/SmartClouds/Runova';

export interface NavLink {
  href: string;
  title: string;
  meta: string;
  icon: IconName;
  external?: boolean;
}

/** The link at the end of a panel, next to its one-line summary. */
export interface PanelIndex {
  href: string;
  label: string;
  external?: boolean;
}

interface SectionBase {
  id: string;
  label: string;
  /** Where the label itself goes when clicked. Without one the label is a button. */
  href?: string;
  summary: string;
  index: PanelIndex;
}

export type NavSection =
  | (SectionBase & { kind: 'links'; links: NavLink[] })
  | (SectionBase & { kind: 'latest'; source: 'news' | 'blog' });

/** Six feature pages, one per part of the app (src/content/features). */
export const FEATURE_LINKS: NavLink[] = [
  {
    href: '/features/workspace',
    title: 'Workspace',
    meta: 'Agents side by side',
    icon: 'layout-grid',
  },
  {
    href: '/features/git-and-review',
    title: 'Git and review',
    meta: 'Diffs, commits and PRs',
    icon: 'git-pull-request',
  },
  {
    href: '/features/tests',
    title: 'Tests',
    meta: 'Run and read every suite',
    icon: 'list-checks',
  },
  { href: '/features/relay', title: 'Relay', meta: 'Hand work between agents', icon: 'waypoints' },
  { href: '/features/agents', title: 'Agents', meta: 'CLIs, skills and MCP', icon: 'bot' },
  { href: '/features/ship', title: 'Ship', meta: 'Build and release', icon: 'rocket' },
];

export const RESOURCE_LINKS: NavLink[] = [
  { href: '/download', title: 'Download', meta: 'Windows, macOS and Linux', icon: 'download' },
  { href: '/help', title: 'Help center', meta: 'How each part works', icon: 'life-buoy' },
  { href: '/news/rss.xml', title: 'News RSS', meta: 'News in your reader', icon: 'rss' },
  { href: '/blog/rss.xml', title: 'Blog RSS', meta: 'Posts in your reader', icon: 'rss' },
  {
    href: GITHUB_URL,
    title: 'Source on GitHub',
    meta: 'Issues and code',
    icon: 'github',
    external: true,
  },
  {
    href: `${GITHUB_URL}/blob/master/LICENSE`,
    title: 'MIT license',
    meta: 'Free to use and change',
    icon: 'scale',
    external: true,
  },
];

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'features',
    label: 'Features',
    href: '/features',
    kind: 'links',
    links: FEATURE_LINKS,
    summary: 'Everything Runova does, part by part.',
    index: { href: '/features', label: 'All features' },
  },
  {
    id: 'news',
    label: 'News',
    href: '/news',
    kind: 'latest',
    source: 'news',
    summary: 'Releases, advisories and changes in the tools you use.',
    index: { href: '/news', label: 'All news' },
  },
  {
    id: 'blog',
    label: 'Blog',
    href: '/blog',
    kind: 'latest',
    source: 'blog',
    summary: 'How Runova is built, and how to get more from it.',
    index: { href: '/blog', label: 'All posts' },
  },
  {
    id: 'resources',
    label: 'Resources',
    kind: 'links',
    links: RESOURCE_LINKS,
    summary: 'Runova is open source.',
    index: { href: GITHUB_URL, label: 'Source code', external: true },
  },
];

/** Plain links after the menus, with no panel. */
export const NAV_LINKS = [{ href: '/help', label: 'Help' }];

/**
 * Each system's installer, through `/download/<os>/latest` (src/pages/download/[os]/latest.ts),
 * which redirects to that file in the latest release. A Mac needs its arch to get one file.
 */
export const DOWNLOAD_LINKS: NavLink[] = [
  {
    href: '/download/windows/latest',
    title: 'Windows',
    meta: 'Installer for x64 PCs',
    icon: 'windows',
  },
  {
    href: '/download/macos/latest?arch=arm64',
    title: 'macOS, Apple silicon',
    meta: 'Disk image for M1 and later',
    icon: 'apple',
  },
  {
    href: '/download/macos/latest?arch=x64',
    title: 'macOS, Intel',
    meta: 'Disk image for Intel Macs',
    icon: 'apple',
  },
  { href: '/download/linux/latest', title: 'Linux', meta: 'AppImage for x64', icon: 'linux' },
];

/** The Download button's panel. The button sits apart from the menu but opens the same way. */
export const DOWNLOAD_SECTION: NavSection = {
  id: 'download',
  label: 'Download',
  href: '/download',
  kind: 'links',
  links: DOWNLOAD_LINKS,
  summary: 'Free and open source.',
  index: { href: '/download', label: 'All builds and checksums' },
};
