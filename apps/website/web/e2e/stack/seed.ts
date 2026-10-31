// Gives a fresh stack the content Lighthouse audits: the owner account, a news item and a blog
// post, posted by an API client like any other. Run again, it finds them there and changes nothing.
//   bun e2e/stack/seed.ts
import { ensureOwner } from './compose.ts';
import { apiClient, newContext, signedPost } from './stackApi.ts';

export const SEED_NEWS_SLUG = 'runova-website-stack-is-live';
export const SEED_POST_SLUG = 'running-the-website-stack';

const news = {
  slug: SEED_NEWS_SLUG,
  title: 'The Runova website stack is live',
  summary:
    'The site, the API and PostgreSQL now run in containers behind one reverse proxy, the way production does.',
  bodyMarkdown:
    'The website and its API run together from one compose file.\n\n' +
    'Caddy serves the site, the API, uploaded media and the jobs dashboard on one origin.',
  category: 'release',
  severity: 'info',
  technologies: [],
  cveIds: [],
  cvssScore: null,
  sourceLinks: [],
  tags: ['website'],
  status: 'published',
  publishedAt: null,
};

const post = {
  slug: SEED_POST_SLUG,
  title: 'Running the website stack',
  excerpt:
    'How the Runova website runs in production: three containers and a reverse proxy, started with one command.',
  bodyMarkdown:
    '## One command\n\n' +
    'The compose file builds the API and the site, starts PostgreSQL, and puts Caddy in front.\n\n' +
    '## One origin\n\n' +
    'Pages, the API and media share an origin, so cookies and caching stay simple.',
  coverMediaId: null,
  tags: ['website'],
  status: 'published',
  publishedAt: null,
};

/** Makes the owner, then posts the news item and the blog post unless their slugs exist already. */
export async function seed() {
  ensureOwner();
  const key = await apiClient(['news:write', 'posts:write']);
  const context = await newContext();
  try {
    for (const [path, item] of [
      ['/news', news],
      ['/posts', post],
    ] as const) {
      const response = await signedPost(context, key, path, JSON.stringify(item));
      // 409: a run before this one posted it.
      if (!response.ok() && response.status() !== 409) {
        throw new Error(`POST ${path} answered ${response.status()}: ${await response.text()}`);
      }
    }
  } finally {
    await context.dispose();
  }
}

if (import.meta.main) await seed();
