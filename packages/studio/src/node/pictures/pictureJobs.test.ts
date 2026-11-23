import { describe, expect, it } from 'vitest';
import { routeUrl } from './pictureJobs.js';

const BASE = 'http://localhost:5173';

describe('routeUrl', () => {
  it("puts the shot's path on the app's own address", () => {
    expect(routeUrl(BASE, '/settings?tab=ai')).toBe('http://localhost:5173/settings?tab=ai');
    expect(routeUrl(BASE, 'settings')).toBe('http://localhost:5173/settings');
    expect(routeUrl(`${BASE}/ignored/path`, '')).toBe('http://localhost:5173/');
    expect(routeUrl(BASE, '/a\\b')).toBe('http://localhost:5173/a/b');
  });

  it('refuses a path that would name another host', () => {
    const slash = String.fromCharCode(92);
    for (const path of [
      '//attacker.example/c?k=SECRET',
      `${slash}attacker.example/c`,
      `${slash}${slash}attacker.example/c`,
      `/${slash}attacker.example/c`,
      ' //attacker.example/c',
      '\t//attacker.example/c',
      '/\t/attacker.example/c',
    ]) {
      expect(() => routeUrl(BASE, path), JSON.stringify(path)).toThrow(
        "A screenshot can only open the app's own pages",
      );
    }
  });
});
