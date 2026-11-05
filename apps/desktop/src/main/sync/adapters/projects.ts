import { type Project, syncCollection } from '@runova/core';
import { arrayStoreAdapter } from './arrayStore';

export interface ProjectStorePort {
  getProjects: () => Promise<Project[]>;
  setProjects: (projects: Project[]) => Promise<void>;
}

/**
 * Projects (E48.14). The folder is this computer's own: a project that arrives from another
 * computer has none until the person picks one ("Choose folder" on its card), and picking it never
 * touches the other computer. The icon travels inline and is written back to this computer's own
 * icon file by the store. The WordPress link belongs to this computer too.
 */
export function projectsAdapter(store: ProjectStorePort, afterWrite?: () => void) {
  return arrayStoreAdapter<Project>({
    collection: syncCollection('projects'),
    area: 'projects',
    read: () => store.getProjects(),
    write: (projects) => store.setProjects(projects),
    id: (project) => project.id,
    fromValue: (value, existing) =>
      ({
        ...value,
        folderPath: existing?.folderPath ?? '',
        iconFile: existing?.iconFile ?? null,
        ...(existing?.wordpress ? { wordpress: existing.wordpress } : {}),
      }) as unknown as Project,
    duplicate: (value) => ({ ...value, name: `${String(value.name)} (from another computer)` }),
    ...(afterWrite ? { afterWrite } : {}),
  });
}

/** A project that came from another computer and has no folder here yet. */
export function needsFolder(project: Pick<Project, 'folderPath'>): boolean {
  return project.folderPath.trim() === '';
}
