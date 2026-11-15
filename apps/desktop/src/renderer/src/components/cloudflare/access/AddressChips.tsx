import {
  type AddressEntry,
  MAX_IP_LOCK_ADDRESSES,
  parseAddresses,
} from '@shared/cloudflare/ipLock';
import { useState } from 'react';
import { X } from '@/components/icons';
import { FIELD_SURFACE, Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Invalid = Extract<AddressEntry, { kind: 'invalid' }>;

/**
 * The addresses that get past an IP limit, as chips in one field: single addresses and ranges like
 * 203.0.113.0/24. Enter, a comma, a semicolon or a space adds what was typed, and so does leaving
 * the field; a pasted list is split up. What cannot be used is listed under the field with why.
 */
export function AddressChips({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: string[];
  onChange: (addresses: string[]) => void;
  describedBy?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [problems, setProblems] = useState<Invalid[]>([]);
  const full = value.length >= MAX_IP_LOCK_ADDRESSES;

  function add(text: string): void {
    const entries = parseAddresses(text);
    setProblems(entries.filter((entry): entry is Invalid => entry.kind === 'invalid'));
    const next = [...value];
    for (const entry of entries) {
      if (next.length >= MAX_IP_LOCK_ADDRESSES) break;
      if (entry.kind === 'address' && !next.includes(entry.value)) next.push(entry.value);
    }
    if (next.length !== value.length) onChange(next);
  }

  function commit(): void {
    if (!draft.trim()) return;
    add(draft);
    setDraft('');
  }

  return (
    <div className="space-y-2">
      <div
        className={cn(
          FIELD_SURFACE,
          'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-2xl px-2 py-1.5',
        )}
      >
        {value.length > 0 && (
          <ul aria-label="Listed addresses" className="contents">
            {value.map((address) => (
              <li key={address} className="contents">
                <span className="inline-flex h-6 items-center gap-1 rounded-full bg-primary/12 pl-2.5 pr-1 font-mono text-xs text-primary">
                  {address}
                  <button
                    type="button"
                    aria-label={`Remove ${address}`}
                    onClick={() => onChange(value.filter((one) => one !== address))}
                    className="flex h-4 w-4 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-2.5 [&_svg]:w-2.5"
                  >
                    <X />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <Input
          id={id}
          variant="bare"
          aria-describedby={describedBy}
          value={draft}
          disabled={full}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            full
              ? 'The list is full'
              : value.length === 0
                ? '203.0.113.10 or 198.51.100.0/24'
                : 'Add another'
          }
          className="h-6 min-w-[12rem] flex-1 border-0 bg-transparent px-1 font-mono text-sm shadow-none focus-visible:ring-0"
          onChange={(event) => {
            const text = event.target.value;
            // A separator typed at the end finishes the entry before it.
            if (/[\s,;]$/.test(text)) {
              add(text);
              setDraft('');
            } else {
              setDraft(text);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            add(`${draft} ${event.clipboardData.getData('text')}`);
            setDraft('');
          }}
          onBlur={commit}
        />
      </div>
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" aria-live="polite">
          {problems.map((problem) => (
            <li key={problem.value}>
              <span className="font-mono">{problem.value}</span>: {problem.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
