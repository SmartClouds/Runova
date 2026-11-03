import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

/**
 * Skill tools over a temp home and project folder: what is installed and where, reading one,
 * what the added repositories offer, and installing or removing a skill through the same
 * functions the Skills page calls. Nothing here may touch the real ~/.claude.
 */

const userData = useTempUserData();
let tools: Map<string, AiTool>;

const projectContext: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
const noProject: ToolContext = { ...projectContext, projectId: null };

const projectDir = () => join(userData.dir, 'shop');
const homeDir = () => join(userData.dir, 'home');
const repoDir = () => join(userData.dir, 'repo');

function writeSkill(parent: string, name: string, body: string): void {
  mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(join(parent, name, 'SKILL.md'), body, 'utf-8');
}

beforeEach(async () => {
  mkdirSync(join(projectDir(), '.claude'), { recursive: true });
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Shop',
      folderPath: projectDir(),
      agentType: 'claude-code',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
  writeSkill(join(projectDir(), '.claude', 'skills'), 'deploy-notes', '# Deploy notes\n');
  writeSkill(join(homeDir(), '.claude', 'skills'), 'reviewer', '# Reviewer\n\nReview code.\n');
  writeFileSync(join(homeDir(), '.claude', 'skills', 'reviewer', 'checklist.md'), '- tests');

  mkdirSync(repoDir(), { recursive: true });
  writeFileSync(
    join(repoDir(), 'repository.json'),
    JSON.stringify({
      name: 'Team skills',
      description: 'Ours',
      skills: [
        {
          id: 'formatter',
          name: 'Formatter',
          description: 'Formats things',
          category: 'dev',
          tags: [],
          author: 'Runova',
          version: '1.0.0',
          popularity: 0,
          dependencies: [],
          compatibility: [],
          files: [{ path: 'SKILL.md', url: 'formatter/SKILL.md' }],
        },
      ],
    }),
  );
  writeSkill(repoDir(), 'formatter', '# Formatter\n');
  userData.writeData('repositories.json', [
    {
      id: 'r1',
      name: 'Team skills',
      sourceType: 'local-folder',
      source: repoDir(),
      addedAt: '2026-01-01T00:00:00Z',
      lastRefreshedAt: null,
    },
  ]);

  const { skillTools } = await import('./skills');
  tools = new Map(skillTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}, context = projectContext) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), projectContext);
}

describe('skill tools', () => {
  it('lists the skills in the project and in the user folder, saying which is which', async () => {
    expect((await run('skills_list')).data).toEqual([
      expect.objectContaining({ name: 'deploy-notes', scope: 'project' }),
      expect.objectContaining({ name: 'reviewer', scope: 'user' }),
    ]);
    expect((await run('skills_list', {}, noProject)).data).toEqual([
      expect.objectContaining({ name: 'reviewer', scope: 'user' }),
    ]);
  });

  it('reads a skill with the other files in its folder', async () => {
    const data = (await run('skills_read', { name: 'reviewer' })).data as {
      scope: string;
      content: string;
      files: string[];
    };
    expect(data.scope).toBe('user');
    expect(data.content).toContain('Review code.');
    expect(data.files).toEqual(['SKILL.md', 'checklist.md']);
    await expect(run('skills_read', { name: 'nope' })).rejects.toThrow('No skill named nope');
  });

  it('lists what the added repositories offer', async () => {
    expect((await run('skills_available')).data).toEqual([
      {
        repository: 'Team skills',
        repositoryId: 'r1',
        skills: [expect.objectContaining({ id: 'formatter', name: 'Formatter', version: '1.0.0' })],
      },
    ]);
  });

  it('installs a repository skill into the project, and into the user folder when asked', async () => {
    const shown = await preview('skills_install', {
      repository: 'team SKILLS',
      skill: 'Formatter',
    });
    expect(shown.title).toBe('Install the skill Formatter into Shop');

    await run('skills_install', { repository: 'team SKILLS', skill: 'Formatter' });
    expect(
      readFileSync(join(projectDir(), '.claude', 'skills', 'formatter', 'SKILL.md'), 'utf-8'),
    ).toContain('# Formatter');

    await run('skills_install', { repository: 'r1', skill: 'formatter', scope: 'user' });
    expect(existsSync(join(homeDir(), '.claude', 'skills', 'formatter', 'SKILL.md'))).toBe(true);
  });

  it('uninstalls a skill folder by name, only from the scope named', async () => {
    expect((await preview('skills_uninstall', { name: 'deploy-notes' })).title).toBe(
      'Uninstall the skill deploy-notes from Shop',
    );
    await run('skills_uninstall', { name: 'deploy-notes' });
    expect(existsSync(join(projectDir(), '.claude', 'skills', 'deploy-notes'))).toBe(false);

    await expect(run('skills_uninstall', { name: 'reviewer' })).rejects.toThrow(
      'No skill named reviewer in Shop',
    );
    await run('skills_uninstall', { name: 'reviewer', scope: 'user' });
    expect(existsSync(join(homeDir(), '.claude', 'skills', 'reviewer'))).toBe(false);
  });

  it('refuses a name that could climb out of the skills folder', async () => {
    await expect(run('skills_uninstall', { name: '../../shop' })).rejects.toThrow();
    expect(existsSync(projectDir())).toBe(true);
  });

  it('leaves a skill whose own CLI owns its files to the Skills page', async () => {
    mkdirSync(join(projectDir(), '.runova'), { recursive: true });
    writeFileSync(
      join(projectDir(), '.runova', 'installed-skills.json'),
      JSON.stringify([
        {
          skillId: 'ui-ux-pro-max',
          repositoryId: UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID,
          version: '1',
          installedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    await expect(run('skills_uninstall', { name: 'ui-ux-pro-max' })).rejects.toThrow('Skills page');
  });
});
