import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { roleOf, STATUS_LABELS, type StaffUser, userStatus } from '@/lib/admin/users';
import { ErrorSummary } from './ErrorSummary';
import { Pager } from './Pager';
import { PAGE_SIZE, useAdminList } from './useAdminList';

function readPage(): number {
  const page = Number(new URLSearchParams(window.location.search).get('page'));
  return Number.isInteger(page) && page > 1 ? page : 1;
}

/** The staff accounts, for Admins. */
export default function UserList() {
  const [page, setPage] = useState(readPage);
  const { list, problem, summary } = useAdminList<StaffUser>(
    `/users?page=${page}&pageSize=${PAGE_SIZE}`,
  );

  const go = (next: number) => {
    setPage(next);
    const search = next > 1 ? `?page=${next}` : '';
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display font-extrabold text-3xl tracking-tight">Users</h1>
        <a className={buttonVariants()} href="/admin/users/new">
          Invite a user
        </a>
      </div>
      <ErrorSummary problem={problem} summaryRef={summary} />
      {!list && !problem && <p className="text-muted-foreground">Loading.</p>}
      {list && list.items.length === 0 && <p className="text-muted-foreground">No users here.</p>}
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
                      className="underline-offset-4 hover:underline"
                      href={`/admin/users/${user.id}`}
                    >
                      {user.displayName}
                    </a>
                  </th>
                  <td className="py-3 pe-4">{user.email}</td>
                  <td className="py-3 pe-4">{roleOf(user)}</td>
                  <td className="py-3 pe-4">{STATUS_LABELS[userStatus(user)]}</td>
                  <td className="py-3">{user.twoFactorEnabled ? 'On' : 'Off'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list && <Pager page={list.page} totalPages={list.totalPages} onPage={go} />}
    </div>
  );
}
