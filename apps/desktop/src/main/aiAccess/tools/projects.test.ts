import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

vi.mock('../../ipc/terminal', () => ({ terminalSessionInfo: () => undefined }));

/** The project tools: find a project, read its details and keep its notes. */

const userData = useTempUserData();

const context: ToolContext = { projectId: 'p1', callerKind: 'runova', agent: 'Codex', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Shop',
      description: 'The store',
      folderPath: 'C:/code/shop',
      tags: ['web'],
      notes: 'Deploy on Fridays',
      runCommands: [{ id: 'r1', label: 'dev', command: 'npm run dev' }],
      repoUrl: 'https://github.com/me/shop',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'p2',
      name: 'Old blog',
      folderPath: 'C:/code/blog',
      archived: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]);
  const { projectTools } = await import('./projects');
  tools = new Map(projectTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('project tools', () => {
  it('lists projects without the archived ones unless asked', async () => {
    expect(((await run('projects_list', {})).data as { id: string }[]).map((p) => p.id)).toEqual([
      'p1',
    ]);
    expect(
      ((await run('projects_list', { includeArchived: true })).data as { id: string }[]).map(
        (p) => p.id,
      ),
    ).toEqual(['p1', 'p2']);
  });

  it('gives the details of a project, its notes and run commands included', async () => {
    expect((await run('projects_get', {})).data).toMatchObject({
      id: 'p1',
      name: 'Shop',
      folder: 'C:/code/shop',
      notes: 'Deploy on Fridays',
      runCommands: [{ label: 'dev', command: 'npm run dev' }],
      repoUrl: 'https://github.com/me/shop',
    });
  });

  it('adds to the notes or replaces them, and shows the change before it is made', async () => {
    const tool = tools.get('project_update_notes') as AiTool;
    const preview = await tool.preview(
      tool.input.parse({ notes: 'Staging is on Hetzner', mode: 'append' }),
      context,
    );
    expect(preview).toMatchObject({
      title: 'Add to the notes of Shop',
      diff: { before: 'Deploy on Fridays', after: 'Deploy on Fridays\n\nStaging is on Hetzner' },
    });

    await run('project_update_notes', { notes: 'Staging is on Hetzner', mode: 'append' });
    expect((await run('projects_get', {})).data).toMatchObject({
      notes: 'Deploy on Fridays\n\nStaging is on Hetzner',
    });

    await run('project_update_notes', { notes: 'Fresh start' });
    expect((await run('projects_get', {})).data).toMatchObject({ notes: 'Fresh start' });
  });
});
