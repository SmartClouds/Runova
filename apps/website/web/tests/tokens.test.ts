import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readTokenBlock } from './cssTokens';

const appCss = readFileSync(
  fileURLToPath(new URL('../../../desktop/src/renderer/src/index.css', import.meta.url)),
  'utf8',
);
const siteCss = readFileSync(
  fileURLToPath(new URL('../src/styles/global.css', import.meta.url)),
  'utf8',
);

// Tokens the site adds on its own (design.md). The severity colors join the app in T024; once the
// app declares them, the comparison below covers them too.
const siteOnly = (name: string) => name === '--glow' || name.startsWith('--severity-');

// In Dark the site lifts its surfaces to a lighter charcoal than the app's near black (design.md,
// Themes). Accents, text and status colors still match the app exactly.
const DARK_SURFACES = new Set([
  '--background',
  '--card',
  '--popover',
  '--secondary',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--border',
  '--input',
]);

const lightness = (value: string) => Number(/(\d+(?:\.\d+)?)%\s*$/.exec(value)?.[1]);

const themes = [
  { name: 'Light', selector: [':root', '.theme-light'], own: new Set<string>() },
  { name: 'Dark', selector: ['.dark'], own: DARK_SURFACES },
];

describe('design tokens match the desktop app', () => {
  const appLight = readTokenBlock(appCss, [':root', '.theme-light']);

  for (const theme of themes) {
    it(`declares every ${theme.name} token of the app with the same value`, () => {
      const app = new Map([...appLight, ...readTokenBlock(appCss, theme.selector)]);
      const site = new Map([
        ...readTokenBlock(siteCss, [':root', '.theme-light']),
        ...readTokenBlock(siteCss, theme.selector),
      ]);
      expect(app.size).toBeGreaterThan(20);
      for (const [name, value] of app) {
        if (theme.own.has(name)) continue;
        expect(site.get(name), `${theme.name} ${name}`).toBe(value);
      }
    });

    it(`adds no ${theme.name} token the app does not have, except the site's own`, () => {
      const app = new Map([...appLight, ...readTokenBlock(appCss, theme.selector)]);
      const extra = [...readTokenBlock(siteCss, theme.selector).keys()].filter(
        (name) => !app.has(name) && !siteOnly(name),
      );
      expect(extra).toEqual([]);
    });
  }

  it('lifts every Dark surface above the app, keeping the order from page to raised surface', () => {
    const app = readTokenBlock(appCss, ['.dark']);
    const site = readTokenBlock(siteCss, ['.dark']);
    for (const name of DARK_SURFACES) {
      expect(app.has(name), `the app declares ${name}`).toBe(true);
      expect(lightness(site.get(name) ?? ''), name).toBeGreaterThan(lightness(app.get(name) ?? ''));
    }
    const l = (name: string) => lightness(site.get(name) ?? '');
    expect(l('--background')).toBeLessThan(l('--card'));
    expect(l('--card')).toBeLessThan(l('--secondary'));
    expect(l('--secondary')).toBeLessThan(l('--border'));
  });

  it('exposes the same Tailwind colors and radii as the app', () => {
    const app = readTokenBlock(appCss, ['@theme inline']);
    const site = readTokenBlock(siteCss, ['@theme inline']);
    for (const [name, value] of app) {
      expect(site.get(name), name).toBe(value);
    }
  });
});
