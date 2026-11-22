import {
  type CloudflarePermissionRow,
  cloudflarePermission,
  permissionRows,
  TOKEN_PAGE,
} from '@shared/cloudflare/permissions';
import {
  cloudflareErrorCode,
  cloudflareErrorMessage,
  cloudflareErrorPermission,
} from '@shared/cloudflareErrors';
import { coreErrorMessage } from '@shared/coreErrors';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Key, RefreshCw, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { Notice } from '../fields';

/**
 * What went wrong with a Cloudflare step, and when Cloudflare refused it for want of a
 * permission, exactly what to add to the token and where (AC1): the permission as the token page
 * names it, the clicks on that page step by step (which menu, what to pick in each of the row's
 * three drop-downs, how to save), a button to the page, and, when there is one, another way
 * (`alternative`).
 */
export function GuidedFix({
  error,
  alternative,
  onRetry,
  retrying = false,
}: {
  error: unknown;
  /** Shown under the fix, such as "or paste a token you made yourself". */
  alternative?: React.ReactNode;
  /** When set, a button beside the token page link checks again once the permission is added. */
  onRetry?: () => void;
  /** Disables the retry button and spins its icon while the check runs. */
  retrying?: boolean;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  if (!error) return null;
  const permission =
    cloudflareErrorCode(error) === 'missing-permission' ? cloudflareErrorPermission(error) : null;
  if (!permission) {
    const words = cloudflareErrorCode(error)
      ? cloudflareErrorMessage(error)
      : coreErrorMessage(error);
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{words}</span>
      </p>
    );
  }
  const needed = cloudflarePermission(permission);
  const rows = permissionRows(needed);
  const groups = new Set(rows.map((row) => row.group));
  return (
    <Notice role="alert" tone="warning" icon={Key}>
      <div className="space-y-2">
        <p>
          The Cloudflare token cannot {needed.action} yet. It needs one more permission:{' '}
          <span className="font-mono text-xs">{needed.label}</span>. You add it to the token you
          already gave Runova, on Cloudflare's website:
        </p>
        <ol aria-label="How to add it" className="list-decimal space-y-1.5 pl-5">
          <li>
            Click <strong>Open Cloudflare's token page</strong> below. Find the token you gave
            Runova in the list, click the <strong>⋯</strong> button at the end of its row and choose{' '}
            <strong>Edit</strong>.
          </li>
          <li>
            Under <strong>Permissions</strong>, click <strong>+ Add more</strong> to get a new row,
            and set its three drop-downs to{' '}
            {rows.length === 1 ? (
              <PermissionRowWords row={rows[0]} />
            ) : (
              <>
                these, one row each:
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {rows.map((row) => (
                    <li key={row.item}>
                      <PermissionRowWords row={row} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
          {groups.has('Account') ? (
            <li>
              Under <strong>Account Resources</strong>, check that it says <strong>Include</strong>{' '}
              with your account (or <strong>All accounts</strong>) next to it.
            </li>
          ) : groups.has('Zone') ? (
            <li>
              Under <strong>Zone Resources</strong>, check that your domain is included (
              <strong>All zones</strong> covers it).
            </li>
          ) : null}
          <li>
            Click <strong>Continue to summary</strong>, then <strong>Update token</strong>. The
            token stays the same, so there is nothing new to paste into Runova.
          </li>
          <li>
            {onRetry ? (
              <>
                Come back here and click <strong>I added it, try again</strong>.
              </>
            ) : (
              'Come back here and try again.'
            )}
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            variant="soft"
            onClick={() => {
              void window.runova.shell.openExternal(TOKEN_PAGE);
              void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareStatus });
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open Cloudflare's token page
          </Button>
          {onRetry ? (
            <Button type="button" size="sm" disabled={retrying} onClick={onRetry}>
              <RefreshCw className={cn('h-3.5 w-3.5', retrying && 'animate-spin')} /> I added it,
              try again
            </Button>
          ) : null}
        </div>
        {alternative}
      </div>
    </Notice>
  );
}

/** "Account, then Cloudflare Tunnel, then Edit": what to pick in each drop-down of one row. */
function PermissionRowWords({ row }: { row: CloudflarePermissionRow }): React.JSX.Element {
  return (
    <>
      <strong>{row.group}</strong>, then <strong>{row.item}</strong>, then{' '}
      <strong>{row.level}</strong>.
    </>
  );
}
