import type { Project } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { createManageMethods } from './methods';

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['core' as const] } };

function project(change: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Website',
    folderPath: 'C:\\Users\\sam\\secret-client\\website',
    tags: ['web'],
    pinned: true,
    archived: false,
    iconDataUrl: `data:image/png;base64,${'A'.repeat(50_000)}`,
    iconBgColor: '#102030',
    iconColor: '#ffffff',
    repoUrl: 'https://github.com/acme/website',
    prompt: 'private standing prompt',
    notes: 'private notes',
    ...change,
  } as Project;
}

describe('projects.list', () => {
  it('gives the phone what it shows and leaves paths, prompts and large icons behind', async () => {
    const methods = createManageMethods({ listProjects: vi.fn(async () => [project()]) });

    const result = await methods.calls['projects.list'](undefined, context);

    expect(result).toEqual([
      {
        id: 'p1',
        name: 'Website',
        tags: ['web'],
        pinned: true,
        archived: false,
        iconBgColor: '#102030',
        iconColor: '#ffffff',
        hasRepository: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-client');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('says plainly when a project has no repository', async () => {
    const methods = createManageMethods({
      listProjects: vi.fn(async () => [project({ repoUrl: undefined })]),
    });

    const result = (await methods.calls['projects.list'](undefined, context)) as {
      hasRepository: boolean;
    }[];

    expect(result[0]?.hasRepository).toBe(false);
  });
});
