import type { RefObject } from 'react';
import type { Problem } from '@/lib/admin/api';

interface ErrorSummaryProps {
  problem: Problem | null;
  /** Messages for fields the form does not show, which have nowhere else to go. */
  unplaced?: string[];
  /** Focused when a problem comes in, so keyboard and screen reader users land on it. */
  summaryRef: RefObject<HTMLDivElement | null>;
  /** Offers to sign in again on 401, except on the sign-in form itself. */
  offerSignIn?: boolean;
}

/** What went wrong with the last load or save, above the form. */
export function ErrorSummary({
  problem,
  unplaced = [],
  summaryRef,
  offerSignIn = true,
}: ErrorSummaryProps) {
  if (!problem) return null;
  const next = `${window.location.pathname}${window.location.search}`;
  return (
    <div
      ref={summaryRef}
      role="alert"
      tabIndex={-1}
      className="grid gap-2 rounded-md border border-destructive p-4 text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
    >
      <p className="font-semibold">{problem.detail || problem.title}</p>
      {unplaced.length > 0 && (
        <ul className="list-disc ps-5">
          {unplaced.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {offerSignIn && problem.status === 401 && (
        <p>
          <a
            className="font-medium text-primary underline underline-offset-4"
            href={`/admin/sign-in?next=${encodeURIComponent(next)}`}
          >
            Sign in again
          </a>{' '}
          and save once more. Copy what you wrote first, because signing in leaves this page.
        </p>
      )}
    </div>
  );
}
