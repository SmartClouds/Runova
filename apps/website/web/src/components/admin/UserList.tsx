import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import {
  KIND_LABELS,
  roleOf,
  STATUS_LABELS,
  type StaffUser,
  USER_KINDS,
  type UserKind,
  userStatus,
} from '@/lib/admin/users';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { Pager } from './Pager';
import { PAGE_SIZE, useAdminList } from './useAdminList';

type Enabled = 'all' | 'enabled' | 'disabled';

const ENABLED_LABELS: Record<Enabled, string> = {
  all: 'Any status',
  enabled: 'Enabled',
  disabled: 'Disabled',
};

interface Filters {
  q: string;
  kind: UserKind | 'all';
  enabled: Enabled;
  page: number;
}

/** The filters in the address, so a reload or a shared link shows the same list. */
export function readFilters(search: string): Filters {
  const query = new URLSearchParams(search);
  const kind = query.get('role');
  const disabled = query.get('disabled');
  const page = Number(query.get('page'));
  return {
    q: query.get('q')?.trim() ?? '',
    kind: USER_KINDS.includes(kind as UserKind) ? (kind as UserKind) : 'all',
    enabled: disabled === 'true' ? 'disabled' : disabled === 'false' ? 'enabled' : 'all',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** The query the API and the address share: only what is set, and the page past the first. */
export function filterQuery({ q, kind, enabled, page }: Filters): URLSearchParams {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (kind !== 'all') query.set('role', kind);
  if (enabled !== 'all') query.set('disabled', String(enabled === 'disabled'));
  if (page > 1) query.set('page', String(page));
  return query;
}

/** Everyone with a sign-in on the site, staff and Runova accounts, for Admins. */
export default function UserList() {
  const [filters, setFilters] = useState(() => readFilters(window.location.search));
  const [draft, setDraft] = useState(filters.q);
  const api = filterQuery({ ...filters, page: 1 });
  api.set('page', String(filters.page));
  api.set('pageSize', String(PAGE_SIZE));
  const { list, problem, summary } = useAdminList<StaffUser>(`/users?${api}`);

  const show = (next: Filters) => {
    setFilters(next);
    const search = filterQuery(next).toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}`,
    );
  };
  // A new filter starts again from the first page.
  const apply = (next: Partial<Filters>) => show({ ...filters, page: 1, ...next });

  const filtered = filters.q !== '' || filters.kind !== 'all' || filters.enabled !== 'all';

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display font-extrabold text-3xl tracking-tight">Users</h1>
        <a className={buttonVariants()} href="/admin/users/new">
          Invite a user
        </a>
      </div>
      <search aria-label="Users" className="flex flex-wrap items-end gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ q: draft.trim() });
          }}
        >
          <Field id="users-q" label="Name or email" className="w-64 max-w-full">
            {(control) => (
              <Input
                {...control}
                type="search"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <Field id="users-kind" label="Type" className="w-48">
          {(control) => (
            <NativeSelect
              {...control}
              value={filters.kind}
              onChange={(event) => apply({ kind: event.target.value as Filters['kind'] })}
            >
              <option value="all">Everyone</option>
              {USER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field id="users-enabled" label="Status" className="w-40">
          {(control) => (
            <NativeSelect
              {...control}
              value={filters.enabled}
              onChange={(event) => apply({ enabled: event.target.value as Enabled })}
            >
              {(Object.keys(ENABLED_LABELS) as Enabled[]).map((value) => (
                <option key={value} value={value}>
                  {ENABLED_LABELS[value]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {filtered && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft('');
              apply({ q: '', kind: 'all', enabled: 'all' });
            }}
          >
            Clear filters
          </Button>
        )}
      </search>
      <ErrorSummary problem={problem} summaryRef={summary} />
      {!list && !problem && <p className="text-muted-foreground">Loading.</p>}
      {list && list.items.length === 0 && (
        <p className="text-muted-foreground">
          {filtered ? 'No users match these filters.' : 'No users here.'}
        </p>
      )}
      {list && list.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Users</caption>
            <thead className="border-b text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Email
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Role
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 font-medium">
                  Two-factor
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((user) => (
                <tr key={user.id} className="border-b">
                  <th scope="row" className="py-3 pe-4 font-medium">
                    <a
                      className="transition-colors duration-[120ms] hover:text-primary"
                      href={`/admin/users/${user.id}`}
                    >
                      {user.displayName}
                    </a>
                  </th>
                  <td className="py-3 pe-4">{user.email}</td>
                  <td className="py-3 pe-4">{KIND_LABELS[roleOf(user)]}</td>
                  <td className="py-3 pe-4">{STATUS_LABELS[userStatus(user)]}</td>
                  <td className="py-3">{user.twoFactorEnabled ? 'On' : 'Off'}</td>
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
          onPage={(page) => show({ ...filters, page })}
        />
      )}
    </div>
  );
}
