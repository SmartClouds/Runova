import { coreErrorMessage } from '@shared/coreErrors';
import type { NetworkInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { LinkOff, NetworkIcon, Plus, Spinner } from '@/components/icons';
import { Chip, EmptyState, Notice, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
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
 */

export interface ServiceNetworksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  /** The app's name, which is also its Compose project: its own networks are not offered. */
  app: string;
  service: string;
  /** The networks the service joins in the live revision. */
  joined: readonly string[];
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
  const byName = new Map((networks.data ?? []).map((network) => [network.name, network]));
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
  info,
  missing,
  busy,
  onRemove,
}: {
  name: string;
  info?: NetworkInfo;
  missing: boolean;
  busy: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <li aria-label={name} className="flex min-w-0 items-center gap-2 px-3 py-2">
      <NetworkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-sm text-foreground">{name}</span>
      {info?.composeProject && (
        <Chip className="h-5 px-1.5 text-[10px]">App {info.composeProject}</Chip>
      )}
      {missing && (
        <Chip tone="warning" className="h-5 px-1.5 text-[10px]">
          Not on the server
        </Chip>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto shrink-0 hover:bg-destructive/10 hover:text-destructive"
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
