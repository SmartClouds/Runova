/**
 * Blog posts as the website API returns them (`PostDto`, newest first), for the page tests and the
 * fake API. Three are written out; the rest are short release notes so the list has three pages.
 */

export interface FixturePost {
  id: number;
  slug: string;
  url: string;
  title: string;
  excerpt: string;
  coverImage: { url: string; width: number; height: number; alt: string } | null;
  tags: Array<{ slug: string; name: string }>;
  author: { displayName: string };
  publishedAt: string;
  updatedAt: string;
  readingTimeMinutes: number;
  bodyHtml: string;
}

const SITE = 'https://runovahq.com';

const relay = { slug: 'relay', name: 'Relay' };
const agents = { slug: 'agents', name: 'Agents' };
const git = { slug: 'git', name: 'Git' };
const releaseNotes = { slug: 'release-notes', name: 'Release notes' };

/** Midnight UTC `days` days before 30 October 2026, as the API writes times. */
function daysAgo(days: number, hour = 9): string {
  return new Date(Date.UTC(2026, 9, 30 - days, hour)).toISOString();
}

function post(
  fields: Omit<FixturePost, 'url' | 'updatedAt'> & { updatedAt?: string },
): FixturePost {
  return {
    ...fields,
    url: `${SITE}/blog/${fields.slug}`,
    updatedAt: fields.updatedAt ?? fields.publishedAt,
  };
}

const written: FixturePost[] = [
  post({
    id: 101,
    slug: 'relay-hands-long-tasks-between-sessions',
    title: 'How Relay hands a long task from one session to the next',
    excerpt:
      'Relay splits a large piece of work into tasks that each fit one agent session, and every session leaves a handoff that the next one reads first.',
    coverImage: {
      url: `${SITE}/media/2026/10/4f1c2a9be07d4a8f9d3c11b2a6e0f7c5.webp`,
      width: 1600,
      height: 900,
      alt: 'The Relay board with three tasks in progress',
    },
    tags: [agents, relay],
    author: { displayName: 'Mina Karimi' },
    publishedAt: daysAgo(0),
    updatedAt: daysAgo(0, 15),
    readingTimeMinutes: 6,
    bodyHtml:
      '<p>Long tasks used to end when the context window filled up.</p><h2 id="handoffs">Handoffs</h2><p>Each session writes what it did, what it decided and the <code>next step</code>.</p><ul><li>Purpose</li><li>Done so far</li></ul>',
  }),
  post({
    id: 100,
    slug: 'review-agent-diffs-by-hunk',
    title: 'Review what an agent changed, one hunk at a time',
    excerpt:
      'The diff tab now stages and reverts single hunks, so you keep the good parts of an agent run and drop the rest without leaving the workspace.',
    coverImage: null,
    tags: [git],
    author: { displayName: 'Sam Rahimi' },
    publishedAt: daysAgo(1),
    readingTimeMinutes: 4,
    bodyHtml: '<p>Agents write a lot of code. Reviewing it should not mean taking all of it.</p>',
  }),
  post({
    id: 99,
    slug: 'relay-budgets-and-estimates',
    title: 'Sizing Relay tasks so each one fits a session',
    excerpt:
      'A task that runs out of context halfway is worse than two smaller ones. Here is how Relay estimates a task before it starts.',
    coverImage: null,
    tags: [relay],
    author: { displayName: 'Mina Karimi' },
    publishedAt: daysAgo(2),
    readingTimeMinutes: 5,
    bodyHtml: '<p>Every task carries an estimate and a budget in its front matter.</p>',
  }),
];

const notes: FixturePost[] = Array.from({ length: 20 }, (_, index) => {
  const version = `2.${19 - index}.0`;
  return post({
    id: 98 - index,
    slug: `release-notes-${version.replaceAll('.', '-')}`,
    title: `What changed in Runova ${version}`,
    excerpt: `The fixes and small improvements that shipped in Runova ${version}, with links to the help articles that cover them.`,
    coverImage: null,
    tags: [releaseNotes],
    author: { displayName: 'Runova release bot' },
    publishedAt: daysAgo(3 + index),
    readingTimeMinutes: 2,
    bodyHtml: `<p>Runova ${version} is out.</p>`,
  });
});

/** Every published post, newest first: 23 in all. */
export const FIXTURE_POSTS: FixturePost[] = [...written, ...notes];
