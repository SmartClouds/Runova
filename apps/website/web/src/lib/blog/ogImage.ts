import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { create, type Font } from 'fontkitten';
import sharp from 'sharp';

/**
 * The Open Graph image of a post without a cover: its title on the site's dark background, drawn
 * from Bricolage Grotesque's glyph outlines into an SVG that sharp turns into a 1200x630 PNG.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const PADDING = 80;
const TITLE_SIZE = 68;
const TITLE_LINE_HEIGHT = 80;
const SMALL_SIZE = 30;
const MAX_LINES = 3;

// The dark theme's tokens from global.css.
const BACKGROUND = '#0a0a0a';
const FOREGROUND = '#f2f2f2';
const PRIMARY = '#00e673';
const MUTED = '#9e9e9e';

/**
 * Breaks a title at spaces into lines no wider than `width`. A title that needs more than three
 * lines keeps three, and the last one ends with an ellipsis.
 */
export function titleLines(
  title: string,
  width: number,
  measure: (text: string) => number,
): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let index = 0;
  while (index < words.length && lines.length < MAX_LINES) {
    let line = words[index++];
    while (index < words.length && measure(`${line} ${words[index]}`) <= width) {
      line = `${line} ${words[index++]}`;
    }
    lines.push(line);
  }
  if (index < words.length) {
    let last = lines.pop() ?? '';
    while (last.includes(' ') && measure(`${last}…`) > width) {
      last = last.slice(0, last.lastIndexOf(' '));
    }
    lines.push(`${last.replace(/[\s,;:.]+$/, '')}…`);
  }
  return lines;
}

const require = createRequire(import.meta.url);
const FONT_FILES = [
  '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2',
  '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-ext-wght-normal.woff2',
];

let fonts: Promise<Font[]> | undefined;

/** The latin subset first, then latin-ext for the letters it lacks. Read once per process. */
function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all(
    FONT_FILES.map(async (file) => create(await readFile(require.resolve(file))) as Font),
  );
  return fonts;
}

function glyphFor(list: Font[], codePoint: number) {
  const font = list.find((candidate) => candidate.hasGlyphForCodePoint(codePoint)) ?? list[0];
  return { font, glyph: font.glyphForCodePoint(codePoint) };
}

function measureText(list: Font[], text: string, size: number): number {
  let width = 0;
  for (const char of text) {
    const { font, glyph } = glyphFor(list, char.codePointAt(0) ?? 0);
    width += (glyph.advanceWidth * size) / font.unitsPerEm;
  }
  return width;
}

/** One line of text as SVG paths, with its baseline at `y`. */
function textPaths(list: Font[], text: string, x: number, y: number, size: number, fill: string) {
  const paths: string[] = [];
  let left = x;
  for (const char of text) {
    const { font, glyph } = glyphFor(list, char.codePointAt(0) ?? 0);
    const scale = size / font.unitsPerEm;
    const d = glyph.path.toSVG();
    if (d) {
      paths.push(
        `<path transform="translate(${left.toFixed(2)} ${y}) scale(${scale} ${-scale})" d="${d}"/>`,
      );
    }
    left += glyph.advanceWidth * scale;
  }
  return `<g fill="${fill}">${paths.join('')}</g>`;
}

export interface OgImageInput {
  title: string;
  /** The line under the title, such as the author and the date. */
  byline: string;
}

/** The post's title card as a PNG. */
export async function renderOgImage({ title, byline }: OgImageInput): Promise<Buffer> {
  const list = await loadFonts();
  const width = OG_WIDTH - 2 * PADDING;
  const lines = titleLines(title, width, (text) => measureText(list, text, TITLE_SIZE));
  // The title sits in the middle of the card, between the label and the byline.
  const top = (OG_HEIGHT - lines.length * TITLE_LINE_HEIGHT) / 2 + TITLE_SIZE * 0.8;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">`,
    `<rect width="100%" height="100%" fill="${BACKGROUND}"/>`,
    `<rect x="${PADDING}" y="${PADDING - 8}" width="64" height="8" rx="4" fill="${PRIMARY}"/>`,
    textPaths(list, 'Runova blog', PADDING, PADDING + 44, SMALL_SIZE, PRIMARY),
    ...lines.map((line, index) =>
      textPaths(
        list,
        line,
        PADDING,
        Math.round(top + index * TITLE_LINE_HEIGHT),
        TITLE_SIZE,
        FOREGROUND,
      ),
    ),
    textPaths(list, byline, PADDING, OG_HEIGHT - PADDING, SMALL_SIZE, MUTED),
    '</svg>',
  ].join('');
  return sharp(Buffer.from(svg)).png().toBuffer();
}
