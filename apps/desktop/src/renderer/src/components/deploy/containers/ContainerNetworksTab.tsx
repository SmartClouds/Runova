import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ContainerDetails,
  ContainerNetwork,
  ContainerSummary,
  NetworkInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { LinkOff, NetworkIcon, Plus, Spinner } from '@/components/icons';
import { Chip, EmptyState, Notice, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { CopyButton } from '@/components/ui/copy-button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * The networks one container is on, with its address, gateway and MAC on each, and the names
 * other containers there reach it by. Operators join it to another network or take it off one;
 * Docker picks the address. A container on the server's own network (host) or on none cannot
 * join others, so the picker is not offered there.
 */

/** Docker refuses these as a second network, so the picker leaves them out. */
const SOLO_NETWORKS = new Set(['host', 'none']);

function Address({ label, value }: { label: string; value?: string }): React.JSX.Element {
  return (
    <div className="group min-w-0 space-y-0.5">
      <dt className={SECTION_HEADING}>{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-sm">
        {value ? (
          <>
            <span className="truncate font-mono text-xs text-foreground">{value}</span>
            <CopyButton text={value} label={`Copy the ${label}`} className="h-5 w-5" />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        )}
      </dd>
    </div>
  );
}

function NetworkRow({
  network,
  info,
  canLeave,
  busy,
  onLeave,
}: {
  network: ContainerNetwork;
  info?: NetworkInfo;
  canLeave: boolean;
  busy: boolean;
  onLeave: () => void;
}): React.JSX.Element {
  return (
    <li aria-label={network.network} className={cn(SECTION_WELL, 'space-y-3 p-4')}>
      <div className="flex min-w-0 items-center gap-2">
        <NetworkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-sm font-medium text-foreground">
          {network.network}
        </span>
        {info?.builtIn && <Chip className="h-5 px-1.5 text-[10px]">Built in</Chip>}
        {info?.composeProject && (
          <Chip className="h-5 px-1.5 text-[10px]">Project {info.composeProject}</Chip>
        )}
        {info?.internal && <Chip className="h-5 px-1.5 text-[10px]">Internal only</Chip>}
        {canLeave && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0 hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Leave ${network.network}`}
            disabled={busy}
            onClick={onLeave}
          >
            {busy ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <LinkOff className="h-3.5 w-3.5" />
            )}
            Leave
          </Button>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Address label="IPv4 address" value={network.ipAddress} />
        <Address label="IPv6 address" value={network.ipv6Address} />
        <Address label="Gateway" value={network.gateway ?? network.ipv6Gateway} />
        <Address label="MAC address" value={network.macAddress} />
      </dl>
      {network.dnsNames && network.dnsNames.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Other containers on it reach this one as{' '}
          <span className="font-mono text-foreground">{network.dnsNames.join(', ')}</span>
        </p>
      )}
    </li>
  );
}

export function ContainerNetworksTab({
  serverId,
  container,
  details,
  canOperate,
}: {
  serverId: string;
  container: ContainerSummary;
  details: ContainerDetails;
  canOperate: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const networks = useQuery({
    queryKey: queryKeys.deployNetworks(serverId),
    queryFn: () => window.runova.deployDocker.listNetworks(serverId),
    retry: false,
  });

  const joined = new Set(details.networks.map((network) => network.network));
  const solo = details.networks.find((network) => SOLO_NETWORKS.has(network.network))?.network;
  const byName = new Map((networks.data ?? []).map((network) => [network.name, network]));
  const options = (networks.data ?? [])
    .filter((network) => !joined.has(network.name) && !SOLO_NETWORKS.has(network.name))
    .map((network) => ({
      value: network.name,
      label: network.name,
      hint: network.subnets[0] ?? network.driver,
      keywords: network.composeProject ? [network.composeProject] : [],
    }));

  function refresh(): void {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.deployContainer(serverId, container.id),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployNetworks(serverId) });
  }

  async function change(network: string, join: boolean): Promise<void> {
    setBusy(network);
    try {
      const input = { serverId, container: container.name, network };
      if (join) await window.runova.deployDocker.joinNetwork(input);
      else await window.runova.deployDocker.leaveNetwork(input);
      toast.success(`${container.name} ${join ? 'joined' : 'left'} ${network}.`);
      if (join) setPicked('');
      refresh();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function leave(network: ContainerNetwork): Promise<void> {
    const reachable = network.dnsNames?.length
      ? ` as ${network.dnsNames.join(', ')}`
      : network.ipAddress
        ? ` at ${network.ipAddress}`
        : '';
    const confirmed = await confirmDialog({
      title: `Take ${container.name} off ${network.network}?`,
      description: `Containers on ${network.network} can no longer reach it${reachable}. It can join again later.`,
      warning:
        details.networks.length === 1
          ? 'It is on no other network, so nothing reaches it over a network until it joins one.'
          : undefined,
      confirmLabel: 'Leave the network',
      variant: 'destructive',
    });
    if (confirmed) await change(network.network, false);
  }

  return (
    <div className="flex flex-col gap-3">
      {solo ? (
        <Notice size="sm">
          {solo === 'host'
            ? "This container shares the server's own network, so it cannot join other networks."
            : 'This container runs with networking turned off, so it cannot join other networks.'}
        </Notice>
      ) : (
        canOperate && (
          <form
            className={cn(SECTION_WELL, 'flex flex-wrap items-center gap-2 px-3 py-2.5')}
            onSubmit={(event) => {
              event.preventDefault();
              if (picked) void change(picked, true);
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
                    : 'Pick a network to join'
              }
              searchPlaceholder="Find a network"
              emptyText="No network matches."
              disabled={networks.isPending || options.length === 0 || busy !== null}
              className="h-8 min-w-48 max-w-sm flex-1"
            />
            <SimpleTooltip label={picked ? undefined : 'Pick a network first'} wrapTrigger>
              <Button type="submit" size="sm" disabled={!picked || busy !== null}>
                {busy !== null && busy === picked ? (
                  <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Join network
              </Button>
            </SimpleTooltip>
            {networks.error && (
              <span className="text-xs text-destructive">
                Could not list the networks: {coreErrorMessage(networks.error)}
              </span>
            )}
          </form>
        )
      )}
      {container.composeProject && canOperate && !solo && (
        <Notice size="sm">
          Compose set up this container's networks. A change here lasts until the app is deployed
          again, when the networks in its compose file come back.
        </Notice>
      )}
      {details.networks.length === 0 ? (
        <EmptyState size="sm" icon={NetworkIcon} title="This container is on no network." />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Networks">
          {details.networks.map((network) => (
            <NetworkRow
              key={network.network}
              network={network}
              info={byName.get(network.network)}
              canLeave={canOperate && network.network !== 'host'}
              busy={busy === network.network}
              onLeave={() => void leave(network)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
