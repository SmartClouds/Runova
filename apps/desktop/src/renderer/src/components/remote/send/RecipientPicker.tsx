import type { SendRecipient } from '@shared/fileSend';
import { useMemo, useState } from 'react';
import { Check, Monitor, Search, Smartphone } from '@/components/icons';
import { Chip, Notice, SECTION_HEADING } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { initials } from './fileKinds';

/** A search field once a list gets longer than this. */
const SEARCH_FROM = 7;

const WHY: Record<NonNullable<SendRecipient['unavailable']>, string> = {
  offline: 'Offline',
  outdated: 'Needs a newer Runova',
  'website-outdated': 'Waiting on a website update',
};

const WHY_LONG: Record<NonNullable<SendRecipient['unavailable']>, string> = {
  offline: 'It needs Runova open and signed in.',
  outdated: 'Update Runova on it to send it files.',
  'website-outdated': 'The Runova website needs an update before files can be sent.',
};

/** A phone is online only while its app is open (E114), so its offline says what to do. */
function whyShort(
  recipient: SendRecipient,
  why: NonNullable<SendRecipient['unavailable']>,
): string {
  return recipient.kind === 'phone' && why === 'offline' ? 'Open Runova on the phone' : WHY[why];
}

function whyLong(recipient: SendRecipient, why: NonNullable<SendRecipient['unavailable']>): string {
  return recipient.kind === 'phone' && why === 'offline'
    ? 'A phone takes files while the Runova app is open on it.'
    : WHY_LONG[why];
}

/**
 * Who files go to (E112): my own devices first, then each teammate with the devices they show to
 * a team I am in. One device at a time, as radio cards; one that can not take files right now is
 * there but can not be picked, and says why in its own row.
 */
export function RecipientPicker({
  recipients,
  value,
  onChange,
  websiteOutdated,
}: {
  recipients: SendRecipient[];
  value: string | null;
  onChange: (remoteId: string) => void;
  websiteOutdated: boolean;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter((r) =>
      [r.name, r.owner.displayName, ...r.teams].some((text) => text.toLowerCase().includes(q)),
    );
  }, [recipients, query]);
  const mine = shown.filter((r) => r.relation === 'own');
  const people = useMemo(() => {
    const byOwner = new Map<
      number,
      { owner: SendRecipient['owner']; teams: Set<string>; devices: SendRecipient[] }
    >();
    for (const r of shown) {
      if (r.relation !== 'teammate') continue;
      const entry = byOwner.get(r.owner.userId) ?? {
        owner: r.owner,
        teams: new Set(),
        devices: [],
      };
      for (const team of r.teams) entry.teams.add(team);
      entry.devices.push(r);
      byOwner.set(r.owner.userId, entry);
    }
    return [...byOwner.values()].sort((a, b) =>
      a.owner.displayName.localeCompare(b.owner.displayName),
    );
  }, [shown]);

  if (recipients.length === 0) {
    return (
      <p className="rounded-xl bg-foreground/[0.025] px-4 py-5 text-center text-xs leading-relaxed text-muted-foreground">
        Your other computers show up here once Runova is signed in on them. A teammate's computers
        show up once they show them to a team you are both in.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {websiteOutdated ? (
        <Notice tone="warning">
          The Runova website needs an update before files can be sent. Sending starts working on its
          own once it has it.
        </Notice>
      ) : null}
      {recipients.length >= SEARCH_FROM ? (
        <label className="search-pill flex h-8 items-center gap-2 rounded-full px-3">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            type="search"
            aria-label="Find a device"
            placeholder="Find a device, a person or a team"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/60 focus:outline-none"
          />
        </label>
      ) : null}
      <div role="radiogroup" aria-label="Send to" className="space-y-3">
        {mine.length > 0 ? (
          <div className="space-y-1.5">
            <h4 className={SECTION_HEADING}>My devices</h4>
            <div className="grid gap-1.5 @lg/send:grid-cols-2">
              {mine.map((r) => (
                <DeviceCard
                  key={r.remoteId}
                  recipient={r}
                  picked={value === r.remoteId}
                  onPick={onChange}
                />
              ))}
            </div>
          </div>
        ) : null}
        {people.map(({ owner, teams, devices }) => (
          <div key={owner.userId} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold text-primary"
              >
                {initials(owner.displayName)}
              </span>
              <span className="text-xs font-medium" {...persianTextProps(owner.displayName)}>
                {owner.displayName}
              </span>
              {[...teams].map((team) => (
                <Chip key={team}>{team}</Chip>
              ))}
            </div>
            <div className="grid gap-1.5 @lg/send:grid-cols-2">
              {devices.map((r) => (
                <DeviceCard
                  key={r.remoteId}
                  recipient={r}
                  picked={value === r.remoteId}
                  onPick={onChange}
                />
              ))}
            </div>
          </div>
        ))}
        {shown.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">Nothing matches that.</p>
        ) : null}
      </div>
    </div>
  );
}

function DeviceCard({
  recipient,
  picked,
  onPick,
}: {
  recipient: SendRecipient;
  picked: boolean;
  onPick: (remoteId: string) => void;
}): React.JSX.Element {
  const why = recipient.unavailable;
  const Icon = recipient.kind === 'phone' ? Smartphone : Monitor;
  return (
    <SimpleTooltip label={why ? whyLong(recipient, why) : null} wrapTrigger>
      <button
        type="button"
        role="radio"
        aria-checked={picked}
        disabled={why !== null}
        onClick={() => onPick(recipient.remoteId)}
        className={cn(
          'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-[background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          picked
            ? 'bg-primary/10 ring-1 ring-inset ring-primary/60 shadow-[0_0_24px_-14px_hsl(var(--primary)/0.9)]'
            : 'bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.06] hover:bg-foreground/[0.06]',
          why !== null && 'cursor-not-allowed opacity-55 hover:bg-foreground/[0.03]',
        )}
      >
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            recipient.online && !why
              ? 'bg-primary/12 text-primary'
              : 'bg-foreground/[0.06] text-muted-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[13px] font-medium"
            {...persianTextProps(recipient.name)}
          >
            {recipient.name}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {why ? (
              <span>{whyShort(recipient, why)}</span>
            ) : (
              <>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
                <span>Online</span>
              </>
            )}
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors',
            picked ? 'bg-primary text-primary-foreground' : 'ring-1 ring-inset ring-foreground/15',
          )}
        >
          {picked ? <Check className="h-2.5 w-2.5" /> : null}
        </span>
      </button>
    </SimpleTooltip>
  );
}
