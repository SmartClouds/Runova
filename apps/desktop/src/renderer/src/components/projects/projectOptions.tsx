import type { Project } from '@runova/core';
import { Ban } from '@/components/icons';
import type { ComboboxOption } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import { ProjectIcon } from './ProjectIcon';

/** The tile sizing every project list row uses, so pickers match the project rail. */
const ROW_TILE = 'h-6 w-6 rounded-md';

const SIZES = {
  /** A row in a dropdown list or a menu. */
  row: { tile: ROW_TILE, glyph: 'h-3 w-3' },
  /** A taller two-line row inside a dialog, where a bigger tile balances the text. */
  card: { tile: 'h-8 w-8 rounded-lg', glyph: 'h-3.5 w-3.5' },
} as const;

/**
 * The combobox field shows the picked row's icon, and a row tile is a size too big for that pill.
 * Shrinking it here, rather than in the combobox, leaves other pickers' icons alone.
 */
const IN_TRIGGER = '[[role=combobox]_&]:h-5 [[role=combobox]_&]:w-5';

/** A project's icon sized for a list of projects to pick from. */
export function ProjectRowIcon({
  project,
  size = 'row',
  className,
}: {
  project: Pick<Project, 'iconDataUrl' | 'iconBgColor' | 'iconColor'>;
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  return (
    <ProjectIcon
      iconDataUrl={project.iconDataUrl ?? null}
      bgColor={project.iconBgColor}
      iconColor={project.iconColor}
      className={cn(SIZES[size].tile, className)}
      glyphClassName={SIZES[size].glyph}
    />
  );
}

/** One project as a combobox row: its icon, its name, and its folder under the name. */
export function projectOption(project: Project): ComboboxOption {
  return {
    value: project.id,
    label: project.name,
    description: project.folderPath,
    keepDescriptionEnd: true,
    keywords: project.tags,
    icon: <ProjectRowIcon project={project} className={IN_TRIGGER} />,
  };
}

/**
 * The row that stands for no project at all ("Do not link", "Standalone video"), drawn as a
 * muted tile so it lines up with the project rows around it.
 */
export function noProjectOption(
  value: string,
  label: string,
  Glyph: React.ComponentType<{ className?: string }> = Ban,
): ComboboxOption {
  return {
    value,
    label,
    icon: (
      <span
        className={cn(
          ROW_TILE,
          IN_TRIGGER,
          'flex shrink-0 items-center justify-center bg-foreground/[0.06] text-muted-foreground',
        )}
      >
        <Glyph className="h-3 w-3" />
      </span>
    ),
  };
}
