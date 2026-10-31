import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { type ApiClient, clientStatus, currentKey, STATUS_LABELS } from '@/lib/admin/apiClients';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { Pager } from './Pager';
import { formatTime, PAGE_SIZE, useAdminList } from './useAdminList';

type Show = 'active' | 'revoked' | 'all';

const SHOW: { value: Show; label: string }[] = [
  { value: 'active', label: 'Not revoked' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'all', label: 'All' },
];

const REVOKED: Record<Show, string | null> = { active: 'false', revoked: 'true', all: null };

function readAddress(): { show: Show; page: number } {
  const query = new URLSearchParams(window.location.search);
  const show = SHOW.find((each) => each.value === query.get('show'))?.value ?? 'active';
  const page = Number(query.get('page'));
  return { show, page: Number.isInteger(page) && page > 1 ? page : 1 };
}

function writeAddress(show: Show, page: number) {
  const query = new URLSearchParams();
  if (show !== 'active') query.set('show', show);
  if (page > 1) query.set('page', String(page));
  const search = query.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
}

/** The systems allowed to publish through signed requests, for Admins. */
export default function ApiClientList() {
  const [{ show, page }, setQuery] = useState(readAddress);
  const query = new URLSearchParams();
  const revoked = REVOKED[show];
  if (revoked) query.set('revoked', revoked);
  query.set('page', String(page));
  query.set('pageSize', String(PAGE_SIZE));
  const { list, problem, summary } = useAdminList<ApiClient>(`/api-clients?${query}`);

  const go = (next: { show: Show; page: number }) => {
    setQuery(next);
    writeAddress(next.show, next.page);
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display font-extrabold text-3xl tracking-tight">API clients</h1>
        <a className={buttonVariants()} href="/admin/api-clients/new">
          New API client
        </a>
      </div>
      <Field id="api-clients-show" label="Show" className="max-w-xs">
        {(control) => (
          <NativeSelect
            {...control}
            value={show}
            onChange={(event) => go({ show: event.target.value as Show, page: 1 })}
          >
            {SHOW.map((each) => (
              <option key={each.value} value={each.value}>
                {each.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <ErrorSummary problem={problem} summaryRef={summary} />
      {!list && !problem && <p className="text-muted-foreground">Loading.</p>}
      {list && list.items.length === 0 && (
        <p className="text-muted-foreground">No API clients here.</p>
      )}
      {list && list.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">API clients</caption>
            <thead className="border-b text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Scopes
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Current key
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 font-medium">
                  Last used
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((client) => (
                <tr key={client.id} className="border-b">
                  <th scope="row" className="py-3 pe-4 font-medium">
                    <a
                      className="underline-offset-4 hover:underline"
                      href={`/admin/api-clients/${client.id}`}
                    >
                      {client.name}
                    </a>
                  </th>
                  <td className="py-3 pe-4 font-mono">{client.scopes.join(', ') || 'None'}</td>
                  <td className="py-3 pe-4 font-mono">{currentKey(client)?.keyId ?? 'None'}</td>
                  <td className="py-3 pe-4">{STATUS_LABELS[clientStatus(client)]}</td>
                  <td className="py-3">{formatTime(client.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list && (
        <Pager
          page={list.page}
          totalPages={list.totalPages}
          onPage={(next) => go({ show, page: next })}
        />
      )}
    </div>
  );
}
