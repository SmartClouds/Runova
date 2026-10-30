import type { TechArticle } from 'schema-dts';
import { type Crumb, fitMetaDescription, organizationId, SITE_NAME } from '../seo';

/** An article's summary as a meta description, with a closing line when it is short. */
export function helpMetaDescription(summary: string): string {
  return fitMetaDescription(
    summary,
    `A step-by-step guide from the ${SITE_NAME} help center for the desktop app.`,
  );
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
