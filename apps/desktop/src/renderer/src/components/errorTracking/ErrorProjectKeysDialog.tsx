import { suggestSentryPlatform } from '@runova/core';
import { useState } from 'react';
import { ExternalLink } from '@/components/icons';
import { Chip, Notice, Problem, SECTION_HEADING } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { DsnField, ErrorSetupSnippets, OUT_LINK } from './ErrorDsnParts';
import { useProjectKeys, useRemoteProjects } from './useErrorTracking';

/**
 * The DSN of a Sentry project that is already linked (E47). Runova keeps no keys, so they are read
 * from Sentry each time this opens: every client key with its state, then the setup snippet for
 * the project's platform with the first active key's DSN in it.
 */

export interface ErrorKeysTarget {
  connectionId: string;
  remoteSlug: string;
  remoteName: string;
  /** What Sentry calls the project's platform, to pick the snippet; null shows Other. */
  platform?: string | null;
}

const targetValue = (target: ErrorKeysTarget) => `${target.connectionId}:${target.remoteSlug}`;

export function ErrorProjectKeysDialog({
  open,
  onOpenChange,
  targets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The linked provider projects to pick from; one needs no picker. */
  targets: readonly ErrorKeysTarget[];
}): React.JSX.Element {
  const [picked, setPicked] = useState<string | null>(null);
  const target = targets.find((one) => targetValue(one) === picked) ?? targets[0];
  const keys = useProjectKeys(
    target ? { connectionId: target.connectionId, remoteSlug: target.remoteSlug } : null,
    open,
  );
  const list = keys.data?.keys ?? [];
  const active = list.find((key) => key.isActive);
  // A target that does not say its platform takes it from the provider's project list.
  const askPlatform = open && target !== undefined && target.platform === undefined;
  const remote = useRemoteProjects(target && askPlatform ? [target.connectionId] : [], askPlatform);
  const platform =
    target?.platform ??
    remote.byConnection
      .get(target?.connectionId ?? '')
      ?.find((one) => one.slug === target?.remoteSlug)?.platform ??
    null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[min(42rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
          <DialogTitle className="text-base">
            {targets.length === 1 && target ? `DSN for ${target.remoteName}` : 'DSN'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            The address your app sends its errors to. It is public by design, so it is fine in
            client code.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {targets.length > 1 && target && (
            <div className="space-y-1.5">
              <p className={SECTION_HEADING}>Sentry project</p>
              <Combobox
                ariaLabel="Sentry project"
                value={targetValue(target)}
                onChange={(value) => value && setPicked(value)}
                options={targets.map((one) => ({ value: targetValue(one), label: one.remoteName }))}
                searchPlaceholder="Search projects…"
                emptyText="No project matches."
              />
            </div>
          )}

          {keys.isLoading && (
            <div role="status" aria-label="Loading keys" className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          )}
          {keys.isError && (
            <Problem
              message={`Could not read the keys: ${ipcErrorMessage(keys.error, 'Something went wrong.')}`}
              onRetry={() => void keys.refetch()}
            />
          )}

          {keys.isSuccess && list.length === 0 && (
            <Notice tone="warning" size="sm">
              {target?.remoteName} has no client key, so there is no DSN yet. Add one in Sentry.
            </Notice>
          )}

          {list.length > 0 && (
            <ul aria-label="Client keys" className="space-y-4">
              {list.map((key) => (
                <li key={key.id}>
                  <DsnField
                    dsn={key.dsn}
                    heading={
                      <span className="flex items-center gap-1.5">
                        {key.name}
                        {key.isActive ? (
                          <Chip tone="success" dot>
                            Active
                          </Chip>
                        ) : (
                          <Chip>Disabled</Chip>
                        )}
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          {active && target && (
            <ErrorSetupSnippets
              key={`${targetValue(target)}:${platform ?? ''}`}
              dsn={active.dsn}
              platformId={suggestSentryPlatform(platform)}
              className="pt-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
            />
          )}

          {keys.data?.keysUrl && (
            <a href={keys.data.keysUrl} target="_blank" rel="noreferrer" className={OUT_LINK}>
              <ExternalLink className="h-3 w-3" />
              Manage keys in Sentry
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
