import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

/** The body of the first `@media (...)` block whose condition contains `condition`. */
function mediaBlock(condition: string): string {
  const start = css.indexOf(`@media (${condition})`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  return '';
}

/** The declarations of `selector` inside `block`. */
function rule(block: string, selector: string): string {
  const start = block.indexOf(`${selector} {`);
  if (start < 0) return '';
  return block.slice(start, block.indexOf('}', start));
}

// design.md, Motion: 300ms for page view transitions, the entrance easing for the page coming in
// and the exit easing for the page going out.
describe('view transitions between pages', () => {
  const motion = mediaBlock('prefers-reduced-motion: no-preference');

  it('are on for cross-document navigation when motion is allowed', () => {
    expect(motion).toMatch(/@view-transition\s*\{\s*navigation:\s*auto;/);
  });

  it('fade the old page out in 300ms with the exit easing', () => {
    const old = rule(motion, '::view-transition-old(root)');
    expect(old).toMatch(/animation-duration:\s*300ms;/);
    expect(old).toMatch(/animation-timing-function:\s*cubic-bezier\(0\.4, 0, 1, 1\);/);
  });

  it('bring the new page in over 300ms with the entrance easing', () => {
    const next = rule(motion, '::view-transition-new(root)');
    expect(next).toMatch(/animation-duration:\s*300ms;/);
    expect(next).toMatch(/animation-timing-function:\s*cubic-bezier\(0\.2, 0, 0, 1\);/);
  });

  it('are off under reduced motion', () => {
    expect(mediaBlock('prefers-reduced-motion: reduce')).toMatch(
      /@view-transition\s*\{\s*navigation:\s*none;/,
    );
  });
});
