/**
 * WCAG 2.2 contrast for the site's tokens, which are written as `H S% L%` (the triplet inside
 * `hsl(var(--token))`).
 */

export type Rgb = [number, number, number];

/** A token value such as `150 100% 45%` as sRGB channels from 0 to 1. */
export function parseHslToken(value: string): Rgb {
  const match = /^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(value);
  if (!match) throw new Error(`Not an H S% L% token: ${value}`);
  const h = Number(match[1]);
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

/** `color` laid over `under` at `alpha`, as a 12% tint is. */
export function mix(color: Rgb, under: Rgb, alpha: number): Rgb {
  return color.map((channel, i) => channel * alpha + under[i] * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colors, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
