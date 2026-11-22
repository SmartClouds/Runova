import type { EnvFileLinkState, EnvFileLinkSummary } from '@shared/apiTypes';
import { CircleAlert, Link, Lock, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** What each link state says on a file row. Plain words, never color alone. */
const STATE_TEXT: Record<EnvFileLinkState, string> = {
  watching: 'Watching for changes',
  missing: 'File not found, showing the last saved copy',
  waitingForUnlock: 'Locked, unlock to pick up changes',
  tooLarge: 'File is over 1 MB, changes are not picked up',
  noFolder: 'This project has no folder on this computer',
  error: "Couldn't write the file. Save again to retry.",
};

function StateIcon({ state }: { state: EnvFileLinkState }): React.JSX.Element {
  switch (state) {
    case 'watching':
      return (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
        />
      );
    case 'waitingForUnlock':
      return <Lock className="h-3 w-3 shrink-0" />;
    case 'missing':
    case 'tooLarge':
      return <TriangleAlert className="h-3 w-3 shrink-0" />;
    default:
      return <CircleAlert className="h-3 w-3 shrink-0" />;
  }
}

/**
 * The line under a linked env file: which project file it follows, and how that is going. The
 * full path is in the chip's title, since a long one is cut short.
 */
export function EnvFileLinkStatus({
  link,
  absolutePath,
  onUnlock,
}: {
  link: EnvFileLinkSummary;
  absolutePath: string;
  onUnlock: () => void;
}): React.JSX.Element {
  const tone =
    link.state === 'error'
      ? 'text-destructive'
      : link.state === 'missing' || link.state === 'tooLarge'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        title={absolutePath}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-primary"
      >
        <Link className="h-3 w-3 shrink-0" />
        <span className="truncate">{link.path}</span>
      </span>
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', tone)}>
        <StateIcon state={link.state} />
        <span className="truncate">{STATE_TEXT[link.state]}</span>
      </span>
      {link.state === 'waitingForUnlock' && (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onUnlock}>
          Unlock
        </Button>
      )}
    </div>
  );
}

/** The linked file's place on this computer, for the OS (show in folder, open in an editor). */
export function linkedFilePath(folderPath: string, path: string): string {
  const separator = folderPath.includes('\\') ? '\\' : '/';
  return `${folderPath.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`;
}
