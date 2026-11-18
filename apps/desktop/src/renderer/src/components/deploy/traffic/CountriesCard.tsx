import type { TrafficReport } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { sourcesText } from '@shared/deploy/trafficFormat';
import { lazy, Suspense, useMemo, useState } from 'react';
import { ExternalLink, Globe } from '@/components/icons';
import { PillTabs } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useChartColors } from '@/lib/chartColors';
import { breakdownRows } from '@/lib/deploy/traffic/geometry';
import { breakdownOf, catchAllsLast } from '@/lib/deploy/traffic/report';
import { DeployCard } from '../deployKit';
import { BreakdownRows } from './BreakdownCard';
import { TEXT } from './messages';

const WorldMap = lazy(() => import('./WorldMap').then((module) => ({ default: module.WorldMap })));
const DimensionDialog = lazy(() =>
  import('./DimensionDialog').then((module) => ({ default: module.DimensionDialog })),
);

const SHOWN = 8;
const DB_IP = 'https://db-ip.com';

type Place = 'country' | 'city';

/**
 * Where visitors are: a world map shaded by page views, the top countries with their flags (or the
 * top cities, when Cloudflare sends them), where each country came from, and DB-IP's credit, which
 * its licence asks for wherever its data shows.
 */
export function CountriesCard({
  serverId,
  report,
  countriesOn,
}: {
  serverId: string;
  report: TrafficReport;
  /** False when countries are turned off in the settings. */
  countriesOn: boolean;
}): React.JSX.Element {
  const { blue } = useChartColors();
  const [place, setPlace] = useState<Place>('country');
  const [focused, setFocused] = useState<string | null>(null);
  const [seeAll, setSeeAll] = useState(false);
  const countries = breakdownOf(report, 'country');
  const cities = breakdownOf(report, 'city');
  const hasCities = cities.top.length > 0;
  const shown = place === 'city' && hasCities ? cities : countries;
  const rows = useMemo(
    () => breakdownRows(catchAllsLast(shown.top.slice(0, SHOWN), shown.dimension), shown.total),
    [shown],
  );
  const sources = sourcesText(report.countrySources);
  const range = { fromUnixMs: report.fromUnixMs, toUnixMs: report.toUnixMs };

  return (
    <DeployCard
      icon={<Globe />}
      title="Where visitors are"
      description={sources ? `Countries: ${sources}.` : 'By page views'}
      className="@container/places"
      actions={
        <>
          {hasCities && (
            <PillTabs
              id="traffic-places"
              label="Show countries or cities"
              kind="toggle"
              size="xs"
              items={[
                { value: 'country', label: 'Countries' },
                { value: 'city', label: 'Cities' },
              ]}
              value={place}
              onChange={setPlace}
            />
          )}
          {shown.top.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSeeAll(true)}>
              {TEXT.seeAll}
            </Button>
          )}
        </>
      }
    >
      {!countriesOn ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{TEXT.noCountries}</p>
      ) : (
        <div className="grid gap-4 @2xl/places:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Suspense fallback={<Skeleton className="aspect-[2/1] w-full rounded-lg" />}>
            <WorldMap counts={countries.top} color={blue} focused={focused} />
          </Suspense>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{TEXT.nothingHere}</p>
          ) : (
            // Pointing at a country in the list outlines it on the map.
            <div
              onPointerOver={(event) => {
                const item = (event.target as HTMLElement).closest('li');
                const index = item ? [...(item.parentElement?.children ?? [])].indexOf(item) : -1;
                setFocused(place === 'country' && index >= 0 ? (rows[index]?.value ?? null) : null);
              }}
              onPointerLeave={() => setFocused(null)}
            >
              <BreakdownRows
                dimension={shown.dimension}
                rows={rows}
                label={place === 'city' ? 'Cities' : 'Countries'}
              />
            </div>
          )}
        </div>
      )}
      <p className="mt-3 flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground/80 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void window.runova.shell.openExternal(DB_IP)}
        >
          {TEXT.dbIpCredit}
          <ExternalLink className="h-2.5 w-2.5" aria-hidden />
        </button>
        <span>({TEXT.dbIpLicence}), for visitors Cloudflare did not place.</span>
      </p>
      {seeAll && (
        <Suspense fallback={null}>
          <DimensionDialog
            serverId={serverId}
            siteId={report.siteId && report.siteId !== '*' ? report.siteId : null}
            range={range}
            dimension={shown.dimension}
            onClose={() => setSeeAll(false)}
          />
        </Suspense>
      )}
    </DeployCard>
  );
}
