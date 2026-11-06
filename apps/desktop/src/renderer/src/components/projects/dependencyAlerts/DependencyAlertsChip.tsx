import { Package, Shield } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useDependencyAlerts } from '@/hooks/useDependencyAlerts';
import { cn } from '@/lib/utils';

/**
 * What the server's daily check found in a project (E51), as one small button on its card or
 * row that opens the Packages tab. Nothing shows for a project with nothing to tell, a muted one,
 * or one that was never checked. A security issue gets its own red chip and leads the name.
 *
 * Like the storage chip, its accessible name never repeats the project's name, so "click
 * <project>" stays one button for a test, a voice command or a screen reader.
 */
export function DependencyAlertsChip({
  projectId,
  onOpen,
  className,
}: {
  projectId: string;
  onOpen: () => void;
  className?: string;
}): React.JSX.Element | null {
  const summary = useDependencyAlerts();
  const entry = summary.enabled ? summary.byProject[projectId] : undefined;
  if (!entry || entry.muted || entry.total === 0) return null;

  const security = entry.counts.security;
  const updates = `${entry.total} package update${entry.total === 1 ? '' : 's'}`;
  const securityNote =
    security > 0
      ? `, ${security} of them a ${entry.worstSeverity ?? 'security'} security issue`
      : '';
  const open = (event: React.MouseEvent): void => {
    // The card around it opens the project; this opens its Packages tab instead.
    event.stopPropagation();
    onOpen();
  };

  return (
    <SimpleTooltip label="Found by the daily package check. Open Packages.">
      <button
        type="button"
        aria-label={`${updates} in this project${securityNote}. Open Packages.`}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        onClick={open}
      >
        {security > 0 && (
          <Chip tone="destructive" className="transition-colors hover:bg-destructive/20">
            <Shield />
            {security} security
          </Chip>
        )}
        <Chip tone="warning" className="transition-colors hover:bg-warning/20">
          <Package />
          {entry.total} update{entry.total === 1 ? '' : 's'}
        </Chip>
      </button>
    </SimpleTooltip>
  );
}
