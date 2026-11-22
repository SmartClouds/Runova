import { create } from 'qrcode';
import { describe, expect, it } from 'vitest';
import { qrPath, qrViewBox } from '../src/lib/qr';

/**
 * The QR codes on the site are drawn as one SVG path (the account panel's sign-in code and the
 * demo page). A path needs no inline HTML or image, which the site's CSP would refuse.
 */

const TEXT = 'https://runovahq.com/demo';

/** The dark modules a path draws, as "x,y". */
const drawn = (path: string) =>
  new Set([...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((match) => `${match[1]},${match[2]}`));

describe('qrPath', () => {
  it('draws one square per dark module and nothing else', () => {
    const { path } = qrPath(TEXT);
    expect(path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });

  it('draws exactly the modules qrcode gives, at medium error correction', () => {
    const { modules } = create(TEXT, { errorCorrectionLevel: 'M' });
    const { size, path } = qrPath(TEXT);
    expect(size).toBe(modules.size);
    const squares = drawn(path);
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!modules.get(y, x)) continue;
        dark++;
        expect(squares.has(`${x},${y}`), `${x},${y}`).toBe(true);
      }
    }
    expect(squares.size).toBe(dark);
  });

  it('has the three finder patterns in their corners', () => {
    const { size, path } = qrPath(TEXT);
    const squares = drawn(path);
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      // The outer ring of a finder is dark, the ring inside it light, the 3x3 center dark.
      expect(squares.has(`${x},${y}`)).toBe(true);
      expect(squares.has(`${x + 1},${y + 1}`)).toBe(false);
      expect(squares.has(`${x + 3},${y + 3}`)).toBe(true);
    }
  });

  it('gives the same path for the same text and a different one for other text', () => {
    expect(qrPath(TEXT)).toEqual(qrPath(TEXT));
    expect(qrPath(`${TEXT}x`).path).not.toBe(qrPath(TEXT).path);
  });
});

describe('qrViewBox', () => {
  it('leaves a quiet zone of four modules on every side by default', () => {
    expect(qrViewBox(25)).toBe('-4 -4 33 33');
  });

  it('takes a narrower quiet zone where the code sits on its own light box', () => {
    expect(qrViewBox(25, 2)).toBe('-2 -2 29 29');
  });
});
