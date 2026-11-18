import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHONE_SHOTS } from '../src/lib/home';
import { forbiddenPhrases } from './helpers/textScan';

interface PhoneEntry {
  name: string;
  source: string;
  alt: string;
}

const shotsDir = new URL('../src/assets/phone/', import.meta.url);
const snapshotsDir = new URL('../../../mobile/android/app/src/test/snapshots/', import.meta.url);
const manifest: PhoneEntry[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('manifest.json', shotsDir)), 'utf8'),
);

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: URL): { width: number; height: number } {
  const bytes = readFileSync(fileURLToPath(file));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('phone screens', () => {
  it('lists each name once, and every screen the home page shows', () => {
    const names = manifest.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([...PHONE_SHOTS]));
  });

  it('has an entry for every image in the folder', () => {
    const images = readdirSync(shotsDir).filter((file) => file.endsWith('.png'));
    expect(images.sort()).toEqual(manifest.map((entry) => `${entry.name}.png`).sort());
  });

  it('keeps each screen at the Android snapshot size (390x844 at 3x)', () => {
    for (const entry of manifest) {
      expect(pngSize(new URL(`${entry.name}.png`, shotsDir)), entry.name).toEqual({
        width: 1170,
        height: 2532,
      });
    }
  });

  it('names the Roborazzi snapshot each screen was copied from', () => {
    for (const entry of manifest) {
      expect(existsSync(new URL(entry.source, snapshotsDir)), entry.source).toBe(true);
    }
  });

  it('describes each screen in its alt text, with no forbidden phrase', () => {
    const phrases = forbiddenPhrases();
    for (const entry of manifest) {
      expect(entry.alt.length, entry.name).toBeGreaterThan(40);
      expect(entry.alt).not.toContain('—');
      const alt = entry.alt.toLowerCase();
      expect(
        phrases.filter((phrase) => alt.includes(phrase)),
        entry.name,
      ).toEqual([]);
    }
  });
});
