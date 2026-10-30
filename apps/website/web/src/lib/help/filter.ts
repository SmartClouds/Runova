/**
 * The help filter from docs/epics/40-website.md ("Help filter (T016)"): what the site drops or
 * rewrites in the app's help articles before rendering, so no page mentions the mobile version of
 * Runova. The rules are data: each one names an article file and matches a front matter field, an
 * exact phrase or a `##` heading. A mention no rule covers is left in, and the text scan over the
 * build fails on it.
 */

export type HelpFilterRule =
  /** Replace a front matter field's value. */
  | { file: string; field: 'summary'; set: string }
  /** Drop items from the comma-separated `keywords` field. */
  | { file: string; field: 'keywords'; drop: string[] }
  /** Replace every copy of an exact phrase. */
  | { file: string; replace: string; with: string }
  /** Drop a `##` section with its `###` children, up to the next `##` heading. */
  | { file: string; dropSection: string };

export const HELP_FILTER: HelpFilterRule[] = [
  {
    file: 'remote.md',
    field: 'summary',
    set: 'Control another Runova over your network, connect to servers over SSH, and open Windows Remote Desktop sessions.',
  },
  { file: 'remote.md', field: 'keywords', drop: ['mobile', 'phone', 'companion app'] },
  {
    file: 'remote.md',
    replace: '**Host** (let another Runova or the mobile app control this computer)',
    with: '**Host** (let another Runova control this computer)',
  },
  {
    file: 'remote.md',
    replace: 'on the same network, and from the Runova mobile app.',
    with: 'on the same network.',
  },
  {
    file: 'remote.md',
    replace: 'scan the QR with the Runova mobile app, or copy the text',
    with: 'copy the text',
  },
  { file: 'remote.md', dropSection: 'The Runova mobile app' },
];

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

function withFrontmatter(source: string, change: (frontmatter: string) => string): string {
  const match = FRONTMATTER.exec(source);
  if (!match) return source;
  return change(match[0]) + source.slice(match[0].length);
}

function setField(source: string, field: string, value: (current: string) => string): string {
  return withFrontmatter(source, (frontmatter) =>
    frontmatter.replace(
      new RegExp(`^${field}:[ \\t]*(.*)$`, 'm'),
      (_, current: string) => `${field}: ${value(current)}`,
    ),
  );
}

function dropSection(source: string, heading: string): string {
  const lines = source.split('\n');
  const kept: string[] = [];
  let inFence = false;
  let dropping = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const level2 = !inFence && /^##\s/.test(line);
    if (level2) dropping = line.replace(/^##\s+/, '').trim() === heading;
    if (!dropping) kept.push(line);
  }
  return kept.join('\n');
}

function applyRule(source: string, rule: HelpFilterRule): string {
  if ('dropSection' in rule) return dropSection(source, rule.dropSection);
  if ('replace' in rule) return source.split(rule.replace).join(rule.with);
  if ('set' in rule) return setField(source, rule.field, () => rule.set);
  const drop = new Set(rule.drop.map((keyword) => keyword.toLowerCase()));
  return setField(source, rule.field, (current) =>
    current
      .split(',')
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword && !drop.has(keyword.toLowerCase()))
      .join(', '),
  );
}

function rulesFor(fileName: string, rules: HelpFilterRule[]): HelpFilterRule[] {
  return rules.filter((rule) => rule.file === fileName);
}

/** The article source with the filter applied, with `\n` line endings. */
export function applyHelpFilter(
  fileName: string,
  source: string,
  rules: HelpFilterRule[] = HELP_FILTER,
): string {
  const normalized = source.replace(/\r\n/g, '\n');
  return rulesFor(fileName, rules).reduce(applyRule, normalized);
}

/** The rules for a file that change nothing in it, which means the article moved on. */
export function unusedFilterRules(
  fileName: string,
  source: string,
  rules: HelpFilterRule[] = HELP_FILTER,
): HelpFilterRule[] {
  const normalized = source.replace(/\r\n/g, '\n');
  return rulesFor(fileName, rules).filter((rule) => applyRule(normalized, rule) === normalized);
}
