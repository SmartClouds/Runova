/**
 * Saves the diagram as a picture. The live SVG takes its colours from the theme through CSS
 * classes, which a file on its own would lose, so the copy gets every colour, line and font
 * written onto its elements. It is cropped to the tables, whatever part is on screen.
 */

export interface DiagramBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAD = 32;
const STYLES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-dasharray',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
] as const;

function inlineStyles(source: Element, copy: Element): void {
  const computed = getComputedStyle(source);
  const style = STYLES.map((name) => [name, computed.getPropertyValue(name)] as const)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  if (style) copy.setAttribute('style', style);
  copy.removeAttribute('class');
  const from = [...source.children];
  const to = [...copy.children];
  for (const [index, child] of from.entries()) {
    const other = to[index];
    if (other) inlineStyles(child, other);
  }
}

/** The diagram as a standalone SVG document, cropped to its tables. */
export function diagramSvg(svg: SVGSVGElement, bounds: DiagramBounds): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, copy);
  const width = Math.ceil(bounds.width + PAD * 2);
  const height = Math.ceil(bounds.height + PAD * 2);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));
  copy.setAttribute('viewBox', `0 0 ${width} ${height}`);
  for (const attribute of ['role', 'aria-label', 'aria-roledescription', 'tabindex', 'style']) {
    copy.removeAttribute(attribute);
  }
  copy
    .querySelector('[data-viewport]')
    ?.setAttribute('transform', `translate(${PAD - bounds.x} ${PAD - bounds.y})`);
  // A solid page instead of the dotted grid, in the theme's background colour.
  const backdrop = copy.querySelector('[data-backdrop]');
  if (backdrop) {
    const page = getComputedStyle(document.body).backgroundColor || '#ffffff';
    backdrop.setAttribute('style', `fill:${page}`);
    backdrop.removeAttribute('fill');
  }
  for (const node of copy.querySelectorAll('[tabindex],[role]')) {
    node.removeAttribute('tabindex');
    node.removeAttribute('role');
  }
  return new XMLSerializer().serializeToString(copy);
}

export function saveFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Draws the SVG onto a canvas at twice the size, so the PNG stays sharp. */
export function svgToPng(markup: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width * 2;
      canvas.height = image.height * 2;
      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error('This computer could not draw the picture.'));
        return;
      }
      context.scale(2, 2);
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No picture came out.'))));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This computer could not draw the picture.'));
    };
    image.src = url;
  });
}
