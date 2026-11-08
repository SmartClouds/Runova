import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';

export type Presence = 'online' | 'starting' | 'offline';

const PRESENCE = {
  online: {
    label: 'online',
    ring: 'bg-success',
    halo: 'bg-success/40 animate-ping motion-reduce:animate-none',
  },
  starting: {
    label: 'connecting',
    ring: 'bg-warning',
    halo: 'bg-warning/40 animate-pulse motion-reduce:animate-none',
  },
  offline: { label: 'offline', ring: 'bg-muted-foreground/50', halo: 'hidden' },
} as const;

/**
 * The Runova ID as people read it to each other over the phone (E61): three groups of three on
 * their own tiles, with a live dot that says whether the computer can be reached right now. It is
 * the one thing on the Anywhere tab meant to be glanced at from across the room.
 */
export function RemoteIdDial({
  remoteId,
  presence,
  copy = false,
  size = 'lg',
}: {
  remoteId: string | null;
  presence: Presence;
  copy?: boolean;
  size?: 'lg' | 'sm';
}): React.JSX.Element {
  const groups = remoteId
    ? [remoteId.slice(0, 3), remoteId.slice(3, 6), remoteId.slice(6)]
    : ['···', '···', '···'];
  const state = PRESENCE[presence];
  const spoken = remoteId ? groups.join(' ') : 'not ready yet';
  return (
    <div className="flex items-center gap-3">
      <div
        role="group"
        aria-label={`Runova ID ${spoken}, ${state.label}`}
        className="flex items-center gap-1.5"
      >
        {groups.map((group, index) => (
          <span
            key={index}
            data-testid="id-group"
            aria-hidden
            className={cn(
              'relative rounded-xl bg-foreground/[0.05] font-mono font-semibold tabular-nums tracking-[0.12em] text-foreground',
              'shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08),inset_0_-1px_0_hsl(var(--foreground)/0.04)]',
              size === 'lg'
                ? 'px-3 py-1.5 text-[28px] leading-none'
                : 'px-2 py-1 text-base leading-none',
              !remoteId && 'text-muted-foreground/60',
            )}
          >
            {group}
          </span>
        ))}
        <span
          className={cn('relative ml-1 flex', size === 'lg' ? 'h-2.5 w-2.5' : 'h-2 w-2')}
          aria-hidden
        >
          <span className={cn('absolute inline-flex h-full w-full rounded-full', state.halo)} />
          <span className={cn('relative inline-flex h-full w-full rounded-full', state.ring)} />
        </span>
      </div>
      {copy && remoteId ? <CopyButton text={remoteId} label="Copy ID" alwaysVisible /> : null}
    </div>
  );
}
