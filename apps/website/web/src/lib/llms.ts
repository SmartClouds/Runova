import { SITE_NAME } from './seo';

/** What llms.txt shows of a feature page. */
export interface LlmsFeature {
  slug: string;
  title: string;
  description: string;
}

/**
 * llms.txt (https://llmstxt.org): the site's name, a one-line summary, then the main pages as
 * Markdown link lists under h2 sections, all with absolute URLs.
 */
export function llmsTxt(site: string | URL, features: LlmsFeature[]): string {
  const link = (title: string, path: string, note: string) =>
    `- [${title}](${new URL(path, site).href}): ${note}`;
  return [
    `# ${SITE_NAME}`,
    '',
    `> ${SITE_NAME} is an Agentic Development Environment: a free, open source desktop app for Windows, macOS and Linux that runs Claude Code, Codex, Gemini and other AI coding CLIs in panes, with git, diffs, tests and deploys next to them.`,
    '',
    'The site explains each part of the app, carries the same help articles the app has, and links the latest release for each system.',
    '',
    '## Features',
    '',
    link('Features', '/features', 'An overview of every part of the app.'),
    ...features.map((feature) =>
      link(feature.title, `/features/${feature.slug}`, feature.description),
    ),
    '',
    '## Help',
    '',
    link('Help center', '/help', 'How to set up and use each part of the app, searchable.'),
    '',
    '## Download',
    '',
    link(
      'Download',
      '/download',
      'The latest release for Windows, macOS and Linux, with checksums.',
    ),
    '',
    '## Optional',
    '',
    link('Blog', '/blog', 'Posts from the team, including release notes.'),
    link('News', '/news', 'Technology and security news for developers.'),
    '',
  ].join('\n');
}
