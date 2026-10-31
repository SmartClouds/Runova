// What the API answers to the admin pages, in the shapes of the API contract.

export const TECHNOLOGIES = [
  { slug: 'git', name: 'Git', kind: 'tool', detectable: true },
  { slug: 'nodejs', name: 'Node.js', kind: 'runtime', detectable: true },
  { slug: 'openssh', name: 'OpenSSH', kind: 'tool', detectable: true },
];

export const NEWS_ITEM = {
  id: 42,
  slug: 'openssh-10-3-fixes-a-pre-auth-crash',
  url: 'https://runovahq.com/news/openssh-10-3-fixes-a-pre-auth-crash',
  title: 'OpenSSH 10.3 fixes a pre-auth crash',
  summary: 'A crafted key exchange can crash sshd before sign-in. Update to 10.3.',
  category: 'security',
  severity: 'high',
  technologies: [
    { technology: 'openssh', name: 'OpenSSH', versionRange: '>=9.8.0 <10.3.0', fixedIn: '10.3.0' },
  ],
  cveIds: ['CVE-2026-41234'],
  cvssScore: 7.5,
  tags: ['ssh', 'servers'],
  publishedAt: '2026-10-29T08:00:00.000Z',
  updatedAt: '2026-10-29T09:30:00.000Z',
  bodyHtml: '<h2>What happened</h2>',
  sourceLinks: [{ title: 'Release notes', url: 'https://www.openssh.com/txt/release-10.3' }],
  bodyMarkdown: '## What happened\n\nA crash.',
  status: 'published',
  createdAt: '2026-10-29T07:00:00.000Z',
  createdBy: { kind: 'user', id: 7, name: 'Sam Editor' },
  version: '12',
};

export const POST = {
  id: 9,
  slug: 'how-relay-hands-work-over',
  url: 'https://runovahq.com/blog/how-relay-hands-work-over',
  title: 'How Relay hands work over',
  excerpt: 'Each session leaves a handoff the next one reads before it starts.',
  coverImage: {
    url: 'https://runovahq.com/media/2026/10/abc.webp',
    width: 1200,
    height: 630,
    alt: 'The Relay board',
  },
  tags: [
    { slug: 'relay', name: 'relay' },
    { slug: 'agents', name: 'agents' },
  ],
  author: { displayName: 'Sam Editor' },
  publishedAt: null,
  updatedAt: '2026-10-29T09:30:00.000Z',
  readingTimeMinutes: 3,
  bodyHtml: '<p>Hi</p>',
  bodyMarkdown: 'Hi',
  status: 'draft',
  createdAt: '2026-10-29T07:00:00.000Z',
  createdBy: { kind: 'user', id: 7, name: 'Sam Editor' },
  version: '5',
};
