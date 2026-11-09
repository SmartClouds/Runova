import type { EncryptionItemName, EncryptionStatus } from '@shared/accountTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock } from '@/components/icons';
import { Notice, SectionCard } from '@/components/pageKit';
import { SECTION_WELL } from '@/components/pageKit/styles';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { errorText } from '@/hooks/useAccount';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

const HINTS: Record<EncryptionItemName, string> = {
  notifications:
    'What your computers tell your phone. The server sees that something happened and when, but not what it says.',
  sync: 'Every record in your own sync, not only passwords and keys. The website can then show only counts.',
};

/** Which items are sealed so only the person's own devices can read them. Each has its own switch. */
export function EncryptionPanel(): React.JSX.Element | null {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.encryption,
    queryFn: () => window.runova.account.encryption(),
  });
  const change = useMutation({
    mutationFn: (input: { item: EncryptionItemName; enabled: boolean }) =>
      window.runova.account.setEncryption(input.item, input.enabled),
    onSuccess: (next: EncryptionStatus) => {
      client.setQueryData(queryKeys.encryption, next);
      void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
    },
    onError: (error) => toast.error(errorText(error)),
  });

  if (!status.data) return null;
  const { entitled, planName, items } = status.data;
  const lapsed = items.filter((item) => item.lapsed);

  return (
    <SectionCard
      icon={<Lock />}
      tone={entitled ? 'primary' : 'neutral'}
      title="End-to-end encryption"
      description="Choose what gets sealed so only your own devices can read it."
    >
      {lapsed.length > 0 && (
        <Notice tone="warning" size="sm" className="mb-3">
          Your plan no longer includes encryption, so {lapsed.map((i) => i.label).join(' and ')}{' '}
          went back to normal. What is already sealed stays sealed.
        </Notice>
      )}
      {!entitled && lapsed.length === 0 && (
        <Notice tone="primary" size="sm" className="mb-3">
          Included with Go, Pro and Ultra. You are on {planName}.
        </Notice>
      )}
      <div className={cn(SECTION_WELL, 'grid gap-3')}>
        {items.map((item) => (
          <div key={item.item} className="flex items-start justify-between gap-3">
            <Label
              htmlFor={`encryption-${item.item}`}
              className="flex flex-col gap-0.5 font-normal"
            >
              <span className="text-sm">{item.label}</span>
              <span className="text-xs text-muted-foreground">
                {item.needsKey ? 'Set a key under Your own data first.' : HINTS[item.item]}
              </span>
            </Label>
            <Switch
              id={`encryption-${item.item}`}
              aria-label={item.label}
              checked={item.enabled}
              disabled={change.isPending || (!item.enabled && (!entitled || item.needsKey))}
              onCheckedChange={(enabled) => change.mutate({ item: item.item, enabled })}
            />
          </div>
        ))}
      </div>
      {!entitled && (
        <div className="mt-3">
          <Button
            shape="pill"
            size="sm"
            onClick={() => void window.runova.account.openWebsite('/pricing')}
          >
            See plans
          </Button>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Your connection to the server uses TLS either way. Alerts the server writes itself, such as
        cloud monitors, can't be sealed.
      </p>
    </SectionCard>
  );
}
