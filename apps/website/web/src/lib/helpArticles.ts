/**
 * Titles of the app's help articles, read from their front matter at build time. The articles
 * become `/help/<file name>` pages in T016; the features pages link to them by file name.
 */

const sources = import.meta.glob<string>('../../../../desktop/src/shared/help/articles/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

const titles = new Map(
  Object.entries(sources).map(([path, source]) => [
    /([\w-]+)\.md$/.exec(path)?.[1] ?? path,
    /^title:\s*(.+?)\s*$/m.exec(source)?.[1] ?? '',
  ]),
);

export function helpArticleTitle(name: string): string {
  const title = titles.get(name);
  if (!title) throw new Error(`No help article named ${name}.md`);
  return title;
}
