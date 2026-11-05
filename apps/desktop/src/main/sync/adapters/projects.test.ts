import type { Project } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { TEAM_FIELD } from './arrayStore';
import { needsFolder, projectsAdapter } from './projects';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Shop',
    folderPath: 'C:\\src\\shop',
    iconFile: 'p1.png',
    iconDataUrl: 'data:image/png;base64,AAA',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as Project;
}

function memoryStore(initial: Project[] = []) {
  let projects = structuredClone(initial);
  return {
    getProjects: async () => structuredClone(projects),
    setProjects: async (next: Project[]) => {
      projects = structuredClone(next);
    },
    get: () => projects,
  };
}

describe('projectsAdapter', () => {
  it('lists projects with their team and without the team field in what syncs', async () => {
    const store = memoryStore([project({ [TEAM_FIELD]: 5 } as never)]);

    const [item] = await projectsAdapter(store).list();

    expect(item?.teamId).toBe(5);
    expect(item?.value).not.toHaveProperty(TEAM_FIELD);
    expect(item?.value.folderPath).toBe('C:\\src\\shop');
  });

  it('adds a project from another computer with no folder here', async () => {
    const store = memoryStore();

    await projectsAdapter(store).apply({
      id: 'p1',
      teamId: null,
      value: { id: 'p1', name: 'Shop' },
    });

    expect(store.get()[0]?.folderPath).toBe('');
    expect(needsFolder(store.get()[0] as Project)).toBe(true);
  });

  it('keeps this computer’s folder, icon file and WordPress link on an update', async () => {
    const store = memoryStore([project({ wordpress: { siteId: 'w' } } as never)]);

    await projectsAdapter(store).apply({
      id: 'p1',
      teamId: 5,
      value: { id: 'p1', name: 'Renamed' },
    });

    const stored = store.get()[0] as Project & Record<string, unknown>;
    expect(stored.name).toBe('Renamed');
    expect(stored.folderPath).toBe('C:\\src\\shop');
    expect(stored.iconFile).toBe('p1.png');
    expect(stored.wordpress).toEqual({ siteId: 'w' });
    expect(stored[TEAM_FIELD]).toBe(5);
  });

  it('removes a project and tells the renderer', async () => {
    const store = memoryStore([project()]);
    let told = 0;

    await projectsAdapter(store, () => {
      told += 1;
    }).remove('p1');

    expect(store.get()).toEqual([]);
    expect(told).toBe(1);
  });
});
