import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';

/**
 * Cloudflare's name servers for a zone, the way a registrar's form wants them: one per row, in
 * a monospace face so similar letters stay apart, each with its own copy button and one to copy
 * them all at once. The add-domain steps and a pending zone's notice both show them.
 */

const COPIED_FOR_MS = 1500;

export function NameServerList({
  servers,
  actions,
  className,
}: {
  servers: readonly string[];
  /** More buttons for the row under the list, beside the one that copies them all. */
  actions?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(servers.join('\n'));
    } catch {
      toast.error('Could not copy that.');
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
  }

  return (
    <div className={cn('space-y-2', className)}>
      <ul
        aria-label="Cloudflare name servers"
        className="divide-y divide-border/60 overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-inset ring-border/60"
      >
        {servers.map((server) => (
          <li key={server} className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
            <span className="min-w-0 flex-1 select-all truncate font-mono text-[13px] text-foreground">
              {server}
            </span>
            <CopyButton text={server} label={`Copy ${server}`} alwaysVisible />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {servers.length > 1 && (
          <Button type="button" size="sm" variant="soft" onClick={() => void copyAll()}>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? 'Copied' : servers.length === 2 ? 'Copy both' : 'Copy all'}
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}
