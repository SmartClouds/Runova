import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The features table in docs/epics/40-website.md and the feature names in the README's Features
 * section, read the way T015's coverage test needs them.
 */

export interface SpecFeatureRow {
  slug: string;
  title: string;
  /** README feature names, empty for an entry with no README bullet (Studio). */
  covers: string[];
  screenshots: string[];
}

const repoRoot = new URL('../../../../../', import.meta.url);

function readRepoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, repoRoot)), 'utf8');
}

export function specFeatureRows(): SpecFeatureRow[] {
  const spec = readRepoFile('docs/epics/40-website.md');
  const start = spec.indexOf('\n## Features');
  const end = spec.indexOf('\n## ', start + 1);
  const rows: SpecFeatureRow[] = [];
  for (const line of spec.slice(start, end).split(/\r?\n/)) {
    const cells = /^\|\s*`([\w-]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!cells) continue;
    const [title, covers, screenshots] = cells[2].split('|').map((cell) => cell.trim());
    rows.push({
      slug: cells[1],
      title,
      covers: covers.startsWith('(') ? [] : covers.split(';').map((name) => name.trim()),
      screenshots: [...screenshots.matchAll(/`([\w-]+)`/g)].map((match) => match[1]),
    });
  }
  return rows;
}

/** The bold names that open each bullet in the README's Features section. */
export function readmeFeatureNames(): string[] {
  const readme = readRepoFile('README.md');
  const start = readme.indexOf('\n## Features');
  const end = readme.indexOf('\n## ', start + 1);
  return [...readme.slice(start, end).matchAll(/^- \*\*(.+?)\*\*:/gm)].map((match) => match[1]);
}
