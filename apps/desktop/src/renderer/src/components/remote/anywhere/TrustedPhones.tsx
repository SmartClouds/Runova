import type { ManageScope } from '@runova/protocol';
import type { AnywhereTrustedPhone } from '@shared/anywhere';
import { useState } from 'react';
import { toast } from 'sonner';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { ManageScopeToggles } from './AccessSettingsDialog';

function report(work: Promise<unknown>): void {
  void work.catch((error: unknown) => toast.error(String(error)));
}

function PhoneRow({ phone }: { phone: AnywhereTrustedPhone }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const setScopes = (scopes: ManageScope[]) =>
    report(window.runova.anywhere.setPhoneScopes(phone.key, scopes));

  return (
    <li className="space-y-2.5 rounded-xl bg-foreground/[0.04] p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{phone.name}</span>
        {phone.connected ? <Chip tone="primary">Connected now</Chip> : null}
        {confirming ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => report(window.runova.anywhere.forgetPhone(phone.key))}
            >
              Forget this phone
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Forget ${phone.name}`}
            onClick={() => setConfirming(true)}
          >
            Forget
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Approved {new Date(phone.approvedAt).toLocaleDateString()}. Last connected{' '}
        {new Date(phone.lastSeenAt).toLocaleString()}.
      </p>
      <ManageScopeToggles value={phone.scopes} onChange={setScopes} />
    </li>
  );
}

/**
 * The phones approved to manage this computer (E71). Changing what a phone may do ends its
 * session, so it reconnects with the new limits and never keeps an old one.
 */
export function TrustedPhones({ phones }: { phones: AnywhereTrustedPhone[] }): React.JSX.Element {
  if (phones.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No phone can manage this computer yet. The first time one asks, you approve it here.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {phones.map((phone) => (
        <PhoneRow key={phone.key} phone={phone} />
      ))}
    </ul>
  );
}
