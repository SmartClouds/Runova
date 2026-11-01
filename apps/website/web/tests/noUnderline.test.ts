import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Links on the site are never underlined (docs/website/design.md, Layout and surfaces). They use
 * the `link` and `link-muted` utilities from global.css instead. This scans the site's source so an
 * underline class or rule cannot creep back in.
 */

const src = fileURLToPath(new URL('../src', import.meta.url));
const CODE = /\.(astro|tsx?|css)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return CODE.test(name) ? [path] : [];
  });
}

/** A Tailwind class that draws an underline, with or without a variant such as `hover:`. */
const UNDERLINE_CLASS = /(?<=^|[\s"'`{:])underline(?=$|[\s"'`}])/;
const UNDERLINE_RULE = /text-decoration(-line)?\s*:\s*[^;]*underline/;

describe('links', () => {
  it('are never underlined anywhere in the site source', () => {
    const found: string[] = [];
    for (const file of files(src)) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (UNDERLINE_CLASS.test(line) || UNDERLINE_RULE.test(line)) {
            found.push(`${relative(src, file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(found).toEqual([]);
  });

  it('the scan catches what it is meant to catch', () => {
    for (const bad of [
      'class="text-primary underline underline-offset-4"',
      "className='hover:underline'",
      'text-decoration: underline;',
      'text-decoration-line: underline',
    ]) {
      expect(UNDERLINE_CLASS.test(bad) || UNDERLINE_RULE.test(bad), bad).toBe(true);
    }
    expect(UNDERLINE_CLASS.test('/* Links are never underlined */')).toBe(false);
  });
});
