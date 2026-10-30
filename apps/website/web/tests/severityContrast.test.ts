import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readTokenBlock } from './cssTokens';
import { contrastRatio, mix, parseHslToken } from './helpers/contrast';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

const LEVELS = ['info', 'low', 'medium', 'high', 'critical'];

// WCAG 2.2 AA for normal text, which the severity labels are.
const AA = 4.5;

const themes = [
  { name: 'Light', tokens: readTokenBlock(css, [':root', '.theme-light']) },
  {
    name: 'Dark',
    tokens: new Map([
      ...readTokenBlock(css, [':root', '.theme-light']),
      ...readTokenBlock(css, ['.dark']),
    ]),
  },
];

function color(tokens: Map<string, string>, name: string) {
  const value = tokens.get(name);
  if (!value) throw new Error(`${name} is not declared`);
  return parseHslToken(value);
}

// docs/website/design.md, Severity colors: each color as text and icon on --background, --card and
// --muted, and the badge (the color on a 12% tint of itself) where the site puts it, on the page
// background.
describe('severity colors', () => {
  for (const theme of themes) {
    for (const level of LEVELS) {
      const token = `--severity-${level}`;

      it(`${theme.name} ${level} meets AA on the background, cards and muted surfaces`, () => {
        const severity = color(theme.tokens, token);
        for (const surface of ['--background', '--card', '--muted']) {
          const ratio = contrastRatio(severity, color(theme.tokens, surface));
          expect(ratio, `${token} on ${surface}`).toBeGreaterThanOrEqual(AA);
        }
      });

      it(`${theme.name} ${level} meets AA as a badge on the page background`, () => {
        const severity = color(theme.tokens, token);
        const tint = mix(severity, color(theme.tokens, '--background'), 0.12);
        expect(contrastRatio(severity, tint)).toBeGreaterThanOrEqual(AA);
      });
    }

    it(`${theme.name} gives every level its own color`, () => {
      const values = LEVELS.map((level) => theme.tokens.get(`--severity-${level}`));
      expect(new Set(values).size).toBe(LEVELS.length);
    });
  }

  it('matches the lowest ratios design.md gives for the plain colors', () => {
    // A sanity check of the math against the spec table (info, Dark 6.03 and Light 5.85).
    const lowest = (tokens: Map<string, string>) =>
      Math.min(
        ...['--background', '--card', '--muted'].map((surface) =>
          contrastRatio(color(tokens, '--severity-info'), color(tokens, surface)),
        ),
      );
    expect(lowest(themes[1].tokens)).toBeCloseTo(6.03, 2);
    expect(lowest(themes[0].tokens)).toBeCloseTo(5.85, 2);
  });
});
