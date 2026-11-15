import { type IpLockSpec, ipLockTarget, parseIpLock } from '@shared/cloudflare/ipLock';
import type { CloudflareCustomRule, CloudflareZone } from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { NetworkIcon, Pencil, Plus, Trash2 } from '@/components/icons';
import { EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CardBody, CloudflareCard, Problem } from '../fields';
import { IpLockDialog } from './IpLockDialog';

/** How many addresses a row shows before "+N more". */
const SHOWN = 3;

interface IpLock {
  rule: CloudflareCustomRule;
  spec: IpLockSpec;
  target: string;
}

function LocksSkeleton(): React.JSX.Element {
  return (
    <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-5 w-64 rounded-full" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The zone's IP limits (E97), on the Access tab: names and paths only listed addresses can open.
 * Each is a WAF custom rule the app wrote and can read back, so other custom rules stay on the
 * Security tab and are never shown or changed here.
 */
export function IpLockCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = queryKeys.cloudflareCustomRules(zone.id);
  const rules = useQuery({
    queryKey: key,
    queryFn: () => window.runova.cloudflare.listCustomRules(zone.id),
  });
  const loadError = useCloudflareError(rules.error);
  const [editing, setEditing] = useState<CloudflareCustomRule | 'new' | null>(null);
  const [changing, setChanging] = useState<string | null>(null);

  const locks: IpLock[] = (rules.data ?? []).flatMap((rule) => {
    const spec = parseIpLock(rule);
    return spec ? [{ rule, spec, target: ipLockTarget(spec, zone.name) }] : [];
  });

  async function setEnabled(lock: IpLock, enabled: boolean): Promise<void> {
    setChanging(lock.rule.id);
    try {
      queryClient.setQueryData(
        key,
        await window.runova.cloudflare.setCustomRuleEnabled(zone.id, lock.rule.id, enabled),
      );
      toast.success(
        enabled
          ? `Only the listed addresses can open ${lock.target} again.`
          : `${lock.target} is open to every address again.`,
      );
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setChanging(null);
    }
  }

  async function remove(lock: IpLock): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete the IP limit for ${lock.target}?`,
      description: 'Every address can open it again. To pause the limit instead, switch it off.',
      confirmLabel: 'Delete limit',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      queryClient.setQueryData(
        key,
        await window.runova.cloudflare.deleteCustomRule(zone.id, lock.rule.id),
      );
      toast.success(`Deleted the IP limit for ${lock.target}.`);
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    }
  }

  let body: React.ReactNode;
  if (rules.isPending) {
    body = <LocksSkeleton />;
  } else if (rules.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void rules.refetch()} />
      </CardBody>
    );
  } else if (locks.length === 0) {
    body = (
      <EmptyState
        size="sm"
        icon={NetworkIcon}
        title="No IP limits yet"
        description="Keep an admin page to your office, or a whole name to your VPN's address."
        className={FOOTER_HAIRLINE}
      />
    );
  } else {
    body = (
      <ul aria-label={`IP limits in ${zone.name}`} className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        {locks.map((lock) => {
          const { rule, spec, target } = lock;
          const hidden = spec.ips.slice(SHOWN);
          return (
            <li
              key={rule.id}
              aria-label={target}
              className="flex flex-wrap items-center gap-3 px-4 py-2.5"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <p
                  className={cn(
                    'truncate font-mono text-sm',
                    rule.enabled ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {target}
                </p>
                <ul
                  aria-label={`Addresses that get into ${target}`}
                  className="flex flex-wrap gap-1"
                >
                  {spec.ips.slice(0, SHOWN).map((ip) => (
                    <li
                      key={ip}
                      className="inline-flex h-5 items-center rounded-full bg-foreground/[0.06] px-2 font-mono text-[11px] text-foreground/80"
                    >
                      {ip}
                    </li>
                  ))}
                  {hidden.length > 0 && (
                    <li className="inline-flex">
                      <SimpleTooltip label={hidden.join(', ')}>
                        <span className="inline-flex h-5 items-center rounded-full px-1.5 text-[11px] text-muted-foreground">
                          +{hidden.length} more
                        </span>
                      </SimpleTooltip>
                    </li>
                  )}
                </ul>
              </div>
              <span className="flex items-center gap-2">
                <span className="w-6 text-xs text-muted-foreground">
                  {rule.enabled ? 'On' : 'Off'}
                </span>
                <Switch
                  checked={rule.enabled}
                  disabled={changing === rule.id}
                  aria-label={`IP limit for ${target}`}
                  onCheckedChange={(checked) => void setEnabled(lock, checked)}
                />
                <SimpleTooltip label="Change">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit IP limit for ${target}`}
                    onClick={() => setEditing(rule)}
                  >
                    <Pencil />
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Delete">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Delete IP limit for ${target}`}
                    onClick={() => void remove(lock)}
                  >
                    <Trash2 />
                  </Button>
                </SimpleTooltip>
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <CloudflareCard
      icon={<NetworkIcon />}
      title="Limit by IP address"
      description="Only the addresses you list can open a name or a path. Everyone else gets Cloudflare's block page."
      actions={
        <Button size="sm" disabled={rules.isError} onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> Add IP limit
        </Button>
      }
    >
      {body}
      {!rules.isPending && !rules.isError && (
        <p className={cn(FOOTER_HAIRLINE, 'px-4 py-2.5 text-xs text-muted-foreground')}>
          Each limit is a WAF custom rule, so it also shows on the Security tab. The Free plan holds
          five custom rules per domain.
        </p>
      )}
      {editing && (
        <IpLockDialog
          zone={zone}
          open
          existing={editing === 'new' ? undefined : editing}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </CloudflareCard>
  );
}
