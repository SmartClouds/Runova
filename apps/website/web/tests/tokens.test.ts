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

// The site is Dark only (design.md, Themes): its :root holds the app's Dark tokens, so it is compared
// with the app's :root plus .dark. It lifts its surfaces to a lighter charcoal than the app's near
// black. Accents, text and status colors still match the app exactly.
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

describe('design tokens match the desktop app', () => {
  const app = new Map([
    ...readTokenBlock(appCss, [':root', '.theme-light']),
    ...readTokenBlock(appCss, ['.dark']),
  ]);
  const site = readTokenBlock(siteCss, [':root']);

  it('declares every Dark token of the app with the same value', () => {
    expect(app.size).toBeGreaterThan(20);
    for (const [name, value] of app) {
      if (DARK_SURFACES.has(name)) continue;
      expect(site.get(name), name).toBe(value);
    }
  });

  it("adds no token the app does not have, except the site's own", () => {
    const extra = [...site.keys()].filter((name) => !app.has(name) && !siteOnly(name));
    expect(extra).toEqual([]);
  });

  it('declares no Light tokens and no separate Dark block', () => {
    expect(readTokenBlock(siteCss, [':root', '.theme-light']).size).toBe(0);
    expect(readTokenBlock(siteCss, ['.theme-light']).size).toBe(0);
    expect(readTokenBlock(siteCss, ['.dark']).size).toBe(0);
  });

  it('lifts every Dark surface above the app, keeping the order from page to raised surface', () => {
    const appDark = readTokenBlock(appCss, ['.dark']);
    for (const name of DARK_SURFACES) {
      expect(appDark.has(name), `the app declares ${name}`).toBe(true);
      expect(lightness(site.get(name) ?? ''), name).toBeGreaterThan(
        lightness(appDark.get(name) ?? ''),
      );
    }
    const l = (name: string) => lightness(site.get(name) ?? '');
    expect(l('--background')).toBeLessThan(l('--card'));
    expect(l('--card')).toBeLessThan(l('--secondary'));
    expect(l('--secondary')).toBeLessThan(l('--border'));
  });

  it('exposes the same Tailwind colors and radii as the app', () => {
    const appTheme = readTokenBlock(appCss, ['@theme inline']);
    const siteTheme = readTokenBlock(siteCss, ['@theme inline']);
    for (const [name, value] of appTheme) {
      expect(siteTheme.get(name), name).toBe(value);
    }
  });
});
