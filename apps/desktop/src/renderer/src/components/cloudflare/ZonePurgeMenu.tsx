import type { CloudflareZone } from '@shared/cloudflareTypes';
import { useRef, useState } from 'react';
import { Broom, ChevronDown } from '@/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PurgeEverythingDialog } from './PurgeEverythingDialog';

/**
 * Purge cache in the zone's header, beside the quick switches, so a purge is one click from every
 * tab. It is an action, not a setting, so it is drawn like a switch that is off and opens a menu:
 * pick what to purge (the Caching tab's card, with focus in its list) or purge everything behind
 * typing the domain's name. It stays when the switches cannot load, since purging needs its own
 * permission and the dialog says so when the token lacks it.
 */
export function ZonePurgeMenu({
  zone,
  onChoose,
}: {
  zone: CloudflareZone;
  /** Opens the Purge cache card, for URLs, folders or hostnames. */
  onChoose: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  // Set when Choose is picked. The card is opened only once the menu has closed: while it is open
  // the menu keeps focus inside itself, and on closing it would hand focus back to its button.
  const choosing = useRef(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Purge cache"
            className="flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-full bg-foreground/[0.03] py-1 pl-1 pr-2.5 text-left text-foreground outline-none ring-1 ring-inset ring-foreground/10 transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.06]"
          >
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <Broom />
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-xs font-medium">Purge cache</span>
              <span className="truncate text-[11px] text-muted-foreground">
                Clear Cloudflare's copies
              </span>
            </span>
            <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (!choosing.current) return;
            choosing.current = false;
            event.preventDefault();
            onChoose();
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              choosing.current = true;
            }}
          >
            Choose URLs, folders or hostnames…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger" onSelect={() => setConfirming(true)}>
            Purge everything…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PurgeEverythingDialog zone={zone} open={confirming} onOpenChange={setConfirming} />
    </>
  );
}
