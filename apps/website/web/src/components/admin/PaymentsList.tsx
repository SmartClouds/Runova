import { useCallback, useEffect, useState } from 'react';
import { NativeSelect } from '@/components/ui/native-select';
import { apiRequest, type Problem } from '@/lib/admin/api';
import {
  type AdminPayment,
  PAYMENT_STATUS_LABELS,
  type PaymentStatus,
  PROVIDER_LABELS,
  price,
} from '@/lib/billing';
import { Pager } from './Pager';

interface PaymentPage {
  items: AdminPayment[];
  page: number;
  totalPages: number;
  totalItems: number;
}

const DATE = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** Every payment, newest first, for Admins (E53). */
export default function PaymentsList() {
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaymentPage | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (status) query.set('status', status);
    const response = await apiRequest<PaymentPage>(`/payments?${query}`);
    if (response.ok) setResult(response.value);
    else setProblem(response.problem);
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor="payment-status" className="grid gap-1.5 text-sm">
          <span className="font-medium">Status</span>
          <NativeSelect
            id="payment-status"
            className="w-48"
            value={status}
            onChange={(event) => {
              setPage(1);
              setStatus(event.target.value as PaymentStatus | '');
            }}
          >
            <option value="">All</option>
            {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </label>
        {result && <p className="text-muted-foreground text-sm">{result.totalItems} payments</p>}
      </div>
      {problem && (
        <p className="font-medium text-destructive text-sm">{problem.detail || problem.title}</p>
      )}
      {result && result.items.length === 0 && (
        <p className="text-muted-foreground text-sm">No payments yet.</p>
      )}
      {result && result.items.length > 0 && (
        <div className="overflow-x-auto rounded-box border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/30 text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Account
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Plan
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  How
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.items.map((payment) => (
                <tr key={payment.id}>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {DATE.format(new Date(payment.createdAt))}
                  </td>
                  <td className="px-4 py-2.5">
                    <a
                      href={`/admin/users/${payment.userId}`}
                      className="font-medium text-primary hover:text-primary/80"
                    >
                      {payment.email ?? `Account ${payment.userId}`}
                    </a>
                  </td>
                  <td className="px-4 py-2.5">
                    {payment.accountTypeName}
                    {payment.months !== null && ` · ${payment.months} mo`}
                  </td>
                  <td className="px-4 py-2.5">{PROVIDER_LABELS[payment.provider]}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                    {price(payment.amountCents, payment.currency)}
                  </td>
                  <td className="px-4 py-2.5">
                    {PAYMENT_STATUS_LABELS[payment.status]}
                    {payment.providerStatus && payment.providerStatus !== payment.status && (
                      <span className="text-muted-foreground"> ({payment.providerStatus})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && result.totalPages > 1 && (
        <Pager page={result.page} totalPages={result.totalPages} onPage={setPage} />
      )}
    </div>
  );
}
