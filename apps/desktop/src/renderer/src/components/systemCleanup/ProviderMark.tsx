import type { CacheProviderId } from '@runova/core';
import {
  siBun,
  siDart,
  siElectron,
  siGo,
  siGradle,
  siNodedotjs,
  siNpm,
  siNuget,
  siPnpm,
  siPypi,
  siRust,
} from 'simple-icons';
import { Globe, Package } from '@/components/icons';
import { useReadableAccent } from '@/lib/chartColors';
import { cn } from '@/lib/utils';

/**
 * The little logo on a cache's card. It is for recognising the tool at a glance, so it is hidden
 * from screen readers; the name next to it says the same thing in words. Marks come from the
 * brand set the app already ships. A tool without one (Playwright) gets a plain icon.
 */

interface Brand {
  path: string;
  hex: string;
}

const BRANDS: Partial<Record<CacheProviderId, Brand>> = {
  nuget: siNuget,
  'nuget-http': siNuget,
  bun: siBun,
  cargo: siRust,
  'go-mod': siGo,
  'go-build': siGo,
  pub: siDart,
  'gradle-dists': siGradle,
  'gradle-caches': siGradle,
  electron: siElectron,
  'node-gyp': siNodedotjs,
  npm: siNpm,
  pnpm: siPnpm,
  pip: siPypi,
};

function BrandGlyph({ brand }: { brand: Brand }): React.JSX.Element {
  // The brand colour, nudged until it can be read on the surface behind it in either theme.
  const color = useReadableAccent(`#${brand.hex}`);
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path d={brand.path} fill={color} />
    </svg>
  );
}

export function ProviderMark({
  id,
  className,
}: {
  id: CacheProviderId;
  className?: string;
}): React.JSX.Element {
  const brand = BRANDS[id];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] ring-1 ring-inset ring-foreground/[0.08]',
        className,
      )}
    >
      {brand ? (
        <BrandGlyph brand={brand} />
      ) : id === 'playwright' ? (
        <Globe className="h-5 w-5 text-muted-foreground" />
      ) : (
        <Package className="h-5 w-5 text-muted-foreground" />
      )}
    </span>
  );
}
