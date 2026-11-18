import type { TrafficCount } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { compactNumber, countryName } from '@shared/deploy/trafficFormat';
import { memo, useMemo, useState } from 'react';
import { CountryFlag } from '@/components/CountryFlag';
import { shadeStep } from '@/lib/deploy/traffic/geometry';
import { SHADE_MIX, shade } from './shades';
import map from './worldMap.json';

/**
 * The world as a choropleth (E109): each country shaded by its page views on one blue ramp that
 * grows with the log, so a single busy country does not wash out the rest. The shapes are world
 * atlas's 110m countries, turned into SVG paths once by scripts/build-world-map.mjs; this file is
 * loaded only when a report shows the map. The country list next to it carries every number, so
 * the map adds the picture and the hover, never the only way to a value.
 */

const STEPS = 5;
const COUNTRIES = Object.entries(map.countries as Record<string, string>);

export const WorldMap = memo(function WorldMap({
  counts,
  color,
  focused,
}: {
  counts: readonly TrafficCount[];
  /** The ramp's hue: the chart blue for the current theme. */
  color: string;
  /** A country picked in the list, outlined on the map. */
  focused: string | null;
}): React.JSX.Element {
  const [hovered, setHovered] = useState<{ code: string; x: number; y: number } | null>(null);
  const byCode = useMemo(
    () => new Map(counts.map((item) => [item.value.toUpperCase(), item.count])),
    [counts],
  );
  const max = useMemo(() => Math.max(0, ...counts.map((item) => item.count)), [counts]);
  const fills = useMemo(
    () =>
      COUNTRIES.map(([code, d]) => ({
        code,
        d,
        fill: shade(shadeStep(byCode.get(code) ?? 0, max, STEPS), color),
      })),
    [byCode, max, color],
  );
  const outlined = hovered?.code ?? focused;
  const outline = outlined ? (map.countries as Record<string, string>)[outlined] : undefined;
  const placed = COUNTRIES.filter(([code]) => (byCode.get(code) ?? 0) > 0).length;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${map.width} ${map.height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`World map of page views by country, ${placed} ${placed === 1 ? 'country' : 'countries'} with visits. The list beside it has every number.`}
        onPointerLeave={() => setHovered(null)}
      >
        {fills.map((country) => (
          <path
            key={country.code}
            d={country.d}
            fill={country.fill}
            stroke="hsl(var(--card))"
            strokeWidth={0.6}
            onPointerMove={(event) => {
              const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
              setHovered({
                code: country.code,
                x: box ? ((event.clientX - box.left) / Math.max(1, box.width)) * 100 : 50,
                y: box ? ((event.clientY - box.top) / Math.max(1, box.height)) * 100 : 50,
              });
            }}
          />
        ))}
        {outline && (
          <path
            d={outline}
            fill="none"
            stroke="hsl(var(--foreground))"
            strokeWidth={1.2}
            pointerEvents="none"
          />
        )}
      </svg>
      {hovered && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 flex min-w-max items-center gap-2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: `${Math.min(80, hovered.x)}%`,
            top: `${hovered.y}%`,
            transform: 'translate(8px, -120%)',
          }}
        >
          <CountryFlag countryCode={hovered.code} className="h-3 w-[18px] rounded-[2px]" />
          <span className="font-semibold">{compactNumber(byCode.get(hovered.code) ?? 0)}</span>
          <span className="text-muted-foreground">{countryName(hovered.code)}</span>
        </div>
      )}
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground" aria-hidden>
        <span>Fewer</span>
        {SHADE_MIX.slice(1).map((_, index) => (
          <span
            key={index}
            className="h-2 w-5 rounded-sm"
            style={{ background: shade(index + 1, color) }}
          />
        ))}
        <span>More page views</span>
      </div>
    </div>
  );
});
