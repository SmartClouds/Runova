/**
 * Where an article's in-app route (`route: /deploy` in its front matter) leads on the site: the
 * features page for that part of the app, and the app screenshot taken on that route.
 */

/** The features entry for each in-app path. */
const ROUTE_FEATURES: Record<string, string> = {
  '/': 'more',
  '/workspace': 'workspace',
  '/projects': 'projects',
  '/prompt-builder': 'build',
  '/ask-ai': 'build',
  '/api-client': 'build',
  '/studio': 'studio',
  '/cli-manager': 'agents',
  '/skills': 'agents',
  '/mcp': 'agents',
  '/tools': 'agents',
  '/usage': 'token-usage',
  '/pipelines': 'ship',
  '/deploy': 'ship',
  '/monitoring': 'ship',
  '/docker': 'ship',
  '/android': 'ship',
  '/remote': 'connect',
  '/remote-files': 'connect',
  '/vault': 'connect',
  '/settings': 'more',
  '/help': 'more',
};

/** Workspace articles whose subject has a features page of its own. */
const ARTICLE_FEATURES: Record<string, string> = {
  relay: 'relay',
  'workspace-git': 'git-and-review',
  'workspace-files-editor': 'git-and-review',
  'workspace-browser-tests': 'tests',
};

function pathOf(route: string): string {
  return route.split(/[?#]/)[0] || '/';
}

/** The features slug an article links to, or nothing for an article without a known route. */
export function featureForArticle(slug: string, route: string | undefined): string | undefined {
  if (!route) return undefined;
  return ARTICLE_FEATURES[slug] ?? ROUTE_FEATURES[pathOf(route)];
}

export interface ShotRoute {
  name: string;
  route: string;
  theme: string;
}

/**
 * The Dark screenshot for an article: one named after it, or else the one taken on its route
 * (the same route, then the same path, then a page under the path, such as one project's
 * workspace for `/workspace`).
 */
export function screenshotForArticle(
  slug: string,
  route: string | undefined,
  shots: ShotRoute[],
): string | undefined {
  const dark = shots.filter((shot) => shot.theme === 'dark');
  const named = dark.find((shot) => shot.name === slug);
  if (named) return named.name;
  if (!route) return undefined;
  const path = pathOf(route);
  const match =
    dark.find((shot) => shot.route === route) ??
    dark.find((shot) => pathOf(shot.route) === path) ??
    dark.find((shot) => path !== '/' && pathOf(shot.route).startsWith(`${path}/`));
  return match?.name;
}
