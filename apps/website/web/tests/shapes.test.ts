import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every button and box on the site has one of three shapes (docs/website/design.md, Shapes):
 * buttons, chips and badges are pills (`rounded-full`), boxes use `rounded-box` and what sits inside
 * a box or is a form field uses `rounded-inner`. This scans the site's source so another radius
 * cannot creep back in.
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

/** A Tailwind radius other than the three shapes, with or without a variant such as `after:`. */
const OTHER_CLASS =
  /(?<=^|[\s"'`{:])rounded(-[trblse]{1,2})?-(md|lg|xl|2xl|3xl|\[[^\]]*\])(?=$|[\s"'`}])/;

/**
 * The radii plain CSS may use. Besides the three shapes: `inherit` for layers inside a shape, the
 * header's alias of the box radius, and three that belong to text rather than to a button or a
 * box (inline code, the focus outline of a link, the lines of the menu icon).
 */
const ALLOWED_RULE =
  /^(999px|9999px|inherit|var\(--radius-(box|inner)\)|var\(--mega-radius\)|0 0 var\(--mega-radius\) var\(--mega-radius\)|0 0 var\(--radius-box\) var\(--radius-box\)|calc\(var\(--radius\) - [46]px\)|1px)$/;

/** The favicon keeps the rounding of the app icon it is cut from. */
const isFavicon = (line: string) => line.includes('/favicon-');

describe('shapes', () => {
  it('buttons and boxes use only the three site radii', () => {
    const found: string[] = [];
    for (const file of files(src)) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          const rule = /border-radius\s*:\s*([^;]+);/.exec(line)?.[1].trim();
          const badRule = rule !== undefined && !ALLOWED_RULE.test(rule);
          const badClass = OTHER_CLASS.test(line) && !isFavicon(line);
          if (badRule || badClass)
            found.push(`${relative(src, file)}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });

  it('the scan catches what it is meant to catch', () => {
    for (const bad of [
      'class="rounded-md border"',
      "className='rounded-xl p-4'",
      'after:rounded-lg',
      'rounded-[12px]',
      'rounded-t-lg',
    ]) {
      expect(OTHER_CLASS.test(bad), bad).toBe(true);
    }
    for (const good of ['rounded-full', 'rounded-box', 'rounded-inner', '/* rounded corners */']) {
      expect(OTHER_CLASS.test(good), good).toBe(false);
    }
    for (const bad of ['14px', 'var(--radius)', 'calc(var(--radius) + 4px)', '0.75rem']) {
      expect(ALLOWED_RULE.test(bad), bad).toBe(false);
    }
  });
});
