/**
 * News items as the website API returns them (`NewsItemDto`, newest first), for the page tests and
 * the fake API. Times count back from when the module loads, so "the last two days" always holds
 * the same items. Twelve are written out, one per severity and category; the rest are short release
 * notes so the list, and the release category alone, have two pages.
 */

export type FixtureCategory =
  | 'security'
  | 'release'
  | 'deprecation'
  | 'end-of-life'
  | 'ai'
  | 'tooling'
  | 'industry';

export type FixtureSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface FixtureTechnology {
  technology: string;
  name: string;
  versionRange: string;
  fixedIn: string | null;
}

export interface FixtureNewsItem {
  id: number;
  slug: string;
  url: string;
  title: string;
  summary: string;
  category: FixtureCategory;
  severity: FixtureSeverity;
  technologies: FixtureTechnology[];
  cveIds: string[];
  cvssScore: number | null;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
  bodyHtml: string;
  sourceLinks: Array<{ title: string; url: string }>;
}

const SITE = 'https://runovahq.com';

/** When the fixture times were made. */
export const FIXTURE_NOW = Date.now();

/** A time `hours` hours before the fixtures were made, as the API writes times. */
export function hoursAgo(hours: number): string {
  return new Date(FIXTURE_NOW - hours * 3_600_000).toISOString();
}

function item(
  fields: Omit<FixtureNewsItem, 'url' | 'updatedAt' | 'bodyHtml' | 'sourceLinks' | 'cvssScore'> &
    Partial<Pick<FixtureNewsItem, 'updatedAt' | 'bodyHtml' | 'sourceLinks' | 'cvssScore'>>,
): FixtureNewsItem {
  return {
    cvssScore: null,
    sourceLinks: [],
    bodyHtml: `<p>${fields.summary}</p>`,
    ...fields,
    url: `${SITE}/news/${fields.slug}`,
    updatedAt: fields.updatedAt ?? fields.publishedAt,
  };
}

const tech = (
  technology: string,
  name: string,
  versionRange: string,
  fixedIn: string | null = null,
): FixtureTechnology => ({ technology, name, versionRange, fixedIn });

const written: FixtureNewsItem[] = [
  item({
    id: 212,
    slug: 'openssh-10-3-fixes-a-pre-auth-crash',
    title: 'OpenSSH 10.3 fixes a pre-auth crash',
    summary: 'A crafted key exchange can crash sshd before sign-in. Update to 10.3.',
    category: 'security',
    severity: 'high',
    technologies: [tech('openssh', 'OpenSSH', '>=9.8.0 <10.3.0', '10.3.0')],
    cveIds: ['CVE-2026-41234'],
    cvssScore: 7.5,
    tags: ['ssh', 'servers'],
    publishedAt: hoursAgo(2),
    updatedAt: hoursAgo(1),
    bodyHtml:
      '<p>The OpenSSH team released 10.3 with a fix for a crash in the key exchange.</p><h2>Who is affected</h2><p>Every server running sshd from 9.8 up to 10.2.</p>',
    sourceLinks: [
      { title: 'OpenSSH 10.3 release notes', url: 'https://www.openssh.com/releasenotes.html' },
    ],
  }),
  item({
    id: 211,
    slug: 'node-js-patches-a-critical-http-parser-bug',
    title: 'Node.js patches a critical HTTP parser bug',
    summary:
      'Request smuggling through the HTTP parser affects every supported line. Update Node.js 22 and 24 now.',
    category: 'security',
    severity: 'critical',
    technologies: [
      tech('nodejs', 'Node.js', '>=22.0.0 <22.21.1', '22.21.1'),
      tech('nodejs', 'Node.js', '>=24.0.0 <24.11.1', '24.11.1'),
    ],
    cveIds: ['CVE-2026-50101', 'CVE-2026-50102'],
    cvssScore: 9.1,
    tags: ['nodejs'],
    publishedAt: hoursAgo(8),
  }),
  item({
    id: 210,
    slug: 'git-fixes-a-credential-leak-in-the-helper',
    title: 'Git fixes a credential leak in the helper protocol',
    summary: 'A crafted remote URL can make Git send stored credentials to the wrong host.',
    category: 'security',
    severity: 'medium',
    technologies: [tech('git', 'Git', '>=2.40.0 <2.47.1 || =2.39.5', '2.47.1')],
    cveIds: ['CVE-2026-33333'],
    cvssScore: 5.9,
    tags: ['git'],
    publishedAt: hoursAgo(20),
  }),
  item({
    id: 209,
    slug: 'nginx-advisory-on-a-resolver-read-past-the-end',
    title: 'nginx advisory on a resolver read past the end',
    summary:
      'The resolver can read one byte past a buffer. No fix is out yet; turn the resolver off.',
    category: 'security',
    severity: 'low',
    technologies: [tech('nginx', 'nginx', '>=1.25.0 <=1.29.2')],
    cveIds: [],
    tags: ['nginx'],
    publishedAt: hoursAgo(30),
  }),
  item({
    id: 208,
    slug: 'typescript-6-1-is-out',
    title: 'TypeScript 6.1 is out',
    summary: 'TypeScript 6.1 brings faster project loading and stricter checks on unused imports.',
    category: 'release',
    severity: 'info',
    technologies: [tech('typescript', 'TypeScript', '*')],
    cveIds: [],
    tags: ['typescript'],
    publishedAt: hoursAgo(40),
  }),
  item({
    id: 207,
    slug: 'claude-code-raises-its-context-limit',
    title: 'Claude Code raises its context limit',
    summary: 'Long sessions can now hold more of a repository before they need a handoff.',
    category: 'ai',
    severity: 'info',
    technologies: [tech('claude-code', 'Claude Code', '*')],
    cveIds: [],
    tags: ['agents'],
    publishedAt: hoursAgo(47),
  }),
  item({
    id: 206,
    slug: 'npm-deprecates-legacy-auth-tokens',
    title: 'npm deprecates legacy auth tokens',
    summary: 'Classic tokens stop working next spring. Move publishing to granular tokens.',
    category: 'deprecation',
    severity: 'info',
    technologies: [tech('npm', 'npm', '*')],
    cveIds: [],
    tags: ['npm'],
    publishedAt: hoursAgo(50),
  }),
  item({
    id: 205,
    slug: 'python-3-10-reaches-end-of-life',
    title: 'Python 3.10 reaches end of life',
    summary: 'Python 3.10 gets no more security fixes. Plan the move to 3.13 or newer.',
    category: 'end-of-life',
    severity: 'info',
    technologies: [tech('python', 'Python', '>=3.10.0 <3.11.0')],
    cveIds: [],
    tags: ['python'],
    publishedAt: hoursAgo(72),
  }),
  item({
    id: 204,
    slug: 'github-actions-moves-runners-to-ubuntu-26-04',
    title: 'GitHub Actions moves ubuntu-latest to 26.04',
    summary: 'Workflows on ubuntu-latest switch images over the next month. Pin a version to wait.',
    category: 'tooling',
    severity: 'info',
    technologies: [tech('github-actions', 'GitHub Actions', '*')],
    cveIds: [],
    tags: ['ci'],
    publishedAt: hoursAgo(96),
  }),
  item({
    id: 203,
    slug: 'open-source-maintainers-get-a-new-security-fund',
    title: 'Open source maintainers get a new security fund',
    summary: 'A new fund pays maintainers of widely used packages for security reviews.',
    category: 'industry',
    severity: 'info',
    technologies: [],
    cveIds: [],
    tags: [],
    publishedAt: hoursAgo(120),
  }),
  item({
    id: 202,
    slug: 'openssl-fixes-a-critical-certificate-check',
    title: 'OpenSSL fixes a critical certificate check',
    summary: 'A malformed certificate can skip name checks. Update OpenSSL 3.5 and 3.6.',
    category: 'security',
    severity: 'critical',
    technologies: [tech('openssl', 'OpenSSL', '>=3.5.0 <3.5.4', '3.5.4')],
    cveIds: ['CVE-2026-20202'],
    cvssScore: 9.8,
    tags: ['tls'],
    publishedAt: hoursAgo(140),
  }),
  item({
    id: 201,
    slug: 'docker-engine-30-is-out',
    title: 'Docker Engine 30 is out',
    summary: 'Docker Engine 30 makes containerd image storage the default.',
    category: 'release',
    severity: 'info',
    technologies: [tech('docker', 'Docker', '*')],
    cveIds: [],
    tags: ['docker'],
    publishedAt: hoursAgo(160),
  }),
];

const releases: FixtureNewsItem[] = Array.from({ length: 20 }, (_, index) => {
  const minor = 20 - index;
  return item({
    id: 200 - index,
    slug: `bun-1-${minor}-is-out`,
    title: `Bun 1.${minor} is out`,
    summary: `Bun 1.${minor} is out with fixes for the package manager and the test runner.`,
    category: 'release',
    severity: 'info',
    technologies: [tech('bun', 'Bun', '*')],
    cveIds: [],
    tags: ['bun'],
    publishedAt: hoursAgo(200 + index * 24),
  });
});

/** Every published item, newest first: 32 of them, 22 of them releases. */
export const FIXTURE_NEWS: FixtureNewsItem[] = [...written, ...releases];

/** The written-out item of each severity, for the card tests. */
export const BY_SEVERITY: Record<FixtureSeverity, FixtureNewsItem> = {
  info: written[4],
  low: written[3],
  medium: written[2],
  high: written[0],
  critical: written[1],
};
