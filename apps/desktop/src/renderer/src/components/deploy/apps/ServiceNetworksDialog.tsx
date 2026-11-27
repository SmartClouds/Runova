import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ContainerSummary,
  NetworkInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { LinkOff, NetworkIcon, Plus, Spinner } from '@/components/icons';
import { Chip, EmptyState, Notice, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeNetwork, joinableNetworks } from '@/lib/deploy/apps/networks';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * The networks one service of an app joins besides its own. Picking another app's network and
 * adding it lets the service reach that app's containers by their service names, and them reach
 * it. The choice is saved with a new revision, so every later deploy and rollback keeps it.
 * Each joined network shows the address the service's containers have on it.
 */

/** One container's addresses on one network. */
interface ServiceAddress {
  container: string;
  ipv4?: string;
  ipv6?: string;
}

/** What the dialog knows of the service's addresses on one network. */
type AddressesState =
  | { kind: 'reading' }
  | { kind: 'failed' }
  | { kind: 'found'; addresses: ServiceAddress[] };

export interface ServiceNetworksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  /** The app's name, which is also its Compose project: its own networks are not offered. */
  app: string;
  service: string;
  /** The networks the service joins in the live revision. */
  joined: readonly string[];
  /** The service's containers right now, read in full for their address on each network. */
  containers?: readonly ContainerSummary[];
  busy: boolean;
  error?: string | null;
  /** Every network the service should join from now on. */
  onSave: (networks: string[], change: { added?: string; removed?: string }) => void;
}

export function ServiceNetworksDialog({
  open,
  onOpenChange,
  serverId,
  app,
  service,
  joined,
  containers = [],
  busy,
  error = null,
  onSave,
}: ServiceNetworksDialogProps): React.JSX.Element {
  const [picked, setPicked] = useState('');
  const [shownOpen, setShownOpen] = useState(open);
  // Each opening starts with nothing picked.
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) setPicked('');
  }
  const networks = useQuery({
    queryKey: queryKeys.deployNetworks(serverId),
    queryFn: () => window.runova.deployDocker.listNetworks(serverId),
    enabled: open,
    retry: false,
  });
  const inspected = useQueries({
    queries: containers.map((container) => ({
      queryKey: queryKeys.deployContainer(serverId, container.id),
      queryFn: () => window.runova.deployDocker.inspect(serverId, container.id),
      enabled: open,
      retry: false,
    })),
  });
  const byName = new Map((networks.data ?? []).map((network) => [network.name, network]));

  function addressesOn(network: string): AddressesState {
    const addresses: ServiceAddress[] = [];
    for (const read of inspected) {
      const on = read.data?.networks.find((entry) => entry.network === network);
      if (read.data && on && (on.ipAddress || on.ipv6Address)) {
        addresses.push({
          container: read.data.summary.name,
          ipv4: on.ipAddress || undefined,
          ipv6: on.ipv6Address || undefined,
        });
      }
    }
    if (addresses.length > 0) return { kind: 'found', addresses };
    if (inspected.some((read) => read.isPending)) return { kind: 'reading' };
    if (inspected.some((read) => read.isError)) return { kind: 'failed' };
    return { kind: 'found', addresses };
  }
  const options = joinableNetworks(networks.data ?? [], app, joined).map((network) => ({
    value: network.name,
    label: network.name,
    hint: describeNetwork(network),
    keywords: network.composeProject ? [network.composeProject] : [],
  }));

  async function remove(network: string): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Take ${service} off ${network}?`,
      description: `Containers on ${network} can no longer reach ${service} by name, and ${service} can no longer reach them. ${service} restarts on its other networks.`,
      confirmLabel: 'Leave the network',
      variant: 'destructive',
    });
    if (confirmed) {
      onSave(
        joined.filter((name) => name !== network),
        { removed: network },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Networks of {service}</DialogTitle>
          <DialogDescription>
            Add {service} to another app's network, so it reaches those containers by their service
            names and they reach it the same way.
          </DialogDescription>
        </DialogHeader>
        <form
          className={cn(SECTION_WELL, 'flex flex-wrap items-center gap-2 px-3 py-2.5')}
          onSubmit={(event) => {
            event.preventDefault();
            if (picked && !busy) onSave([...joined, picked], { added: picked });
          }}
        >
          <Combobox
            ariaLabel="Network to join"
            options={options}
            value={picked}
            onChange={setPicked}
            placeholder={
              networks.isPending
                ? 'Loading networks…'
                : options.length === 0
                  ? 'No other network to join'
                  : 'Pick a network'
            }
            searchPlaceholder="Find a network or an app"
            emptyText="No network matches."
            disabled={networks.isPending || options.length === 0 || busy}
            className="h-8 min-w-48 flex-1"
          />
          <Button type="submit" size="sm" disabled={!picked || busy}>
            {busy ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Add
          </Button>
          {networks.error && (
            <span className="basis-full text-xs text-destructive">
              Could not list the networks: {coreErrorMessage(networks.error)}
            </span>
          )}
        </form>
        <section className="space-y-2">
          <h4 className={SECTION_HEADING}>Joined networks</h4>
          {joined.length === 0 ? (
            <EmptyState
              size="sm"
              icon={NetworkIcon}
              title={`${service} is on this app's own network only.`}
            />
          ) : (
            <ul aria-label="Joined networks" className={cn(SECTION_WELL, 'settings-rows p-0')}>
              {joined.map((name) => (
                <JoinedRow
                  key={name}
                  name={name}
                  service={service}
                  addresses={addressesOn(name)}
                  several={containers.length > 1}
                  info={byName.get(name)}
                  missing={networks.isSuccess && !byName.has(name)}
                  busy={busy}
                  onRemove={() => void remove(name)}
                />
              ))}
            </ul>
          )}
        </section>
        {error && (
          <Notice tone="destructive" size="sm" role="alert">
            {error}
          </Notice>
        )}
        <p className="text-xs text-muted-foreground">
          Each change saves a new revision and deploys it. Only {service} restarts, and it stays on
          this app's own network too.
        </p>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JoinedRow({
  name,
  service,
  addresses,
  several,
  info,
  missing,
  busy,
  onRemove,
}: {
  name: string;
  service: string;
  addresses: AddressesState;
  /** The service runs more than one container, so each address names its container. */
  several: boolean;
  info?: NetworkInfo;
  missing: boolean;
  busy: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <li aria-label={name} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground">
        <NetworkIcon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm text-foreground">{name}</span>
          {info?.composeProject && (
            <Chip className="h-5 px-1.5 text-[10px]">App {info.composeProject}</Chip>
          )}
          {missing && (
            <Chip tone="warning" className="h-5 px-1.5 text-[10px]">
              Not on the server
            </Chip>
          )}
        </div>
        <NetworkAddresses network={name} service={service} state={addresses} several={several} />
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 hover:bg-destructive/10 hover:text-destructive"
        aria-label={`Remove ${name}`}
        disabled={busy}
        onClick={onRemove}
      >
        <LinkOff className="h-3.5 w-3.5" />
        Remove
      </Button>
    </li>
  );
}

/** The service's addresses on one network, each one ready to copy. */
function NetworkAddresses({
  network,
  service,
  state,
  several,
}: {
  network: string;
  service: string;
  state: AddressesState;
  several: boolean;
}): React.JSX.Element {
  if (state.kind === 'reading') {
    return (
      <span
        aria-hidden
        className="block h-5 w-28 rounded-md bg-foreground/[0.06] motion-safe:animate-pulse"
      />
    );
  }
  if (state.kind === 'failed') {
    return <p className="text-xs text-muted-foreground">Could not read the address.</p>;
  }
  if (state.addresses.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No address yet. {service} gets one once its container is on this network.
      </p>
    );
  }
  return (
    <ul aria-label={`Addresses of ${service} on ${network}`} className="flex flex-wrap gap-1.5">
      {state.addresses.map((address) => (
        <li
          key={address.container}
          className="flex min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.04] py-0.5 pl-2 pr-0.5 ring-1 ring-inset ring-border/60"
        >
          {several && (
            <span className="truncate text-[11px] text-muted-foreground">{address.container}</span>
          )}
          {address.ipv4 && <Address value={address.ipv4} />}
          {address.ipv6 && <Address value={address.ipv6} muted />}
        </li>
      ))}
    </ul>
  );
}

function Address({ value, muted = false }: { value: string; muted?: boolean }): React.JSX.Element {
  return (
    <span className="group flex min-w-0 items-center">
      <span
        className={cn(
          'truncate font-mono text-xs',
          muted ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {value}
      </span>
      <CopyButton text={value} label={`Copy the address ${value}`} className="h-5 w-5" />
    </span>
  );
}
