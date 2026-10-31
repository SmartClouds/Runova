/** The MDX files in src/content/features, loaded through Vite (vitest only). */

export interface FeatureFrontmatter {
  title: string;
  description: string;
  summary: string;
  group: string;
  order: number;
  cover: string;
  covers: string[];
  help: string[];
}

export interface FeatureModule {
  frontmatter: FeatureFrontmatter;
  default: (props: Record<string, unknown>) => unknown;
}

/** The help article file names (without `.md`) the site turns into `/help/<name>`. */
export function helpArticleNames(): string[] {
  const names = import.meta.glob('../../../../desktop/src/shared/help/articles/*.md');
  return Object.keys(names).map((path) => /([\w-]+)\.md$/.exec(path)?.[1] ?? path);
}

const modules = import.meta.glob<FeatureModule>('../../src/content/features/*.mdx', {
  eager: true,
});
const sources = import.meta.glob<string>('../../src/content/features/*.mdx', {
  eager: true,
  query: '?raw',
  import: 'default',
});

export interface FeatureEntryFile {
  slug: string;
  module: FeatureModule;
  source: string;
}

/** Every MDX file in src/content/features, by its file name. */
export function featureEntryFiles(): FeatureEntryFile[] {
  return Object.entries(modules).map(([path, module]) => ({
    slug: /([\w-]+)\.mdx$/.exec(path)?.[1] ?? path,
    module,
    source: sources[path] ?? '',
  }));
}

/** The screenshot names an MDX body shows with `<Screenshot name="..." />`. */
export function screenshotReferences(source: string): string[] {
  return [...source.matchAll(/<Screenshot\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);
}
