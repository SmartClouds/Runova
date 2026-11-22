import { create } from 'qrcode';

/**
 * QR codes on the site are drawn as one SVG path: a 1x1 square per dark module. A path needs no
 * inline HTML and no image, which the site's CSP would refuse.
 */
export interface QrPath {
  /** The number of modules on each side. */
  size: number;
  /** The `d` of a path that draws every dark module. */
  path: string;
}

/** The path that draws `text` as a QR code, at medium error correction. */
export function qrPath(text: string): QrPath {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  let path = '';
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (modules.get(y, x)) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return { size: modules.size, path };
}

/**
 * The viewBox for a code of `size` modules with `quiet` light modules around it. Scanners want
 * four; a code drawn on a light box of its own can do with less.
 */
export function qrViewBox(size: number, quiet = 4): string {
  return `${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`;
}
