import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ManifestEntry {
  name: string;
  route: string;
  theme: string;
  alt: string;
}

const shotsDir = new URL('../src/assets/screenshots/', import.meta.url);
const manifestFile = fileURLToPath(new URL('manifest.json', shotsDir));
const spec = readFileSync(
  fileURLToPath(new URL('../../../../docs/epics/40-website.md', import.meta.url)),
  'utf8',
);

/** The names in the table under "Captured by **<task>**" in the website spec. */
function specShotNames(task: string): string[] {
  const start = spec.indexOf(`Captured by **${task}**`);
  if (start < 0) return [];
  const names: string[] = [];
  let inTable = false;
  for (const line of spec.slice(start).split(/\r?\n/).slice(1)) {
    if (line.startsWith('|')) {
      inTable = true;
      const name = /^\|\s*`([\w-]+)`\s*\|/.exec(line)?.[1];
      if (name) names.push(name);
    } else if (inTable) {
      break;
    }
  }
  return names;
}

/** The phrases in the spec's `forbidden` block, up to the first line starting with `#`. */
function forbiddenPhrases(): string[] {
  const block = /```forbidden\r?\n([\s\S]*?)```/.exec(spec)?.[1] ?? '';
  const phrases: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('#')) break;
    if (line.trim()) phrases.push(line.trim().toLowerCase());
  }
  return phrases;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const manifest: ManifestEntry[] = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, 'utf8'))
  : [];

describe('app screenshots', () => {
  for (const task of ['T012', 'T013']) {
    it(`has a manifest entry for every shot the spec gives ${task}`, () => {
      const wanted = specShotNames(task);
      expect(wanted.length).toBeGreaterThan(10);
      expect(manifest.map((entry) => entry.name)).toEqual(expect.arrayContaining(wanted));
    });
  }

  it('lists each name once', () => {
    const names = manifest.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const entry of manifest) {
    describe(entry.name, () => {
      it('points at an existing 1600x1000 image at 2x', () => {
        const file = fileURLToPath(new URL(`${entry.name}.png`, shotsDir));
        expect(existsSync(file), file).toBe(true);
        expect(pngSize(file)).toEqual({ width: 3200, height: 2000 });
      });

      it('has alt text, a route and a theme', () => {
        expect(entry.alt.trim().length).toBeGreaterThan(10);
        expect(entry.route).toMatch(/^\//);
        expect(['dark', 'light', 'vscode-dark', 'vs2026']).toContain(entry.theme);
      });

      it('never names a forbidden phrase in its alt text', () => {
        const alt = entry.alt.toLowerCase();
        for (const phrase of forbiddenPhrases()) expect(alt).not.toContain(phrase);
      });
    });
  }
});
