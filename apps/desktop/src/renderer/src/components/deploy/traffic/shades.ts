/**
 * The one-hue ramps the traffic report shades with (E109): the map in the chart blue, the hours of
 * the week in the chart green. Each step mixes more of the hue into the card, so the ramp follows
 * the theme without a colour of its own; step 0 is "none", a faint grey.
 */

/** How much of the hue each step mixes into the card, from faint to full. */
export const SHADE_MIX = [0, 22, 40, 58, 78, 100];

export function shade(step: number, color: string): string {
  return step === 0
    ? 'hsl(var(--foreground) / 0.07)'
    : `color-mix(in oklab, ${color} ${SHADE_MIX[step]}%, hsl(var(--card)))`;
}
