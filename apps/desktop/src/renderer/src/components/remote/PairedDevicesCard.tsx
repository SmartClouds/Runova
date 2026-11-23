import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Key, Smartphone, Trash2 } from '@/components/icons';
import { EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { confirmDialog } from '@/stores/confirmStore';
import { useRemoteStore } from '@/stores/remoteStore';
import { REMOTE_CARD, RemoteCardHeader } from './remoteCard';

/**
 * The LAN devices that paired with this computer and can come back without a new code. Revoking
 * one stops its saved login from working and ends any session it has open.
 */
export function PairedDevicesCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  // A device pairing or reconnecting changes who is listed and when they were last seen, so the
  // list is fetched again whenever the connected peers change.
  const peerKey = useRemoteStore((s) => (s.state?.peers ?? []).map((p) => p.id).join(','));
  const devicesQuery = useQuery({
    queryKey: [...queryKeys.remotePairedDevices, peerKey],
    queryFn: () => window.runova.remote.listPairedDevices(),
    placeholderData: keepPreviousData,
  });
  const devices = devicesQuery.data ?? [];

  async function revoke(id: string, name: string): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove "${name}"?`,
      description:
        'It will be disconnected and will need a fresh pairing code to control this computer again.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.remote.revokePairedDevice(id);
    } catch (err) {
      toast.error((err as Error).message);
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.remotePairedDevices });
  }

  return (
    <section className={REMOTE_CARD}>
      <RemoteCardHeader
        icon={Key}
        title={`Paired devices (${devices.length})`}
        description="Devices that paired with a code can reconnect on their own. A device that has not connected for 30 days has to pair again."
      />
      <div className={FOOTER_HAIRLINE}>
        {devices.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Smartphone}
            title="No paired devices"
            description="A device shows up here once it pairs with a code from this computer."
          />
        ) : (
          <ul className="settings-rows">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
                  <Smartphone className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{device.deviceName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    Last seen {timeAgo(new Date(device.lastSeenAt).toISOString())}
                  </p>
                </div>
                <Button
                  variant="soft"
                  aria-label={`Revoke ${device.deviceName}`}
                  className="shrink-0 hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void revoke(device.id, device.deviceName)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
