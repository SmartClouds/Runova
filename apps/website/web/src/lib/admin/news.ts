/** The news editor's form, and how it maps to the API's `NewsItemAdminDto` and `NewsItemWriteDto`. */

import type { Category, Severity, SourceLink } from '../news/api';
import {
  type ItemStatus,
  NEW_PUBLISHING,
  type Publishing,
  publishingFields,
  publishingFrom,
  splitList,
} from './publishing';

/** A `NewsItemAdminDto` from the API contract, as far as the editor reads it. */
export interface NewsItemAdmin {
  id: number;
  slug: string;
  title: string;
  summary: string;
  category: Category;
  severity: Severity;
  technologies: {
    technology: string;
    name: string;
    versionRange: string;
    fixedIn: string | null;
  }[];
  cveIds: string[];
  cvssScore: number | null;
  tags: string[];
  publishedAt: string | null;
  sourceLinks: SourceLink[];
  bodyMarkdown: string;
  status: ItemStatus;
  version: string;
}

/** A `TechnologyDto` from `GET /api/v1/technologies`. */
export interface Technology {
  slug: string;
  name: string;
  kind: string;
  detectable: boolean;
}

/** An affected technology as the form edits it: both versions as typed. */
export interface TechnologyRow {
  technology: string;
  name: string;
  versionRange: string;
  fixedIn: string;
}

export interface NewsForm {
  title: string;
  slug: string;
  /** False until the editor types a slug of their own; until then it follows the title. */
  slugEdited: boolean;
  summary: string;
  category: Category;
  severity: Severity;
  technologies: TechnologyRow[];
  /** CVE ids as typed, comma or space separated. */
  cveIds: string;
  /** The `type="number"` input's value, empty when there is no score. */
  cvssScore: string;
  /** Not edited here; kept so a save does not drop them. */
  sourceLinks: SourceLink[];
  tags: string;
  bodyMarkdown: string;
  publishing: Publishing;
}

export const NEW_NEWS_FORM: NewsForm = {
  title: '',
  slug: '',
  slugEdited: false,
  summary: '',
  category: 'release',
  severity: 'info',
  technologies: [],
  cveIds: '',
  cvssScore: '',
  sourceLinks: [],
  tags: '',
  bodyMarkdown: '',
  publishing: NEW_PUBLISHING,
};

/** The severities each category allows, lowest first (API contract, News categories). */
export function allowedSeverities(category: Category): Severity[] {
  return category === 'security' ? ['low', 'medium', 'high', 'critical'] : ['info'];
}

/** The severity a CVSS score suggests, or null when the score is missing or out of range. */
export function cvssSeverity(score: string): Severity | null {
  if (score.trim() === '') return null;
  const value = Number(score);
  if (!Number.isFinite(value) || value < 0.1 || value > 10) return null;
  if (value < 4) return 'low';
  if (value < 7) return 'medium';
  if (value < 9) return 'high';
  return 'critical';
}

/** A category change keeps the severity when the new category allows it, else takes its lowest. */
export function withCategory(form: NewsForm, category: Category): NewsForm {
  const allowed = allowedSeverities(category);
  return {
    ...form,
    category,
    severity: allowed.includes(form.severity) ? form.severity : allowed[0],
  };
}

export function newsFormFrom(item: NewsItemAdmin): NewsForm {
  return {
    title: item.title,
    slug: item.slug,
    slugEdited: true,
    summary: item.summary,
    category: item.category,
    severity: item.severity,
    technologies: item.technologies.map((each) => ({
      technology: each.technology,
      name: each.name,
      versionRange: each.versionRange,
      fixedIn: each.fixedIn ?? '',
    })),
    cveIds: item.cveIds.join(', '),
    cvssScore: item.cvssScore === null ? '' : String(item.cvssScore),
    sourceLinks: item.sourceLinks,
    tags: item.tags.join(', '),
    bodyMarkdown: item.bodyMarkdown,
    publishing: publishingFrom(item.status, item.publishedAt),
  };
}

/** The `NewsItemWriteDto` of a save. Technologies go without `name`: the API refuses it. */
export function newsWriteDto(form: NewsForm) {
  const security = form.category === 'security';
  return {
    slug: form.slug,
    title: form.title,
    summary: form.summary,
    bodyMarkdown: form.bodyMarkdown,
    category: form.category,
    severity: form.severity,
    technologies: form.technologies.map((each) => ({
      technology: each.technology,
      versionRange: each.versionRange,
      fixedIn: each.fixedIn.trim() === '' ? null : each.fixedIn.trim(),
    })),
    // Only a security item shows these fields, so only one sends them.
    cveIds: security ? splitList(form.cveIds).map((each) => each.toUpperCase()) : [],
    cvssScore: security && form.cvssScore.trim() !== '' ? Number(form.cvssScore) : null,
    sourceLinks: form.sourceLinks,
    tags: splitList(form.tags).map((each) => each.toLowerCase()),
    ...publishingFields(form.publishing),
  };
}
