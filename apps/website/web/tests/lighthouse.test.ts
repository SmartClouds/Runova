import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The budgets from docs/epics/40-website.md (SEO rules) and T014, checked by `bun run lighthouse`.
const config = JSON.parse(readFileSync(new URL('../lighthouserc.json', import.meta.url), 'utf8'));
const { collect, assert } = config.ci;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

describe('lighthouserc', () => {
  it('runs against the built site served by bun run preview', () => {
    expect(collect.startServerCommand).toBe('bun run preview');
    expect(pkg.scripts.preview).toBe('bun scripts/preview.ts');
    expect(collect.url).toEqual([expect.stringMatching(/^http:\/\/localhost:\d+\/$/)]);
    expect(collect.numberOfRuns).toBeGreaterThanOrEqual(3);
  });

  it('uses mobile emulation', () => {
    const settings = collect.settings ?? {};
    expect(settings.preset ?? 'mobile').toBe('mobile');
    expect(settings.formFactor ?? 'mobile').toBe('mobile');
    expect(settings.screenEmulation?.mobile ?? true).toBe(true);
  });

  it('asserts the category budgets as errors', () => {
    expect(assert.assertions).toMatchObject({
      'categories:performance': ['error', { minScore: 0.9 }],
      'categories:accessibility': ['error', { minScore: 0.95 }],
      'categories:best-practices': ['error', { minScore: 0.95 }],
      'categories:seo': ['error', { minScore: 1 }],
    });
  });

  it('asserts LCP under 2.5 s and CLS under 0.1', () => {
    expect(assert.assertions).toMatchObject({
      'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
      'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
    });
  });

  it('has a lighthouse script that builds the site and runs lhci', () => {
    expect(pkg.scripts.lighthouse).toBe('bun scripts/lighthouse.ts');
    const script = readFileSync(new URL('../scripts/lighthouse.ts', import.meta.url), 'utf8');
    expect(script).toContain('SITE_URL');
    expect(script).toContain('lhci');
    expect(script).toContain('CHROME_PATH');
  });

  it('keeps the lhci output out of git', () => {
    const lines = gitignore.split('\n').map((line: string) => line.trim());
    expect(lines).toContain('.lighthouseci/');
  });
});
