import type { Project } from '@runova/core';
import type { ManageProject } from '@runova/protocol';
import type { ManageMethods } from './session';

/** What the methods need from the rest of the app, so each can be tested without it. */
export interface ManageMethodDeps {
  listProjects(): Promise<Project[]>;
}

function toManageProject(project: Project): ManageProject {
  return {
    id: project.id,
    name: project.name,
    tags: project.tags,
    pinned: project.pinned === true,
    archived: project.archived === true,
    iconBgColor: project.iconBgColor ?? null,
    iconColor: project.iconColor ?? null,
    hasRepository: Boolean(project.repoUrl),
  };
}

/** Every method a phone can reach, by the names in `MANAGE_METHODS`. */
export function createManageMethods(deps: ManageMethodDeps): ManageMethods {
  return {
    calls: {
      'projects.list': async () => (await deps.listProjects()).map(toManageProject),
    },
    streams: {},
  };
}
