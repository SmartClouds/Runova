import { MAX_EMAIL_GATE_PEOPLE, type PeopleEntry, parsePeople } from '@shared/cloudflare/emailGate';
import type { EmailGatePeople } from '@shared/cloudflareTypes';
import { useId, useState } from 'react';
import { Users, X } from '@/components/icons';
import { FIELD_SURFACE, Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type Invalid = Extract<PeopleEntry, { kind: 'invalid' }>;

/**
 * Who may ask for a code, as chips in one field: email addresses, and whole domains shown as
 * @company.com (everyone with an address there). Typing an entry and pressing Enter, a comma, a
 * semicolon or a space adds it, and so does leaving the field. A pasted list, even one copied from
 * a mail app's "Name <address>" form, is split up. What cannot be used is listed under the field
 * with the reason, so nothing is dropped silently.
 */
export function PeopleChips({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: EmailGatePeople;
  onChange: (people: EmailGatePeople) => void;
  describedBy?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [problems, setProblems] = useState<Invalid[]>([]);
  const listId = useId();
  const count = value.emails.length + value.emailDomains.length;
  const full = count >= MAX_EMAIL_GATE_PEOPLE;

  function add(text: string): void {
    const entries = parsePeople(text);
    setProblems(entries.filter((entry): entry is Invalid => entry.kind === 'invalid'));
    const emails = [...value.emails];
    const emailDomains = [...value.emailDomains];
    for (const entry of entries) {
      if (emails.length + emailDomains.length >= MAX_EMAIL_GATE_PEOPLE) break;
      if (entry.kind === 'email' && !emails.includes(entry.value)) emails.push(entry.value);
      if (entry.kind === 'domain' && !emailDomains.includes(entry.value)) {
        emailDomains.push(entry.value);
      }
    }
    if (
      emails.length !== value.emails.length ||
      emailDomains.length !== value.emailDomains.length
    ) {
      onChange({ emails, emailDomains });
    }
  }

  function commit(): void {
    if (!draft.trim()) return;
    add(draft);
    setDraft('');
  }

  function removeLast(): void {
    if (value.emails.length > 0) {
      onChange({ ...value, emails: value.emails.slice(0, -1) });
    } else if (value.emailDomains.length > 0) {
      onChange({ ...value, emailDomains: value.emailDomains.slice(0, -1) });
    }
  }

  return (
    <div className="space-y-2">
      <div
        className={cn(
          FIELD_SURFACE,
          'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-2xl px-2 py-1.5',
        )}
      >
        {count > 0 && (
          <ul id={listId} aria-label="Listed people and domains" className="contents">
            {value.emailDomains.map((domain) => (
              <li key={`d:${domain}`} className="contents">
                <SimpleTooltip label={`Everyone with an address at ${domain}`}>
                  <span className="inline-flex h-6 items-center gap-1 rounded-full bg-success/12 pl-2 pr-1 text-xs text-success">
                    <Users className="h-3 w-3" aria-hidden />
                    <span className="font-mono">@{domain}</span>
                    <ChipRemove
                      label={`Remove @${domain}`}
                      onClick={() =>
                        onChange({
                          ...value,
                          emailDomains: value.emailDomains.filter((one) => one !== domain),
                        })
                      }
                    />
                  </span>
                </SimpleTooltip>
              </li>
            ))}
            {value.emails.map((email) => (
              <li key={`e:${email}`} className="contents">
                <span className="inline-flex h-6 items-center gap-1 rounded-full bg-primary/12 pl-2.5 pr-1 font-mono text-xs text-primary">
                  {email}
                  <ChipRemove
                    label={`Remove ${email}`}
                    onClick={() =>
                      onChange({ ...value, emails: value.emails.filter((one) => one !== email) })
                    }
                  />
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
          placeholder={
            full
              ? 'The list is full'
              : count === 0
                ? 'ana@company.com, or @company.com for everyone there'
                : 'Add another'
          }
          className="h-6 min-w-[12rem] flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
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
            } else if (event.key === 'Backspace' && draft === '' && count > 0) {
              removeLast();
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

function ChipRemove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-4 w-4 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-2.5 [&_svg]:w-2.5"
    >
      <X />
    </button>
  );
}
