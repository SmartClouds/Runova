import type { Project } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FolderOpen } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';

/** A project that came from another computer and has no folder here yet (E48). */
export function needsFolder(project: Pick<Project, 'folderPath'>): boolean {
  return project.folderPath.trim() === '';
}

/**
 * Picks this computer's folder for a synced project. The folder stays on this computer: picking
 * it never changes the folder on the computer the project came from.
 */
export function ChooseFolderButton({ project }: { project: Project }): React.JSX.Element {
  const client = useQueryClient();
  const choose = async () => {
    const folder = await window.runova.projects.pickFolder();
    if (!folder) return;
    await window.runova.projects.update(project.id, { folderPath: folder });
    toast.success(`${project.name} now opens from ${folder} on this computer.`);
    void client.invalidateQueries({ queryKey: queryKeys.projects });
  };
  return (
    <SimpleTooltip label="This project came from another computer. Pick where it lives on this one.">
      <button
        type="button"
        className="-ml-1 flex items-center gap-1 rounded-md bg-warning/12 px-1.5 py-0.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(e) => {
          e.stopPropagation();
          void choose();
        }}
      >
        <FolderOpen className="h-3 w-3 shrink-0" />
        Choose folder
      </button>
    </SimpleTooltip>
  );
}
