import type { Crumb } from './seo';

/** The groups the features index filters by, in the order the filter shows them. */
export const FEATURE_GROUPS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'projects', label: 'Projects' },
  { id: 'build', label: 'Build' },
  { id: 'agents', label: 'Agents' },
  { id: 'ship', label: 'Ship' },
  { id: 'connect', label: 'Connect' },
  { id: 'app', label: 'Around the app' },
] as const;

export type FeatureGroup = (typeof FEATURE_GROUPS)[number]['id'];

export const FEATURE_GROUP_IDS = FEATURE_GROUPS.map((group) => group.id) as [
  FeatureGroup,
  ...FeatureGroup[],
];

export function groupLabel(id: FeatureGroup): string {
  return FEATURE_GROUPS.find((group) => group.id === id)?.label ?? id;
}

/** What the features index needs from an entry to draw its card. */
export interface FeatureCard {
  slug: string;
  title: string;
  summary: string;
  group: FeatureGroup;
  order: number;
  /** The screenshot name in src/assets/screenshots/manifest.json. */
  cover: string;
  covers: string[];
}

/** Home, Features, and the feature page when there is one. */
export function featureCrumbs(page?: { slug: string; title: string }): Crumb[] {
  const crumbs: Crumb[] = [
    { name: 'Home', path: '/' },
    { name: 'Features', path: '/features' },
  ];
  if (page) crumbs.push({ name: page.title, path: `/features/${page.slug}` });
  return crumbs;
}

export interface FilterableCard {
  group: string;
  /** Everything a search should match: the title, the summary and the features it covers. */
  text: string;
}

/**
 * Whether a card stays visible for a group (`all` for every group) and a search. The search
 * matches when every word in it appears in the card's text, ignoring case.
 */
export function matchesFilter(card: FilterableCard, group: string, query: string): boolean {
  if (group !== 'all' && card.group !== group) return false;
  const text = card.text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
