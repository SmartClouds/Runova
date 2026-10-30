import type { TechArticle } from 'schema-dts';
import { type Crumb, organizationId, SITE_NAME } from '../seo';

const MIN_DESCRIPTION = 70;
const MAX_DESCRIPTION = 160;

/**
 * An article's summary as a meta description of 70 to 160 characters: whole sentences while they
 * fit, else the first sentence cut at a word with an ellipsis. A short one gets a closing line.
 */
export function helpMetaDescription(summary: string): string {
  let description = summary.trim();
  if (description.length > MAX_DESCRIPTION) {
    const sentences = description.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
    let fitting = '';
    for (const sentence of sentences) {
      const next = `${fitting}${sentence}`.trim();
      if (next.length > MAX_DESCRIPTION) break;
      fitting = next;
    }
    if (fitting.length >= MIN_DESCRIPTION) {
      description = fitting;
    } else {
      const cut = description.slice(0, MAX_DESCRIPTION);
      description = `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:]+$/, '')}…`;
    }
  }
  if (description.length < MIN_DESCRIPTION) {
    description = `${description} A step-by-step guide from the ${SITE_NAME} help center for the desktop app.`;
  }
  return description;
}

/** Home, Help, and the article when there is one. */
export function helpCrumbs(page?: { slug: string; title: string }): Crumb[] {
  const crumbs: Crumb[] = [
    { name: 'Home', path: '/' },
    { name: 'Help', path: '/help' },
  ];
  if (page) crumbs.push({ name: page.title, path: `/help/${page.slug}` });
  return crumbs;
}

export interface TechArticleInput {
  slug: string;
  title: string;
  description: string;
  category: string;
  keywords: string[];
  /** The path of the article's screenshot, when it has one. */
  image?: string;
}

/** The TechArticle node for a help page, published by the site's Organization. */
export function helpTechArticle(site: string | URL, input: TechArticleInput): TechArticle {
  const url = new URL(`/help/${input.slug}`, site).href;
  return {
    '@type': 'TechArticle',
    '@id': `${url}#article`,
    headline: input.title,
    description: input.description,
    url,
    mainEntityOfPage: url,
    articleSection: input.category,
    keywords: input.keywords.join(', '),
    inLanguage: 'en',
    ...(input.image ? { image: new URL(input.image, site).href } : {}),
    author: { '@id': organizationId(site) },
    publisher: { '@id': organizationId(site) },
    isPartOf: { '@id': new URL('/#website', site).href },
    about: { '@type': 'SoftwareApplication', name: SITE_NAME },
  };
}
